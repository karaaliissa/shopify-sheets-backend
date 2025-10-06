// /api/[...route].js
// Unified router (robust) — keeps everything in one file.

import getRawBody from "raw-body";
import crypto from "crypto";
import { setCors } from "./lib/cors.js";
import {
  getAll, getLatestItems, upsertOrder, writeLineItems, logWebhook,
  Tabs, createWorkEntry, markWorkDone
} from "./lib/sheets.js";
import { verifyShopifyHmac, normalizeOrderPayload, enrichLineItemImages } from "./lib/shopify.js";
import { getCache, setCache, invalidateByTag, k } from "./lib/cache.js";

export const config = { api: { bodyParser: false }, runtime: "nodejs" }; // important on Vercel
const inflight = new Map(); // key -> Promise resolving to payload
const MIN_REFRESH_MS = 15_000; // ignore refresh spam inside this window
const lastFetchAt = new Map(); // key -> ts

async function withCache({ key, ttlMs, tags = [], refresh = false, fetcher }) {
  // 1) serve fresh cache if not forcing refresh
  const cached = getCache(key);
  if (!refresh && cached) return cached;

  // 2) rate-limit "refresh=1" spam: within window, still return cached (or in-flight)
  if (refresh) {
    const last = lastFetchAt.get(key) || 0;
    if (Date.now() - last < MIN_REFRESH_MS && cached) return cached;
  }

  // 3) coalesce concurrent identical fetches
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const val = await fetcher();           // <-- the only place that hits Sheets
      setCache(key, val, ttlMs, tags);
      lastFetchAt.set(key, Date.now());
      return val;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}
// --- utils ------------------------------------------------------------------
const esc = (s = "") => String(s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");

const csvEsc = (s = "") => String(s).replace(/"/g,'""');
const toCSV = rows => {
  const headers = Object.keys(rows[0] || {});
  const body = rows.map(r => headers.map(h => `"${csvEsc(r[h] ?? "")}"`).join(",")).join("\n");
  return [headers.join(","), body].filter(Boolean).join("\n");
};

function exposeDownloadHeaders(res) {
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
}

async function readJsonBody(req) {
  const raw = await getRawBody(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { return {}; }
}

// HTTP cache headers (CDN + tiny client cache)
function setHttpCacheOk(res, seconds = 30) {
  res.setHeader("Cache-Control", `public, max-age=5, s-maxage=${seconds}, stale-while-revalidate=60`);
}

// --- HANDLERS ---------------------------------------------------------------

async function handleOrders(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  const shop    = (req.query.shop || "").toLowerCase();
  const status  = (req.query.status || "").toLowerCase();
  const limit   = Math.min(Number(req.query.limit || 100), 1000);
  const refresh = String(req.query.refresh || "").toLowerCase() === "1";

  const key = k(["orders", shop, status, limit]);

  try {
    const payload = await withCache({
      key,
      ttlMs: 45_000,
      tags: ["orders"],
      refresh,
      fetcher: async () => {
        const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");
        let rows = shop ? all.filter(r => (r.SHOP_DOMAIN || "").toLowerCase() === shop) : all;
        if (status) rows = rows.filter(r => (r.FULFILLMENT_STATUS || "").toLowerCase() === status);
        rows.sort((a,b) => (a.UPDATED_AT < b.UPDATED_AT ? 1 : -1));
        return { ok:true, items: rows.slice(0, limit) };
      }
    });

    setHttpCacheOk(res, 45);
    return res.status(200).json(payload);
  } catch (e) {
    // stale-on-error: if something still throws, give last cache or empty list
    const fallback = getCache(key) || { ok:true, items: [] };
    setHttpCacheOk(res, 15);
    return res.status(200).json(fallback);
  }
}


async function handleItems(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  const shop    = (req.query.shop || "").toLowerCase();
  const orderId = String(req.query.order_id || "");
  const refresh = String(req.query.refresh || "").toLowerCase() === "1";
  if (!shop || !orderId) return res.status(400).json({ ok:false, error:"Missing shop or order_id" });

  const key = k(["items", shop, orderId]);

  try {
    const payload = await withCache({
      key,
      ttlMs: 60_000,
      tags: [`items:${shop}`, `items:${shop}:${orderId}`],
      refresh,
      fetcher: async () => {
        const items = await getLatestItems(shop, orderId);
        return { ok:true, items };
      }
    });

    setHttpCacheOk(res, 60);
    return res.status(200).json(payload);
  } catch (e) {
    const fallback = getCache(key) || { ok:true, items: [] };
    setHttpCacheOk(res, 15);
    return res.status(200).json(fallback);
  }
}


async function handleShipday(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");
  exposeDownloadHeaders(res);

  const shop = (req.query.shop || "").trim();
  const dateQ = (req.query.date || new Date().toISOString().slice(0,10)).slice(0,10);
  const allFlag = String(req.query.all || "").toLowerCase() === "1";
  const allowedStatuses = (req.query.statuses || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const refresh = String(req.query.refresh || "").toLowerCase() === "1";

  const key = k(["shipday", shop, dateQ, allFlag ? "all" : "day", allowedStatuses.join(",")]);
  if (!refresh) {
    const cached = getCache(key);
    if (cached) {
      setHttpCacheOk(res, 30);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="shipday-${dateQ}.csv"`);
      return res.status(200).send(cached);
    }
  }

  const orders = await getAll(Tabs.ORDERS);
  const oDate = o => (o.PROCESSED_AT || o.CREATED_AT || o.UPDATED_AT || "").slice(0,10);
  const oStatus = o => (o.STATUS || o.FULFILLMENT_STATUS || o.FULFILL_STATUS || o.ORDER_STATUS || "").toString().toLowerCase();
  const shopMatch = o => !shop || (String(o.SHOP_DOMAIN || o.SHOP || "").trim() === shop);

  let selected = orders.filter(o => shopMatch(o));
  if (!allFlag) {
    selected = selected.filter(o => oDate(o) === dateQ);
    if (allowedStatuses.length > 0) selected = selected.filter(o => allowedStatuses.includes(oStatus(o)));
  }

  const rows = selected.map(o => ({
    orderNumber        : (o.ORDER_NAME || o.NAME || o.ORDER_NUMBER || o.ORDER_ID || "").toString().replace(/^#/, ""),
    customerName       : o.SHIP_NAME || o.CUSTOMER_NAME || "",
    customerPhoneNumber: o.SHIP_PHONE || o.CUSTOMER_PHONE || "",
    customerEmail      : o.CUSTOMER_EMAIL || "",
    addressLine1       : o.SHIP_ADDRESS1 || "",
    addressLine2       : o.SHIP_ADDRESS2 || "",
    city               : o.SHIP_CITY || "",
    state              : o.SHIP_PROVINCE || "",
    postalCode         : o.SHIP_ZIP || "",
    country            : o.SHIP_COUNTRY || "",
    paymentMethod      : (o.COD_AMOUNT ? "COD" : "Prepaid"),
    codAmount          : o.COD_AMOUNT || "",
    note               : o.NOTE || ""
  })).filter(r => r.orderNumber);

  if (String(req.query.debug || "").toLowerCase() === "1") {
    return res.status(200).json({ ok:true, shop, date:dateQ, count:rows.length, sample:rows.slice(0,3) });
  }

  const csv = rows.length ? toCSV(rows) : "orderNumber\n";
  setCache(key, csv, 30_000, ["orders"]); // tag with orders so webhook clears it
  setHttpCacheOk(res, 30);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="shipday-${dateQ}.csv"`);
  return res.status(200).send(csv);
}

async function handlePickingListJson(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  const shop = (req.query.shop || "").toLowerCase();
  const fromIso = req.query.from ? new Date(req.query.from) : null;
  const toIso   = req.query.to   ? new Date(req.query.to)   : null;

  const orders = await getAll(Tabs.ORDERS);
  const ordersFiltered = orders.filter(o => {
    if (shop && (o.SHOP_DOMAIN || "").toLowerCase() !== shop) return false;
    const t = new Date(o.CREATED_AT || o.UPDATED_AT || 0).getTime();
    if (fromIso && t < fromIso.getTime()) return false;
    if (toIso && t > toIso.getTime()) return false;
    return true;
  });

  const orderIdSet = new Set(ordersFiltered.map(o => String(o.ORDER_ID)));
  const itemsAll = await getAll(Tabs.ITEMS);
  const itemsForOrders = itemsAll.filter(r =>
    (!shop || (r.SHOP_DOMAIN || "").toLowerCase() === shop) && orderIdSet.has(String(r.ORDER_ID))
  );

  const latestBatchByOrder = new Map();
  for (const it of itemsForOrders) {
    const key = `${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`;
    const ts = Number(it.BATCH_TS || 0);
    if (!latestBatchByOrder.has(key) || ts > latestBatchByOrder.get(key)) latestBatchByOrder.set(key, ts);
  }
  const latestItems = itemsForOrders.filter(it => Number(it.BATCH_TS || 0) === latestBatchByOrder.get(`${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`));

  const byKey = new Map();
  const orderNameById = new Map(ordersFiltered.map(o => [String(o.ORDER_ID), o.ORDER_NAME || `#${o.ORDER_ID}`]));
  for (const it of latestItems) {
    const sku = (it.SKU || "").trim();
    const k = sku || `${it.TITLE || ""}|${it.VARIANT_TITLE || ""}`;
    const qty = Number(it.FULFILLABLE_QUANTITY ?? it.QUANTITY ?? 0);
    if (!byKey.has(k)) byKey.set(k, { KEY:k, SKU:sku || "", TITLE:it.TITLE || "", VARIANT_TITLE:it.VARIANT_TITLE || "", IMAGE:it.IMAGE || "", TOTAL_QTY:0, ORDERS:new Set() });
    const g = byKey.get(k);
    g.TOTAL_QTY += qty;
    g.IMAGE = g.IMAGE || it.IMAGE || "";
    g.ORDERS.add(orderNameById.get(String(it.ORDER_ID)) || `#${it.ORDER_ID}`);
  }

  const rows = Array.from(byKey.values()).map(g => ({ ...g, ORDERS: Array.from(g.ORDERS) }))
    .filter(x => x.TOTAL_QTY > 0)
    .sort((a,b) => b.TOTAL_QTY - a.TOTAL_QTY);

  return res.status(200).json({ ok:true, items:rows });
}
// --- PRINT: Picking (HTML) ---------------------------------------------------
async function handlePrintPicking(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const shop = (req.query.shop || "").toLowerCase().trim();
  const q    = (req.query.q || "").toLowerCase().trim();

  // reuse same grouping logic as handlePickingListJson
  const orders = await getAll(Tabs.ORDERS);
  const orderIdSet = new Set(
    orders.filter(o => !shop || (o.SHOP_DOMAIN || "").toLowerCase() === shop)
          .map(o => String(o.ORDER_ID))
  );

  const itemsAll = await getAll(Tabs.ITEMS);
  const itemsForOrders = itemsAll.filter(r =>
    (!shop || (r.SHOP_DOMAIN || "").toLowerCase() === shop) &&
    orderIdSet.has(String(r.ORDER_ID))
  );

  // keep latest batch per (shop,order)
  const last = new Map();
  for (const it of itemsForOrders) {
    const key = `${(it.SHOP_DOMAIN||"").toLowerCase()}|${String(it.ORDER_ID)}`;
    const ts  = Number(it.BATCH_TS || 0);
    if (!last.has(key) || ts > last.get(key)) last.set(key, ts);
  }
  const latest = itemsForOrders.filter(it =>
    Number(it.BATCH_TS || 0) === last.get(`${(it.SHOP_DOMAIN||"").toLowerCase()}|${String(it.ORDER_ID)}`)
  );

  const orderNameById = new Map(orders.map(o => [String(o.ORDER_ID), o.ORDER_NAME || `#${o.ORDER_ID}`]));
  const byKey = new Map();
  for (const it of latest) {
    const sku = (it.SKU || "").trim();
    const key = sku || `${it.TITLE || ""}|${it.VARIANT_TITLE || ""}`;
    const qty = Number(it.FULFILLABLE_QUANTITY ?? it.QUANTITY ?? 0);
    if (!byKey.has(key)) byKey.set(key, {
      KEY:key, SKU:sku || "", TITLE:it.TITLE || "", VARIANT_TITLE:it.VARIANT_TITLE || "",
      IMAGE:it.IMAGE || "", TOTAL_QTY:0, ORDERS:new Set()
    });
    const g = byKey.get(key);
    g.TOTAL_QTY += qty;
    g.IMAGE = g.IMAGE || it.IMAGE || "";
    g.ORDERS.add(orderNameById.get(String(it.ORDER_ID)) || `#${it.ORDER_ID}`);
  }

  let rows = Array.from(byKey.values()).map(g => ({...g, ORDERS:Array.from(g.ORDERS)}))
                 .filter(x => x.TOTAL_QTY > 0)
                 .sort((a,b) => b.TOTAL_QTY - a.TOTAL_QTY);

  if (q) {
    rows = rows.filter(x =>
      (x.SKU||"").toLowerCase().includes(q) ||
      (x.TITLE||"").toLowerCase().includes(q) ||
      (x.VARIANT_TITLE||"").toLowerCase().includes(q)
    );
  }

  // tiny HTML printable page
  const html = `<!doctype html><html><head>
  <meta charset="utf-8"/>
  <title>Picking – ${esc(shop)}</title>
  <style>
    *{box-sizing:border-box} body{font:14px/1.35 system-ui,Segoe UI,Roboto,Arial;padding:16px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
    .card{border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:flex;gap:10px}
    img{width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid #eee}
    .title{font-weight:600;margin-bottom:4px}
    .sku{font-size:12px;color:#6b7280;margin-right:6px}
    .variant{font-size:12px;color:#6b7280;margin-left:6px}
    .qty{margin:6px 0;font-size:15px}
    .tag{display:inline-block;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:999px;
         padding:2px 8px;margin:2px;font-size:12px}
    .top{display:flex;justify-content:space-between;align-items:center;margin:0 0 12px}
    .muted{color:#6b7280}
    @media print{ .no-print{display:none} body{padding:0} .card{break-inside:avoid} }
  </style></head><body>
    <div class="top no-print">
      <div><strong>Picking List</strong> — Shop: ${esc(shop || "all")} — Items: ${rows.length}</div>
      <button onclick="window.print()">Print</button>
    </div>
    <div class="grid">
      ${rows.map(r => `
        <div class="card">
          ${r.IMAGE ? `<img src="${esc(r.IMAGE)}" onerror="this.style.display='none'">` : ""}
          <div class="info">
            <div class="title"><span class="sku">${esc(r.SKU)}</span>${esc(r.TITLE)}${r.VARIANT_TITLE ? ` <span class="variant">(${esc(r.VARIANT_TITLE)})</span>` : ""}</div>
            <div class="qty">Qty: <strong>${r.TOTAL_QTY}</strong></div>
            <div class="orders">${r.ORDERS.map(o => `<span class="tag">${esc(o)}</span>`).join("")}</div>
          </div>
        </div>`).join("")}
    </div>
    <div class="muted no-print" style="margin-top:16px">Generated at ${new Date().toLocaleString()}</div>
  </body></html>`;

  setHttpCacheOk(res, 30); // allow CDN caching briefly
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.status(200).send(html);
}

async function handleWebhookShopify(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).json({ ok:false, error:"Method Not Allowed" }); }
  const { SHOPIFY_WEBHOOK_SECRET, DEBUG_BYPASS_TOKEN, ALLOW_DEBUG_BYPASS = "false", SHOPIFY_ADMIN_TOKEN } = process.env;

  const topic      = req.headers["x-shopify-topic"] || req.headers["X-Shopify-Topic"] || "";
  const shopDomain = req.headers["x-shopify-shop-domain"] || req.headers["X-Shopify-Shop-Domain"] || "";
  const headerHmac = req.headers["x-shopify-hmac-sha256"] || req.headers["X-Shopify-Hmac-Sha256"] || "";

  let raw; try { raw = await getRawBody(req); } catch { return res.status(400).json({ ok:false, error:"Unable to read raw body" }); }

  const allowBypass = (ALLOW_DEBUG_BYPASS || "false").toLowerCase() === "true"
    && DEBUG_BYPASS_TOKEN && req.headers["x-debug-bypass"] === DEBUG_BYPASS_TOKEN;

  let hmacOk = false;
  if (allowBypass) hmacOk = true;
  else {
    if (!SHOPIFY_WEBHOOK_SECRET) return res.status(500).json({ ok:false, error:"Missing SHOPIFY_WEBHOOK_SECRET" });
    hmacOk = verifyShopifyHmac(raw, SHOPIFY_WEBHOOK_SECRET, headerHmac);
  }
  if (!hmacOk) return res.status(401).json({ ok:false, error:"Invalid HMAC" });

  let payload; try { payload = JSON.parse(raw.toString("utf8")); }
  catch { return res.status(400).json({ ok:false, error:"Invalid JSON" }); }

  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  let items = lineItems;
  try { items = await enrichLineItemImages(shopDomain, items, SHOPIFY_ADMIN_TOKEN); }
  catch (e) { console.error("enrichLineItemImages:", e?.message || e); }

  let action = "none", errMsg = "";
  try {
    const out = await upsertOrder(order);
    action = out?.action || "none";
    if (Array.isArray(items) && items.length) await writeLineItems(items, Date.now());
  } catch (e) {
    errMsg = e?.message || String(e);
  }

  // cache invalidation (once)
  try {
    invalidateByTag("orders");
    if (order?.SHOP_DOMAIN && order?.ORDER_ID) {
      const s = String(order.SHOP_DOMAIN).toLowerCase();
      const id = String(order.ORDER_ID);
      invalidateByTag(`items:${s}`);
      invalidateByTag(`items:${s}:${id}`);
    }
  } catch {}

  // log webhook
  try {
    const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
    await logWebhook({ TS:new Date().toISOString(), SHOP_DOMAIN:shopDomain, TOPIC:topic, ORDER_ID:order?.ORDER_ID ?? "", HASH:hash, RESULT:action, ERROR:errMsg });
  } catch (e) { console.error("logWebhook error:", e?.message || e); }

  if (errMsg) return res.status(500).json({ ok:false, error:errMsg });
  return res.status(200).json({ ok:true, result:action });
}

// …(work routes & print HTML you already have can be added here the same way)…

// --- ROUTER -----------------------------------------------------------------
// Bulletproof path extraction across runtimes:
function extractPath(req) {
  // 1) Prefer query array when present
  const segs = req.query?.route;
  if (Array.isArray(segs) && segs.length) return segs.join("/").toLowerCase();

  // 2) If it's a string (some adapters), use it
  if (typeof segs === "string" && segs) return segs.toLowerCase();

  // 3) Fallback: parse URL and remove a single /api prefix
  const host = req.headers.host || "local";
  const url = new URL(req.url || "", `http://${host}`);
  let p = url.pathname || "/";
  p = p.replace(/^\/+/, "/");           // collapse leading slashes
  p = p.replace(/^\/api(\/|$)/, "");    // strip ONLY the first /api
  p = p.replace(/\/+$/, "");            // strip trailing slashes
  return (p || "").toLowerCase();       // "" means index → routes list
}

// Map routes to handlers so it’s easy to add more
const routes = new Map([
  ["",                async (req,res) => res.status(200).json({ ok:true, routes: Array.from(routes.keys()).filter(Boolean) })],
  ["orders",          handleOrders],
  ["items",           handleItems],
  ["order-items",     handleItems],
  ["export/shipday",  handleShipday],
  ["shipday",         handleShipday],
  ["picking-list",    handlePickingListJson],
  ["print/picking",   handlePrintPicking],
  ["webhooks/shopify",handleWebhookShopify],
  // add: "print/picking", "work/*" handlers if you want them here
]);

export default async function main(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const path = extractPath(req);
  const handler = routes.get(path);
  if (!handler) return res.status(404).json({ ok:false, error:`Unknown route /api/${path}` });

  try { await handler(req, res); }
  catch (e) { res.status(500).json({ ok:false, error:String(e?.message || e) }); }
}

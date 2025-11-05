// /api/[...route].js

import getRawBody from "raw-body";
import crypto from "crypto";
import { setCors } from "./lib/cors.js";
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

// /api/[...route].js
async function readJsonBody(req) {
  const raw = await getRawBody(req);
  const s = raw.toString('utf8') || '';
  try { return JSON.parse(s); } catch {}
  try { return Object.fromEntries(new URLSearchParams(s).entries()); } catch {}
  return {};
}

// HTTP cache headers (CDN + tiny client cache)
function setHttpCacheOk(res, seconds = 30) {
  res.setHeader("Cache-Control", `public, max-age=5, s-maxage=${seconds}, stale-while-revalidate=60`);
}

// --- HANDLERS ---------------------------------------------------------------

async function handleSetDeliverBy(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  }
  const body = await readJsonBody(req);
  const shop    = String(body.shop || "").toLowerCase();
  const orderId = String(body.orderId || "");
  let deliverBy = body.deliverBy === null ? null : String(body.deliverBy || "").trim() || null;
  const autoIfExpress = String(body.autoIfExpress || "").toLowerCase() === "true";

  if (!shop || !orderId) {
    return res.status(400).json({ ok:false, error:"Missing shop or orderId" });
  }
  if (deliverBy && !/^\d{4}-\d{2}-\d{2}$/.test(deliverBy)) {
    return res.status(400).json({ ok:false, error:"Bad date format (YYYY-MM-DD)" });
  }

  try {
    const { getAll, upsertOrder, upsertOrderField } = await import("./lib/sheets.js");
    const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");
    const row = all.find(r =>
      String(r.SHOP_DOMAIN || "").toLowerCase() === shop &&
      String(r.ORDER_ID || "") === orderId
    );
    if (!row) return res.status(404).json({ ok:false, error:"Order not found in sheet" });

    // Optional: auto for express if requested and no date provided
    if (autoIfExpress && !deliverBy) {
      const isExpress = /\bexpress\b/i.test(String(row.SHIPPING_METHOD || ""));
      if (isExpress) {
        const created = new Date(row.CREATED_AT || row.UPDATED_AT || Date.now());
        const hr = new Date(created).getHours(); // local runtime hour
        const base = new Date(created);
        base.setDate(base.getDate() + (hr < 12 ? 1 : 2));
        deliverBy = base.toISOString().slice(0,10);
      }
    }

    // Persist only the DELIVER_BY field (without touching UPDATED_AT)
    if (typeof upsertOrderField === "function") {
      await upsertOrderField({ shopDomain: shop, orderId, field: "DELIVER_BY", value: deliverBy ?? "" });
    } else {
      await upsertOrder({ SHOP_DOMAIN: shop, ORDER_ID: orderId, DELIVER_BY: deliverBy ?? "" });
    }

    // Bust cache
    try { invalidateByTag("orders"); } catch {}

    return res.status(200).json({ ok:true, deliverBy });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
async function handleOrdersSummary(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  }
  const { getAll, Tabs } = await import("./lib/sheets.js");
  const all = await getAll(Tabs.ORDERS);

  // same canonical logic as UI
  const statusOf = (r) => {
    const tags = (r.TAGS || "").toLowerCase();
    if (tags.includes("complete"))  return "complete";
    if (tags.includes("cancel"))    return "cancel";
    if (tags.includes("shipped"))   return "shipped";
    if (tags.includes("processing"))return "processing";
    const f = (r.FULFILLMENT_STATUS || "").toLowerCase();
    if (!f || f === "open" || f === "unfulfilled") return "pending";
    return "pending";
  };
  const isExpress = (r) => /\bexpress\b/i.test(String(r.SHIPPING_METHOD || ""));

  const out = {
    ok: true,
    total: all.length,
    pending: 0, processing: 0, shipped: 0, complete: 0, cancel: 0,
    expressPending: 0, expressProcessing: 0, expressShipped: 0, expressComplete: 0, expressCancel: 0,
  };

  for (const r of all) {
    const s = statusOf(r);
    out[s] += 1;
    if (isExpress(r)) {
      if (s === "pending")     out.expressPending++;
      else if (s === "processing") out.expressProcessing++;
      else if (s === "shipped") out.expressShipped++;
      else if (s === "complete")out.expressComplete++;
      else if (s === "cancel") out.expressCancel++;
    }
  }

  // tiny public cache
  res.setHeader("Cache-Control", "public, max-age=5, s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json(out);
}

function encodeCursor(n) { return Buffer.from(String(n)).toString("base64"); }
function decodeCursor(c) {
  if (!c) return 0;
  try { return Number(Buffer.from(String(c), "base64").toString("utf8")) || 0; }
  catch { return 0; }
}

async function handleOrdersPage(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  }
  const { getAll, Tabs } = await import("./lib/sheets.js");

  const shop    = String(req.query.shop || "").toLowerCase();
  const limit   = Math.min(Number(req.query.limit || 25), 100);
  const cursor  = String(req.query.cursor || "");
  const offset  = decodeCursor(cursor);

  // load all then filter (Sheets doesn’t page natively)
  let rows = await getAll(Tabs.ORDERS);
  if (shop) rows = rows.filter(r => String(r.SHOP_DOMAIN || "").toLowerCase() === shop);

  // sort newest first (match your UI)
  rows.sort((a,b) => (a.CREATED_AT < b.CREATED_AT ? 1 : -1));

  const total = rows.length;
  const slice = rows.slice(offset, offset + limit);
  const next  = offset + limit < total ? encodeCursor(offset + limit) : null;

  res.setHeader("Cache-Control", "public, max-age=5, s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json({ ok:true, items: slice, nextCursor: next, total });
}

async function handleOrders(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    
  }
  const { getAll } = await import("./lib/sheets.js");
  const shop    = (req.query.shop || "").toLowerCase();
  const status  = (req.query.status || "").toLowerCase();
  const limit   = Math.min(Number(req.query.limit || 50), 1000);
  const refresh = String(req.query.refresh || "").toLowerCase() === "1";

  const key = k(["orders", shop, status, limit]);

  const fetcher = async () => {
    const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");
    let rows = shop ? all.filter(r => (r.SHOP_DOMAIN || "").toLowerCase() === shop) : all;
    if (status) rows = rows.filter(r => (r.FULFILLMENT_STATUS || "").toLowerCase() === status);
    // rows.sort((a, b) => (a.UPDATED_AT < b.UPDATED_AT ? 1 : -1));
    // rows.sort((a, b) => Number(b.ORDER_ID) - Number(a.ORDER_ID));
    rows.sort((a, b) => (a.CREATED_AT < b.CREATED_AT ? 1 : -1));
    return { ok: true, items: rows.slice(0, limit) };
  };

  try {
    const payload = refresh
      ? await fetcher() // hard bypass memory cache
      : await withCache({ key, ttlMs: 45_000, tags: ["orders"], fetcher });

    if (refresh) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    } else {
      setHttpCacheOk(res, 45); // public, s-maxage=45
    }

    return res.status(200).json(payload);
  } catch {
    const fallback = getCache(key) || { ok: true, items: [] };
    setHttpCacheOk(res, 15);
    return res.status(200).json(fallback);
  }
}


async function handleItems(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  const { getLatestItems } = await import("./lib/sheets.js");
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
  const { getAll, Tabs } = await import("./lib/sheets.js");
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
// async function handlePickingListJson(req, res) {
//   if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
//   const shop = (req.query.shop || "").toLowerCase();
//   const fromIso = req.query.from ? new Date(req.query.from) : null;
//   const toIso   = req.query.to   ? new Date(req.query.to)   : null;

//   const orders = await getAll(Tabs.ORDERS);
//   const ordersFiltered = orders.filter(o => {
//     if (shop && (o.SHOP_DOMAIN || "").toLowerCase() !== shop) return false;
//     const t = new Date(o.CREATED_AT || o.UPDATED_AT || 0).getTime();
//     if (fromIso && t < fromIso.getTime()) return false;
//     if (toIso && t > toIso.getTime()) return false;
//     return true;
//   });

//   const orderIdSet = new Set(ordersFiltered.map(o => String(o.ORDER_ID)));
//   const orderNameById = new Map(
//     ordersFiltered.map(o => [String(o.ORDER_ID), o.ORDER_NAME || `#${o.ORDER_ID}`])
//   );
//   const shipMethodById = new Map(
//     ordersFiltered.map(o => [String(o.ORDER_ID), (o.SHIPPING_METHOD || "").toString()])
//   );

//   const itemsAll = await getAll(Tabs.ITEMS);
//   const itemsForOrders = itemsAll.filter(r =>
//     (!shop || (r.SHOP_DOMAIN || "").toLowerCase() === shop) && orderIdSet.has(String(r.ORDER_ID))
//   );

//   const latestBatchByOrder = new Map();
//   for (const it of itemsForOrders) {
//     const key = `${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`;
//     const ts = Number(it.BATCH_TS || 0);
//     if (!latestBatchByOrder.has(key) || ts > latestBatchByOrder.get(key)) latestBatchByOrder.set(key, ts);
//   }
//   const latestItems = itemsForOrders.filter(
//     it => Number(it.BATCH_TS || 0) === latestBatchByOrder.get(`${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`)
//   );

//   // Group by item key, but keep per-order express info
//   const byKey = new Map(); // key -> { …, ORDERS: Map<orderName, isExpress> }
//   for (const it of latestItems) {
//     const sku = (it.SKU || "").trim();
//     const k = sku || `${it.TITLE || ""}|${it.VARIANT_TITLE || ""}`;
//     const qty = Number(it.FULFILLABLE_QUANTITY ?? it.QUANTITY ?? 0);
//     const orderId = String(it.ORDER_ID);
//     const orderName = orderNameById.get(orderId) || `#${orderId}`;
//     const method = shipMethodById.get(orderId) || "";
//     const isExpress = /\bexpress\b/i.test(method);

//     if (!byKey.has(k)) {
//       byKey.set(k, {
//         KEY: k,
//         SKU: sku || "",
//         TITLE: it.TITLE || "",
//         VARIANT_TITLE: it.VARIANT_TITLE || "",
//         IMAGE: it.IMAGE || "",
//         TOTAL_QTY: 0,
//         ORDERS: new Map() // name -> boolean (isExpress)
//       });
//     }

//     const g = byKey.get(k);
//     g.TOTAL_QTY += qty;
//     g.IMAGE = g.IMAGE || it.IMAGE || "";
//     // if same order name appears multiple times, keep TRUE if any line is express
//     g.ORDERS.set(orderName, (g.ORDERS.get(orderName) || false) || isExpress);
//   }

//   const rows = Array.from(byKey.values())
//     .map(g => ({
//       ...g,
//       ORDERS: Array.from(g.ORDERS.entries()).map(([NAME, IS_EXPRESS]) => ({ NAME, IS_EXPRESS }))
//     }))
//     .filter(x => x.TOTAL_QTY > 0)
//     .sort((a, b) => b.TOTAL_QTY - a.TOTAL_QTY);

//   return res.status(200).json({ ok: true, items: rows });
// }
async function handlePickingListJson(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  const shop = (req.query.shop || "").toLowerCase();
  const fromIso = req.query.from ? new Date(req.query.from) : null;
  const toIso   = req.query.to   ? new Date(req.query.to)   : null;
  const { getAll, Tabs } = await import("./lib/sheets.js");
  const orders = await getAll(Tabs.ORDERS);
  const ordersFiltered = orders.filter(o => {
    if (shop && (o.SHOP_DOMAIN || "").toLowerCase() !== shop) return false;
    const t = new Date(o.CREATED_AT || o.UPDATED_AT || 0).getTime();
    if (fromIso && t < fromIso.getTime()) return false;
    if (toIso && t > toIso.getTime()) return false;
    return true;
  });

  const orderIdSet = new Set(ordersFiltered.map(o => String(o.ORDER_ID)));
  const orderById = new Map(ordersFiltered.map(o => [String(o.ORDER_ID), o]));
  const orderNameById = new Map(
    ordersFiltered.map(o => [String(o.ORDER_ID), o.ORDER_NAME || `#${o.ORDER_ID}`])
  );

  const itemsAll = await getAll(Tabs.ITEMS);
  const itemsForOrders = itemsAll.filter(r =>
    (!shop || (r.SHOP_DOMAIN || "").toLowerCase() === shop) && orderIdSet.has(String(r.ORDER_ID))
  );

  // keep only latest batch per order
  const latestBatchByOrder = new Map();
  for (const it of itemsForOrders) {
    const key = `${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`;
    const ts = Number(it.BATCH_TS || 0);
    if (!latestBatchByOrder.has(key) || ts > latestBatchByOrder.get(key)) latestBatchByOrder.set(key, ts);
  }
  const latestItems = itemsForOrders.filter(
    it => Number(it.BATCH_TS || 0) === latestBatchByOrder.get(`${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`)
  );

  // group by item key, but store per-order flags
  const byKey = new Map(); // key -> { ..., ORDERS: Map<orderName, {IS_EXPRESS, IS_OLD, DATE}> }
  const now = Date.now();

  for (const it of latestItems) {
    const sku = (it.SKU || "").trim();
    const k = sku || `${it.TITLE || ""}|${it.VARIANT_TITLE || ""}`;
    const qty = Number(it.FULFILLABLE_QUANTITY ?? it.QUANTITY ?? 0);

    const orderId = String(it.ORDER_ID);
    const ord = orderById.get(orderId) || {};
    const orderName = orderNameById.get(orderId) || `#${orderId}`;

    const shippingMethod = (ord.SHIPPING_METHOD || "").toString();
    const isExpress = /\bexpress\b/i.test(shippingMethod);

    const created = new Date(ord.CREATED_AT || ord.UPDATED_AT || 0);
    const ageDays = Math.floor((now - created.getTime()) / 86400000);
    const tags = (ord.TAGS || "").toString();
    const shipped = /\bshipped\b/i.test(tags);
    const isOld = ageDays > 7 && !shipped;

    if (!byKey.has(k)) {
      byKey.set(k, {
        KEY: k,
        SKU: sku || "",
        TITLE: it.TITLE || "",
        VARIANT_TITLE: it.VARIANT_TITLE || "",
        IMAGE: it.IMAGE || "",
        TOTAL_QTY: 0,
        ORDERS: new Map()
      });
    }

    const g = byKey.get(k);
    g.TOTAL_QTY += qty;
    g.IMAGE = g.IMAGE || it.IMAGE || "";

    const prev = g.ORDERS.get(orderName) || { IS_EXPRESS: false, IS_OLD: false, DATE: created.toISOString() };
    g.ORDERS.set(orderName, {
      NAME: orderName,
      IS_EXPRESS: prev.IS_EXPRESS || isExpress,
      IS_OLD: prev.IS_OLD || isOld,
      DATE: created.toISOString()
    });
  }

  const rows = Array.from(byKey.values())
    .map(g => ({
      ...g,
      ORDERS: Array.from(g.ORDERS.values()) // to array of {NAME, IS_EXPRESS, IS_OLD, DATE}
    }))
    .filter(x => x.TOTAL_QTY > 0)
    .sort((a, b) => b.TOTAL_QTY - a.TOTAL_QTY);

  return res.status(200).json({ ok: true, items: rows });
}



async function handleWebhookShopify(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).json({ ok:false, error:"Method Not Allowed" }); }
   const { normalizeOrderPayload } =
     await import("./lib/shopify.js");
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
    const { verifyShopifyHmac } = await import("./lib/shopify.js");
    hmacOk = verifyShopifyHmac(raw, SHOPIFY_WEBHOOK_SECRET, headerHmac);
  }
  if (!hmacOk) return res.status(401).json({ ok:false, error:"Invalid HMAC" });

  let payload; try { payload = JSON.parse(raw.toString("utf8")); }
  catch { return res.status(400).json({ ok:false, error:"Invalid JSON" }); }

  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);
  const { enrichLineItemImages } = await import("./lib/shopify.js");

  let items = lineItems;
  
  try { items = await enrichLineItemImages(shopDomain, items, SHOPIFY_ADMIN_TOKEN); }
  catch (e) { console.error("enrichLineItemImages:", e?.message || e); }

  let action = "none", errMsg = "";
  try {
    const { upsertOrder } = await import("./lib/sheets.js");
    const out = await upsertOrder(order);
    action = out?.action || "none";
    const { writeLineItems } = await import("./lib/sheets.js");
    if (Array.isArray(items) && items.length) await writeLineItems(items, Date.now());
  } catch (e) {
    errMsg = e?.message || String(e);
  }

  // cache invalidation (once)
  try {
    const { invalidateByTag } = await import("./lib/cache.js");
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
    const { logWebhook } = await import("./lib/sheets.js");
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
  ["orders/summary",  handleOrdersSummary],
  ["orders/page",     handleOrdersPage],
  ["items",           handleItems],
  ["order-items",     handleItems],
  ["export/shipday",  handleShipday],
  ["shipday",         handleShipday],
  ["orders/deliver-by", handleSetDeliverBy],
  ["picking-list",    handlePickingListJson],
  ["webhooks/shopify",handleWebhookShopify],
  ["orders/tags",     handleOrderTag]
]);

// export default async function main(req, res) {
//   setCors(req, res);
//   if (req.method === "OPTIONS") return res.status(204).end();
export default async function main(req, res) {
  res.setHeader('x-handler', 'catchall:[...route].js');

  // Handle CORS (also terminates OPTIONS)
  const preflightHandled = setCors(req, res);
  if (preflightHandled) return;

  const path = extractPath(req);
  const handler = routes.get(path);
  if (!handler) return res.status(404).json({ ok:false, error:`Unknown route /api/${path}` });

  try {
    await handler(req, res);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
async function handleOrderTag(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  const body = await readJsonBody(req);
  // const { readJsonBody } = await import("./lib/cors.js");
  const shop = String(body.shop || "").toLowerCase();
  const orderId = String(body.orderId || "");
  const action = String(body.action || "add").toLowerCase(); // add | remove | set
  const tag = String(body.tag || "").trim();
  const tagsIn = Array.isArray(body.tags) ? body.tags.map(s => String(s).trim()).filter(Boolean) : null;

  if (!shop || !orderId) return res.status(400).json({ ok: false, error: "Missing shop or orderId" });
  if (action !== "set" && !tag) return res.status(400).json({ ok: false, error: "Missing tag" });

  try {
    // Read current tags from Sheets (cheap & immediate)
    const { getAll, upsertOrder } = await import("./lib/sheets.js");
    // const { invalidateByTag } = await import("./lib/cache.js");
    const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");
    const curRow = all.find(r =>
      String(r.SHOP_DOMAIN || "").toLowerCase() === shop &&
      String(r.ORDER_ID || "") === orderId
    );
    const currentTags = (curRow?.TAGS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    let nextTags = currentTags;
    if (action === "add") {
      if (!currentTags.map(t => t.toLowerCase()).includes(tag.toLowerCase())) {
        nextTags = [...currentTags, tag];
      }
    } else if (action === "remove") {
      nextTags = currentTags.filter(t => t.toLowerCase() !== tag.toLowerCase());
    } else if (action === "set") {
      nextTags = tagsIn || [];
    }

    // Upsert a minimal row so the dashboard reflects immediately
    await upsertOrder({
         SHOP_DOMAIN: shop,
         ORDER_ID: orderId,
         TAGS: nextTags.join(", ")
         // DO NOT set UPDATED_AT here – keep Shopify’s timestamp
       });

    try { invalidateByTag("orders"); } catch {}

    return res.status(200).json({ ok: true, tags: nextTags });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

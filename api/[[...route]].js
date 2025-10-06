// /api/[...route].js
import { setCors } from "./lib/cors.js";
import {
  getAll, getLatestItems, upsertOrder, writeLineItems, logWebhook,
  Tabs, createWorkEntry, markWorkDone
} from "./lib/sheets.js";
import {
  verifyShopifyHmac, normalizeOrderPayload, enrichLineItemImages
} from "./lib/shopify.js";

import getRawBody from "raw-body";
import crypto from "crypto";

// Needed for Shopify HMAC verification (raw body) and to keep one file.
// NOTE: Because bodyParser is false, we manually parse JSON on POST routes.
export const config = { api: { bodyParser: false } };

// ---- helpers ----
const esc = (s="") => String(s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");

const csvEsc = (s='') => String(s).replace(/"/g,'""');
const toCSV = rows => {
  const headers = Object.keys(rows[0] || {});
  const body = rows.map(r => headers.map(h => `"${csvEsc(r[h] ?? '')}"`).join(',')).join('\n');
  return [headers.join(','), body].filter(Boolean).join('\n');
};

function exposeDownloadHeaders(res) {
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
}

async function readJsonBody(req) {
  const raw = await getRawBody(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { return {}; }
}

// ---- routes you already had (CSV export, picking JSON, orders/items/logs, runs, webhook) ----
async function handleShipday(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");
  exposeDownloadHeaders(res);

  const shop = (req.query.shop || "").trim();
  const dateQ = (req.query.date || new Date().toISOString().slice(0,10)).slice(0,10);
  const allFlag = String(req.query.all || "").toLowerCase() === "1";
  const allowedStatuses = (req.query.statuses || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

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
    orderNumber        : (o.ORDER_NAME || o.NAME || o.ORDER_NUMBER || o.ORDER_ID || "").toString().replace(/^#/, ''),
    customerName       : o.SHIP_NAME || o.CUSTOMER_NAME || '',
    customerPhoneNumber: o.SHIP_PHONE || o.CUSTOMER_PHONE || '',
    customerEmail      : o.CUSTOMER_EMAIL || '',
    addressLine1       : o.SHIP_ADDRESS1 || '',
    addressLine2       : o.SHIP_ADDRESS2 || '',
    city               : o.SHIP_CITY || '',
    state              : o.SHIP_PROVINCE || '',
    postalCode         : o.SHIP_ZIP || '',
    country            : o.SHIP_COUNTRY || '',
    paymentMethod      : (o.COD_AMOUNT ? 'COD' : 'Prepaid'),
    codAmount          : o.COD_AMOUNT || '',
    note               : o.NOTE || ''
  })).filter(r => r.orderNumber);

  if (String(req.query.debug || "").toLowerCase() === "1") {
    return res.status(200).json({ ok:true, shop, date:dateQ, count:rows.length, sample:rows.slice(0,3), info:{ totalOrders:orders.length, selectedBeforeMap:selected.length }});
  }

  const csv = rows.length ? toCSV(rows) : 'orderNumber\n';
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
    (!shop || (r.SHOP_DOMAIN || "").toLowerCase() === shop) &&
    orderIdSet.has(String(r.ORDER_ID))
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

  const rows = Array.from(byKey.values()).map(g => ({ ...g, ORDERS: Array.from(g.ORDERS) })).filter(x => x.TOTAL_QTY > 0).sort((a,b) => b.TOTAL_QTY - a.TOTAL_QTY);
  return res.status(200).json({ ok:true, items:rows });
}

async function handleOrders(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  const shop   = (req.query.shop || "").toLowerCase();
  const status = (req.query.status || "").toLowerCase();
  const limit  = Math.min(Number(req.query.limit || 100), 1000);
  const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");

  let rows = shop ? all.filter(r => (r.SHOP_DOMAIN || "").toLowerCase() === shop) : all;
  if (status) rows = rows.filter(r => (r.FULFILLMENT_STATUS || "").toLowerCase() === status);
  rows.sort((a,b) => (a.UPDATED_AT < b.UPDATED_AT ? 1 : -1));
  return res.status(200).json({ ok:true, items: rows.slice(0, limit) });
}

async function handleItems(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  const shop = req.query.shop, orderId = req.query.order_id;
  if (!shop || !orderId) return res.status(400).json({ ok:false, error:"Missing shop or order_id" });
  const items = await getLatestItems(shop, orderId);
  return res.status(200).json({ ok:true, items });
}

async function handleLogs(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  const { TAB_LOGS = "TBL_WEBHOOK_LOG" } = process.env;
  const limit = Math.min(Number(req.query.limit || 50), 500);
  const all = await getAll(TAB_LOGS);
  const sorted = all.sort((a,b) => (a.TS < b.TS ? 1 : -1)).slice(0, limit);
  return res.status(200).json({ ok:true, items: sorted });
}

async function handleRunsForDriver(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  const driverId = (req.query.driverId || "").trim();
  const date = (req.query.date || new Date().toISOString().slice(0,10)).slice(0,10);
  if (!driverId) return res.status(400).json({ ok:false, error:"driverId required" });

  const runs  = (await getAll(Tabs.DRIVER_RUN))
    .filter(r => (r.DRIVER_ID || "").trim() === driverId && (r.DATE || "").startsWith(date));
  const runIds = new Set(runs.map(r => r.RUN_ID));

  const stopsRows = await getAll(Tabs.DRIVER_STOP);
  const stops = stopsRows
    .filter(s => runIds.has(s.RUN_ID))
    .reduce((acc, s) => {
      const key = `${s.RUN_ID}|${s.STOP_ID}`;
      const prev = acc.get(key);
      const prevTs = prev ? new Date(prev.DONE_AT || prev.UPDATED_AT || prev.START_TS || 0).getTime() : -1;
      const curTs  = new Date(s.DONE_AT || s.UPDATED_AT || s.START_TS || 0).getTime();
      if (!prev || curTs >= prevTs) acc.set(key, s);
      return acc;
    }, new Map());

  return res.status(200).json({
    ok: true,
    items: runs.map(r => ({
      RUN_ID: r.RUN_ID, DRIVER_ID: r.DRIVER_ID, DATE: r.DATE, STATUS: r.STATUS,
      STOPS: [...stops.values()].filter(s => s.RUN_ID === r.RUN_ID)
    }))
  });
}

// ---- NEW: print/picking HTML (from routes/print/picking.js) ----
async function handlePrintPickingHtml(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");
  const shop = (req.query.shop || "").trim();
  const q = (req.query.q || "").toLowerCase();
  if (!shop) return res.status(400).send("Missing shop");

  const recent = await getAll(process.env.TAB_ITEMS || "TBL_ORDER_LINE_ITEM");
  const orderIds = [...new Set(recent.map(r => r.ORDER_ID))].slice(-50);

  const all = [];
  for (const id of orderIds) {
    const items = await getLatestItems(shop, id);
    all.push(...items);
  }

  const groups = new Map();
  for (const it of all) {
    const key = it.SKU?.trim() || `${it.TITLE} | ${it.VARIANT_TITLE || ""}`.trim();
    const needle = `${key} ${it.TITLE} ${it.VARIANT_TITLE || ""}`.toLowerCase();
    if (q && !needle.includes(q)) continue;

    const g = groups.get(key) || {
      KEY: key, SKU: it.SKU || "", TITLE: it.TITLE || "",
      VARIANT_TITLE: it.VARIANT_TITLE || "", IMAGE: it.IMAGE || "",
      TOTAL_QTY: 0, ORDERS: new Set()
    };
    g.TOTAL_QTY += Number(it.FULFILLABLE_QUANTITY ?? it.QUANTITY ?? 0);
    g.ORDERS.add(it.ORDER_ID);
    if (!g.IMAGE && it.IMAGE) g.IMAGE = it.IMAGE;
    groups.set(key, g);
  }

  const rows = [...groups.values()]
    .sort((a,b) => b.TOTAL_QTY - a.TOTAL_QTY)
    .map(g => ({ ...g, ORDERS: [...g.ORDERS] }));

  const title = `Picking List — ${esc(shop)} — ${new Date().toLocaleString()}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
    <title>${title}</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:16px;}
      .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
      .meta{color:#666;font-size:12px;}
      table{width:100%;border-collapse:collapse;}
      th,td{border:1px solid #e5e7eb;padding:8px;font-size:14px;vertical-align:top;}
      th{background:#f8fafc;text-transform:uppercase;font-size:12px;color:#475569;}
      .qty{font-weight:700;text-align:center;}
      .img{width:48px;height:48px;object-fit:cover;border-radius:6px}
      @media print{ .noprint{display:none} body{margin:0} }
    </style>
  </head><body>
    <div class="head"><h2 style="margin:0">Picking List</h2>
      <button class="noprint" onclick="window.print()">Print</button></div>
    <div class="meta">${esc(shop)} — ${new Date().toLocaleString()} — ${rows.length} items</div>
    <table><thead><tr><th>Image</th><th>SKU / Item</th><th>Variant</th><th>Orders</th><th class="qty">Total Qty</th></tr></thead>
    <tbody>
    ${rows.map(r=>`
      <tr>
        <td>${r.IMAGE?`<img class="img" src="${esc(r.IMAGE)}" />`:''}</td>
        <td>${esc(r.SKU || r.TITLE)}</td>
        <td>${esc(r.VARIANT_TITLE || '')}</td>
        <td>${r.ORDERS.map(id=>`#${esc(String(id))}`).join(', ')}</td>
        <td class="qty">${r.TOTAL_QTY}</td>
      </tr>`).join('')}
    </tbody></table>
  </body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
}

// ---- NEW: work/start, work/list, work/done (from routes/work/*) ----
async function handleWorkStart(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  const body = await readJsonBody(req);

  const { shopDomain, orderId, lineId, sku, title, variantTitle, qty, stage, assignee, notes } = body || {};
  if (!shopDomain || !orderId || !lineId || !stage) {
    return res.status(400).json({ ok:false, error:"Missing shopDomain/orderId/lineId/stage" });
    }

  const entry = {
    WORK_ID: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    SHOP_DOMAIN: shopDomain,
    ORDER_ID: String(orderId),
    LINE_ID: String(lineId),
    SKU: sku || "",
    TITLE: title || "",
    VARIANT_TITLE: variantTitle || "",
    QTY: Number(qty ?? 0),
    STAGE: String(stage),
    ASSIGNEE: assignee || "",
    START_TS: new Date().toISOString(),
    END_TS: "",
    STATUS: "active",
    NOTES: notes || ""
  };

  await createWorkEntry(entry);
  return res.status(200).json({ ok:true, workId: entry.WORK_ID });
}

async function handleWorkList(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  const stage = (req.query.stage || "").toLowerCase();
  const shop  = (req.query.shop  || "").toLowerCase();
  const date  = req.query.date ? new Date(req.query.date) : null;

  const all = await getAll(Tabs.WORK);
  const rows = all.filter(r => {
    if ((r.STATUS || "").toLowerCase() !== "active") return false;
    if (stage && (r.STAGE || "").toLowerCase() !== stage) return false;
    if (shop && (r.SHOP_DOMAIN || "").toLowerCase() !== shop) return false;
    if (date) {
      const t = new Date(r.START_TS || 0).getTime();
      const d0 = new Date(date); d0.setHours(0,0,0,0);
      const d1 = new Date(date); d1.setHours(23,59,59,999);
      if (t < d0.getTime() || t > d1.getTime()) return false;
    }
    return true;
  });

  rows.sort((a,b) => (a.START_TS < b.START_TS ? 1 : -1));
  return res.status(200).json({ ok:true, items: rows });
}

async function handleWorkDone(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  const body = await readJsonBody(req);
  const { workId } = body || {};
  if (!workId) return res.status(400).json({ ok:false, error:"Missing workId" });
  await markWorkDone(workId);
  return res.status(200).json({ ok:true });
}

// ---- Shopify webhook (moved in) ----
async function handleWebhookShopify(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  }

  const {
    SHOPIFY_WEBHOOK_SECRET, DEBUG_BYPASS_TOKEN, ALLOW_DEBUG_BYPASS = "false", SHOPIFY_ADMIN_TOKEN,
  } = process.env;

  const topic =
    req.headers["x-shopify-topic"] || req.headers["X-Shopify-Topic"] || "";
  const shopDomain =
    req.headers["x-shopify-shop-domain"] || req.headers["X-Shopify-Shop-Domain"] || "";
  const headerHmac =
    req.headers["x-shopify-hmac-sha256"] || req.headers["X-Shopify-Hmac-Sha256"] || "";

  let raw;
  try { raw = await getRawBody(req); }
  catch { return res.status(400).json({ ok:false, error:"Unable to read raw body" }); }

  const allowBypass =
    (ALLOW_DEBUG_BYPASS || "false").toLowerCase() === "true" &&
    DEBUG_BYPASS_TOKEN && req.headers["x-debug-bypass"] === DEBUG_BYPASS_TOKEN;

  let hmacOk = false;
  if (allowBypass) hmacOk = true;
  else {
    if (!SHOPIFY_WEBHOOK_SECRET) return res.status(500).json({ ok:false, error:"Missing SHOPIFY_WEBHOOK_SECRET" });
    hmacOk = verifyShopifyHmac(raw, SHOPIFY_WEBHOOK_SECRET, headerHmac);
  }
  if (!hmacOk) return res.status(401).json({ ok:false, error:"Invalid HMAC" });

  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); }
  catch { return res.status(400).json({ ok:false, error:"Invalid JSON" }); }

  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  let items = lineItems;
  try { items = await enrichLineItemImages(shopDomain, items, SHOPIFY_ADMIN_TOKEN); }
  catch (e) { console.error("enrichLineItemImages:", e?.message || e); }

  let action = "none", errMsg = "";
  try {
    const out = await upsertOrder(order);
    action = out?.action || "none";
    const batchTs = Date.now();
    if (Array.isArray(items) && items.length) await writeLineItems(items, batchTs);
  } catch (e) {
    errMsg = e?.message || String(e);
  }

  try {
    const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
    await logWebhook({
      TS: new Date().toISOString(),
      SHOP_DOMAIN: shopDomain,
      TOPIC: topic,
      ORDER_ID: order?.ORDER_ID ?? "",
      HASH: hash,
      RESULT: action,
      ERROR: errMsg,
    });
  } catch (e) {
    console.error("logWebhook error:", e?.message || e);
  }

  if (errMsg) return res.status(500).json({ ok:false, error:errMsg });
  return res.status(200).json({ ok:true, result:action });
}

// ---- main router ----
export default async function router(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  // Some runtimes don't populate req.query.route for catch-alls.
  // Fall back to parsing req.url.
  const segsFromQuery = Array.isArray(req.query.route) ? req.query.route : null;
  // ---- path detection (robust) ----
let path = "";
const p = req.query?.route;
if (Array.isArray(p)) {
  path = p.join("/").toLowerCase();
} else if (typeof p === "string") {
  path = p.toLowerCase();
} else {
  // Fallback when query param isn't populated by the runtime
  const urlPath = (req.url || "").split("?")[0];   // e.g. /api/orders
  // remove only the first /api prefix
  path = urlPath.replace(/^\/api(\/|$)/, "").toLowerCase(); // => "orders" or ""
}

}

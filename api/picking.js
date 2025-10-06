// pages/api/print/picking.js
import { getAll, Tabs } from "../lib/sheets.js";

// tiny helpers duplicated to keep this file standalone
const esc = (s = "") => String(s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
function setHttpCacheOk(res, seconds = 30) {
  res.setHeader("Cache-Control", `public, max-age=5, s-maxage=${seconds}, stale-while-revalidate=60`);
}

export const config = { api: { bodyParser: false }, runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const shop = (req.query.shop || "").toLowerCase().trim();
  const q    = (req.query.q || "").toLowerCase().trim();

  // --- same logic as your JSON picking-list handler ---
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

  const last = new Map(); // latest batch per (shop,order)
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

  setHttpCacheOk(res, 30);
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.status(200).send(html);
}

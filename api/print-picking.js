// api/print-picking.js
export const config = { api: { bodyParser: false } };

import { setCors } from "../lib/cors.js";
import { getLatestItems, getAll } from "../lib/sheets.js";

const esc = (s="") =>
  String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
           .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
           .replace(/'/g,"&#39;");

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  try {
    const shop = (req.query.shop || "").trim();
    const q = (req.query.q || "").toLowerCase();
    if (!shop) return res.status(400).send("Missing shop");

    const tabItems = process.env.TAB_ITEMS || "TBL_ORDER_LINE_ITEM";
    const recent = await getAll(tabItems);
    const orderIds = [...new Set(recent.map(r => r.ORDER_ID))].slice(-50);

    let all = [];
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
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
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
</style></head><body>
<div class="head"><h2 style="margin:0">Picking List</h2>
<button class="noprint" onclick="window.print()">Print</button></div>
<div class="meta">${esc(shop)} — ${new Date().toLocaleString()} — ${rows.length} items</div>
<table><thead><tr><th>Image</th><th>SKU / Item</th><th>Variant</th><th>Orders</th><th class="qty">Total Qty</th></tr></thead><tbody>
${rows.map(r=>`
<tr>
  <td>${r.IMAGE?`<img class="img" src="${esc(r.IMAGE)}" />`:''}</td>
  <td>${esc(r.SKU || r.TITLE)}</td>
  <td>${esc(r.VARIANT_TITLE || '')}</td>
  <td>${r.ORDERS.map(id=>`#${esc(String(id))}`).join(', ')}</td>
  <td class="qty">${r.TOTAL_QTY}</td>
</tr>`).join('')}
</tbody></table></body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
}

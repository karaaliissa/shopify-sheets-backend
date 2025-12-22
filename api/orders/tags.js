// // api/orders/tags.js
// import { setCors } from '../lib/cors.js';
// import { getAll, upsertOrder } from '../lib/sheets.js';
// export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

// // Small helper identical to your [...route].js version
// async function readJsonBody(req) {
//   const chunks = [];
//   for await (const c of req) chunks.push(c);
//   const s = Buffer.concat(chunks).toString('utf8') || '';
//   try { return JSON.parse(s); } catch {}
//   try { return Object.fromEntries(new URLSearchParams(s).entries()); } catch {}
//   return {};
// }
// export default async function handler(req, res) {
//   res.setHeader('x-handler', 'file:orders/tags.js');
//   setCors(req, res);
//   if (req.method === 'OPTIONS') return res.status(204).end();
//   if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

//   const body = await readJsonBody(req);
//   const shop   = String(body.shop || '').toLowerCase();
//   const orderId= String(body.orderId || '');
//   const action = String(body.action || 'add').toLowerCase(); // add | remove | set
//   const tag    = String(body.tag || '').trim();
//   const tagsIn = Array.isArray(body.tags) ? body.tags.map(s => String(s).trim()).filter(Boolean) : null;

//   if (!shop || !orderId) return res.status(400).json({ ok:false, error:'Missing shop or orderId' });
//   if (action !== 'set' && !tag) return res.status(400).json({ ok:false, error:'Missing tag' });

//   try {
//     // Read current from Sheets (fast) and compute nextTags
//     const all = await getAll(process.env.TAB_ORDERS || 'TBL_ORDER');
//     const row = all.find(r =>
//       String(r.SHOP_DOMAIN || '').toLowerCase() === shop &&
//       String(r.ORDER_ID || '') === orderId
//     );
//     const current = (row?.TAGS || '').split(',').map(s => s.trim()).filter(Boolean);

//     let next = current;
//     if (action === 'add') {
//       const has = current.map(t => t.toLowerCase()).includes(tag.toLowerCase());
//       if (!has) next = [...current, tag];
//     } else if (action === 'remove') {
//       next = current.filter(t => t.toLowerCase() !== tag.toLowerCase());
//     } else if (action === 'set') {
//       next = tagsIn || [];
//     }

//     // Upsert minimal row (don’t touch UPDATED_AT)
//     await upsertOrder({ SHOP_DOMAIN: shop, ORDER_ID: orderId, TAGS: next.join(', ') });

//     return res.status(200).json({ ok:true, tags: next });
//   } catch (e) {
//     return res.status(500).json({ ok:false, error: e?.message || String(e) });
//   }
// }



// api/orders/tags.js
import { setCors } from "../lib/cors.js";

export const config = { api: { bodyParser: false }, runtime: "nodejs" };

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8") || "";
  try { return JSON.parse(s); } catch {}
  try { return Object.fromEntries(new URLSearchParams(s).entries()); } catch {}
  return {};
}

export default async function handler(req, res) {
  res.setHeader("x-handler", "file:orders/tags.js");
  const preflight = setCors(req, res);
  if (preflight) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const body = await readJsonBody(req);
  const shop = String(body.shop || "").toLowerCase();
  const orderId = String(body.orderId || "");
  const action = String(body.action || "add").toLowerCase(); // add | remove | set
  const tag = String(body.tag || "").trim();
  const tagsIn = Array.isArray(body.tags)
    ? body.tags.map(s => String(s).trim()).filter(Boolean)
    : null;

  if (!shop || !orderId) return res.status(400).json({ ok: false, error: "Missing shop or orderId" });
  if (action !== "set" && !tag) return res.status(400).json({ ok: false, error: "Missing tag" });

  try {
    const { getOrders, updateOrderField } = await import("../lib/db.js");

    // verify exists + read current tags
    const rows = await getOrders({ shopDomain: shop });
    const row = rows.find(r =>
      String(r.SHOP_DOMAIN || "").toLowerCase() === shop &&
      String(r.ORDER_ID || "") === orderId
    );
    if (!row) return res.status(404).json({ ok: false, error: "Order not found" });

    const current = String(row.TAGS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    let next = current;

    if (action === "add") {
      const has = current.some(t => t.toLowerCase() === tag.toLowerCase());
      if (!has) next = [...current, tag];
    } else if (action === "remove") {
      next = current.filter(t => t.toLowerCase() !== tag.toLowerCase());
    } else if (action === "set") {
      next = tagsIn || [];
    } else {
      return res.status(400).json({ ok: false, error: "Bad action (add|remove|set)" });
    }

    await updateOrderField({
      shopDomain: shop,
      orderId,
      field: "tags",
      value: next.join(", "),
    });

    try {
      const { invalidateByTag } = await import("../lib/cache.js");
      invalidateByTag("orders");
    } catch {}

    return res.status(200).json({ ok: true, tags: next });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

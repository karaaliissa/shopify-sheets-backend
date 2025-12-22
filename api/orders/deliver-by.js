// // api/orders/deliver-by.js
// import { setCors } from '../lib/cors.js';

// export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

// // identical to the helper you already use
// async function readJsonBody(req) {
//   const chunks = [];
//   for await (const c of req) chunks.push(c);
//   const s = Buffer.concat(chunks).toString('utf8') || '';
//   try { return JSON.parse(s); } catch {}
//   try { return Object.fromEntries(new URLSearchParams(s).entries()); } catch {}
//   return {};
// }

// export default async function handler(req, res) {
//   res.setHeader('x-handler', 'file:orders/deliver-by.js');
//   const preflight = setCors(req, res);
//   if (preflight) return; // OPTIONS handled

//   if (req.method !== 'POST') {
//     res.setHeader('Allow', 'POST');
//     return res.status(405).json({ ok:false, error:'Method Not Allowed' });
//   }

//   const body = await readJsonBody(req);
//   const shop    = String(body.shop || '').toLowerCase();
//   const orderId = String(body.orderId || '');
//   let deliverBy = body.deliverBy === null ? null : String(body.deliverBy || '').trim() || null;

//   if (!shop || !orderId) {
//     return res.status(400).json({ ok:false, error:'Missing shop or orderId' });
//   }
//   if (deliverBy && !/^\d{4}-\d{2}-\d{2}$/.test(deliverBy)) {
//     return res.status(400).json({ ok:false, error:'Bad date format (YYYY-MM-DD)' });
//   }

//   try {
//     const { getAll, upsertOrder, upsertOrderField } = await import('../lib/sheets.js');
//     const all = await getAll(process.env.TAB_ORDERS || 'TBL_ORDER');
//     const row = all.find(r =>
//       String(r.SHOP_DOMAIN || '').toLowerCase() === shop &&
//       String(r.ORDER_ID || '') === orderId
//     );
//     if (!row) return res.status(404).json({ ok:false, error:'Order not found in sheet' });

//     if (typeof upsertOrderField === 'function') {
//       await upsertOrderField({ shopDomain: shop, orderId, field: 'DELIVER_BY', value: deliverBy ?? '' });
//     } else {
//       await upsertOrder({ SHOP_DOMAIN: shop, ORDER_ID: orderId, DELIVER_BY: deliverBy ?? '' });
//     }

//     // optional: clear in-memory caches if you use them
//     try {
//       const { invalidateByTag } = await import('../lib/cache.js');
//       invalidateByTag('orders');
//     } catch {}

//     return res.status(200).json({ ok:true, deliverBy });
//   } catch (e) {
//     return res.status(500).json({ ok:false, error: e?.message || String(e) });
//   }
// }



// api/orders/deliver-by.js
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
  res.setHeader("x-handler", "file:orders/deliver-by.js");
  const preflight = setCors(req, res);
  if (preflight) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const body = await readJsonBody(req);
  const shop = String(body.shop || "").toLowerCase();
  const orderId = String(body.orderId || "");
  let deliverBy = body.deliverBy === null ? null : String(body.deliverBy || "").trim() || null;

  if (!shop || !orderId) {
    return res.status(400).json({ ok: false, error: "Missing shop or orderId" });
  }
  if (deliverBy && !/^\d{4}-\d{2}-\d{2}$/.test(deliverBy)) {
    return res.status(400).json({ ok: false, error: "Bad date format (YYYY-MM-DD)" });
  }

  try {
    const { getOrders, updateOrderField } = await import("../lib/db.js");

    // verify order exists
    const rows = await getOrders({ shopDomain: shop });
    const row = rows.find(r =>
      String(r.SHOP_DOMAIN || "").toLowerCase() === shop &&
      String(r.ORDER_ID || "") === orderId
    );
    if (!row) return res.status(404).json({ ok: false, error: "Order not found" });

    // update only deliver_by
    await updateOrderField({
      shopDomain: shop,
      orderId,
      field: "deliver_by",
      value: deliverBy, // updateOrderField handles null / date conversion
    });

    // bust memory cache
    try {
      const { invalidateByTag } = await import("../lib/cache.js");
      invalidateByTag("orders");
    } catch {}

    return res.status(200).json({ ok: true, deliverBy });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

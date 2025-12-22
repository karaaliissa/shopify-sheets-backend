// // api/orders/note-local.js
// import { setCors } from '../lib/cors.js';
// export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

// async function readJsonBody(req) {
//   const chunks = [];
//   for await (const c of req) chunks.push(c);
//   const s = Buffer.concat(chunks).toString('utf8') || '';
//   try { return JSON.parse(s); } catch {}
//   try { return Object.fromEntries(new URLSearchParams(s).entries()); } catch {}
//   return {};
// }

// export default async function handler(req, res) {
//   res.setHeader('x-handler', 'file:orders/note-local.js');
//   const preflight = setCors(req, res);
//   if (preflight) return;

//   if (req.method !== 'POST') {
//     res.setHeader('Allow','POST'); return res.status(405).json({ ok:false, error:'Method Not Allowed' });
//   }
//   const body = await readJsonBody(req);
//   const shop = String(body.shop || '').toLowerCase();
//   const orderId = String(body.orderId || '');
//   const noteLocal = body.noteLocal === null ? null : String(body.noteLocal || '').trim() || null;

//   if (!shop || !orderId) return res.status(400).json({ ok:false, error:'Missing shop or orderId' });

//   try {
//     const { getAll, upsertOrderField } = await import('../lib/sheets.js');
//     const all = await getAll(process.env.TAB_ORDERS || 'TBL_ORDER');
//     const row = all.find(r => String(r.SHOP_DOMAIN || '').toLowerCase() === shop && String(r.ORDER_ID || '') === orderId);
//     if (!row) return res.status(404).json({ ok:false, error:'Order not found in sheet' });

//     if (typeof upsertOrderField === 'function') {
//       await upsertOrderField({ shopDomain: shop, orderId, field: 'NOTE_LOCAL', value: noteLocal ?? '' });
//     } else {
//       await upsertOrder({ SHOP_DOMAIN: shop, ORDER_ID: orderId, NOTE_LOCAL: noteLocal ?? '' });
//     }
//     try { const { invalidateByTag } = await import('../lib/cache.js'); invalidateByTag('orders'); } catch {}

//     return res.status(200).json({ ok:true, noteLocal });
//   } catch (e) {
//     return res.status(500).json({ ok:false, error: e?.message || String(e) });
//   }
// }


// api/orders/note-local.js
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
  res.setHeader("x-handler", "file:orders/note-local.js");
  const preflight = setCors(req, res);
  if (preflight) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const body = await readJsonBody(req);
  const shop = String(body.shop || "").toLowerCase();
  const orderId = String(body.orderId || "");
  const noteLocal = body.noteLocal === null ? null : String(body.noteLocal || "").trim() || null;

  if (!shop || !orderId) {
    return res.status(400).json({ ok: false, error: "Missing shop or orderId" });
  }

  try {
    const { getOrders, updateOrderField } = await import("../lib/db.js");

    // verify exists
    const rows = await getOrders({ shopDomain: shop });
    const row = rows.find(r =>
      String(r.SHOP_DOMAIN || "").toLowerCase() === shop &&
      String(r.ORDER_ID || "") === orderId
    );
    if (!row) return res.status(404).json({ ok: false, error: "Order not found" });

    await updateOrderField({
      shopDomain: shop,
      orderId,
      field: "note_local",
      value: noteLocal,
    });

    try {
      const { invalidateByTag } = await import("../lib/cache.js");
      invalidateByTag("orders");
    } catch {}

    return res.status(200).json({ ok: true, noteLocal });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// // api/orders/summary.js
// import { setCors } from '../lib/cors.js';

// export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

// export default async function handler(req, res) {
//   res.setHeader('x-handler', 'file:orders/summary.js');

//   // CORS (handles OPTIONS)
//   const preflight = setCors(req, res);
//   if (preflight) return;

//   if (req.method !== 'GET') {
//     res.setHeader('Allow', 'GET');
//     return res.status(405).json({ ok:false, error:'Method Not Allowed' });
//   }

//   try {
//     // const { getAll, Tabs } = await import('../lib/sheets.js');
//     const { getOrders } = await import('../lib/db.js');
//     // const all = await getAll(Tabs.ORDERS);
//     const all = await getOrders({ shopDomain: shop || undefined });

//     const shop = String(req.query.shop || '').toLowerCase();
//     const rows = shop
//       ? all.filter(r => String(r.SHOP_DOMAIN || '').toLowerCase() === shop)
//       : all;

//     // same canonical status as the UI
//     const statusOf = (r) => {
//       const tags = (r.TAGS || '').toLowerCase();
//       if (tags.includes('complete'))   return 'complete';
//       if (tags.includes('cancel'))     return 'cancel';
//       if (tags.includes('shipped'))    return 'shipped';
//       if (tags.includes('processing')) return 'processing';

//       const f = (r.FULFILLMENT_STATUS || '').toLowerCase();
//       if (!f || f === 'open' || f === 'unfulfilled') return 'pending';
//       return 'pending';
//     };
//     const isExpress = (r) => /\bexpress\b/i.test(String(r.SHIPPING_METHOD || ''));

//     const out = {
//       ok: true,
//       total: rows.length,
//       pending: 0, processing: 0, shipped: 0, complete: 0, cancel: 0,
//       expressPending: 0, expressProcessing: 0, expressShipped: 0, expressComplete: 0, expressCancel: 0
//     };

//     for (const r of rows) {
//       const s = statusOf(r);
//       out[s] += 1;
//       if (isExpress(r)) {
//         if (s === 'pending')      out.expressPending++;
//         else if (s === 'processing') out.expressProcessing++;
//         else if (s === 'shipped') out.expressShipped++;
//         else if (s === 'complete')out.expressComplete++;
//         else if (s === 'cancel')  out.expressCancel++;
//       }
//     }

//     // short public cache so dashboards stay snappy
//     res.setHeader('Cache-Control', 'public, max-age=5, s-maxage=30, stale-while-revalidate=60');
//     return res.status(200).json(out);
//   } catch (e) {
//     return res.status(500).json({ ok:false, error: e?.message || String(e) });
//   }
// }



// api/orders/summary.js
import { setCors } from "../lib/cors.js";

export const config = { api: { bodyParser: false }, runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("x-handler", "file:orders/summary.js");

  if (setCors(req, res)) return; // handles OPTIONS

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const { getOrders } = await import("../lib/db.js");
    const shop = String(req.query.shop || "").toLowerCase();

    // DB already returns UPPERCASE keys (legacy)
    const rows = await getOrders({ shopDomain: shop || undefined });

    const statusOf = (r) => {
      const tags = String(r.TAGS || "").toLowerCase();
      if (tags.includes("complete")) return "complete";
      if (tags.includes("cancel")) return "cancel";
      if (tags.includes("shipped")) return "shipped";
      if (tags.includes("processing")) return "processing";

      const f = String(r.FULFILLMENT_STATUS || "").toLowerCase();
      if (!f || f === "open" || f === "unfulfilled") return "pending";
      return "pending";
    };

    const isExpress = (r) =>
      /\bexpress\b/i.test(String(r.SHIPPING_METHOD || ""));

    const out = {
      ok: true,
      total: rows.length,
      pending: 0,
      processing: 0,
      shipped: 0,
      complete: 0,
      cancel: 0,
      expressPending: 0,
      expressProcessing: 0,
      expressShipped: 0,
      expressComplete: 0,
      expressCancel: 0,
    };

    for (const r of rows) {
      const s = statusOf(r);
      out[s] += 1;

      if (isExpress(r)) {
        if (s === "pending") out.expressPending++;
        else if (s === "processing") out.expressProcessing++;
        else if (s === "shipped") out.expressShipped++;
        else if (s === "complete") out.expressComplete++;
        else if (s === "cancel") out.expressCancel++;
      }
    }

    res.setHeader(
      "Cache-Control",
      "public, max-age=5, s-maxage=30, stale-while-revalidate=60"
    );
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

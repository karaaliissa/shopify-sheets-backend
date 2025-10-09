// // api/orders/tag.js
// import { setCors } from '../lib/cors.js';
// import { getOrder, setOrderTags, normalizeOrderPayload } from '../lib/shopify.js';
// import { upsertOrder } from '../lib/sheets.js';
// import { invalidateByTag } from '../lib/cache.js';

// export const config = { api: { bodyParser: true }, runtime: 'nodejs' };

// export default async function handler(req, res) {
//   setCors(req, res);
//   if (req.method === 'OPTIONS') return res.status(204).end();
//   if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

//   const { SHOPIFY_ADMIN_TOKEN } = process.env;
//   if (!SHOPIFY_ADMIN_TOKEN) return res.status(500).json({ ok:false, error:'Missing SHOPIFY_ADMIN_TOKEN' });

//   try {
//     const { shop, orderId, action = 'add', tag = '', tags: tagsIn } = req.body || {};
//     if (!shop || !orderId) return res.status(400).json({ ok:false, error:'Missing shop or orderId' });
//     if (action !== 'set' && !tag) return res.status(400).json({ ok:false, error:'Missing tag' });

//     const cur = await getOrder(String(shop).toLowerCase(), String(orderId), SHOPIFY_ADMIN_TOKEN);
//     const currentTags = (cur?.tags || '').split(',').map(s => s.trim()).filter(Boolean);

//     let nextTags = currentTags;
//     if (action === 'add') {
//       if (!currentTags.map(t=>t.toLowerCase()).includes(tag.toLowerCase())) nextTags = [...currentTags, tag];
//     } else if (action === 'remove') {
//       nextTags = currentTags.filter(t => t.toLowerCase() !== tag.toLowerCase());
//     } else if (action === 'set') {
//       nextTags = Array.isArray(tagsIn) ? tagsIn.map(s => String(s).trim()).filter(Boolean) : [];
//     }

//     const updated = await setOrderTags(String(shop).toLowerCase(), String(orderId), nextTags, SHOPIFY_ADMIN_TOKEN);

//     const { order } = normalizeOrderPayload(updated, String(shop).toLowerCase());
//     await upsertOrder(order);
//     try { invalidateByTag('orders'); } catch {}

//     return res.status(200).json({ ok:true, tags: nextTags });
//   } catch (e) {
//     return res.status(500).json({ ok:false, error: e?.message || String(e) });
//   }
// }

// /api/orders/tag.js
import { setCors } from '../lib/cors.js';
import getRawBody from 'raw-body';
import { getAll, upsertOrder } from '../lib/sheets.js';

export const config = { api: { bodyParser: false, runtime: 'nodejs' } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
//   if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });
if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });
req.query = req.query || {}; req.query.route = 'orders/tag';


  const bodyRaw = await getRawBody(req);
  let body = {};
  try { body = JSON.parse(bodyRaw.toString('utf8') || '{}'); } catch {}
  const shop   = String(body.shop || '').toLowerCase();
  const orderId= String(body.orderId || '');
  const action = String(body.action || 'add').toLowerCase();
  const tag    = String(body.tag || '').trim();
  const tagsIn = Array.isArray(body.tags) ? body.tags.map(s=>String(s).trim()).filter(Boolean) : null;

  if (!shop || !orderId) return res.status(400).json({ ok:false, error:'Missing shop or orderId' });
  if (action !== 'set' && !tag) return res.status(400).json({ ok:false, error:'Missing tag' });

  // read current tags from Sheets (cheap & instant)
  const all = await getAll(process.env.TAB_ORDERS || 'TBL_ORDER');
  const cur = all.find(r => String(r.SHOP_DOMAIN || '').toLowerCase() === shop && String(r.ORDER_ID || '') === orderId);
  const current = (cur?.TAGS || '').split(',').map(s=>s.trim()).filter(Boolean);

  let next = current;
  if (action === 'add') {
    if (!current.map(t=>t.toLowerCase()).includes(tag.toLowerCase())) next = [...current, tag];
  } else if (action === 'remove') {
    next = current.filter(t => t.toLowerCase() !== tag.toLowerCase());
  } else if (action === 'set') {
    next = tagsIn || [];
  }

  await upsertOrder({ SHOP_DOMAIN: shop, ORDER_ID: orderId, TAGS: next.join(', ') });
//   return res.status(200).json({ ok:true, tags: next });
return router(req, res); // lets your existing code path run
}

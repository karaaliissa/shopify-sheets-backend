// api/orders/tag.js
import { setCors } from '../lib/cors.js';
import { getAll, upsertOrder } from '../lib/sheets.js';

export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

// Small helper identical to your [...route].js version
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('x-handler', 'file:orders/tag.js');
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  const body = await readJsonBody(req);
  const shop   = String(body.shop || '').toLowerCase();
  const orderId= String(body.orderId || '');
  const action = String(body.action || 'add').toLowerCase(); // add | remove | set
  const tag    = String(body.tag || '').trim();
  const tagsIn = Array.isArray(body.tags) ? body.tags.map(s => String(s).trim()).filter(Boolean) : null;

  if (!shop || !orderId) return res.status(400).json({ ok:false, error:'Missing shop or orderId' });
  if (action !== 'set' && !tag) return res.status(400).json({ ok:false, error:'Missing tag' });

  try {
    // Read current from Sheets (fast) and compute nextTags
    const all = await getAll(process.env.TAB_ORDERS || 'TBL_ORDER');
    const row = all.find(r =>
      String(r.SHOP_DOMAIN || '').toLowerCase() === shop &&
      String(r.ORDER_ID || '') === orderId
    );
    const current = (row?.TAGS || '').split(',').map(s => s.trim()).filter(Boolean);

    let next = current;
    if (action === 'add') {
      const has = current.map(t => t.toLowerCase()).includes(tag.toLowerCase());
      if (!has) next = [...current, tag];
    } else if (action === 'remove') {
      next = current.filter(t => t.toLowerCase() !== tag.toLowerCase());
    } else if (action === 'set') {
      next = tagsIn || [];
    }

    // Upsert minimal row (don’t touch UPDATED_AT)
    await upsertOrder({ SHOP_DOMAIN: shop, ORDER_ID: orderId, TAGS: next.join(', ') });

    return res.status(200).json({ ok:true, tags: next });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}

// api/orders/page.js
import { setCors } from '../lib/cors.js';

export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

function enc(n){ return Buffer.from(String(n)).toString('base64'); }
function dec(c){
  try { return Number(Buffer.from(String(c || ''), 'base64').toString('utf8')) || 0; }
  catch { return 0; }
}

export default async function handler(req, res) {
  res.setHeader('x-handler', 'file:orders/page.js');
  if (setCors(req, res)) return;              // handles OPTIONS and sets ACAO
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  }

  const { getAll, Tabs } = await import('../lib/sheets.js');

  const shop   = String(req.query.shop || '').toLowerCase();
  const limit  = Math.min(Number(req.query.limit || 25), 100);
  const offset = dec(String(req.query.cursor || ''));

  let rows = await getAll(Tabs.ORDERS);
  if (shop) rows = rows.filter(r => String(r.SHOP_DOMAIN || '').toLowerCase() === shop);
  rows.sort((a,b) => (a.CREATED_AT < b.CREATED_AT ? 1 : -1));

  const total = rows.length;
  const slice = rows.slice(offset, offset + limit);
  const nextCursor = offset + limit < total ? enc(offset + limit) : null;

  res.setHeader('Cache-Control', 'public, max-age=5, s-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({ ok:true, items: slice, nextCursor, total });
}
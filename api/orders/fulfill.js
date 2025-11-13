// api/orders/fulfill.js
import { setCors } from '../lib/cors.js';

export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

// same helper style as your note-local.js
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8') || '';

  // try JSON first
  try { return JSON.parse(s); } catch {}

  // then x-www-form-urlencoded
  try { return Object.fromEntries(new URLSearchParams(s).entries()); } catch {}

  return {};
}

export default async function handler(req, res) {
  // just for debugging in headers, same style as your other files
  res.setHeader('x-handler', 'file:orders/fulfill.js');

  const preflight = setCors(req, res);
  if (preflight) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res
      .status(405)
      .json({ ok: false, error: 'Method Not Allowed' });
  }

  const body = await readJsonBody(req);
  const shop    = String(body.shop || '').toLowerCase();
  const orderId = String(body.orderId || '');
  const token   = process.env.SHOPIFY_ADMIN_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';

  if (!shop || !orderId) {
    return res
      .status(400)
      .json({ ok: false, error: 'Missing shop or orderId' });
  }
  if (!token) {
    return res
      .status(500)
      .json({ ok: false, error: 'Missing SHOPIFY_ADMIN_TOKEN' });
  }

  try {
    // 1) Load order from Shopify
    const baseUrl = `https://${shop}/admin/api/${apiVersion}`;
    const orderRes = await fetch(`${baseUrl}/orders/${orderId}.json`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    if (!orderRes.ok) {
      const t = await orderRes.text();
      console.error('fetch order failed:', orderRes.status, t);
      return res
        .status(502)
        .json({ ok: false, error: `Failed to fetch order from Shopify (${orderRes.status})` });
    }

    const orderJson = await orderRes.json();
    const order = orderJson?.order;
    if (!order) {
      return res
        .status(404)
        .json({ ok: false, error: 'Order not found in Shopify' });
    }

    // 2) Build line items (fulfillable quantities only)
    const lineItems = (order.line_items || [])
      .map(li => ({
        id: li.id,
        quantity: li.fulfillable_quantity ?? li.quantity ?? 0
      }))
      .filter(li => li.quantity > 0);

    if (!lineItems.length) {
      // nothing to fulfill is not an error
      return res
        .status(200)
        .json({ ok: true, note: 'Nothing to fulfill (no fulfillable_quantity)' });
    }

    // 3) Choose location_id
    const envLoc   = process.env.SHOPIFY_LOCATION_ID ? Number(process.env.SHOPIFY_LOCATION_ID) : null;
    const orderLoc = order.location_id || (order.fulfillments?.[0]?.location_id) || null;
    const locationId = envLoc || orderLoc;

    if (!locationId) {
      return res
        .status(500)
        .json({ ok: false, error: 'No location_id for fulfillment (set SHOPIFY_LOCATION_ID or ensure order has one)' });
    }

    // 4) Create fulfillment (all items in one shot)
    const fulfillRes = await fetch(`${baseUrl}/fulfillments.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fulfillment: {
          location_id: locationId,
          notify_customer: false,
          line_items: lineItems
        }
      })
    });

    if (!fulfillRes.ok) {
      const t = await fulfillRes.text();
      console.error('fulfill failed:', fulfillRes.status, t);
      return res
        .status(502)
        .json({ ok: false, error: `Failed to create fulfillment (${fulfillRes.status})` });
    }

    const payload = await fulfillRes.json();
    return res
      .status(200)
      .json({ ok: true, fulfillment: payload?.fulfillment || payload });

  } catch (e) {
    console.error('handle fulfill error:', e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || String(e) });
  }
}

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
import { setCors } from '../lib/cors.js';

export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

// ===== shared helper to read body =====
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8') || '';

  // JSON
  try { return JSON.parse(s); } catch {}

  // x-www-form-urlencoded
  try { return Object.fromEntries(new URLSearchParams(s).entries()); } catch {}

  return {};
}

// ===== NOTE-LOCAL LOGIC (old behavior) =====
async function handleNoteLocal(body, res) {
  const shop = String(body.shop || '').toLowerCase();
  const orderId = String(body.orderId || '');
  const noteLocal = body.noteLocal === null
    ? null
    : String(body.noteLocal || '').trim() || null;

  if (!shop || !orderId) {
    return res.status(400).json({ ok: false, error: 'Missing shop or orderId' });
  }

  try {
    const { getAll, upsertOrderField, upsertOrder } = await import('../lib/sheets.js');

    const all = await getAll(process.env.TAB_ORDERS || 'TBL_ORDER');
    const row = all.find(
      r =>
        String(r.SHOP_DOMAIN || '').toLowerCase() === shop &&
        String(r.ORDER_ID || '') === orderId
    );

    if (!row) {
      return res.status(404).json({ ok: false, error: 'Order not found in sheet' });
    }

    if (typeof upsertOrderField === 'function') {
      await upsertOrderField({
        shopDomain: shop,
        orderId,
        field: 'NOTE_LOCAL',
        value: noteLocal ?? ''
      });
    } else if (typeof upsertOrder === 'function') {
      await upsertOrder({
        SHOP_DOMAIN: shop,
        ORDER_ID: orderId,
        NOTE_LOCAL: noteLocal ?? ''
      });
    }

    try {
      const { invalidateByTag } = await import('../lib/cache.js');
      invalidateByTag('orders');
    } catch {}

    return res.status(200).json({ ok: true, noteLocal });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// ===== FULFILL LOGIC (Shopify fulfillment) =====
async function handleFulfill(body, res) {
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
    const baseUrl = `https://${shop}/admin/api/${apiVersion}`;

    // 1) Load order
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

    // 2) Build fulfillable line items
    const lineItems = (order.line_items || [])
      .map(li => ({
        id: li.id,
        quantity: li.fulfillable_quantity ?? li.quantity ?? 0
      }))
      .filter(li => li.quantity > 0);

    if (!lineItems.length) {
      return res
        .status(200)
        .json({ ok: true, note: 'Nothing to fulfill (no fulfillable_quantity)' });
    }

    // 3) Choose location_id
    let envLoc   = process.env.SHOPIFY_LOCATION_ID ? Number(process.env.SHOPIFY_LOCATION_ID) : null;
    let orderLoc = order.location_id || (order.fulfillments?.[0]?.location_id) || null;
    let locationId = envLoc || orderLoc;

    // 🔥 NEW: if still no locationId, fetch locations from Shopify and pick one
    if (!locationId) {
      const locRes = await fetch(`${baseUrl}/locations.json`, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      if (!locRes.ok) {
        const t = await locRes.text();
        console.error('locations fetch failed:', locRes.status, t);
        return res
          .status(502)
          .json({ ok: false, error: `Failed to fetch locations from Shopify (${locRes.status})` });
      }

      const locJson = await locRes.json();
      const locations = locJson?.locations || [];

      // Prefer an active / non-deactivated location
      const chosen =
        locations.find(l => !l.deactivated_at) ||
        locations[0];

      if (chosen) {
        locationId = chosen.id;
        console.log('Using auto-detected location_id:', locationId);
      }
    }

    if (!locationId) {
      return res
        .status(500)
        .json({ ok: false, error: 'No location_id for fulfillment (even after locations lookup)' });
    }

    // 4) Create fulfillment
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


// ===== single handler that routes to one of the two =====
export default async function handler(req, res) {
  res.setHeader('x-handler', 'file:orders/note-local+fulfill.js');

  const preflight = setCors(req, res);
  if (preflight) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const body = await readJsonBody(req);

  // decide which behavior:
  // - if body.action = 'fulfill' or body.fulfill = '1'/'true' => fulfillment
  // - otherwise => note-local (old behavior)
  const action = String(body.action || body.mode || '').toLowerCase();
  const isFulfill =
    action === 'fulfill' ||
    String(body.fulfill || '').toLowerCase() === '1' ||
    String(body.fulfill || '').toLowerCase() === 'true';

  if (isFulfill) {
    return handleFulfill(body, res);
  } else {
    return handleNoteLocal(body, res);
  }
}

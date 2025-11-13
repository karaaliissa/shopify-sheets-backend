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
  const shop       = String(body.shop || '').toLowerCase();
  const orderId    = String(body.orderId || '');
  const token      = process.env.SHOPIFY_ADMIN_TOKEN;
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

    // 1) Get fulfillment orders for this order
    const foRes = await fetch(
      `${baseUrl}/orders/${orderId}/fulfillment_orders.json`,
      {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!foRes.ok) {
      const text = await foRes.text();
      console.error('fulfillment_orders fetch failed:', foRes.status, text);
      let msg = `Failed to fetch fulfillment orders (${foRes.status})`;
      try {
        const j = JSON.parse(text);
        if (j?.errors) msg += ' - ' + JSON.stringify(j.errors);
      } catch {}
      return res.status(502).json({ ok: false, error: msg });
    }

    const foJson = await foRes.json();
    const fulfillmentOrders = foJson?.fulfillment_orders || [];

    // 2) Build line_items_by_fulfillment_order from remaining quantities
    const lineItemsByFO = fulfillmentOrders
      .map((fo) => {
        const items = (fo.line_items || [])
          .map((li) => ({
            id: li.id,
            // use remaining_quantity when available
            quantity:
              li.remaining_quantity ??
              li.unfulfilled_quantity ??
              li.quantity ??
              0,
          }))
          .filter((li) => li.quantity > 0);

        if (!items.length) return null;
        return {
          fulfillment_order_id: fo.id,
          fulfillment_order_line_items: items,
        };
      })
      .filter(Boolean);

    if (!lineItemsByFO.length) {
      return res.status(200).json({
        ok: true,
        note: 'Nothing to fulfill (no remaining_quantity on any fulfillment order)',
      });
    }

    // 3) Create fulfillment using the new API shape
    const fulfillRes = await fetch(`${baseUrl}/fulfillments.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fulfillment: {
          notify_customer: false,
          line_items_by_fulfillment_order: lineItemsByFO,
        },
      }),
    });

    if (!fulfillRes.ok) {
      const text = await fulfillRes.text();
      console.error('fulfill failed:', fulfillRes.status, text);
      let msg = `Failed to create fulfillment (${fulfillRes.status})`;
      try {
        const j = JSON.parse(text);
        if (j?.errors) msg += ' - ' + JSON.stringify(j.errors);
      } catch {}
      return res.status(502).json({ ok: false, error: msg });
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

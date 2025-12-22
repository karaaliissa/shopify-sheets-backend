// server.js
import dotenv from "dotenv";
dotenv.config();
import http from 'http';

// Catch-all router (for legacy routes like /api/orders, /api/items, /export/shipday, /picking-list, etc.)
import mainCatchAll from './api/[[...route]].js';

// Dedicated route handlers
import ordersSummary from './api/orders/summary.js';
import ordersPage from './api/orders/page.js';
import ordersDeliverBy from './api/orders/deliver-by.js';
import ordersNoteLocal from './api/orders/note-local.js';
import ordersTags from './api/orders/tags.js';

// Webhook handler
import webhookHandler from './api/webhooks/shopify.js';

// ----- Helpers -------------------------------------------------------------

function enhanceRes(res) {
  // Express-like .status()
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };

  // Express-like .json()
  res.json = function (obj) {
    if (!this.headersSent) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    this.end(JSON.stringify(obj));
    return this;
  };

  return res;
}

// Parse query string like Vercel does → req.query = { ... }
function attachQuery(req) {
  try {
    const host = req.headers.host || 'local';
    const url = new URL(req.url || '/', `http://${host}`);
    req.query = Object.fromEntries(url.searchParams.entries());
  } catch {
    req.query = {};
  }
}

// ----- HTTP server ---------------------------------------------------------

const server = http.createServer((req, res) => {
  const r = enhanceRes(res);
  attachQuery(req);

  const url = req.url || '';

  // 1) Shopify webhook
  if (url.startsWith('/api/webhooks/shopify')) {
    webhookHandler(req, r).catch(err => {
      console.error('webhook error', err);
      if (!r.headersSent) {
        r.statusCode = 500;
        r.end('Internal Server Error');
      }
    });
    return;
  }

  // 2) Explicit file routes (mirror Next/Vercel routing)
  if (url.startsWith('/api/orders/summary')) {
    ordersSummary(req, r).catch?.(err => {
      console.error('orders/summary error', err);
      if (!r.headersSent) r.status(500).json({ ok: false, error: String(err?.message || err) });
    });
    return;
  }

  if (url.startsWith('/api/orders/page')) {
    ordersPage(req, r).catch?.(err => {
      console.error('orders/page error', err);
      if (!r.headersSent) r.status(500).json({ ok: false, error: String(err?.message || err) });
    });
    return;
  }

  if (url.startsWith('/api/orders/deliver-by')) {
    ordersDeliverBy(req, r).catch?.(err => {
      console.error('orders/deliver-by error', err);
      if (!r.headersSent) r.status(500).json({ ok: false, error: String(err?.message || err) });
    });
    return;
  }

  if (url.startsWith('/api/orders/note-local')) {
    ordersNoteLocal(req, r).catch?.(err => {
      console.error('orders/note-local error', err);
      if (!r.headersSent) r.status(500).json({ ok: false, error: String(err?.message || err) });
    });
    return;
  }

  if (url.startsWith('/api/orders/tags')) {
    ordersTags(req, r).catch?.(err => {
      console.error('orders/tags error', err);
      if (!r.headersSent) r.status(500).json({ ok: false, error: String(err?.message || err) });
    });
    return;
  }

  // 3) Everything else under /api/... goes to the catch-all router
  if (url.startsWith('/api/')) {
    mainCatchAll(req, r).catch(err => {
      console.error('catch-all route error', err);
      if (!r.headersSent) {
        r.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    });
    return;
  }

  // 4) Health + root
  if (url === '/' || url === '/health') {
    r.statusCode = 200;
    return r.end('OK');
  }

  // 5) Fallback 404
  r.statusCode = 404;
  r.setHeader('Content-Type', 'text/plain; charset=utf-8');
  r.end('Not found');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('Backend listening on port', port);
});
console.log('DB:', process.env.DATABASE_URL ? 'OK' : 'MISSING');
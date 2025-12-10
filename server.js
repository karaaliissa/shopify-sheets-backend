// server.js
import http from 'http';
import main from './api/[[...route]].js';           // <-- keep double brackets
import webhookHandler from './api/webhooks/shopify.js';

// Add Express-like helpers to Node's ServerResponse
function enhanceRes(res) {
  res.status = function (code) {
    this.statusCode = code;
    return this; // allow chaining .json()
  };

  res.json = function (obj) {
    if (!this.headersSent) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    this.end(JSON.stringify(obj));
    return this;
  };

  return res;
}

const server = http.createServer((req, res) => {
  const r = enhanceRes(res);

  // Shopify webhook
  if (req.url.startsWith('/api/webhooks/shopify')) {
    // handler is async; we just fire and forget
    webhookHandler(req, r).catch(err => {
      console.error('webhook error', err);
      if (!r.headersSent) {
        r.statusCode = 500;
        r.end('Internal Server Error');
      }
    });
    return;
  }

  // All other /api/... handled by the catch-all router
  if (req.url.startsWith('/api/')) {
    main(req, r).catch(err => {
      console.error('route error', err);
      if (!r.headersSent) {
        r.statusCode = 500;
        r.end('Internal Server Error');
      }
    });
    return;
  }

  // Health check / root
  if (req.url === '/' || req.url === '/health') {
    r.statusCode = 200;
    return r.end('OK');
  }

  // Fallback
  r.statusCode = 404;
  r.setHeader('Content-Type', 'text/plain; charset=utf-8');
  r.end('Not found');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('Backend listening on port', port);
});

// server.mjs
import http from 'http';
import main from './api/[...route].js';
import webhookHandler from './api/webhooks/shopify.js';

const server = http.createServer((req, res) => {
  // Webhook endpoint (Shopify admin → this URL)
  if (req.url.startsWith('/api/webhooks/shopify')) {
    return webhookHandler(req, res);
  }

  // All other /api/... go through your catch-all router
  if (req.url.startsWith('/api/')) {
    return main(req, res);
  }

  // Optional: basic health check
  if (req.url === '/' || req.url === '/health') {
    res.statusCode = 200;
    return res.end('OK');
  }

  res.statusCode = 404;
  res.end('Not found');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('Backend listening on port', port);
});

// lib/cors.js
const ALLOWED_LIST = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// NOTE: origin strings must match exactly, e.g. "http://localhost:4200" (no trailing slash)
export function setCors(req, res) {
  const origin = req.headers.origin || "";

  if (ALLOWED_LIST.includes(origin)) {
    // reflect the exact allowed origin
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");

  // methods you support
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  // allow whatever the browser asked for, or fall back to common headers
  const reqHeaders =
    req.headers["access-control-request-headers"] ||
    "Content-Type, Authorization, X-Requested-With, X-XSRF-TOKEN";
  res.setHeader("Access-Control-Allow-Headers", reqHeaders);

  // cache preflight
  res.setHeader("Access-Control-Max-Age", "86400");
}

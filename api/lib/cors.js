// /api/lib/cors.js
const ALLOWED_LIST = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ALLOW_ALL = (process.env.ALLOW_ALL_ORIGINS || "false").toLowerCase() === "true";
export function setCors(req, res) {
  const reqHeaders =
    req.headers['access-control-request-headers'] ||
    'Content-Type, Authorization, X-Requested-With, X-XSRF-TOKEN';

  // ALWAYS send CORS (no env gating)
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', reqHeaders);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Access-Control-Max-Age', '86400');
}
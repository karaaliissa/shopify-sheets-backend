// // /api/lib/cors.js
// const ALLOWED_LIST = (process.env.ALLOWED_ORIGINS || "")
//   .split(",")
//   .map(s => s.trim())
//   .filter(Boolean);

// const ALLOW_ALL = (process.env.ALLOW_ALL_ORIGINS || "false").toLowerCase() === "true";
// export function setCors(req, res) {
//   const reqHeaders =
//     req.headers['access-control-request-headers'] ||
//     'Content-Type, Authorization, X-Requested-With, X-XSRF-TOKEN';

//   // ALWAYS send CORS (no env gating)
//   res.setHeader('Vary', 'Origin');
//   res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
//   res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
//   res.setHeader('Access-Control-Allow-Headers', reqHeaders);
//   res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
//   res.setHeader('Access-Control-Max-Age', '86400');
// }
// api/lib/cors.js
export function setCors(req, res) {
  const origin = req.headers.origin || '*';

  // Always set CORS headers
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  // If you don't need cookies, you can set this to 'false' or remove it.
  // Leaving it 'true' is fine; just be aware '*' cannot be used together with credentials.
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Preflight: answer here and stop.
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true; // handled
  }
  return false; // not handled (continue to route)
}
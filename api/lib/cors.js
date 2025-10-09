// /api/lib/cors.js
const ALLOWED_LIST = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ALLOW_ALL = (process.env.ALLOW_ALL_ORIGINS || "false").toLowerCase() === "true";

// origin strings must match exactly (no trailing slash)
// export function setCors(req, res) {
//   const origin = req.headers.origin || "";

//   if (ALLOW_ALL) {
//     // reflect any origin so credentials still work
//     res.setHeader("Access-Control-Allow-Origin", origin || "*");
//   } else if (ALLOWED_LIST.length > 0) {
//     if (ALLOWED_LIST.includes(origin)) {
//       res.setHeader("Access-Control-Allow-Origin", origin);
//     }
//   } else {
//     // no config provided → be permissive for simple cases
//     res.setHeader("Access-Control-Allow-Origin", origin || "*");
//   }

//   res.setHeader("Vary", "Origin");
//   res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

//   const reqHeaders =
//     req.headers["access-control-request-headers"] ||
//     "Content-Type, Authorization, X-Requested-With, X-XSRF-TOKEN";
//   res.setHeader("Access-Control-Allow-Headers", reqHeaders);

//   // Let the browser read filenames on downloads
//   res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

//   res.setHeader("Access-Control-Max-Age", "86400");
// }
export function setCors(req, res) {
  const origin = req.headers.origin || '*';
  const allowAll = (process.env.ALLOW_ALL_ORIGINS || 'false').toLowerCase() === 'true';
  const list = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const allowed = allowAll ? origin : (list.includes(origin) ? origin : '');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', allowed || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ||
      'Content-Type, Authorization, X-Requested-With, X-XSRF-TOKEN'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Access-Control-Max-Age', '86400');
}
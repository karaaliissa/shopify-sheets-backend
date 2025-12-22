// api/lib/cors.js
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export function setCors(req, res) {
  const origin = req.headers.origin;

  // إذا في Origin حقيقي → حطّه وخلّي credentials true
  if (origin) {
    const ok = ALLOWED.length === 0 || ALLOWED.includes(origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Origin", ok ? origin : origin); // same origin, but you can block if you want
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    // إذا ما في origin (curl/postman) → خليه * وخلّي credentials false أو شيلها
    res.setHeader("Access-Control-Allow-Origin", "*");
    // no credentials
  }

  const reqHeaders =
    req.headers["access-control-request-headers"] ||
    "Content-Type, Authorization, X-Requested-With";

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", reqHeaders);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

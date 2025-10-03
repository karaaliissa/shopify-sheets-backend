// ONE serverless function for ALL /api/work/* routes
export const config = { api: { bodyParser: false } };

import { setCors } from "../../lib/cors.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  // slug is an array, e.g. /api/work/picking-list -> ["picking-list"]
  const slug = (req.query.slug || []);
  const action = (slug[0] || "").toLowerCase();

  try {
    // load the real handler from routes/work/<action>.js
    const mod = await import(`../../routes/work/${action}.js`)
      .catch(() => null);

    if (!mod || typeof mod.default !== "function") {
      return res.status(404).send(`Unknown work action: ${action}`);
    }
    return mod.default(req, res); // delegate
  } catch (e) {
    console.error("work catch-all error", e);
    return res.status(500).send(String(e?.message || e));
  }
}

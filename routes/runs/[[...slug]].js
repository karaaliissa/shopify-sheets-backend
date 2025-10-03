export const config = { api: { bodyParser: false } };

import { setCors } from "../../lib/cors.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const slug = (req.query.slug || []);
  const action = (slug[0] || "").toLowerCase();

  try {
    const mod = await import(`../../routes/runs/${action}.js`)
      .catch(() => null);

    if (!mod || typeof mod.default !== "function") {
      return res.status(404).send(`Unknown runs action: ${action}`);
    }
    return mod.default(req, res);
  } catch (e) {
    console.error("runs catch-all error", e);
    return res.status(500).send(String(e?.message || e));
  }
}

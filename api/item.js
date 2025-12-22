// api/items.js (or use inside catch-all handleItems)
import { setCors } from "./lib/cors.js";

export const config = { api: { bodyParser: false }, runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("x-handler", "file:items.js");
  if (setCors(req, res)) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const shop = String(req.query.shop || "").toLowerCase();
  const orderId = String(req.query.order_id || req.query.orderId || "");
  if (!shop || !orderId) {
    return res.status(400).json({ ok: false, error: "Missing shop or order_id" });
  }

  try {
    const { getLatestItems } = await import("./lib/db.js");
    const items = await getLatestItems(shop, orderId);
    res.setHeader("Cache-Control", "public, max-age=5, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

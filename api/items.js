import { setCors } from "./lib/cors.js";
import { getLatestItems } from "./lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  const shop = req.query.shop, orderId = req.query.order_id;
  if (!shop || !orderId) return res.status(400).json({ ok:false, error:"Missing shop or order_id" });

  const items = await getLatestItems(shop, orderId);
  return res.status(200).json({ ok:true, items });
}

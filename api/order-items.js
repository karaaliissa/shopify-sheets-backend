import { getLatestItems } from "../lib/sheets.js";

export default async function handler(req, res) {
  const shop = req.query.shop;
  const orderId = req.query.order_id;
  if (!shop || !orderId) return res.status(400).json({ ok: false, error: "Missing shop or order_id" });

  const items = await getLatestItems(shop, orderId);
  res.status(200).json({ ok: true, items });
}

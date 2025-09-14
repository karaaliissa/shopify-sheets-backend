import { getAll } from "../lib/sheets.js";

export default async function handler(req, res) {
  const shop = (req.query.shop || "").toLowerCase();
  const status = req.query.status || "";
  const limit = Math.min(Number(req.query.limit || 100), 1000);

  const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");
  let rows = shop ? all.filter(r => r.SHOP_DOMAIN.toLowerCase() === shop) : all;
  if (status) rows = rows.filter(r => (r.FULFILLMENT_STATUS || "").toLowerCase() === status.toLowerCase());

  // newest updated first
  rows.sort((a, b) => (a.UPDATED_AT < b.UPDATED_AT ? 1 : -1));
  res.status(200).json({ ok: true, items: rows.slice(0, limit) });
}

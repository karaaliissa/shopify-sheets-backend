import { setCors } from "./lib/cors.js";
import { getAll } from "./lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  const shop   = (req.query.shop || "").toLowerCase();
  const status = (req.query.status || "").toLowerCase();
  const limit  = Math.min(Number(req.query.limit || 100), 1000);

  const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");
  let rows = shop ? all.filter(r => (r.SHOP_DOMAIN || "").toLowerCase() === shop) : all;
  if (status) rows = rows.filter(r => (r.FULFILLMENT_STATUS || "").toLowerCase() === status);
  rows.sort((a,b) => (a.UPDATED_AT < b.UPDATED_AT ? 1 : -1));
  return res.status(200).json({ ok:true, items: rows.slice(0, limit) });
}

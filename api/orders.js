import { getAll } from "../lib/sheets.js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400"); // 1 day
}

export default async function handler(req, res) {
  setCors(res);

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const shop = (req.query.shop || "").toLowerCase();
    const status = req.query.status || "";
    const limit = Math.min(Number(req.query.limit || 100), 1000);

    const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");

    let rows = shop ? all.filter(r => (r.SHOP_DOMAIN || "").toLowerCase() === shop) : all;
    if (status) {
      rows = rows.filter(
        r => (r.FULFILLMENT_STATUS || "").toLowerCase() === status.toLowerCase()
      );
    }

    rows.sort((a, b) => (a.UPDATED_AT < b.UPDATED_AT ? 1 : -1));
    return res.status(200).json({ ok: true, items: rows.slice(0, limit) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

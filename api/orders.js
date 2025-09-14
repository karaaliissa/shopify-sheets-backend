import { getAll } from "../lib/sheets.js";

const ALLOWED_LIST = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_LIST.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin); // reflect the exact origin
  }
  // If you prefer to allow everything when no match:
  // else res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Vary", "Origin"); // important with CDN
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight
  res.setHeader("Cache-Control", "no-store");       // avoid stale headers being cached
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const shop   = (req.query.shop || "").toLowerCase();
    const status = (req.query.status || "").toLowerCase();
    const limit  = Math.min(Number(req.query.limit || 100), 1000);

    const all = await getAll(process.env.TAB_ORDERS || "TBL_ORDER");

    let rows = shop ? all.filter(r => (r.SHOP_DOMAIN || "").toLowerCase() === shop) : all;
    if (status) rows = rows.filter(r => (r.FULFILLMENT_STATUS || "").toLowerCase() === status);

    rows.sort((a, b) => (a.UPDATED_AT < b.UPDATED_AT ? 1 : -1));
    return res.status(200).json({ ok: true, items: rows.slice(0, limit) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

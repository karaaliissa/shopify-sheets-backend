// /pages/api/logs.js
import { getAll } from "../lib/sheets.js";
import { setCors } from "../lib/cors.js";

const { TAB_LOGS = "TBL_WEBHOOK_LOG" } = process.env;

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const all = await getAll(TAB_LOGS);
    const sorted = all.sort((a, b) => (a.TS < b.TS ? 1 : -1)).slice(0, limit);
    return res.status(200).json({ ok: true, items: sorted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

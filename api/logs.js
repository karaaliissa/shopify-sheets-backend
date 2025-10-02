import { getAll } from "../lib/sheets.js";
import { setCors } from "../lib/cors.js";
setCors(req, res);
if (req.method === "OPTIONS") return res.status(204).end();
const { TAB_LOGS = "TBL_WEBHOOK_LOG" } = process.env;

export default async function handler(req, res) {
  const limit = Math.min(Number(req.query.limit || 50), 500);
  const all = await getAll(TAB_LOGS);
  // newest first (TS is ISO string)
  const sorted = all.sort((a, b) => (a.TS < b.TS ? 1 : -1)).slice(0, limit);
  res.status(200).json({ ok: true, items: sorted });
}

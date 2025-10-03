// /pages/api/work/done.js
import { setCors } from "../../lib/cors.js";
import { markWorkDone } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const { workId } = req.body || {};
    if (!workId) return res.status(400).json({ ok: false, error: "Missing workId" });

    await markWorkDone(workId);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

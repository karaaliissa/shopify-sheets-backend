// /pages/api/runs/list.js
import { setCors } from "../../lib/cors.js";
import { getAll, Tabs } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const date = req.query.date || new Date().toISOString().slice(0,10);
    const runs = (await getAll(Tabs.DRIVER_RUN)).filter(r => (r.DATE||"").startsWith(date));
    const stops = await getAll(Tabs.DRIVER_STOP);
    const out = runs.map(r => ({
      ...r,
      STOPS: stops.filter(s => s.RUN_ID === r.RUN_ID)
    }));
    return res.status(200).json({ ok:true, items: out });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

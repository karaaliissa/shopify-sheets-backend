// /pages/api/runs/for-driver.js
import { setCors } from "../lib/cors.js";
import { getAll, Tabs } from "../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const driverId = (req.query.driverId || "").trim();
    const date = (req.query.date || new Date().toISOString().slice(0,10)).slice(0,10);
    if (!driverId) return res.status(400).json({ ok:false, error:"driverId required" });

    const runs  = (await getAll(Tabs.DRIVER_RUN))
      .filter(r => (r.DRIVER_ID || "").trim() === driverId && (r.DATE || "").startsWith(date));
    const runIds = new Set(runs.map(r => r.RUN_ID));

    const stops = (await getAll(Tabs.DRIVER_STOP))
      .filter(s => runIds.has(s.RUN_ID))
      // keep latest record per RUN_ID+STOP_ID (in case you append updates)
      .reduce((acc, s) => {
        const key = `${s.RUN_ID}|${s.STOP_ID}`;
        const prev = acc.get(key);
        const prevTs = prev ? new Date(prev.DONE_AT || prev.UPDATED_AT || prev.START_TS || 0).getTime() : -1;
        const curTs  = new Date(s.DONE_AT || s.UPDATED_AT || s.START_TS || 0).getTime();
        if (!prev || curTs >= prevTs) acc.set(key, s);
        return acc;
      }, new Map());

    return res.status(200).json({
      ok: true,
      items: runs.map(r => ({
        RUN_ID: r.RUN_ID,
        DRIVER_ID: r.DRIVER_ID,
        DATE: r.DATE,
        STATUS: r.STATUS,
        STOPS: [...stops.values()].filter(s => s.RUN_ID === r.RUN_ID)
      }))
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

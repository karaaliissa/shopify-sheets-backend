// /pages/api/runs/list.js
import { setCors } from "../../lib/cors.js";
import { getAll, Tabs } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const date = (req.query.date || new Date().toISOString().slice(0,10)).slice(0,10);

    const runs  = (await getAll(Tabs.DRIVER_RUN))
      .filter(r => (r.DATE || "").startsWith(date));

    const runIds = new Set(runs.map(r => r.RUN_ID));
    const stops  = (await getAll(Tabs.DRIVER_STOP)).filter(s => runIds.has(s.RUN_ID));

    // keep latest per RUN_ID+STOP_ID
    const latest = [...stops].reduce((acc, s) => {
      const k = `${s.RUN_ID}|${s.STOP_ID}`;
      const prev = acc.get(k);
      const prevTs = prev ? new Date(prev.DONE_AT || prev.UPDATED_AT || prev.START_TS || 0).getTime() : -1;
      const curTs  = new Date(s.DONE_AT || s.UPDATED_AT || s.START_TS || 0).getTime();
      if (!prev || curTs >= prevTs) acc.set(k, s);
      return acc;
    }, new Map());

    const result = runs.map(r => ({
      RUN_ID: r.RUN_ID,
      DRIVER_ID: r.DRIVER_ID,
      DATE: r.DATE,
      STATUS: r.STATUS,
      STOPS: [...latest.values()].filter(s => s.RUN_ID === r.RUN_ID)
    }));

    return res.status(200).json({ ok:true, runs: result });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

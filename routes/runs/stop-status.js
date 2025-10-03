// /pages/api/runs/stop-status.js
import { setCors } from "../../lib/cors.js";
import { getAll, appendObjects, Tabs } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const { runId, stopId, status, codAmount, notes } = req.body || {};
    if (!runId || !stopId || !status) return res.status(400).json({ ok:false, error:"runId, stopId, status required" });

    // find last known stop row (so we keep columns like ORDER_ID, ADDRESS…)
    const allStops = await getAll(Tabs.DRIVER_STOP);
    const latest = allStops
      .filter(s => s.RUN_ID === String(runId) && String(s.STOP_ID) === String(stopId))
      .sort((a,b)=> new Date(b.DONE_AT || 0) - new Date(a.DONE_AT || 0))[0] || {};

    await appendObjects(Tabs.DRIVER_STOP, [{
      ...latest,
      RUN_ID: String(runId),
      STOP_ID: String(stopId),
      STATUS: status,
      COD_AMOUNT: codAmount ?? latest.COD_AMOUNT ?? "",
      NOTES: (notes ?? latest.NOTES ?? ""),
      DONE_AT: new Date().toISOString(),
    }]);

    if (status === "delivered" && codAmount) {
      await appendObjects(Tabs.CASH, [{
        RUN_ID: String(runId),
        DRIVER_ID: "", // optional: fill from TBL_DRIVER_RUN if you want
        AMOUNT_COLLECTED: Number(codAmount),
        HANDED_AT: "",
        RECEIVER: "",
        NOTES: ""
      }]);
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

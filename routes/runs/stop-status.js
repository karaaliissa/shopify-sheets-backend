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

    // Append a light log row for history; you can also upsert in-place later.
    await appendObjects(Tabs.DRIVER_STOP, [{
      RUN_ID: runId, STOP_ID: stopId, STATUS: status,
      COD_AMOUNT: codAmount ?? "", NOTES: notes ?? "", DONE_AT: new Date().toISOString()
    }]);

    // optional: if delivered with COD, add a cash remittance seed row
    if (status === "delivered" && codAmount) {
      await appendObjects(Tabs.CASH, [{
        RUN_ID: runId, DRIVER_ID: "", AMOUNT_COLLECTED: codAmount, HANDED_AT: "", RECEIVER: "", NOTES: ""
      }]);
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

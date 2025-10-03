// routes/runs/remit.js
import { appendObjects } from "../../lib/sheets.js";
import { setCors } from "../../lib/cors.js";

export default async function handler(req,res){
  setCors(req,res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const { runId, driverId, amount, receiver='admin', notes='' } = req.body || {};
  if (!runId || !driverId || amount == null) {
    return res.status(400).json({ ok:false, error:'runId, driverId, amount required' });
  }
  await appendObjects('TBL_CASH_REMITTANCE',[{
    RUN_ID: runId, DRIVER_ID: driverId, AMOUNT_COLLECTED: Number(amount),
    HANDED_AT: new Date().toISOString(), RECEIVER: receiver, NOTES: notes
  }]);
  res.json({ ok:true });
}

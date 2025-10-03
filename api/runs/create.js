// /pages/api/runs/create.js
import { setCors } from "../../lib/cors.js";
import { appendObjects, getAll, Tabs } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const { date, driverId, orderIds = [], assigner = "system" } = req.body || {};
    if (!driverId || !orderIds.length) return res.status(400).json({ ok:false, error:"driverId and orderIds[] required" });

    const runId = `RUN-${Date.now()}`;
    await appendObjects(Tabs.DRIVER_RUN, [{
      RUN_ID: runId, DATE: date || new Date().toISOString().slice(0,10),
      DRIVER_ID: driverId, ASSIGNER: assigner, STATUS: "active", NOTES: ""
    }]);

    // pull orders to create stops
    const orders = await getAll(Tabs.ORDERS);
    const byId = new Map(orders.map(o => [String(o.ORDER_ID), o]));
    const stops = orderIds.map((id, idx) => {
      const o = byId.get(String(id)) || {};
      return {
        RUN_ID: runId,
        STOP_ID: `${idx+1}`,
        ORDER_ID: String(id),
        CUSTOMER_NAME: o.SHIP_NAME || "",
        ADDRESS: [o.SHIP_ADDRESS1, o.SHIP_CITY, o.SHIP_PROVINCE, o.SHIP_COUNTRY].filter(Boolean).join(", "),
        PHONE: o.SHIP_PHONE || o.CUSTOMER_EMAIL || "",
        COD_AMOUNT: o.TOTAL || "",
        STATUS: "assigned",
        ETA: "", DONE_AT: "", NOTES: ""
      };
    });
    await appendObjects(Tabs.DRIVER_STOP, stops);

    return res.status(200).json({ ok:true, runId, stopsCount: stops.length });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

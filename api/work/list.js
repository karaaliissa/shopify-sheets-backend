// /pages/api/work/list.js
import { setCors } from "../../lib/cors.js";
import { getAll, Tabs } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const stage = (req.query.stage || "").toLowerCase(); // optional
    const shop  = (req.query.shop  || "").toLowerCase(); // optional
    const date  = req.query.date ? new Date(req.query.date) : null; // optional filter

    const all = await getAll(Tabs.WORK);
    const rows = all.filter(r => {
      if ((r.STATUS || "").toLowerCase() !== "active") return false;
      if (stage && (r.STAGE || "").toLowerCase() !== stage) return false;
      if (shop && (r.SHOP_DOMAIN || "").toLowerCase() !== shop) return false;
      if (date) {
        const t = new Date(r.START_TS || 0).getTime();
        const d0 = new Date(date); d0.setHours(0,0,0,0);
        const d1 = new Date(date); d1.setHours(23,59,59,999);
        if (t < d0.getTime() || t > d1.getTime()) return false;
      }
      return true;
    });

    // newest first
    rows.sort((a,b) => (a.START_TS < b.START_TS ? 1 : -1));
    return res.status(200).json({ ok:true, items: rows });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

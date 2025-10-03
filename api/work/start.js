// /pages/api/work/start.js
import { setCors } from "../../lib/cors.js";
import { createWorkEntry } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const { shopDomain, orderId, lineId, sku, title, variantTitle, qty, stage, assignee, notes } = req.body || {};
    if (!shopDomain || !orderId || !lineId || !stage) {
      return res.status(400).json({ ok: false, error: "Missing shopDomain/orderId/lineId/stage" });
    }

    const entry = {
      WORK_ID: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      SHOP_DOMAIN: shopDomain,
      ORDER_ID: String(orderId),
      LINE_ID: String(lineId),
      SKU: sku || "",
      TITLE: title || "",
      VARIANT_TITLE: variantTitle || "",
      QTY: Number(qty ?? 0),
      STAGE: String(stage),
      ASSIGNEE: assignee || "",
      START_TS: new Date().toISOString(),
      END_TS: "",
      STATUS: "active",
      NOTES: notes || ""
    };

    await createWorkEntry(entry);
    return res.status(200).json({ ok: true, workId: entry.WORK_ID });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

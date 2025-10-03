// /pages/api/picking-list.js
import { setCors } from "../lib/cors.js";
import { getAll, Tabs } from "../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const shop = (req.query.shop || "").toLowerCase();
    const fromIso = req.query.from ? new Date(req.query.from) : null;
    const toIso   = req.query.to   ? new Date(req.query.to)   : null;

    // 1) load orders (filter shop/date)
    const orders = await getAll(Tabs.ORDERS);
    const ordersFiltered = orders.filter(o => {
      if (shop && (o.SHOP_DOMAIN || "").toLowerCase() !== shop) return false;
      const t = new Date(o.CREATED_AT || o.UPDATED_AT || 0).getTime();
      if (fromIso && t < fromIso.getTime()) return false;
      if (toIso && t > toIso.getTime()) return false;
      return true;
    });

    const orderIdSet = new Set(ordersFiltered.map(o => String(o.ORDER_ID)));

    // 2) load items (single read), keep only latest batch per order
    const itemsAll = await getAll(Tabs.ITEMS);
    const itemsForOrders = itemsAll.filter(r =>
      (!shop || (r.SHOP_DOMAIN || "").toLowerCase() === shop) &&
      orderIdSet.has(String(r.ORDER_ID))
    );

    // find latest batch per (SHOP_DOMAIN, ORDER_ID)
    const latestBatchByOrder = new Map(); // key: shop|orderId -> max BATCH_TS
    for (const it of itemsForOrders) {
      const key = `${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`;
      const ts = Number(it.BATCH_TS || 0);
      if (!latestBatchByOrder.has(key) || ts > latestBatchByOrder.get(key)) {
        latestBatchByOrder.set(key, ts);
      }
    }
    const latestItems = itemsForOrders.filter(it => {
      const key = `${it.SHOP_DOMAIN}|${String(it.ORDER_ID)}`;
      return Number(it.BATCH_TS || 0) === latestBatchByOrder.get(key);
    });

    // 3) group by SKU OR (TITLE|VARIANT_TITLE)
    const byKey = new Map();
    const orderNameById = new Map(ordersFiltered.map(o => [String(o.ORDER_ID), o.ORDER_NAME || `#${o.ORDER_ID}`]));

    for (const it of latestItems) {
      const sku = (it.SKU || "").trim();
      const k = sku || `${it.TITLE || ""}|${it.VARIANT_TITLE || ""}`;
      const qty = Number(it.FULFILLABLE_QUANTITY ?? it.QUANTITY ?? 0);
      if (!byKey.has(k)) {
        byKey.set(k, {
          KEY: k,
          SKU: sku || "",
          TITLE: it.TITLE || "",
          VARIANT_TITLE: it.VARIANT_TITLE || "",
          IMAGE: it.IMAGE || "",
          TOTAL_QTY: 0,
          ORDERS: new Set(),
        });
      }
      const g = byKey.get(k);
      g.TOTAL_QTY += qty;
      g.IMAGE = g.IMAGE || it.IMAGE || "";
      g.ORDERS.add(orderNameById.get(String(it.ORDER_ID)) || `#${it.ORDER_ID}`);
    }

    // 4) response
    const rows = Array.from(byKey.values())
      .map(g => ({ ...g, ORDERS: Array.from(g.ORDERS) }))
      .filter(x => x.TOTAL_QTY > 0)
      .sort((a, b) => b.TOTAL_QTY - a.TOTAL_QTY);

    return res.status(200).json({ ok: true, items: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

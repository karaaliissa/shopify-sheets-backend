import { setCors } from "../lib/cors.js";
import { getAll, Tabs } from "../lib/sheets.js";

const esc = (s='') => String(s).replace(/"/g,'""');
const toCSV = rows => {
  const headers = Object.keys(rows[0] || {});
  const body = rows.map(r => headers.map(h => `"${esc(r[h] ?? '')}"`).join(',')).join('\n');
  return [headers.join(','), body].filter(Boolean).join('\n');
};

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // CORS + allow Angular to read filename
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

  try {
    const shop = (req.query.shop || "").trim();
    const dateQ = (req.query.date || new Date().toISOString().slice(0,10)).slice(0,10);
    const allFlag = String(req.query.all || "").toLowerCase() === "1";
    const allowedStatuses = (req.query.statuses || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

    const orders = await getAll(Tabs.ORDERS); // your TBL_ORDER

    // Normalize helpers
    const oDate = o =>
      (o.PROCESSED_AT || o.CREATED_AT || o.UPDATED_AT || "").slice(0,10);

    const oStatus = o =>
      (o.STATUS || o.FULFILLMENT_STATUS || o.FULFILL_STATUS || o.ORDER_STATUS || "")
        .toString().toLowerCase();

    const shopMatch = o =>
      !shop || (String(o.SHOP_DOMAIN || o.SHOP || "").trim() === shop);

    // Default behavior: export orders for that date (==), optionally filter by statuses.
    // Use ?all=1 to ignore status and date filters (good for testing).
    let selected = orders.filter(o => shopMatch(o));
    if (!allFlag) {
      selected = selected.filter(o => oDate(o) === dateQ);
      if (allowedStatuses.length > 0) {
        selected = selected.filter(o => allowedStatuses.includes(oStatus(o)));
      }
    }

    // Map to Shipday columns (with orderNumber fallbacks)
    const rows = selected.map(o => ({
      orderNumber        : (o.ORDER_NAME || o.NAME || o.ORDER_NUMBER || o.ORDER_ID || "").toString().replace(/^#/, ''),
      customerName       : o.SHIP_NAME || o.CUSTOMER_NAME || '',
      customerPhoneNumber: o.SHIP_PHONE || o.CUSTOMER_PHONE || '',
      customerEmail      : o.CUSTOMER_EMAIL || '',
      addressLine1       : o.SHIP_ADDRESS1 || '',
      addressLine2       : o.SHIP_ADDRESS2 || '',
      city               : o.SHIP_CITY || '',
      state              : o.SHIP_PROVINCE || '',
      postalCode         : o.SHIP_ZIP || '',
      country            : o.SHIP_COUNTRY || '',
      paymentMethod      : (o.COD_AMOUNT ? 'COD' : 'Prepaid'),
      codAmount          : o.COD_AMOUNT || '',
      note               : o.NOTE || ''
    })).filter(r => r.orderNumber); // keep only if we have an order number

    // Optional debug: ?debug=1 returns a JSON preview instead of CSV
    if (String(req.query.debug || "").toLowerCase() === "1") {
      return res.status(200).json({
        ok: true,
        shop, date: dateQ, count: rows.length,
        sample: rows.slice(0, 3),
        info: {
          totalOrders: orders.length,
          selectedBeforeMap: selected.length
        }
      });
    }

    const csv = rows.length ? toCSV(rows) : 'orderNumber\n';
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shipday-${dateQ}.csv"`);
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
}
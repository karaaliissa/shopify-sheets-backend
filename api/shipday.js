import { setCors } from "../lib/cors.js";
import { getAll, Tabs } from "../lib/sheets.js";

const esc = (s='') => String(s).replace(/"/g,'""');
const csv = rows => {
  const headers = Object.keys(rows[0] || {});
  const body = rows.map(r => headers.map(h => `"${esc(r[h] ?? '')}"`).join(',')).join('\n');
  return [headers.join(','), body].filter(Boolean).join('\n');
};

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  try {
    const shop = (req.query.shop || "").trim();
    const date = (req.query.date || new Date().toISOString().slice(0,10)).slice(0,10);

    const orders = await getAll(Tabs.ORDERS);
    const items  = orders.filter(o =>
      (!shop || (o.SHOP_DOMAIN||'').trim() === shop) &&
      (o.CREATED_AT || '').slice(0,10) <= date &&
      ['ready_dispatch','packed'].includes((o.STATUS||'').toLowerCase())
    );

    const rows = items.map(o => ({
      orderNumber        : o.ORDER_NAME || o.ORDER_ID,
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
      note               : o.NOTE || '',
    }));

    const out = rows.length ? csv(rows) : 'orderNumber\n';

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shipday-${date}.csv"`);

    // CORS + let the browser read filename
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    return res.status(200).send(out);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
}

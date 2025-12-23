import pg from "pg";
const { Pool } = pg;

let _pool;

export function pool() {
  if (_pool) return _pool;

  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL missing");

  _pool = new Pool({
    connectionString: cs,
    ssl: cs.includes("sslmode=require")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  return _pool;
}

export async function upsertOrder(o) {
  const sql = `
    INSERT INTO tbl_order (
      shop_domain, order_id, order_name,
      created_at, updated_at, cancelled_at,
      fulfillment_status, financial_status,
      payment_gateway, shipping_method,
      total, currency, customer_email, tags,
      note, deliver_by, source_name, discount_codes, note_local,
      ship_name, ship_address1, ship_address2, ship_city, ship_province, ship_zip, ship_country, ship_phone
    )
    VALUES (
      $1,$2,$3,
      NULLIF($4,'')::timestamp, NULLIF($5,'')::timestamp, NULLIF($6,'')::timestamp,
      $7,$8,
      $9,$10,
      NULLIF($11,'')::numeric, $12, $13, $14,
      $15, NULLIF($16,'')::date, $17, $18, $19,
      $20,$21,$22,$23,$24,$25,$26,$27
    )
    ON CONFLICT (shop_domain, order_id)
    DO UPDATE SET
      order_name         = EXCLUDED.order_name,
      created_at         = EXCLUDED.created_at,
      updated_at         = EXCLUDED.updated_at,
      cancelled_at       = EXCLUDED.cancelled_at,
      fulfillment_status = EXCLUDED.fulfillment_status,
      financial_status   = EXCLUDED.financial_status,
      payment_gateway    = EXCLUDED.payment_gateway,
      shipping_method    = EXCLUDED.shipping_method,
      total              = EXCLUDED.total,
      currency           = EXCLUDED.currency,
      customer_email     = EXCLUDED.customer_email,
      tags               = EXCLUDED.tags,
      note               = EXCLUDED.note,
      deliver_by         = EXCLUDED.deliver_by,
      source_name        = EXCLUDED.source_name,
      discount_codes     = EXCLUDED.discount_codes,
      note_local         = EXCLUDED.note_local,
      ship_name          = EXCLUDED.ship_name,
      ship_address1      = EXCLUDED.ship_address1,
      ship_address2      = EXCLUDED.ship_address2,
      ship_city          = EXCLUDED.ship_city,
      ship_province      = EXCLUDED.ship_province,
      ship_zip           = EXCLUDED.ship_zip,
      ship_country       = EXCLUDED.ship_country,
      ship_phone         = EXCLUDED.ship_phone
  `;

  const v = [
    o.SHOP_DOMAIN,
    o.ORDER_ID,
    o.ORDER_NAME,
    o.CREATED_AT,
    o.UPDATED_AT,
    o.CANCELLED_AT,
    o.FULFILLMENT_STATUS,
    o.FINANCIAL_STATUS,
    o.PAYMENT_GATEWAY,
    o.SHIPPING_METHOD,
    o.TOTAL,
    o.CURRENCY,
    o.CUSTOMER_EMAIL,
    o.TAGS,
    o.NOTE,
    o.DELIVER_BY,
    o.SOURCE_NAME,
    o.DISCOUNT_CODES,
    o.NOTE_LOCAL,
    o.SHIP_NAME,
    o.SHIP_ADDRESS1,
    o.SHIP_ADDRESS2,
    o.SHIP_CITY,
    o.SHIP_PROVINCE,
    o.SHIP_ZIP,
    o.SHIP_COUNTRY,
    o.SHIP_PHONE,
  ];

  await pool().query(sql, v);
}

export async function replaceLineItems(shopDomain, orderId, items) {
  const sd = String(shopDomain || "").toLowerCase();
  const oid = String(orderId || "").trim();
  if (!sd || !oid) return;

  await pool().query(
    `DELETE FROM tbl_order_line_item WHERE shop_domain=$1 AND order_id=$2`,
    [sd, oid]
  );

  if (!Array.isArray(items) || items.length === 0) return;

  const sql = `
    INSERT INTO tbl_order_line_item (
      shop_domain, order_id, line_id,
      title, variant_title, quantity, fulfillable_quantity,
      sku, image, product_id, variant_id,
      unit_price, line_total, currency,
      properties_json, batch_ts
    )
    VALUES (
      $1,$2,$3,
      $4,$5,$6,$7,
      $8,$9,$10,$11,
      NULLIF($12,'')::numeric, NULLIF($13,'')::numeric, $14,
      $15, NOW()
    )
  `;

  for (const it of items) {
    const lineId =
      String(it.LINE_ID || "").trim() || `no_line_id_${Date.now()}`;
    await pool().query(sql, [
      sd,
      oid,
      lineId,
      it.TITLE ?? "",
      it.VARIANT_TITLE ?? "",
      Number(it.QUANTITY ?? 0),
      Number(it.FULFILLABLE_QUANTITY ?? 0),
      it.SKU ?? "",
      it.IMAGE ?? "",
      String(it.PRODUCT_ID ?? ""),
      String(it.VARIANT_ID ?? ""),
      String(it.UNIT_PRICE ?? ""),
      String(it.LINE_TOTAL ?? ""),
      it.CURRENCY ?? "",
      it.PROPERTIES_JSON ?? "",
    ]);
  }
}

export async function logWebhook(entry) {
  const sql = `
    INSERT INTO tbl_webhook_log (ts, shop_domain, topic, order_id, hash, result, error)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (shop_domain, topic, order_id, hash)
    DO UPDATE SET
      ts = EXCLUDED.ts,
      result = EXCLUDED.result,
      error = EXCLUDED.error
  `;

  await pool().query(sql, [
    entry.ts || new Date().toISOString(),
    entry.shop_domain || null,
    entry.topic || null,
    entry.order_id || null,
    entry.hash || null,
    entry.result || null,
    entry.error || null,
  ]);
}

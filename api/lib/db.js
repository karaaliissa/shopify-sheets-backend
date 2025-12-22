// api/lib/db.js
import pg from "pg";

const { Pool } = pg;

let _pool;
function pool() {
  if (_pool) return _pool;

  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL missing");

  _pool = new Pool({
    connectionString: cs,
    ssl: cs.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });

  return _pool;
}

function normShop(shopDomain) {
  const s = String(shopDomain || "").trim();
  return s ? s.toLowerCase() : "";
}

// ✅ returns UPPERCASE keys (legacy UI expectation)
export async function getOrders({ shopDomain } = {}) {
  const shop = normShop(shopDomain);

  const sql = `
    SELECT
      shop_domain         AS "SHOP_DOMAIN",
      order_id            AS "ORDER_ID",
      order_name          AS "ORDER_NAME",
      created_at          AS "CREATED_AT",
      updated_at          AS "UPDATED_AT",
      cancelled_at        AS "CANCELLED_AT",
      fulfillment_status  AS "FULFILLMENT_STATUS",
      financial_status    AS "FINANCIAL_STATUS",
      payment_gateway     AS "PAYMENT_GATEWAY",
      shipping_method     AS "SHIPPING_METHOD",
      total               AS "TOTAL",
      currency            AS "CURRENCY",
      customer_email      AS "CUSTOMER_EMAIL",
      tags                AS "TAGS",
      note                AS "NOTE",
      deliver_by          AS "DELIVER_BY",
      source_name         AS "SOURCE_NAME",
      discount_codes      AS "DISCOUNT_CODES",
      note_local          AS "NOTE_LOCAL",
      ship_name           AS "SHIP_NAME",
      ship_address1       AS "SHIP_ADDRESS1",
      ship_address2       AS "SHIP_ADDRESS2",
      ship_city           AS "SHIP_CITY",
      ship_province       AS "SHIP_PROVINCE",
      ship_zip            AS "SHIP_ZIP",
      ship_country        AS "SHIP_COUNTRY",
      ship_phone          AS "SHIP_PHONE"
    FROM tbl_order
    WHERE ($1 = '' OR lower(shop_domain) = $1)
    ORDER BY updated_at DESC NULLS LAST
  `;

  const { rows } = await pool().query(sql, [shop]);
  return rows;
}

// ✅ pagination endpoint support: /api/orders/page?shop=...&limit=50&cursor=...
export async function getOrdersPage({ shopDomain, limit = 50, cursor } = {}) {
  const shop = normShop(shopDomain);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  // cursor = updated_at ISO OR order_id; we keep it simple by using updated_at
  const sql = `
    SELECT
      shop_domain         AS "SHOP_DOMAIN",
      order_id            AS "ORDER_ID",
      order_name          AS "ORDER_NAME",
      created_at          AS "CREATED_AT",
      updated_at          AS "UPDATED_AT",
      cancelled_at        AS "CANCELLED_AT",
      fulfillment_status  AS "FULFILLMENT_STATUS",
      financial_status    AS "FINANCIAL_STATUS",
      payment_gateway     AS "PAYMENT_GATEWAY",
      shipping_method     AS "SHIPPING_METHOD",
      total               AS "TOTAL",
      currency            AS "CURRENCY",
      customer_email      AS "CUSTOMER_EMAIL",
      tags                AS "TAGS",
      note                AS "NOTE",
      deliver_by          AS "DELIVER_BY",
      source_name         AS "SOURCE_NAME",
      discount_codes      AS "DISCOUNT_CODES",
      note_local          AS "NOTE_LOCAL",
      ship_name           AS "SHIP_NAME",
      ship_address1       AS "SHIP_ADDRESS1",
      ship_address2       AS "SHIP_ADDRESS2",
      ship_city           AS "SHIP_CITY",
      ship_province       AS "SHIP_PROVINCE",
      ship_zip            AS "SHIP_ZIP",
      ship_country        AS "SHIP_COUNTRY",
      ship_phone          AS "SHIP_PHONE"
    FROM tbl_order
    WHERE ($1 = '' OR lower(shop_domain) = $1)
      AND ($2::timestamp is null OR updated_at < $2::timestamp)
    ORDER BY updated_at DESC NULLS LAST
    LIMIT $3
  `;

  const cur = cursor ? String(cursor) : null;
  const { rows } = await pool().query(sql, [shop, cur, lim]);

  const nextCursor =
    rows.length ? rows[rows.length - 1].UPDATED_AT : null;

  // optional total (for this shop)
  const { rows: t } = await pool().query(
    `SELECT count(*)::int AS total FROM tbl_order WHERE ($1 = '' OR lower(shop_domain) = $1)`,
    [shop]
  );

  return { items: rows, nextCursor, total: t?.[0]?.total ?? 0 };
}

// ✅ order items: /api/items?shop=...&order_id=...
export async function getOrderItems({ shopDomain, orderId } = {}) {
  const shop = normShop(shopDomain);
  const oid = String(orderId || "").trim();
  if (!oid) return [];

  const sql = `
    SELECT
      title            AS "TITLE",
      variant_title    AS "VARIANT_TITLE",
      quantity         AS "QUANTITY",
      fulfillable_quantity AS "FULFILLABLE_QUANTITY",
      sku              AS "SKU",
      image            AS "IMAGE",
      unit_price       AS "UNIT_PRICE",
      line_total       AS "LINE_TOTAL",
      currency         AS "CURRENCY",
      properties_json  AS "PROPERTIES_JSON"
    FROM tbl_order_line_item
    WHERE ($1 = '' OR lower(shop_domain) = $1)
      AND order_id = $2
    ORDER BY title ASC
  `;

  const { rows } = await pool().query(sql, [shop, oid]);
  return rows;
}

/* =========================
   Webhook writers (Neon)
   ========================= */

export async function upsertOrder(o) {
  // expects normalized object already
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
      $4,$5,$6,
      $7,$8,
      $9,$10,
      $11,$12,$13,$14,
      $15,$16,$17,$18,$19,
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
      source_name        = EXCLUDED.source_name,
      discount_codes     = EXCLUDED.discount_codes,
      ship_name          = EXCLUDED.ship_name,
      ship_address1      = EXCLUDED.ship_address1,
      ship_address2      = EXCLUDED.ship_address2,
      ship_city          = EXCLUDED.ship_city,
      ship_province      = EXCLUDED.ship_province,
      ship_zip           = EXCLUDED.ship_zip,
      ship_country       = EXCLUDED.ship_country,
      ship_phone         = EXCLUDED.ship_phone
  `;
  const v = o._vals; // we’ll build this in webhook
  await pool().query(sql, v);
}

export async function writeLineItems(items, batchTs) {
  if (!Array.isArray(items) || !items.length) return;

  // simplest: delete then insert for that order (safe + easy)
  const { shop_domain, order_id } = items[0];
  await pool().query(
    `DELETE FROM tbl_order_line_item WHERE shop_domain=$1 AND order_id=$2`,
    [shop_domain, order_id]
  );

  const sql = `
    INSERT INTO tbl_order_line_item (
      shop_domain, order_id,
      title, variant_title, quantity, fulfillable_quantity,
      sku, image, unit_price, line_total, currency, properties_json,
      batch_ts
    )
    VALUES (
      $1,$2,
      $3,$4,$5,$6,
      $7,$8,$9,$10,$11,$12,
      $13
    )
  `;

  for (const it of items) {
    await pool().query(sql, [
      it.shop_domain,
      it.order_id,
      it.title,
      it.variant_title,
      it.quantity,
      it.fulfillable_quantity,
      it.sku,
      it.image,
      it.unit_price,
      it.line_total,
      it.currency,
      it.properties_json,
      batchTs,
    ]);
  }
}

export async function logWebhook(entry) {
  const sql = `
    INSERT INTO tbl_webhook_log (ts, shop_domain, topic, order_id, hash, result, error)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `;
  await pool().query(sql, [
    entry.ts || new Date(),
    entry.shop_domain || null,
    entry.topic || null,
    entry.order_id || null,
    entry.hash || null,
    entry.result || null,
    entry.error || null,
  ]);
}

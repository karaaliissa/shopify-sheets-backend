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

/* =========================
   Read APIs (UPPERCASE keys)
   ========================= */

// ✅ now supports limit
export async function getOrders({ shopDomain, limit = 5000 } = {}) {
  const shop = normShop(shopDomain);
  const lim = Math.max(1, Math.min(5000, Number(limit) || 5000));

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
    LIMIT $2
  `;

  const { rows } = await pool().query(sql, [shop, lim]);
  return rows;
}

// ✅ pagination endpoint support: /api/orders/page?shop=...&limit=50&cursor=...
export async function getOrdersPage({ shopDomain, limit = 50, cursor } = {}) {
  const shop = normShop(shopDomain);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

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

  const nextCursor = rows.length ? rows[rows.length - 1].UPDATED_AT : null;

  const { rows: t } = await pool().query(
    `SELECT count(*)::int AS total FROM tbl_order WHERE ($1 = '' OR lower(shop_domain) = $1)`,
    [shop]
  );

  return { items: rows, nextCursor, total: t?.[0]?.total ?? 0 };
}

// ✅ helper for summary
export async function getAllOrders() {
  return getOrders({ limit: 5000 });
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
    currency         AS "CURRENCY"
  FROM tbl_order_line_item
  WHERE ($1 = '' OR lower(shop_domain) = $1)
    AND order_id = $2
  ORDER BY title ASC
`;


  const { rows } = await pool().query(sql, [shop, oid]);
  return rows;
}

/* =========================
   Update APIs (for dashboard)
   ========================= */

export async function setDeliverBy({ shopDomain, orderId, deliverBy }) {
  const shop = normShop(shopDomain);
  const oid = String(orderId || "").trim();
  await pool().query(
    `UPDATE tbl_order SET deliver_by=$3 WHERE lower(shop_domain)=$1 AND order_id=$2`,
    [shop, oid, deliverBy]
  );
}

export async function setNoteLocal({ shopDomain, orderId, noteLocal }) {
  const shop = normShop(shopDomain);
  const oid = String(orderId || "").trim();
  await pool().query(
    `UPDATE tbl_order SET note_local=$3 WHERE lower(shop_domain)=$1 AND order_id=$2`,
    [shop, oid, noteLocal]
  );
}

// action: add | remove | set
export async function setOrderTags({ shopDomain, orderId, action, tag, tagsIn }) {
  const shop = normShop(shopDomain);
  const oid = String(orderId || "").trim();

  const { rows } = await pool().query(
    `SELECT tags FROM tbl_order WHERE lower(shop_domain)=$1 AND order_id=$2 LIMIT 1`,
    [shop, oid]
  );

  const cur = String(rows?.[0]?.tags || "");
  const currentTags = cur.split(",").map(s => s.trim()).filter(Boolean);

  let next = currentTags;

  if (action === "add") {
    const exists = currentTags.map(t => t.toLowerCase()).includes(String(tag || "").toLowerCase());
    if (!exists) next = [...currentTags, tag];
  } else if (action === "remove") {
    next = currentTags.filter(t => t.toLowerCase() !== String(tag || "").toLowerCase());
  } else if (action === "set") {
    next = Array.isArray(tagsIn) ? tagsIn : [];
  } else {
    throw new Error("Bad action (add|remove|set)");
  }

  await pool().query(
    `UPDATE tbl_order SET tags=$3 WHERE lower(shop_domain)=$1 AND order_id=$2`,
    [shop, oid, next.join(", ")]
  );

  return next;
}

/* =========================
   Webhook writers (Neon)
   ========================= */

   export async function upsertOrder(order) {
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
      order.SHOP_DOMAIN,
      order.ORDER_ID,
      order.ORDER_NAME,
      order.CREATED_AT,
      order.UPDATED_AT,
      order.CANCELLED_AT,
      order.FULFILLMENT_STATUS,
      order.FINANCIAL_STATUS,
      order.PAYMENT_GATEWAY,
      order.SHIPPING_METHOD,
      order.TOTAL,
      order.CURRENCY,
      order.CUSTOMER_EMAIL,
      order.TAGS,
      order.NOTE,
      order.DELIVER_BY ?? null,
      order.SOURCE_NAME,
      order.DISCOUNT_CODES,
      order.NOTE_LOCAL ?? null,
      order.SHIP_NAME,
      order.SHIP_ADDRESS1,
      order.SHIP_ADDRESS2,
      order.SHIP_CITY,
      order.SHIP_PROVINCE,
      order.SHIP_ZIP,
      order.SHIP_COUNTRY,
      order.SHIP_PHONE,
    ];
  
    await pool().query(sql, v);
  }
  

export async function writeLineItems(items, batchTs) {
  if (!Array.isArray(items) || !items.length) return;

  const first = items[0];
  const shop_domain = first.shop_domain || first.SHOP_DOMAIN;
  const order_id = first.order_id || first.ORDER_ID;
  

  await pool().query(
    `DELETE FROM tbl_order_line_item WHERE shop_domain=$1 AND order_id=$2`,
    [shop_domain, order_id]
  );

  const sql = `
  INSERT INTO tbl_order_line_item (
    shop_domain, order_id,
    title, variant_title, quantity, fulfillable_quantity,
    sku, image, unit_price, line_total, currency,
    batch_ts
  )
  VALUES (
    $1,$2,
    $3,$4,$5,$6,
    $7,$8,$9,$10,$11,
    $12
  )
`;

for (const it of items) {
  const sd = it.shop_domain || it.SHOP_DOMAIN;
  const oid = it.order_id || it.ORDER_ID;

  await pool().query(sql, [
    sd,
    oid,
    it.title || it.TITLE,
    it.variant_title || it.VARIANT_TITLE,
    it.quantity ?? it.QUANTITY,
    it.fulfillable_quantity ?? it.FULFILLABLE_QUANTITY,
    it.sku || it.SKU,
    it.image || it.IMAGE,
    it.unit_price ?? it.UNIT_PRICE,
    it.line_total ?? it.LINE_TOTAL,
    it.currency || it.CURRENCY,
    batchTs,
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
    entry.ts || new Date(),
    entry.shop_domain || null,
    entry.topic || null,
    entry.order_id || null,
    entry.hash || null,
    entry.result || null,
    entry.error || null,
  ]);
}


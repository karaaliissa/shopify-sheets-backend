import dotenv from "dotenv";
dotenv.config();

import http from "http";
import crypto from "crypto";
import getRawBody from "raw-body";

import { pool, upsertOrderTx, replaceLineItemsTx, logWebhook } from "./db.js";
import { verifyShopifyHmac, normalizeOrderPayload } from "./shopify.js";

function enhanceRes(res) {
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.json = function (obj) {
    if (!this.headersSent)
      this.setHeader("Content-Type", "application/json; charset=utf-8");
    this.end(JSON.stringify(obj));
    return this;
  };
  res.send = function (txt) {
    this.end(txt);
    return this;
  };
  return res;
}

function pathOf(req) {
  const host = req.headers.host || "local";
  const url = new URL(req.url || "/", `http://${host}`);
  req.query = Object.fromEntries(url.searchParams.entries());
  return url.pathname || "/";
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (origin) {
    const ok = allowed.length === 0 || allowed.includes(origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Origin", ok ? origin : "null");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, x-app-token"
  );

  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

async function handlePing(req, res) {
  const { rows } = await pool().query("select 1 as ok");
  return res.status(200).json({ ok: rows?.[0]?.ok === 1 });
}
async function readForm(req) {
  const raw = await getRawBody(req, { limit: "200kb", encoding: "utf8" });
  return Object.fromEntries(new URLSearchParams(raw));
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}
function parseTags(tagsStr) {
  if (!tagsStr) return [];
  return String(tagsStr)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function serializeTags(tagsArr) {
  // Shopify style: "A, B, C"
  return (tagsArr || []).join(", ");
}

function titleCaseTag(s) {
  // keeps "VIP" etc if already uppercase short
  const x = String(s || "").trim();
  if (!x) return "";
  if (x.length <= 4 && x === x.toUpperCase()) return x;
  return x
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ")
    .trim();
}

function normalizeTagsForStore(tagsArr) {
  // de-dupe case-insensitive, keep first canonical Title Case
  const out = [];
  const seen = new Set();
  for (const raw of tagsArr || []) {
    const t = titleCaseTag(raw);
    const key = t.toLowerCase();
    if (!t) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
function normalizeTagName(tag) {
  // Shopify tags are usually case-sensitive visually, بس نحنا بدنا نفس الformat عندك:
  // "Processing, Shipped, Complete"
  return String(tag || "").trim();
}

function joinTags(tagsArr) {
  // keep your DB style: comma + space
  return (tagsArr || []).filter(Boolean).join(", ");
}

async function handleOrdersSummary(req, res) {
  const shop = String(req.query?.shop || "")
    .toLowerCase()
    .trim();
  if (!shop) return res.status(400).json({ ok: false, error: "Missing shop" });

  // tags format: "Processing, Shipped, Complete"
  // نعدّهم بطريقة safe:
  const { rows } = await pool().query(
    `
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN (',' || LOWER(COALESCE(tags,'')) || ',') LIKE '%,processing,%' THEN 1 ELSE 0 END)::int AS processing,
      SUM(CASE WHEN (',' || LOWER(COALESCE(tags,'')) || ',') LIKE '%,shipped,%' THEN 1 ELSE 0 END)::int AS shipped,
      SUM(CASE WHEN (',' || LOWER(COALESCE(tags,'')) || ',') LIKE '%,complete,%' THEN 1 ELSE 0 END)::int AS complete
    FROM tbl_order
    WHERE shop_domain=$1
    `,
    [shop]
  );

  return res.status(200).json({ ok: true, shop, ...(rows?.[0] || {}) });
}

async function handleOrdersTags(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const f = await readForm(req);
  const shop = String(f.shop || "").toLowerCase();
  const orderId = String(f.orderId || "").trim();
  const action = String(f.action || "").toLowerCase(); // add/remove/set(optional)
  const tagRaw = String(f.tag || "").trim();

  if (!shop || !orderId) {
    return res.status(400).json({ ok: false, error: "Missing shop/orderId" });
  }
  if (!tagRaw) {
    return res.status(400).json({ ok: false, error: "Missing tag" });
  }
  if (action !== "add" && action !== "remove") {
    return res.status(400).json({ ok: false, error: "Invalid action" });
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT tags
       FROM tbl_order
       WHERE shop_domain=$1 AND order_id=$2
       FOR UPDATE`,
      [shop, orderId]
    );

    if (!rows?.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Order not found" });
    }

    const currentTags = normalizeTagsForStore(parseTags(rows[0].tags));
    const tag = titleCaseTag(tagRaw);
    const key = tag.toLowerCase();

    let nextTags = currentTags.slice();

    if (action === "add") {
      if (!nextTags.some((t) => t.toLowerCase() === key)) nextTags.push(tag);
    } else if (action === "remove") {
      nextTags = nextTags.filter((t) => t.toLowerCase() !== key);
    }

    nextTags = normalizeTagsForStore(nextTags);
    const tagsStr = serializeTags(nextTags);

    await client.query(
      `UPDATE tbl_order
       SET tags = NULLIF($3,'')
       WHERE shop_domain=$1 AND order_id=$2`,
      [shop, orderId, tagsStr]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      ok: true,
      shop,
      order_id: orderId,
      tags: nextTags, // array
      tags_str: tagsStr, // string "A, B, C"
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    client.release();
  }
}
function decodeCursor(s) {
  try {
    return JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function handleOrdersPage(req, res) {
  const { shop, status, limit, cursor, search } = req.query || {};
  const pageSize = Math.min(
    Math.max(parseInt(limit || "50", 10) || 50, 1),
    200
  );

  const cur = cursor ? decodeCursor(cursor) : null;
  const curUpdatedAt = cur?.updated_at || null;
  const curOrderId = cur?.order_id || null;

  const where = [];
  const vals = [];
  let i = 1;

  if (shop) {
    where.push(`shop_domain=$${i++}`);
    vals.push(String(shop).toLowerCase());
  }

  // status filter (حسب tags أو fulfillment_status)
  if (status && status !== "all") {
    // أبسط حل: tags ILIKE
    where.push(`(',' || LOWER(COALESCE(tags,'')) || ',') LIKE $${i++}`);
    vals.push(`%,${String(status).toLowerCase()},%`);
  }

  if (search) {
    const q = `%${String(search).toLowerCase()}%`;
    where.push(`(
      LOWER(COALESCE(order_name,'')) LIKE $${i++}
      OR LOWER(COALESCE(customer_email,'')) LIKE $${i++}
      OR LOWER(COALESCE(ship_name,'')) LIKE $${i++}
      OR LOWER(COALESCE(order_id,'')) LIKE $${i++}
    )`);
    vals.push(q, q, q, q);
  }

  if (curUpdatedAt && curOrderId) {
    where.push(`(
      (updated_at < $${i++}::timestamp)
      OR (updated_at = $${i++}::timestamp AND order_id < $${i++})
    )`);
    vals.push(curUpdatedAt, curUpdatedAt, String(curOrderId));
  }

  const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT *
    FROM tbl_order
    ${wsql}
    ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST, order_id DESC

    LIMIT $${i++}
  `;
  vals.push(pageSize + 1);

  const { rows } = await pool().query(sql, vals);
  const items = rows.slice(0, pageSize);

  const next = rows.length > pageSize ? items[items.length - 1] : null;
  const nextCursor = next
    ? encodeCursor({ updated_at: next.updated_at, order_id: next.order_id })
    : null;

  return res.status(200).json({
    ok: true,
    items,
    nextCursor,
    total: undefined, // optional later
  });
}
async function handleOrderItems(req, res) {
  const shop = String(req.query?.shop || "").toLowerCase();
  const orderId = String(req.query?.order_id || "").trim();
  if (!shop || !orderId)
    return res.status(400).json({ ok: false, error: "Missing shop/order_id" });

  const { rows } = await pool().query(
    `SELECT title as "TITLE",
            variant_title as "VARIANT_TITLE",
            quantity as "QUANTITY",
            fulfillable_quantity as "FULFILLABLE_QUANTITY",
            sku as "SKU",
            image as "IMAGE",
            unit_price as "UNIT_PRICE",
            line_total as "LINE_TOTAL",
            currency as "CURRENCY",
            properties_json as "PROPERTIES_JSON"
     FROM tbl_order_line_item
     WHERE shop_domain=$1 AND order_id=$2
     ORDER BY line_id ASC`,
    [shop, orderId]
  );

  return res.status(200).json({ ok: true, items: rows || [] });
}
async function handleDeliverBy(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  const f = await readForm(req);
  const shop = String(f.shop || "").toLowerCase();
  const orderId = String(f.orderId || "").trim();
  const deliverBy = String(f.deliverBy || "").trim(); // YYYY-MM-DD or ''

  await pool().query(
    `UPDATE tbl_order
     SET deliver_by = NULLIF($3,'')::date
     WHERE shop_domain=$1 AND order_id=$2`,
    [shop, orderId, deliverBy]
  );

  return res.status(200).json({ ok: true, deliverBy: deliverBy || null });
}

async function handleNoteLocal(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  const f = await readForm(req);
  const shop = String(f.shop || "").toLowerCase();
  const orderId = String(f.orderId || "").trim();
  const noteLocal = String(f.noteLocal || "").trim();

  await pool().query(
    `UPDATE tbl_order
     SET note_local = NULLIF($3,'')
     WHERE shop_domain=$1 AND order_id=$2`,
    [shop, orderId, noteLocal]
  );

  return res.status(200).json({ ok: true, noteLocal: noteLocal || null });
}

async function handleWebhookShopify(req, res) {
  // 1) Method guard
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) Headers
  const topic = String(req.headers["x-shopify-topic"] || "").trim();
  const shopDomain = String(req.headers["x-shopify-shop-domain"] || "").trim();
  const headerHmac = String(req.headers["x-shopify-hmac-sha256"] || "").trim();

  // 3) Accept ONLY orders/create
  if (topic !== "orders/create") {
    return res.status(200).json({ ok: true, ignored: true, topic });
  }

  // 4) Secret
  const secret = String(process.env.SHOPIFY_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return res
      .status(500)
      .json({ ok: false, error: "Missing SHOPIFY_WEBHOOK_SECRET" });
  }

  // 5) HMAC header must exist
  if (!headerHmac) {
    return res.status(401).json({ ok: false, error: "Missing HMAC header" });
  }

  // 6) Read RAW body (Buffer!)
  let raw;
  try {
    const lenHeader = req.headers["content-length"];
    const len = lenHeader ? parseInt(String(lenHeader), 10) : undefined;

    raw = await getRawBody(req, {
      length: Number.isFinite(len) ? len : undefined,
      limit: "5mb",
      encoding: null, // IMPORTANT: keep Buffer
    });
  } catch (e) {
    return res
      .status(400)
      .json({ ok: false, error: "Unable to read raw body" });
  }

  // 7) Verify HMAC
  const ok = verifyShopifyHmac(raw, secret, headerHmac);
  if (!ok) {
    return res.status(401).json({ ok: false, error: "Invalid HMAC" });
  }

  // 8) Parse JSON
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  // 9) 🔥 FILTER OLD ORDERS (important!)
  const createdAt = new Date(payload?.created_at || 0).getTime();
  const now = Date.now();
  const maxAgeMs = 10 * 60 * 1000; // 10 minutes

  if (!createdAt || now - createdAt > maxAgeMs) {
    return res
      .status(200)
      .json({ ok: true, ignored: true, reason: "old_order" });
  }

  // 10) Normalize payload
  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  if (!order?.SHOP_DOMAIN || !order?.ORDER_ID) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: "Missing ORDER_ID/SHOP_DOMAIN",
    });
  }

  // 11) DB transaction
  let errMsg = "";
  const client = await pool().connect();

  try {
    await client.query("BEGIN");

    await upsertOrderTx(client, order);
    await replaceLineItemsTx(
      client,
      order.SHOP_DOMAIN,
      order.ORDER_ID,
      lineItems
    );

    await client.query("COMMIT");
  } catch (e) {
    errMsg = e?.message || String(e);
    try {
      await client.query("ROLLBACK");
    } catch {}
  } finally {
    client.release();
  }

  // 12) Log webhook (non-blocking)
  try {
    const hash = crypto
      .createHash("sha256")
      .update(raw)
      .digest("hex")
      .slice(0, 16);

    await logWebhook({
      ts: new Date().toISOString(),
      shop_domain: order.SHOP_DOMAIN,
      topic,
      order_id: order.ORDER_ID,
      hash,
      result: errMsg ? "error" : "upsert",
      error: errMsg || null,
    });
  } catch {}

  // 13) Response
  if (errMsg) {
    return res.status(500).json({ ok: false, error: errMsg });
  }

  return res.status(200).json({
    ok: true,
    order_id: order.ORDER_ID,
    items: lineItems.length,
  });
}

const server = http.createServer(async (req, res) => {
  const r = enhanceRes(res);
  const p = pathOf(req);

  if (setCors(req, r)) return;

  if (p === "/" || p === "/health") return r.status(200).send("OK");
  if (p === "/api/ping") return handlePing(req, r);
  if (p === "/api/webhooks/shopify") return handleWebhookShopify(req, r);
  if (p === "/api/orders/page") return handleOrdersPage(req, r);
  if (p === "/api/order-items") return handleOrderItems(req, r);
  if (p === "/api/orders/summary") return handleOrdersSummary(req, r);
  if (p === "/api/orders/tags") return handleOrdersTags(req, r);
  if (p === "/api/orders/deliver-by") return handleDeliverBy(req, r);
  if (p === "/api/orders/note-local") return handleNoteLocal(req, r);

  return r.status(404).json({ ok: false, error: "Not Found" });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Backend listening on", port);
  console.log("DB:", process.env.DATABASE_URL ? "OK" : "MISSING");
});

//server.js
import dotenv from "dotenv";
dotenv.config();
import https from "https";
import http from "http";
import crypto from "crypto";
import getRawBody from "raw-body";
import { pool, upsertOrderTx, replaceLineItemsTx, logWebhook } from "./db.js";
import { verifyShopifyHmac, normalizeOrderPayload } from "./shopify.js";
import { Readable } from "stream";
import { fetchVariantLookup } from "./server/lib/shopifyCatalog.js";
import { parseStockCsvStream } from "./server/lib/stockCsv.js";
import { Transform } from "stream";
import { applyOrderProcessingToInventory } from "./server/lib/inventoryApply.js";

async function handleOrdersFulfill(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const f = await readForm(req);
  const shop = String(f.shop || "").toLowerCase();
  const orderId = String(f.orderId || "").trim();
  if (!shop || !orderId) {
    return res.status(400).json({ ok: false, error: "Missing shop/orderId" });
  }

  try {
    const r1 = await fulfillOrderAllItems(shop, orderId);
    return res.status(200).json({ ok: true, ...r1 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

function httpsReqJson(url, method = "GET", headers = {}, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch { }
          resolve({ ok, status: res.statusCode, json: parsed, data });
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function shopifyBase(shopDomain) {
  // لازم يكون myshopify.com الأفضل
  return `https://${shopDomain}/admin/api/2024-10`;
}

async function fulfillOrderAllItems(shopDomain, orderId) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("Missing SHOPIFY_ADMIN_TOKEN");

  // 1) get fulfillment_orders
  const foUrl = `${shopifyBase(
    shopDomain
  )}/orders/${orderId}/fulfillment_orders.json`;
  const fo = await httpsReqJson(foUrl, "GET", {
    "X-Shopify-Access-Token": token,
  });
  if (!fo.ok) throw new Error(`Fulfillment orders fetch failed (${fo.status})`);

  const fos = fo.json?.fulfillment_orders || [];
  if (!fos.length) return { ok: true, message: "No fulfillment orders" };

  // 2) build payload for ALL fulfillments
  const line_items_by_fulfillment_order = fos
    .map((x) => ({
      fulfillment_order_id: x.id,
      // fulfill ALL remaining quantities
      fulfillment_order_line_items: (x.line_items || [])
        .map((li) => ({
          id: li.id,
          quantity: li.remaining_quantity ?? li.quantity ?? 0,
        }))
        .filter((li) => li.quantity > 0),
    }))
    .filter((x) => x.fulfillment_order_line_items.length > 0);

  if (!line_items_by_fulfillment_order.length) {
    return { ok: true, message: "Nothing to fulfill (already fulfilled)" };
  }

  // 3) create fulfillment
  const fUrl = `${shopifyBase(shopDomain)}/fulfillments.json`;
  const payload = {
    fulfillment: {
      notify_customer: false,
      line_items_by_fulfillment_order,
    },
  };

  const created = await httpsReqJson(
    fUrl,
    "POST",
    { "X-Shopify-Access-Token": token },
    payload
  );
  if (!created.ok) {
    throw new Error(
      `Fulfillment create failed (${created.status}): ${String(
        created.data
      ).slice(0, 200)}`
    );
  }

  return { ok: true, fulfillment_id: created.json?.fulfillment?.id || null };
}
async function listOrderFulfillments(shopDomain, orderId) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("Missing SHOPIFY_ADMIN_TOKEN");

  const url = `${shopifyBase(shopDomain)}/orders/${orderId}/fulfillments.json`;
  const r = await httpsReqJson(url, "GET", { "X-Shopify-Access-Token": token });
  if (!r.ok) throw new Error(`Fulfillments fetch failed (${r.status})`);

  const arr = r.json?.fulfillments || [];
  return Array.isArray(arr) ? arr : [];
}

async function cancelFulfillment(shopDomain, fulfillmentId) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("Missing SHOPIFY_ADMIN_TOKEN");

  const url = `${shopifyBase(
    shopDomain
  )}/fulfillments/${fulfillmentId}/cancel.json`;
  const r = await httpsReqJson(
    url,
    "POST",
    { "X-Shopify-Access-Token": token },
    {} // body required in docs
  );

  if (!r.ok) {
    throw new Error(
      `Fulfillment cancel failed (${r.status}): ${String(r.data).slice(0, 200)}`
    );
  }
  return r.json?.fulfillment || null;
}

// Cancel newest fulfillments first (usually your “Shipped” action created the newest one)
async function unfulfillOrder(shopDomain, orderId) {
  const fulfillments = await listOrderFulfillments(shopDomain, orderId);

  // keep only not-cancelled
  const active = fulfillments.filter((f) => {
    const st = String(f?.status || "").toLowerCase();
    return st && st !== "cancelled";
  });

  if (!active.length)
    return { ok: true, message: "No active fulfillments to cancel" };

  // newest first
  active.sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  });

  const cancelledIds = [];
  const errors = [];

  for (const f of active) {
    try {
      const out = await cancelFulfillment(shopDomain, f.id);
      cancelledIds.push(out?.id || f.id);
    } catch (e) {
      errors.push(e?.message || String(e));
    }
  }

  return {
    ok: cancelledIds.length > 0,
    cancelled_ids: cancelledIds,
    errors,
  };
}

async function shopifyGraphql(shopDomain, query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("Missing SHOPIFY_ADMIN_TOKEN");

  const url = `https://${shopDomain}/admin/api/2024-10/graphql.json`;

  const r = await httpsReqJson(
    url,
    "POST",
    { "X-Shopify-Access-Token": token },
    { query, variables }
  );

  if (!r.ok) {
    throw new Error(
      `GraphQL HTTP failed (${r.status}): ${String(r.data).slice(0, 300)}`
    );
  }

  // GraphQL can return 200 with errors
  if (r.json?.errors?.length) {
    throw new Error(
      `GraphQL errors: ${JSON.stringify(r.json.errors).slice(0, 300)}`
    );
  }

  return r.json?.data;
}

// ✅ Mark as Paid (Manual Payment) — matches Shopify admin behavior
async function markOrderAsPaid(shopDomain, orderId) {
  const gid = String(orderId || "").startsWith("gid://")
    ? String(orderId)
    : `gid://shopify/Order/${String(orderId).trim()}`;

  const query = `
    mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        userErrors { field message }
        order {
          id
          name
          canMarkAsPaid
          displayFinancialStatus
          totalOutstandingSet { shopMoney { amount currencyCode } }
        }
      }
    }
  `;

  const data = await shopifyGraphql(shopDomain, query, { input: { id: gid } });

  const payload = data?.orderMarkAsPaid;
  const errs = payload?.userErrors || [];
  if (errs.length) {
    throw new Error(
      `orderMarkAsPaid failed: ${errs.map((e) => e.message).join(" | ")}`
    );
  }

  const o = payload?.order;
  return {
    ok: true,
    order_gid: o?.id || gid,
    order_name: o?.name || null,
    financial: o?.displayFinancialStatus || null,
    outstanding: o?.totalOutstandingSet?.shopMoney || null,
  };
}

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
async function readJson(req) {
  const raw = await getRawBody(req, { limit: "200kb", encoding: "utf8" });
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
async function handleOrdersTags(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const f = await readForm(req);
  const shop = String(f.shop || "")
    .toLowerCase()
    .trim();
  const orderId = String(f.orderId || "").trim();
  const action = String(f.action || "")
    .toLowerCase()
    .trim(); // add/remove
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

  // We’ll compute these so we can use them after COMMIT
  let nextTags = [];
  let tagsStr = "";
  let normalized = "";

  try {
    await client.query("BEGIN");

    // lock row
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
    normalized = tag.toLowerCase();

    // Apply action
    if (action === "add") {
      if (!currentTags.some((t) => t.toLowerCase() === normalized)) {
        currentTags.push(tag);
      }
      // ✅ IMPORTANT: for add, nextTags must reflect currentTags
      nextTags = currentTags.slice();
    } else {
      // remove
      const beforeLen = currentTags.length;
      nextTags = currentTags.filter((t) => t.toLowerCase() !== normalized);
      // if nothing removed, keep as-is
      if (nextTags.length === beforeLen) nextTags = currentTags.slice();
    }

    // normalize + serialize
    nextTags = normalizeTagsForStore(nextTags);
    tagsStr = serializeTags(nextTags);

    // Update DB tags
    await client.query(
      `UPDATE tbl_order
       SET tags = NULLIF($3,'')
       WHERE shop_domain=$1 AND order_id=$2`,
      [shop, orderId, tagsStr]
    );

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { }
    try {
      client.release();
    } catch { }
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    try {
      client.release();
    } catch { }
  }

  // ✅ AFTER COMMIT: trigger Shopify actions (do NOT block response if it fails)
  (async () => {
    try {
      const token = process.env.SHOPIFY_ADMIN_TOKEN;
      if (!token) {
        console.log("SHOPIFY ACTION ERROR: Missing SHOPIFY_ADMIN_TOKEN");
        return;
      }

      // ✅ REMOVE SHIPPED => cancel fulfillment(s) (undo shipped in Shopify)
      if (action === "remove" && normalized === "shipped") {
        const r0 = await unfulfillOrder(shop, orderId);
        console.log("UNFULFILL RESULT", r0);
        return;
      }

      // ✅ Only below this point: "add" actions
      if (action !== "add") return;
      // ===== PROCESSING => deduct inventory (LOCAL DB only) =====
      if (normalized === "processing") {
        const rInv = await applyOrderProcessingToInventory(shop, orderId);
        console.log("INVENTORY DEDUCT RESULT", rInv);
        // ما تعمل return هون إذا بدك تكمل أي actions ثانية
      }

      // ===== SHIPPED => fulfill =====
      if (normalized === "shipped") {
        // optional safety: check if already fulfilled
        try {
          const oUrl = `${shopifyBase(shop)}/orders/${orderId}.json`;
          const o = await httpsReqJson(oUrl, "GET", {
            "X-Shopify-Access-Token": token,
          });

          const fStatus = String(
            o.json?.order?.fulfillment_status || ""
          ).toLowerCase();
          if (fStatus === "fulfilled") {
            console.log("Already fulfilled, skip fulfill", {
              orderId,
              fStatus,
            });
          } else {
            const r1 = await fulfillOrderAllItems(shop, orderId);
            console.log("FULFILL RESULT", r1);
          }
        } catch (e) {
          console.log("FULFILL PRECHECK ERROR", e?.message || String(e));
          const r1 = await fulfillOrderAllItems(shop, orderId);
          console.log("FULFILL RESULT", r1);
        }
        return;
      }

      // ===== COMPLETE => mark paid =====
      if (normalized === "complete") {
        // safety: skip if already paid
        const oUrl = `${shopifyBase(shop)}/orders/${orderId}.json`;
        const o = await httpsReqJson(oUrl, "GET", {
          "X-Shopify-Access-Token": token,
        });

        const fin = String(o.json?.order?.financial_status || "").toLowerCase();
        if (fin === "paid" || fin === "partially_paid") {
          console.log("Already paid, skip mark paid", { orderId, fin });
        } else {
          const r2 = await markOrderAsPaid(shop, orderId);
          console.log("PAID RESULT", r2);
        }
        return;
      }
    } catch (e) {
      console.log("SHOPIFY ACTION ERROR", e?.message || String(e));
    }
  })();

  // ✅ Response immediately (DB updated already)
  return res.status(200).json({
    ok: true,
    shop,
    order_id: orderId,
    tags: nextTags,
    tags_str: tagsStr,
  });
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
function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({ ok: false, status: res.statusCode, data });
          }
          try {
            resolve({ ok: true, json: JSON.parse(data) });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, data });
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchProductImage(shopDomain, productId) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token || !shopDomain || !productId) return null;

  const url = `https://${shopDomain}/admin/api/2024-10/products/${productId}.json`;
  const r = await httpsGetJson(url, { "X-Shopify-Access-Token": token });

  if (!r.ok) return null;

  const p = r.json?.product;
  return p?.image?.src || p?.images?.[0]?.src || null;
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

  // 3) Allow only needed topics
  const allowedTopics = new Set([
    "orders/create",
    "fulfillments/create",
    "fulfillments/update",
    "fulfillments/cancelled",
  ]);

  if (!allowedTopics.has(topic)) {
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

  // ========================
  //  A) Fulfillment webhooks
  // ========================
  if (
    topic === "fulfillments/create" ||
    topic === "fulfillments/update" ||
    topic === "fulfillments/cancelled"
  ) {
    const orderId = String(payload?.order_id || "").trim();
    if (!shopDomain || !orderId) {
      return res
        .status(200)
        .json({
          ok: true,
          skipped: true,
          reason: "missing shop/order_id",
          topic,
        });
    }

    const st = String(payload?.status || "").toLowerCase();
    const shouldBeShipped = st
      ? st !== "cancelled"
      : topic !== "fulfillments/cancelled";

    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const out = await applyShippedFromShopify(
        client,
        shopDomain.toLowerCase(),
        orderId,
        shouldBeShipped
      );
      await client.query("COMMIT");
      return res.status(200).json({ ok: true, topic, orderId, ...out });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch { }
      return res
        .status(500)
        .json({ ok: false, error: e?.message || String(e) });
    } finally {
      client.release();
    }
  }

  // ========================
  //  B) Orders/create webhook
  // ========================
  if (topic === "orders/create") {
    // ✅ FILTER OLD ORDERS only here
    const createdAt = new Date(payload?.created_at || 0).getTime();
    const now = Date.now();
    const maxAgeMs = 10 * 60 * 1000; // 10 minutes

    if (!createdAt || now - createdAt > maxAgeMs) {
      return res
        .status(200)
        .json({ ok: true, ignored: true, reason: "old_order" });
    }

    // ✅ Normalize payload ONLY for orders payload
    const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

    if (!order?.SHOP_DOMAIN || !order?.ORDER_ID) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "Missing ORDER_ID/SHOP_DOMAIN",
      });
    }

    // DB transaction
    let errMsg = "";
    const client = await pool().connect();

    try {
      await client.query("BEGIN");

      await upsertOrderTx(client, order);

      // enrich images (cache per product to avoid spam)
      const imgCache = new Map();

      for (const li of lineItems) {
        if (String(li.IMAGE || "").trim()) continue; // ✅ treat empty string as missing
        const pid = li.PRODUCT_ID;
        if (!pid) continue;

        if (!imgCache.has(pid)) {
          imgCache.set(pid, fetchProductImage(order.SHOP_DOMAIN, pid));
        }
        li.IMAGE = await imgCache.get(pid);
      }

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
      } catch { }
    } finally {
      client.release();
    }

    // Log webhook (non-blocking)
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
    } catch { }

    if (errMsg) {
      return res.status(500).json({ ok: false, error: errMsg });
    }

    return res.status(200).json({
      ok: true,
      order_id: order.ORDER_ID,
      items: lineItems.length,
    });
  }

  // Should never reach here (topics are already filtered)
  return res.status(200).json({ ok: true, ignored: true, topic });
}

async function applyShippedFromShopify(client, shop, orderId, shouldBeShipped) {
  // lock row
  const { rows } = await client.query(
    `SELECT tags
     FROM tbl_order
     WHERE shop_domain=$1 AND order_id=$2
     FOR UPDATE`,
    [shop, orderId]
  );

  if (!rows?.length) return { ok: false, reason: "order_not_found" };

  const current = normalizeTagsForStore(parseTags(rows[0].tags));
  const hasShipped = current.some((t) => t.toLowerCase() === "shipped");

  let next = current.slice();

  if (shouldBeShipped && !hasShipped) next.push("Shipped");
  if (!shouldBeShipped && hasShipped)
    next = next.filter((t) => t.toLowerCase() !== "shipped");

  next = normalizeTagsForStore(next);
  const tagsStr = serializeTags(next);

  await client.query(
    `UPDATE tbl_order
     SET tags = NULLIF($3,'')
     WHERE shop_domain=$1 AND order_id=$2`,
    [shop, orderId, tagsStr]
  );

  return { ok: true, tags: next, tags_str: tagsStr };
}
// ✅ Inventory Import (CSV streaming) — handles big files safely
async function handleInventoryImport(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const shop = String(req.query?.shop || "").toLowerCase().trim();
  if (!shop) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing shop in query" });
  }

  // ✅ count bytes without buffering whole file
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      cb(null, chunk); // pass-through
    },
  });
  req.pipe(counter);

  // 1) Shopify variant lookup (your swap/material heuristics live here)
  const { lookup, makeKey } = await fetchVariantLookup(shop);

  // 2) aggregate ON THE FLY
  const agg = new Map(); // key => qty
  let parsedRows = 0;
  let emitted = 0;

  try {
    const stats = await parseStockCsvStream(counter, (row) => {
      emitted++;
      const key = makeKey(row.title, row.color, row.size);
      agg.set(key, (agg.get(key) || 0) + Number(row.qty || 0));
    });

    parsedRows = stats?.parsed || 0;

    // 3) match
    const items = [];
    const unmatched = [];

    for (const [key, qty] of agg.entries()) {
      const v = lookup.get(key);
      if (!v) {
        const [t, c, s] = key.split("|");
        unmatched.push({
          product_title: t || "",
          color: c || "",
          size: s || "",
          qty: Number(qty || 0),
          key,
        });
        continue;
      }
      items.push({ variant_id: String(v.variant_id), qty: Number(qty || 0) });
    }

    // ✅ build helpful outputs
    const unmatched_text = unmatched
      .map(
        (u, i) =>
          `${i + 1}) ${u.product_title} | ${u.color} | ${u.size} | qty=${u.qty}`
      )
      .join("\n");

    const unmatched_csv =
      "title,color,size,qty\n" +
      unmatched
        .map((u) => `${u.product_title},${u.color},${u.size},${u.qty}`)
        .join("\n");

    // ✅ Excel-friendly (tab-separated)
    const unmatched_tsv =
      "title\tcolor\tsize\tqty\n" +
      unmatched
        .map((u) => `${u.product_title}\t${u.color}\t${u.size}\t${u.qty}`)
        .join("\n");

    // 4) upsert matched inventory
    let matched = 0;
    const chunkSize = 500;

    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);

      const vals = [];
      const params = [];
      let p = 1;

      for (const it of chunk) {
        vals.push(`($${p++}, $${p++}, now())`);
        params.push(String(it.variant_id), Number(it.qty));
      }

      const sql = `
        insert into inventory_stock (variant_id, qty, updated_at)
        values ${vals.join(",")}
        on conflict (variant_id)
        do update set qty = excluded.qty, updated_at = now()
      `;

      await pool().query(sql, params);
      matched += chunk.length;
    }

    return res.status(200).json({
      ok: true,
      shop,
      bytes_received: bytes || Number(req.headers["content-length"] || 0),
      csv_parser: stats,
      parsed_rows: parsedRows,
      emitted_rows: emitted,
      unique_keys: agg.size,
      matched,
      unmatched_count: unmatched.length,

      // keep small sample
      unmatched_sample: unmatched.slice(0, 50),

      // ✅ best for you
      unmatched_text: unmatched_text.slice(0, 15000),
      unmatched_csv: unmatched_csv.slice(0, 15000),
      unmatched_tsv: unmatched_tsv.slice(0, 15000),

      // ✅ full structured for scripts
      unmatched_json: unmatched.slice(0, 500), // (optional cap)

      note: unmatched.length
        ? `Unmatched exist. Use unmatched_text / unmatched_tsv (count=${unmatched.length}).`
        : "All matched ✅",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

async function handleInventorySet(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const shop = String(req.query?.shop || "").toLowerCase().trim(); // optional
  const body = await readJson(req);

  const variant_id = String(body?.variant_id || "").trim();
  const qtyNum = Number(body?.qty);

  if (!variant_id) return res.status(400).json({ ok: false, error: "missing_variant_id" });
  if (!Number.isFinite(qtyNum) || qtyNum < 0)
    return res.status(400).json({ ok: false, error: "invalid_qty" });

  const qty = Math.floor(qtyNum);

  await pool().query(
    `
    insert into inventory_stock(variant_id, qty, updated_at)
    values ($1, $2, now())
    on conflict (variant_id)
    do update set qty = excluded.qty, updated_at = now()
    `,
    [variant_id, qty]
  );

  return res.status(200).json({ ok: true, shop, variant_id, qty });
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
  if (p === "/api/orders/fulfill") return handleOrdersFulfill(req, r);
  if (p === "/api/inventory/import") return handleInventoryImport(req, r);
  if (p === "/api/inventory/search") return handleInventorySearch(req, r);
  if (p === "/api/inventory/set") return handleInventorySet(req, r);

  return r.status(404).json({ ok: false, error: "Not Found" });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Backend listening on", port);
  console.log("DB:", process.env.DATABASE_URL ? "OK" : "MISSING");
});

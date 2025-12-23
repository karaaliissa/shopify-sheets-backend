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
    res.setHeader("Access-Control-Allow-Origin", ok ? origin : origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
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

async function handleWebhookShopify(req, res) {
  // 1) Method guard
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) Read headers
  const topic = String(req.headers["x-shopify-topic"] || "").trim();
  const shopDomain = String(req.headers["x-shopify-shop-domain"] || "").trim();
  const headerHmac = String(req.headers["x-shopify-hmac-sha256"] || "").trim();

  // 3) Only accept orders/create (ignore everything else)
  // IMPORTANT: do this AFTER reading topic, but BEFORE DB work
  if (topic !== "orders/create") {
    // Respond 200 so Shopify doesn't keep retrying
    return res.status(200).json({ ok: true, ignored: true, topic });
  }

  // 4) Secret check
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

  // 6) Read RAW body EXACTLY (Buffer)
  let raw;
  try {
    const lenHeader = req.headers["content-length"];
    const len = lenHeader ? parseInt(String(lenHeader), 10) : undefined;

    raw = await getRawBody(req, {
      length: Number.isFinite(len) ? len : undefined,
      limit: "5mb",
      encoding: null, // keep Buffer
    });
  } catch (e) {
    console.error("RAW BODY READ ERROR:", e?.message || e);
    return res
      .status(400)
      .json({ ok: false, error: "Unable to read raw body" });
  }

  // 7) Verify HMAC
  const ok = verifyShopifyHmac(raw, secret, headerHmac);
  if (!ok) {
    // Return 401 so you know it failed verification
    return res.status(401).json({ ok: false, error: "Invalid HMAC" });
  }

  // 8) Parse JSON
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  // 9) Normalize payload into DB model
  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  // If missing identifiers, skip safely (don't crash Shopify)
  if (!order?.SHOP_DOMAIN || !order?.ORDER_ID) {
    return res
      .status(200)
      .json({
        ok: true,
        skipped: true,
        reason: "Missing ORDER_ID/SHOP_DOMAIN",
      });
  }

  // 10) Write to DB
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
    console.error("TX DB ERROR:", errMsg);
  } finally {
    client.release();
  }

  // 11) Log webhook (never block response)
  try {
    const hash = crypto
      .createHash("sha256")
      .update(raw)
      .digest("hex")
      .slice(0, 16);
    await logWebhook({
      ts: new Date().toISOString(),
      shop_domain: order.SHOP_DOMAIN || shopDomain,
      topic,
      order_id: order.ORDER_ID,
      hash,
      result: errMsg ? "error" : "upsert",
      error: errMsg || null,
    });
  } catch (e) {
    // ignore logging errors
  }

  // 12) Respond
  if (errMsg) return res.status(500).json({ ok: false, error: errMsg });
  return res.status(200).json({ ok: true, result: "upsert" });
}

const server = http.createServer(async (req, res) => {
  const r = enhanceRes(res);
  const p = pathOf(req);

  if (setCors(req, r)) return;

  if (p === "/" || p === "/health") return r.status(200).send("OK");
  if (p === "/api/ping") return handlePing(req, r);
  if (p === "/api/webhooks/shopify") return handleWebhookShopify(req, r);

  return r.status(404).json({ ok: false, error: "Not Found" });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Backend listening on", port);
  console.log("DB:", process.env.DATABASE_URL ? "OK" : "MISSING");
});

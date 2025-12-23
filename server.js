import dotenv from "dotenv";
dotenv.config();

import http from "http";
import crypto from "crypto";
import getRawBody from "raw-body";

import { pool, upsertOrder, replaceLineItems, logWebhook } from "./db.js";
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const topic = String(req.headers["x-shopify-topic"] || "");
  const shopDomain = String(req.headers["x-shopify-shop-domain"] || "");
  const headerHmac = String(req.headers["x-shopify-hmac-sha256"] || "");

  // IMPORTANT: read raw bytes EXACTLY
  let raw;
  try {
    const len = req.headers["content-length"]
      ? parseInt(String(req.headers["content-length"]), 10)
      : null;

    raw = await getRawBody(req, {
      length: Number.isFinite(len) ? len : undefined,
      limit: "5mb",
      encoding: null, // ✅ keep as Buffer
    });
  } catch (e) {
    console.error("RAW BODY READ ERROR:", e?.message || e);
    return res
      .status(400)
      .json({ ok: false, error: "Unable to read raw body" });
  }

  // 🔥 Debug logs (always)
  console.log("HIT webhook", {
    topic,
    shop: shopDomain,
    hasHmac: !!headerHmac,
    hmacLen: headerHmac.length,
    rawLen: raw?.length || 0,
  });

  // ✅ DEBUG BYPASS (only if header matches env token)
  const bypassToken = String(process.env.DEBUG_BYPASS_TOKEN || "").trim();
  const gotBypass = String(req.headers["x-bypass-token"] || "").trim();
  const bypass = bypassToken && gotBypass && gotBypass === bypassToken;

  if (bypass) {
    console.log("✅ DEBUG BYPASS ENABLED (skipping HMAC)");
  } else {
    const secret = String(process.env.SHOPIFY_WEBHOOK_SECRET || "").trim();
    if (!secret)
      return res
        .status(500)
        .json({ ok: false, error: "Missing SHOPIFY_WEBHOOK_SECRET" });

    const ok = verifyShopifyHmac(raw, secret, headerHmac);
    console.log("HMAC OK?", ok);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid HMAC" });
  }

  // --- parse JSON ---
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  if (!order.SHOP_DOMAIN || !order.ORDER_ID) {
    // do not crash; just skip
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: "Missing ORDER_ID/SHOP_DOMAIN",
    });
  }

  let errMsg = "";
  try {
    await upsertOrder(order);
    await replaceLineItems(order.SHOP_DOMAIN, order.ORDER_ID, lineItems);
  } catch (e) {
    errMsg = e?.message || String(e);
    console.error("DB WRITE ERROR:", errMsg);
  }

  // log webhook (never block response)
  try {
    const hash = crypto
      .createHash("sha256")
      .update(raw)
      .digest("hex")
      .slice(0, 16);
    await logWebhook({
      ts: new Date().toISOString(),
      shop_domain: shopDomain,
      topic,
      order_id: order.ORDER_ID,
      hash,
      result: errMsg ? "error" : "upsert",
      error: errMsg || null,
    });
  } catch {}

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
  if (p === "/debug/headers") {
    return res.status(200).json({
      ok: true,
      method: req.method,
      headers: req.headers,
      query: req.query,
    });
  }
  return r.status(404).json({ ok: false, error: "Not Found" });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Backend listening on", port);
  console.log("DB:", process.env.DATABASE_URL ? "OK" : "MISSING");
});

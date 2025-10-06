// /pages/api/webhooks/shopify.js
import getRawBody from "raw-body";
import crypto from "crypto";
import { verifyShopifyHmac, normalizeOrderPayload, enrichLineItemImages } from "../lib/shopify.js";
import { upsertOrder, writeLineItems, logWebhook } from "../lib/sheets.js";

const {
  SHOPIFY_WEBHOOK_SECRET,
  DEBUG_BYPASS_TOKEN,
  ALLOW_DEBUG_BYPASS = "false",
  SHOPIFY_ADMIN_TOKEN, // ⬅️ added
} = process.env;

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const topic =
    req.headers["x-shopify-topic"] ||
    req.headers["X-Shopify-Topic"] ||
    "";
  const shopDomain =
    req.headers["x-shopify-shop-domain"] ||
    req.headers["X-Shopify-Shop-Domain"] ||
    "";
  const headerHmac =
    req.headers["x-shopify-hmac-sha256"] ||
    req.headers["X-Shopify-Hmac-Sha256"] ||
    "";

  let raw;
  try {
    raw = await getRawBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "Unable to read raw body" });
  }

  const bypassHeader = req.headers["x-debug-bypass"];
  const allowBypass =
    ALLOW_DEBUG_BYPASS.toLowerCase() === "true" &&
    DEBUG_BYPASS_TOKEN &&
    bypassHeader === DEBUG_BYPASS_TOKEN;

  let hmacOk = false;
  if (allowBypass) {
    hmacOk = true;
  } else {
    if (!SHOPIFY_WEBHOOK_SECRET) {
      return res.status(500).json({ ok: false, error: "Missing SHOPIFY_WEBHOOK_SECRET" });
    }
    hmacOk = verifyShopifyHmac(raw, SHOPIFY_WEBHOOK_SECRET, headerHmac);
  }

  if (!hmacOk) {
    return res.status(401).json({ ok: false, error: "Invalid HMAC" });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  // Normalize Shopify -> sheet shape
  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  // ⬇️ INSERTED: enrich images only if token exists; non-fatal if it fails
  let items = lineItems;
  try {
    items = await enrichLineItemImages(shopDomain, items, SHOPIFY_ADMIN_TOKEN);
  } catch (e) {
    console.error("enrichLineItemImages:", e?.message || e);
  }

  // Persist
  let action = "none";
  let errMsg = "";
  try {
    const resUpsert = await upsertOrder(order); // { action: 'inserted' | 'updated' | 'skipped-older-or-equal' }
    action = resUpsert?.action || "none";

    const batchTs = Date.now();
    if (Array.isArray(items) && items.length) {
      await writeLineItems(items, batchTs); // ⬅️ use possibly enriched items
    }
  } catch (e) {
    errMsg = e?.message || String(e);
  }

  // Log attempt
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  try {
    await logWebhook({
      TS: new Date().toISOString(),
      SHOP_DOMAIN: shopDomain,
      TOPIC: topic,
      ORDER_ID: order?.ORDER_ID ?? "",
      HASH: hash,
      RESULT: action,
      ERROR: errMsg,
    });
  } catch (e) {
    console.error("logWebhook error:", e?.message || e);
  }

  if (errMsg) return res.status(500).json({ ok: false, error: errMsg });
  return res.status(200).json({ ok: true, result: action });
}

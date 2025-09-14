// /pages/api/webhooks/shopify.js
import getRawBody from "raw-body";
import crypto from "crypto";
import { verifyShopifyHmac, normalizeOrderPayload } from "../../lib/shopify.js";
import { upsertOrder, writeLineItems, logWebhook } from "../../lib/sheets.js";

// ─────────────────────────────────────────────────────────────
// ENV
// SHOPIFY_WEBHOOK_SECRET  -> from Shopify "Webhook secret" (used to sign webhooks)
// DEBUG_BYPASS_TOKEN      -> any string you choose (only for Postman testing)
// ALLOW_DEBUG_BYPASS      -> "true" to allow bypass, anything else disables it
// (Optional) SHOPIFY_ADMIN_TOKEN / SHOPIFY_API_KEY / SHOPIFY_API_SECRET are NOT
// used for HMAC verification and can be used elsewhere in your app.
// ─────────────────────────────────────────────────────────────
const {
  SHOPIFY_WEBHOOK_SECRET,
  DEBUG_BYPASS_TOKEN,
  ALLOW_DEBUG_BYPASS = "false",
} = process.env;

// Raw body is required for Shopify HMAC verification
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // Headers we care about
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

  // Read raw request body (Buffer)
  let raw;
  try {
    raw = await getRawBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "Unable to read raw body" });
  }

  // Optional debug bypass for Postman
  const bypassHeader = req.headers["x-debug-bypass"];
  const allowBypass =
    ALLOW_DEBUG_BYPASS.toLowerCase() === "true" &&
    DEBUG_BYPASS_TOKEN &&
    bypassHeader === DEBUG_BYPASS_TOKEN;

  // Verify HMAC unless bypass is explicitly enabled
  let hmacOk = false;
  if (allowBypass) {
    hmacOk = true;
  } else {
    if (!SHOPIFY_WEBHOOK_SECRET) {
      return res
        .status(500)
        .json({ ok: false, error: "Missing SHOPIFY_WEBHOOK_SECRET" });
    }
    hmacOk = verifyShopifyHmac(raw, SHOPIFY_WEBHOOK_SECRET, headerHmac);
  }

  if (!hmacOk) {
    return res.status(401).json({ ok: false, error: "Invalid HMAC" });
  }

  // Parse JSON
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  // Normalize to your sheet shape
  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  // Persist
  let action = "none";
  let errMsg = "";
  try {
    const resUpsert = await upsertOrder(order); // { action: 'insert' | 'update' }
    action = resUpsert?.action || "none";

    const batchTs = Date.now();
    if (Array.isArray(lineItems) && lineItems.length) {
      await writeLineItems(lineItems, batchTs);
    }
  } catch (e) {
    errMsg = e?.message || String(e);
  }

  // Log the webhook attempt
  const hash = crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, 16);

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
    // Logging failures shouldn't fail the webhook
    console.error("logWebhook error:", e?.message || e);
  }

  if (errMsg) return res.status(500).json({ ok: false, error: errMsg });
  return res.status(200).json({ ok: true, result: action });
}

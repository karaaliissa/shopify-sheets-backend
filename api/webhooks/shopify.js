import getRawBody from "raw-body";
import crypto from "crypto";
import { verifyShopifyHmac, normalizeOrderPayload } from "../../lib/shopify.js";
import { upsertOrder, writeLineItems, logWebhook } from "../../lib/sheets.js";

const {
  SHOPIFY_APP_SECRET,
  DEBUG_BYPASS_TOKEN,
  ALLOW_DEBUG_BYPASS = "false"
} = process.env;

export const config = { api: { bodyParser: false } }; // important for raw body

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  const topic = req.headers["x-shopify-topic"] || "";
  const shopDomain = req.headers["x-shopify-shop-domain"] || "";
  const headerHmac = req.headers["x-shopify-hmac-sha256"] || "";

  let raw;
  try {
    raw = await getRawBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Unable to read raw body" });
  }

  // optional debug bypass (for Postman only)
  const bypass = req.headers["x-debug-bypass"];
  const allowBypass = ALLOW_DEBUG_BYPASS.toLowerCase() === "true" && DEBUG_BYPASS_TOKEN && bypass === DEBUG_BYPASS_TOKEN;

  const hmacOk = allowBypass || verifyShopifyHmac(raw, SHOPIFY_APP_SECRET, headerHmac);
  if (!hmacOk) {
    return res.status(401).json({ ok: false, error: "Invalid HMAC" });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

  let action = "none";
  let errMsg = "";
  try {
    const resUpsert = await upsertOrder(order);
    action = resUpsert.action;
    const batchTs = Date.now();
    await writeLineItems(lineItems, batchTs);
  } catch (e) {
    errMsg = e?.message || String(e);
  }

  // log
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  await logWebhook({
    TS: new Date().toISOString(),
    SHOP_DOMAIN: shopDomain,
    TOPIC: topic,
    ORDER_ID: order.ORDER_ID,
    HASH: hash,
    RESULT: action,
    ERROR: errMsg
  });

  if (errMsg) return res.status(500).json({ ok: false, error: errMsg });
  return res.status(200).json({ ok: true, result: action });
}

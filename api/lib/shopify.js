// lib/shopify.js
import crypto from "crypto";

/* ------------------------------------------------------------------ */
/* HMAC                                                               */
/* ------------------------------------------------------------------ */
export function verifyShopifyHmac(rawBodyBuffer, secret, headerHmac) {
  if (!secret || !headerHmac) return false;

  // 🔥 Shopify secret is HEX → convert to bytes
  const secretBuffer = Buffer.from(secret, "hex");

  const digest = crypto
    .createHmac("sha256", secretBuffer)
    .update(rawBodyBuffer)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(headerHmac)
    );
  } catch {
    return false;
  }
}


/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalize phone numbers so they store safely in Google Sheets.
 * - Keeps only digits and a leading '+'
 * - Converts 00xx → +xx
 * - For Lebanon, converts local 0xxxxxxxx to +961xxxxxxxx
 * - If the value starts with '+', prefixes an apostrophe so Sheets stores as text
 *   (avoids #ERROR caused by a leading '+')
 */
function normalizePhone(raw = "", country = "") {
  let s = String(raw || "").trim();
  if (!s) return "";

  // Keep digits and a single leading +
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);

  // Country-specific tidy (Lebanon example)
  const isLebanon =
    String(country || "").toLowerCase() === "lebanon" ||
    String(country || "").toLowerCase() === "lb";
  if (!s.startsWith("+") && isLebanon) {
    const digits = s.replace(/\D/g, "");
    if (digits.startsWith("0")) {
      // 03xxxxxx → +9613xxxxxx, 0 dropped after country code
      s = "+961" + digits.slice(1);
    } else if (digits) {
      s = "+961" + digits; // fallback if already missing leading 0
    }
  }

  // If it still doesn't start with +, just return digits
  if (!s.startsWith("+")) s = s.replace(/\D/g, "");

  // Sheets hack: if value starts with '+', prefix apostrophe so Sheets stores text
  return s.startsWith("+") ? "'" + s : s;
}

/* ------------------------------------------------------------------ */
/* Normalization (Order + Line Items)                                 */
/* ------------------------------------------------------------------ */
export function normalizeOrderPayload(payload, shopDomain) {
  const o = payload || {};
  const addr = o.shipping_address || {};
  const shippingLine = (o.shipping_lines && o.shipping_lines[0]) || {};

  // Discount code(s)
  const codes = Array.isArray(o.discount_codes)
    ? o.discount_codes.map((d) => d?.code).filter(Boolean)
    : [];

  const noteAttrsJson = JSON.stringify(o.note_attributes ?? []);

  const order = {
    SHOP_DOMAIN: shopDomain,
    ORDER_ID: String(o.id ?? ""),
    ORDER_NAME: o.name ?? "",
    CREATED_AT: o.created_at ?? "",
    UPDATED_AT: o.updated_at ?? "",
    CANCELLED_AT: o.cancelled_at ?? "",
    FULFILLMENT_STATUS: o.fulfillment_status ?? "",

    FINANCIAL_STATUS: o.financial_status ?? "",
    PAYMENT_GATEWAY: o.payment_gateway_names?.[0] ?? "",
    SHIPPING_METHOD: shippingLine.title ?? "",

    // Ship-to
    SHIP_NAME: [addr.first_name, addr.last_name].filter(Boolean).join(" "),
    SHIP_ADDRESS1: addr.address1 ?? "",
    SHIP_ADDRESS2: addr.address2 ?? "",
    SHIP_CITY: addr.city ?? "",
    SHIP_PROVINCE: addr.province ?? "",
    SHIP_ZIP: addr.zip ?? "",
    SHIP_COUNTRY: addr.country ?? "",
    SHIP_PHONE: normalizePhone(addr.phone ?? "", addr.country ?? ""),

    TAGS: (o.tags ?? "")?.toString(),
    TOTAL: o.total_price ?? "",
    CURRENCY: o.currency ?? "",
    CUSTOMER_EMAIL: o?.email ?? o?.customer?.email ?? "",

    // Extra columns
    NOTE: (o.note ?? "")?.toString(),
    NOTE_ATTRIBUTES: noteAttrsJson,
    SOURCE_NAME: (o.source_name ?? "")?.toString(), // 'web', 'pos', etc.
    DISCOUNT_CODES: codes.join(","), // "WELCOME10,VIP15"
  };

  // Prefer money from price_set (handles multi-currency)
  const lineItems = (o.line_items || []).map((li) => {
    const unit = Number(li.price_set?.shop_money?.amount ?? li.price ?? 0);
    const currency =
      li.price_set?.shop_money?.currency_code ?? o.currency ?? "";
    const qty = Number(li.quantity ?? 0);

    return {
      SHOP_DOMAIN: shopDomain,
      ORDER_ID: String(o.id ?? ""),
      LINE_ID: String(li.id ?? ""),
      TITLE: li.title ?? "",
      VARIANT_TITLE: li.variant_title ?? "",
      QUANTITY: qty,
      FULFILLABLE_QUANTITY: Number(
        li.fulfillable_quantity ?? li.quantity ?? 0
      ),
      SKU: li.sku ?? "",
      IMAGE:
        li?.image?.src ??
        (li?.properties?.find?.((p) => p.name === "_image")?.value ?? ""),
      PRODUCT_ID: String(li.product_id ?? ""),
      VARIANT_ID: String(li.variant_id ?? ""),
      UNIT_PRICE: unit,
      LINE_TOTAL: unit * qty,
      CURRENCY: currency,
      PROPERTIES_JSON: JSON.stringify(li.properties ?? []),
    };
  });

  return { order, lineItems };
}

/* ------------------------------------------------------------------ */
/* Admin API helper + image enrichment                                */
/* ------------------------------------------------------------------ */
async function shopifyGetJson(shopDomain, path, adminToken) {
  const url = `https://${shopDomain}/admin/api/2024-07${path}`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": adminToken },
  });
  if (!res.ok) throw new Error(`Shopify ${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

export async function enrichLineItemImages(shopDomain, items, adminToken) {
  if (!adminToken) return items;

  const byProduct = new Map();
  for (const it of items) {
    if (!it.IMAGE && it.PRODUCT_ID) {
      const key = String(it.PRODUCT_ID);
      if (!byProduct.has(key)) byProduct.set(key, []);
      byProduct.get(key).push(it);
    }
  }
  if (byProduct.size === 0) return items;

  for (const [productId, list] of byProduct) {
    const { product } = await shopifyGetJson(
      shopDomain,
      `/products/${productId}.json`,
      adminToken
    );
    const images = product?.images || [];
    const imgById = new Map(images.map((img) => [String(img.id), img.src]));
    const variants = product?.variants || [];

    for (const it of list) {
      const v = variants.find((v) => String(v.id) === String(it.VARIANT_ID));
      const imageId = v?.image_id ? String(v.image_id) : null;
      it.IMAGE =
        (imageId && imgById.get(imageId)) ||
        images[0]?.src ||
        it.IMAGE ||
        "";
    }
  }
  return items;
}

async function shopifyPutJson(shopDomain, path, adminToken, body) {
  const url = `https://${shopDomain}/admin/api/2024-07${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": adminToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Shopify ${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

export async function getOrder(shopDomain, orderId, adminToken) {
  const { order } = await shopifyGetJson(
    shopDomain,
    `/orders/${orderId}.json`,
    adminToken
  );
  return order;
}

export async function setOrderTags(shopDomain, orderId, tagsArray, adminToken) {
  const tags = (tagsArray || []).filter(Boolean).join(", ");
  // Shopify requires the full tags string; this overwrites existing tags
  const { order } = await shopifyPutJson(
    shopDomain,
    `/orders/${orderId}.json`,
    adminToken,
    { order: { id: Number(orderId), tags } }
  );
  return order; // updated order
}
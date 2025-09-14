import crypto from "crypto";

export function verifyShopifyHmac(rawBodyBuffer, secret, headerHmac) {
  if (!secret || !headerHmac) return false;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer, "utf8")
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(headerHmac));
  } catch {
    return false;
  }
}

export function normalizeOrderPayload(payload, shopDomain) {
  const o = payload || {};
  const order = {
    SHOP_DOMAIN: shopDomain,
    ORDER_ID: String(o.id ?? ""),
    ORDER_NAME: o.name ?? "",
    CREATED_AT: o.created_at ?? "",
    UPDATED_AT: o.updated_at ?? "",
    FULFILLMENT_STATUS: o.fulfillment_status ?? "",
    CANCELLED_AT: o.cancelled_at ?? "",
    TAGS: (o.tags ?? "")?.toString(),
    TOTAL: o.total_price ?? "",
    CURRENCY: o.currency ?? "",
    CUSTOMER_EMAIL: o?.email ?? o?.customer?.email ?? ""
  };

  const lineItems = (o.line_items || []).map(li => ({
    SHOP_DOMAIN: shopDomain,
    ORDER_ID: String(o.id ?? ""),
    LINE_ID: String(li.id ?? ""),
    TITLE: li.title ?? "",
    VARIANT_TITLE: li.variant_title ?? "",
    QUANTITY: Number(li.quantity ?? 0),
    FULFILLABLE_QUANTITY: Number(li.fulfillable_quantity ?? li.quantity ?? 0),
    SKU: li.sku ?? "",
    IMAGE: li?.image?.src ?? (li?.properties?.find?.(p => p.name === "_image")?.value ?? "")
  }));

  return { order, lineItems };
}

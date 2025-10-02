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
  const addr = o.shipping_address || {};
  const shippingLine = (o.shipping_lines && o.shipping_lines[0]) || {};

  const order = {
    SHOP_DOMAIN: shopDomain,
    ORDER_ID: String(o.id ?? ""),
    ORDER_NAME: o.name ?? "",
    CREATED_AT: o.created_at ?? "",
    UPDATED_AT: o.updated_at ?? "",
    CANCELLED_AT: o.cancelled_at ?? "",
    FULFILLMENT_STATUS: o.fulfillment_status ?? "",

    // NEW: to match the screenshot
    FINANCIAL_STATUS: o.financial_status ?? "",                // "paid", "pending", ...
    PAYMENT_GATEWAY: (o.payment_gateway_names?.[0] ?? ""),     // e.g. "Cash on Delivery (COD)"
    SHIPPING_METHOD: shippingLine.title ?? "",                 // e.g. "Standard Shipping"

    // Shipping to (flattened)
    SHIP_NAME: [addr.first_name, addr.last_name].filter(Boolean).join(" "),
    SHIP_ADDRESS1: addr.address1 ?? "",
    SHIP_ADDRESS2: addr.address2 ?? "",
    SHIP_CITY: addr.city ?? "",
    SHIP_PROVINCE: addr.province ?? "",
    SHIP_ZIP: addr.zip ?? "",
    SHIP_COUNTRY: addr.country ?? "",
    SHIP_PHONE: addr.phone ?? "",

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


// export function normalizeOrderPayload(payload, shopDomain) {
//   const o = payload || {};
//   const order = {
//     SHOP_DOMAIN: shopDomain,
//     ORDER_ID: String(o.id ?? ""),
//     ORDER_NAME: o.name ?? "",
//     CREATED_AT: o.created_at ?? "",
//     UPDATED_AT: o.updated_at ?? "",
//     FULFILLMENT_STATUS: o.fulfillment_status ?? "",
//     CANCELLED_AT: o.cancelled_at ?? "",
//     TAGS: (o.tags ?? "")?.toString(),
//     TOTAL: o.total_price ?? "",
//     CURRENCY: o.currency ?? "",
//     CUSTOMER_EMAIL: o?.email ?? o?.customer?.email ?? ""
//   };

//   const lineItems = (o.line_items || []).map(li => ({
//     SHOP_DOMAIN: shopDomain,
//     ORDER_ID: String(o.id ?? ""),
//     LINE_ID: String(li.id ?? ""),
//     TITLE: li.title ?? "",
//     VARIANT_TITLE: li.variant_title ?? "",
//     QUANTITY: Number(li.quantity ?? 0),
//     FULFILLABLE_QUANTITY: Number(li.fulfillable_quantity ?? li.quantity ?? 0),
//     SKU: li.sku ?? "",
//     IMAGE: li?.image?.src ?? (li?.properties?.find?.(p => p.name === "_image")?.value ?? "")
//   }));

//   return { order, lineItems };
// }

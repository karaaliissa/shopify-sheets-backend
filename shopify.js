import crypto from "crypto";

export function verifyShopifyHmac(rawBodyBuffer, secret, headerHmac) {
  if (!secret || !headerHmac) return false;

  const s = String(secret).trim();

  // Shopify secret sometimes displayed as hex; accept both safely:
  const key =
    /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0
      ? Buffer.from(s, "hex")
      : Buffer.from(s, "utf8");

  const digest = crypto.createHmac("sha256", key).update(rawBodyBuffer).digest("base64");

  try {
    // Important: headerHmac may include whitespace
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(headerHmac).trim()));
  } catch {
    return false;
  }
}


function normalizePhone(raw = "") {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = s.replace(/\D/g, "");
  return s;
}

export function normalizeOrderPayload(payload, shopDomain) {
  const o = payload || {};
  const addr = o.shipping_address || {};
  const shippingLine = (o.shipping_lines && o.shipping_lines[0]) || {};

  const orderId =
    o.id ??
    o.order_id ??
    (typeof o.admin_graphql_api_id === "string" ? o.admin_graphql_api_id.split("/").pop() : null) ??
    "";

  const order = {
    SHOP_DOMAIN: String(shopDomain || "").toLowerCase(),
    ORDER_ID: String(orderId || ""),
    ORDER_NAME: o.name ?? "",
    CREATED_AT: o.created_at ?? "",
    UPDATED_AT: o.updated_at ?? "",
    CANCELLED_AT: o.cancelled_at ?? "",
    FULFILLMENT_STATUS: o.fulfillment_status ?? "",
    FINANCIAL_STATUS: o.financial_status ?? "",
    PAYMENT_GATEWAY: o.payment_gateway_names?.[0] ?? "",
    SHIPPING_METHOD: shippingLine.title ?? "",
    TAGS: (o.tags ?? "")?.toString(),
    TOTAL: o.total_price ?? "",
    CURRENCY: o.currency ?? "",
    CUSTOMER_EMAIL: o?.email ?? o?.customer?.email ?? "",
    NOTE: (o.note ?? "")?.toString(),
    DELIVER_BY: null,
    SOURCE_NAME: (o.source_name ?? "")?.toString(),
    DISCOUNT_CODES: Array.isArray(o.discount_codes)
      ? o.discount_codes.map(d => d?.code).filter(Boolean).join(",")
      : "",
    NOTE_LOCAL: null,

    SHIP_NAME: [addr.first_name, addr.last_name].filter(Boolean).join(" "),
    SHIP_ADDRESS1: addr.address1 ?? "",
    SHIP_ADDRESS2: addr.address2 ?? "",
    SHIP_CITY: addr.city ?? "",
    SHIP_PROVINCE: addr.province ?? "",
    SHIP_ZIP: addr.zip ?? "",
    SHIP_COUNTRY: addr.country ?? "",
    SHIP_PHONE: normalizePhone(addr.phone ?? ""),
  };

  const lineItems = Array.isArray(o.line_items)
    ? o.line_items.map((li) => {
        const qty = Number(li.quantity ?? 0);
        const unit = Number(li.price_set?.shop_money?.amount ?? li.price ?? 0);
        const currency = li.price_set?.shop_money?.currency_code ?? o.currency ?? "";

        const lineId =
          String(li.id ?? "") ||
          `no_line_id_${String(li.variant_id ?? li.product_id ?? li.title ?? "x").slice(0, 40)}`;

        return {
          SHOP_DOMAIN: order.SHOP_DOMAIN,
          ORDER_ID: order.ORDER_ID,
          LINE_ID: lineId,
          TITLE: li.title ?? "",
          VARIANT_TITLE: li.variant_title ?? "",
          QUANTITY: qty,
          FULFILLABLE_QUANTITY: Number(li.fulfillable_quantity ?? li.quantity ?? 0),
          SKU: li.sku ?? "",
          IMAGE: li?.image?.src ?? "",
          PRODUCT_ID: String(li.product_id ?? ""),
          VARIANT_ID: String(li.variant_id ?? ""),
          UNIT_PRICE: unit,
          LINE_TOTAL: unit * qty,
          CURRENCY: currency,
          PROPERTIES_JSON: JSON.stringify(li.properties ?? []),
        };
      })
    : [];

  return { order, lineItems };
}

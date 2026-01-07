// server/lib/shopifycatalog.js
import { shopifyGraphql } from "./shopifyClient.js";

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[’']/g, "'")
    .replace(/[_-]+/g, " ");
}

function makeKey(title, color, size) {
  return `${norm(title)}|${norm(color)}|${norm(size)}`;
}

// --- Heuristics: detect sizes even if employee put them under Color/Size wrong ---
const SIZE_SET = new Set([
  "xxxs", "xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
]);

function looksLikeSize(v) {
  const x = norm(v);
  if (!x) return false;
  if (SIZE_SET.has(x)) return true;

  // common forms: "XS/S", "S-M", "EU 38", "38", "42", "32-34"
  if (/^(xs|s|m|l|xl|xxl|xxxl)(\/(xs|s|m|l|xl|xxl|xxxl))+$/i.test(v)) return true;
  if (/^\d{1,2}(\.\d)?$/.test(x)) return true;          // 38, 40, 42, 7.5
  if (/^\d{1,2}\s*-\s*\d{1,2}$/.test(x)) return true;   // 32-34
  if (/^(eu|us|uk)\s*\d{1,2}(\.\d)?$/.test(x)) return true;

  return false;
}

function pickOptionValue(selectedOptions, aliases) {
  const a = new Set(aliases.map(norm));
  for (const o of selectedOptions || []) {
    const name = norm(o?.name);
    if (a.has(name)) return String(o?.value || "");
  }
  return "";
}

function inferColorSize(selectedOptions) {
  const opts = (selectedOptions || []).map(o => ({
    name: String(o?.name || ""),
    value: String(o?.value || "")
  }));

  // 1) try by name (with aliases)
  let color = pickOptionValue(opts, ["color", "colour", "colors", "colours"]);
  let size = pickOptionValue(opts, ["size", "sizes"]);

  // 2) if swapped or wrong: check values
  const colorLooksSize = looksLikeSize(color);
  const sizeLooksSize = looksLikeSize(size);

  // if "size" value is NOT size, but "color" value IS size => swap
  if (color && size && colorLooksSize && !sizeLooksSize) {
    // means Color has size-like value and Size doesn't -> swap
    const tmp = color; color = size; size = tmp;
  }

  // 3) if still missing any of them, infer from all values
  if (!size) {
    // pick first value that looks like size
    const found = opts.find(o => looksLikeSize(o.value));
    if (found) size = found.value;
  }
  if (!color) {
    // pick first value that does NOT look like size and is not fabric/material
    const fabricVal = pickOptionValue(opts, ["fabric", "material"]);
    const found = opts.find(o => {
      if (!o.value) return false;
      if (fabricVal && norm(o.value) === norm(fabricVal)) return false;
      return !looksLikeSize(o.value);
    });
    if (found) color = found.value;
  }

  // 4) final cleanup
  return { color: String(color || "").trim(), size: String(size || "").trim() };
}

// server/lib/shopifyCatalog.js
export async function fetchVariantLookup(shopDomain) {
  if (!shopDomain) throw new Error("Missing shopDomain");

  const lookup = new Map();       // key(title+color+size) => item
  const byVariantId = new Map();  // variant_id => item ✅

  let cursor = null;

  const query = `
    query($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        edges {
          cursor
          node {
            id
            sku
            image { url }
            product {
              title
              featuredImage { url }
              images(first: 1) { nodes { url } }
            }
            selectedOptions { name value }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  while (true) {
    const data = await shopifyGraphql(shopDomain, query, { cursor });

    const edges = data?.productVariants?.edges || [];
    const hasNext = !!data?.productVariants?.pageInfo?.hasNextPage;

    for (const e of edges) {
      const node = e?.node || {};
      const variant_id = String(node?.id || "").split("/").pop();
      if (!variant_id) {
        cursor = e?.cursor || cursor;
        continue;
      }

      const product_title = String(node?.product?.title || "").trim();

      const { color, size } = inferColorSize(node?.selectedOptions || []);
      const sku = String(node?.sku || "").trim();

      const productImg =
        node?.product?.featuredImage?.url ||
        node?.product?.images?.nodes?.[0]?.url ||
        null;

      const image = node?.image?.url || productImg || null;

      const item = {
        variant_id,
        product_title,
        title: product_title, // 👈 لو بتحب تستخدم it.title بالفرونت
        color: color || "",
        size: size || "",
        sku,
        image,
      };

      // ✅ direct map by variant_id (important for stock UI)
      if (!byVariantId.has(variant_id)) byVariantId.set(variant_id, item);

      // ✅ key map (only if title exists)
      const key = makeKey(product_title, item.color, item.size);
      if (product_title && key && !lookup.has(key)) {
        lookup.set(key, item);
      }

      cursor = e?.cursor || cursor;
    }

    if (!hasNext) break;
  }

  return { lookup, byVariantId, makeKey, norm };
}


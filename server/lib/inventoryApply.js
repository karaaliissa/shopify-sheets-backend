// server/lib/inventoryApply.js
import { pool } from "../../db.js";

function normVariantId(v) {
  const s = String(v || "").trim();
  const m = s.match(/ProductVariant\/(\d+)/i);
  return m ? m[1] : s;
}

export async function applyOrderProcessingToInventory(shop, orderId) {
  const shopDomain = String(shop || "").toLowerCase().trim();
  const oid = String(orderId || "").trim();
  if (!shopDomain || !oid) return { ok: false, error: "missing_shop_or_order" };

  // 1) get raw line items (NO group by) then aggregate in JS after normalizing variant_id
  const { rows } = await pool().query(
    `
    select variant_id, quantity
    from tbl_order_line_item
    where shop_domain = $1 and order_id = $2
    `,
    [shopDomain, oid]
  );

  const agg = new Map(); // normalized_variant_id -> qty
  for (const r of rows) {
    const vid = normVariantId(r.variant_id);
    const q = Number(r.quantity || 0);
    if (!vid || q <= 0) continue;
    agg.set(vid, (agg.get(vid) || 0) + q);
  }

  const items = [...agg.entries()].map(([variant_id, qty]) => ({
    variant_id,
    qty,
  }));

  if (!items.length) return { ok: true, applied: 0, items: [] };

  const client = await pool().connect();
  let applied = 0;

  try {
    await client.query("BEGIN");

    for (const it of items) {
      const variant_id = String(it.variant_id || "").trim();
      const qty = Number(it.qty || 0);
      if (!variant_id || qty <= 0) continue;

      // 2) inventory_move (idempotent)
      const ins = await client.query(
        `
        insert into inventory_move(shop_domain, order_id, variant_id, qty_delta, reason)
        values ($1, $2, $3, $4, 'ORDER_PROCESSING')
        on conflict (shop_domain, order_id, variant_id, reason)
        do nothing
        returning id
        `,
        [shopDomain, oid, variant_id, -qty]
      );

      // already applied
      if (!ins.rowCount) continue;

      // 3) ensure stock row
      await client.query(
        `
        insert into inventory_stock(variant_id, qty, updated_at)
        values ($1, 0, now())
        on conflict (variant_id) do nothing
        `,
        [variant_id]
      );

      // 4) deduct stock (clamp)
      await client.query(
        `
        update inventory_stock
        set qty = greatest(qty - $2, 0), updated_at = now()
        where variant_id = $1
        `,
        [variant_id, qty]
      );

      applied++;
    }

    // 5) clear reserves for this order (because now it's processing)
    await client.query(
      `delete from inventory_reserve where shop_domain=$1 and order_id=$2`,
      [shopDomain, oid]
    );

    await client.query("COMMIT");
    return { ok: true, applied, items };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { }
    return { ok: false, error: e?.message || String(e) };
  } finally {
    client.release();
  }
}

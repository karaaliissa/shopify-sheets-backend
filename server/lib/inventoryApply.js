// server/lib/inventoryApply.js
import { pool } from "../../db.js";

export async function applyOrderProcessingToInventory(shop, orderId) {
    const shopDomain = String(shop || "").toLowerCase().trim();
    const oid = String(orderId || "").trim();
    if (!shopDomain || !oid) return { ok: false, error: "missing_shop_or_order" };

    // 1) اجمع الكميات per variant من line items
    const { rows: items } = await pool().query(
        `
    select variant_id, sum(quantity)::int as qty
    from tbl_order_line_item
    where shop_domain = $1 and order_id = $2
    group by variant_id
    `,
        [shopDomain, oid]
    );

    if (!items.length) return { ok: true, applied: 0 };

    const client = await pool().connect();
    let applied = 0;

    try {
        await client.query("BEGIN");

        for (const it of items) {
            const variant_id = String(it.variant_id || "").trim();
            const qty = Number(it.qty || 0);
            if (!variant_id || qty <= 0) continue;

            // 2) سجل حركة (idempotent)
            try {
                await client.query(
                    `
          insert into inventory_move(shop_domain, order_id, variant_id, qty_delta, reason)
          values ($1, $2, $3, $4, 'ORDER_PROCESSING')
          `,
                    [shopDomain, oid, variant_id, -qty]
                );
            } catch (e) {
                const msg = String(e?.message || "");
                // already applied => skip this variant
                if (msg.toLowerCase().includes("duplicate") || msg.includes("ux_inventory_move_once")) {
                    continue;
                }
                throw e;
            }

            // 3) اضمن row موجود في stock (بدون shop_domain)
            await client.query(
                `
        insert into inventory_stock(variant_id, qty, updated_at)
        values ($1, 0, now())
        on conflict (variant_id) do nothing
        `,
                [variant_id]
            );

            // 4) خصم
            await client.query(
                `
        update inventory_stock
        set qty = greatest(qty + $2, 0), updated_at = now()
        where variant_id = $1
        `,
                [variant_id, -qty]
            );

            applied++;
        }
await client.query(
  `delete from inventory_reserve where shop_domain=$1 and order_id=$2`,
  [shopDomain, oid]
);

        await client.query("COMMIT");
        return { ok: true, applied };
    } catch (e) {
        try { await client.query("ROLLBACK"); } catch { }
        throw e;
    } finally {
        client.release();
    }
}
// server/routes/inventory.js
import { Router } from "express";
import multer from "multer";
import { q } from "../lib/db.js";
import { ok, bad } from "../lib/http.js";
import { fetchVariantLookup } from "../lib/shopifyCatalog.js";
import { parseStockCsvStream } from "../lib/stockCsv.js";

const r = Router();
const upload = multer({ storage: multer.memoryStorage() });

r.post("/import", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Missing file");

    // 1) Build Shopify variant lookup
    const { lookup, makeKey } = await fetchVariantLookup();

    // 2) Parse CSV into records
    const { Readable } = await import("stream");
    const stream = Readable.from(req.file.buffer);

    const rows = [];
    await parseStockCsvStream(stream, (row) => rows.push(row));

    // 3) Aggregate qty per key (in case duplicates in sheet)
    const agg = new Map(); // key -> qty sum
    for (const row of rows) {
      const key = makeKey(row.title, row.color, row.size);
      const prev = agg.get(key) || 0;
      agg.set(key, prev + Number(row.qty || 0));
    }

    // 4) Match + upsert
    let matched = 0;
    const unmatched = [];

    // Build upsert batch
    const items = [];
    for (const [key, qty] of agg.entries()) {
      const v = lookup.get(key);
      if (!v) {
        // keep a sample of unmatched for debugging
        const [title, color, size] = key.split("|");
        unmatched.push({ product_title: title, color, size, qty });
        continue;
      }
      items.push({ variant_id: v.variant_id, qty });
    }

    // Upsert in chunks
    const chunkSize = 500;
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);

      // Build dynamic VALUES ($1,$2),($3,$4)...
      const vals = [];
      const params = [];
      let p = 1;
      for (const it of chunk) {
        vals.push(`($${p++}, $${p++}, now())`);
        params.push(String(it.variant_id), Number(it.qty));
      }

      const sql = `
        insert into inventory_stock (variant_id, qty, updated_at)
        values ${vals.join(",")}
        on conflict (variant_id)
        do update set qty = excluded.qty, updated_at = now()
      `;

      await q(sql, params);
      matched += chunk.length;
    }

    return ok(res, {
      total_rows_parsed: rows.length,
      unique_keys: agg.size,
      matched,
      unmatched_count: unmatched.length,
      unmatched_sample: unmatched.slice(0, 50),
      tip: unmatched.length
        ? "Some rows didn't match Shopify variants. Usually due to Color/Size naming differences. We'll add a small 'manual mapper' UI next."
        : "All good ✅",
    });
  } catch (e) {
    return bad(res, e.message);
  }
});

export default r;

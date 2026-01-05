import { parse } from "csv-parse";

const BLOCK_STARTS = [0, 6, 12, 18, 24, 30, 36];

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}
function safeNum(x) {
  const n = Number(String(x || "").trim());
  return Number.isFinite(n) ? n : null;
}

export function parseStockCsvStream(readable, onRow) {
  return new Promise((resolve, reject) => {
    let emptyStreak = 0;
    let parsed = 0;
    let emitted = 0;

    const parser = parse({
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter: [",", ";", "\t"],
    });
// ✅ supports normalized CSV: title,color,size,qty
const c0 = safeStr(record[0]).toLowerCase();
if (c0 === "title" || c0 === "product") return; // header

if (record.length >= 4) {
  const title = safeStr(record[0]);
  const color = safeStr(record[1]);
  const size  = safeStr(record[2]);
  const qty   = safeNum(record[3]);

  if (title && qty !== null) {
    anyFound = true;
    emitted++;
    onRow({ title, color, size, qty });
    return; // done for this row
  }
}

    parser.on("data", (record) => {
      parsed++;

      let anyFound = false;

      for (const s of BLOCK_STARTS) {
        const title = safeStr(record[s + 1]);
        const color = safeStr(record[s + 2]);
        const size = safeStr(record[s + 3]);
        const qty = safeNum(record[s + 4]);

        if (!title || qty === null) continue;

        const t = title.toLowerCase();
        if (t === "product" || t === "title") continue;

        anyFound = true;
        emitted++;
        onRow({ title, color, size, qty });
      }

      if (!anyFound) emptyStreak++;
      else emptyStreak = 0;

      if (emptyStreak > 5000) {
        readable.unpipe(parser);
        parser.end();
        resolve({ stoppedEarly: true, parsed, emitted });
      }
    });

    parser.on("error", reject);
    parser.on("end", () => resolve({ stoppedEarly: false, parsed, emitted }));

    readable.pipe(parser);
  });
}

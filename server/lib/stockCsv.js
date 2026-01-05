// server/lib/stockCsv.js
import { parse } from "csv-parse";

const BLOCK_STARTS = [0, 6, 12, 18, 24, 30, 36];
// each block is: [CategoryHeaderCol, Title, Color, Size, Qty, Extra]

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

    const parser = parse({
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });

    parser.on("readable", () => {
      let record;
      while ((record = parser.read()) !== null) {
        // record is an array of columns (wide)
        let anyFound = false;

        for (const s of BLOCK_STARTS) {
          const title = safeStr(record[s + 1]);
          const color = safeStr(record[s + 2]);
          const size  = safeStr(record[s + 3]);
          const qty   = safeNum(record[s + 4]);

          if (!title || qty === null) continue;

          // Ignore weird internal headers/garbage
          if (title.toLowerCase() === "product" || title.toLowerCase() === "title") continue;

          anyFound = true;
          onRow({ title, color, size, qty });
        }

        if (!anyFound) emptyStreak++;
        else emptyStreak = 0;

        // Important: your file seems to have tons of empty rows.
        // Stop after many consecutive empty rows to avoid reading 1M blanks.
        if (emptyStreak > 5000) {
          resolve({ stoppedEarly: true });
          readable.unpipe(parser);
          parser.end();
          return;
        }
      }
    });

    parser.on("error", reject);
    parser.on("end", () => resolve({ stoppedEarly: false }));

    readable.pipe(parser);
  });
}

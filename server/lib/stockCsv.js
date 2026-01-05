// server/lib/stockCsv.js
import { parse } from "csv-parse";
import iconv from "iconv-lite"; // ✅ add this

const BLOCK_STARTS = [0, 6, 12, 18, 24, 30, 36];

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function safeNum(x) {
  const n = Number(String(x || "").trim());
  return Number.isFinite(n) ? n : null;
}

function isProbablyUtf16(buf) {
  if (!buf || buf.length < 2) return false;
  // UTF-16 LE BOM: FF FE, UTF-16 BE BOM: FE FF
  return (
    (buf[0] === 0xff && buf[1] === 0xfe) ||
    (buf[0] === 0xfe && buf[1] === 0xff)
  );
}

export function parseStockCsvStream(readable, onRow) {
  return new Promise((resolve, reject) => {
    let emptyStreak = 0;
    let parsed = 0;
    let emitted = 0;

    // ✅ auto-detect delimiter (comma/semicolon/tab)
    const parser = parse({
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter: [",", ";", "\t"],
    });

    // ✅ If file is UTF-16, decode it to UTF-8
    let firstChunk = true;
    readable.on("data", (chunk) => {
      if (!firstChunk) return;
      firstChunk = false;

      // If utf16, re-pipe through decoder
      if (Buffer.isBuffer(chunk) && isProbablyUtf16(chunk)) {
        readable.pause();
        // unshift back the chunk to be decoded
        readable.unshift(chunk);

        const decoded = readable.pipe(iconv.decodeStream("utf16-le"));
        decoded.pipe(parser);
        readable.resume();
      }
    });

    parser.on("readable", () => {
      let record;
      while ((record = parser.read()) !== null) {
        parsed++;

        let anyFound = false;

        for (const s of BLOCK_STARTS) {
          const title = safeStr(record[s + 1]);
          const color = safeStr(record[s + 2]);
          const size  = safeStr(record[s + 3]);
          const qty   = safeNum(record[s + 4]);

          if (!title || qty === null) continue;

          // Ignore weird headers
          const t = title.toLowerCase();
          if (t === "product" || t === "title") continue;

          anyFound = true;
          emitted++;
          onRow({ title, color, size, qty });
        }

        if (!anyFound) emptyStreak++;
        else emptyStreak = 0;

        if (emptyStreak > 5000) {
          resolve({ stoppedEarly: true, parsed, emitted });
          readable.unpipe(parser);
          parser.end();
          return;
        }
      }
    });

    parser.on("error", (e) => reject(e));
    parser.on("end", () => resolve({ stoppedEarly: false, parsed, emitted }));

    // default pipe (utf8/normal)
    readable.pipe(parser);
  });
}

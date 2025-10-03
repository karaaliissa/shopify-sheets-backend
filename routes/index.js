import { setCors } from "../../lib/cors.js";
import { getAll, getLatestItems } from "../../lib/sheets.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.url.startsWith("/api/print-picking")) {
      // handle picking print
      const shop = (req.query.shop || "").trim();
      const q = (req.query.q || "").toLowerCase();
      if (!shop) return res.status(400).send("Missing shop");

      const tabItems = process.env.TAB_ITEMS || "TBL_ORDER_LINE_ITEM";
      const recent = await getAll(tabItems);
      const orderIds = [...new Set(recent.map(r => r.ORDER_ID))].slice(-50);

      let all = [];
      for (const id of orderIds) {
        const items = await getLatestItems(shop, id);
        all.push(...items);
      }

      return res.status(200).json(all);
    }

    if (req.url.startsWith("/api/orders")) {
      // handle orders
      return res.status(200).send("Orders logic here");
    }

    if (req.url.startsWith("/api/items")) {
      // handle items
      return res.status(200).send("Items logic here");
    }

    // Default
    return res.status(404).send("Not Found");
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
}

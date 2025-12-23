// api/router.js
import getRawBody from "raw-body";
import crypto from "crypto";
import { setCors } from "./lib/cors.js";
import { getCache, setCache, invalidateByTag, k } from "./lib/cache.js";
import {
    getOrders,
    getOrdersPage,
    getOrderItems,
    getAllOrders,
    setDeliverBy,
    setNoteLocal,
    setOrderTags,
    upsertOrder,
    writeLineItems,
    logWebhook,
} from "./lib/db.js";
import { verifyShopifyHmac, normalizeOrderPayload, enrichLineItemImages } from "./lib/shopify.js";

/* ===============================
   Small in-memory cache helper
   =============================== */
const inflight = new Map();
const MIN_REFRESH_MS = 15_000;
const lastFetchAt = new Map();

async function withCache({ key, ttlMs, tags = [], refresh = false, fetcher }) {
    const cached = getCache(key);
    if (!refresh && cached) return cached;

    if (refresh) {
        const last = lastFetchAt.get(key) || 0;
        if (Date.now() - last < MIN_REFRESH_MS && cached) return cached;
    }

    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
        try {
            const val = await fetcher();
            setCache(key, val, ttlMs, tags);
            lastFetchAt.set(key, Date.now());
            return val;
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, p);
    return p;
}

/* ===============================
   Utils
   =============================== */
const csvEsc = (s = "") => String(s).replace(/"/g, '""');
const toCSV = (rows) => {
    const headers = Object.keys(rows[0] || {});
    const body = rows
        .map((r) => headers.map((h) => `"${csvEsc(r[h] ?? "")}"`).join(","))
        .join("\n");
    return [headers.join(","), body].filter(Boolean).join("\n");
};

function exposeDownloadHeaders(res) {
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
}

async function readJsonBody(req) {
    const raw = await getRawBody(req);
    const s = raw.toString("utf8") || "";
    try {
        return JSON.parse(s);
    } catch { }
    try {
        return Object.fromEntries(new URLSearchParams(s).entries());
    } catch { }
    return {};
}

function setHttpCacheOk(res, seconds = 30) {
    res.setHeader(
        "Cache-Control",
        `public, max-age=5, s-maxage=${seconds}, stale-while-revalidate=60`
    );
}

function getPath(req) {
    const host = req.headers.host || "local";
    const url = new URL(req.url || "", `http://${host}`);
    // remove only first /api
    return (url.pathname || "/").replace(/^\/api\/?/, "/");
}

/* ===============================
   Handlers (NEON DB)
   =============================== */

async function handleOrders(req, res) {
    if (req.method !== "GET")
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const shop = String(req.query.shop || "").toLowerCase();
    const refresh = String(req.query.refresh || "") === "1";
    const limit = Math.min(Number(req.query.limit || 200), 1000);

    const key = k(["orders", shop, limit]);
    const fetcher = async () => {
        const items = await getOrders({ shopDomain: shop || undefined, limit });
        return { ok: true, items };
    };

    const payload = refresh
        ? await fetcher()
        : await withCache({ key, ttlMs: 45_000, tags: ["orders"], fetcher });

    if (refresh) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    } else {
        setHttpCacheOk(res, 45);
    }

    return res.status(200).json(payload);
}

async function handleOrdersPage(req, res) {
    if (req.method !== "GET")
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const shop = String(req.query.shop || "").toLowerCase();
    const limit = Number(req.query.limit || 50);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    const out = await getOrdersPage({ shopDomain: shop || undefined, limit, cursor });
    return res.status(200).json({ ok: true, items: out.items, nextCursor: out.nextCursor, total: out.total });
}

async function handleOrdersSummary(req, res) {
    if (req.method !== "GET")
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const all = await getAllOrders(); // all shops

    const statusOf = (r) => {
        const tags = String(r.TAGS || "").toLowerCase();
        if (tags.includes("complete")) return "complete";
        if (tags.includes("cancel")) return "cancel";
        if (tags.includes("shipped")) return "shipped";
        if (tags.includes("processing")) return "processing";
        const f = String(r.FULFILLMENT_STATUS || "").toLowerCase();
        if (!f || f === "open" || f === "unfulfilled") return "pending";
        return "pending";
    };
    const isExpress = (r) => /\bexpress\b/i.test(String(r.SHIPPING_METHOD || ""));

    const out = {
        ok: true,
        total: all.length,
        pending: 0,
        processing: 0,
        shipped: 0,
        complete: 0,
        cancel: 0,
        expressPending: 0,
        expressProcessing: 0,
        expressShipped: 0,
        expressComplete: 0,
        expressCancel: 0,
    };

    for (const r of all) {
        const s = statusOf(r);
        out[s] += 1;
        if (isExpress(r)) {
            if (s === "pending") out.expressPending++;
            else if (s === "processing") out.expressProcessing++;
            else if (s === "shipped") out.expressShipped++;
            else if (s === "complete") out.expressComplete++;
            else if (s === "cancel") out.expressCancel++;
        }
    }

    setHttpCacheOk(res, 30);
    return res.status(200).json(out);
}

async function handleItems(req, res) {
    if (req.method !== "GET")
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const shop = String(req.query.shop || "").toLowerCase();
    const orderId = String(req.query.order_id || "");
    if (!shop || !orderId)
        return res.status(400).json({ ok: false, error: "Missing shop or order_id" });

    const items = await getOrderItems({ shopDomain: shop, orderId });
    return res.status(200).json({ ok: true, items });
}

async function handleSetDeliverBy(req, res) {
    if (req.method !== "POST")
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const body = await readJsonBody(req);
    const shop = String(body.shop || "").toLowerCase();
    const orderId = String(body.orderId || "");
    let deliverBy = body.deliverBy === null ? null : String(body.deliverBy || "").trim() || null;

    if (!shop || !orderId)
        return res.status(400).json({ ok: false, error: "Missing shop or orderId" });

    if (deliverBy && !/^\d{4}-\d{2}-\d{2}$/.test(deliverBy))
        return res.status(400).json({ ok: false, error: "Bad date format (YYYY-MM-DD)" });

    await setDeliverBy({ shopDomain: shop, orderId, deliverBy });
    try { invalidateByTag("orders"); } catch { }
    return res.status(200).json({ ok: true, deliverBy });
}

async function handleSetNoteLocal(req, res) {
    if (req.method !== "POST")
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const body = await readJsonBody(req);
    const shop = String(body.shop || "").toLowerCase();
    const orderId = String(body.orderId || "");
    const noteLocal = body.noteLocal === null ? null : String(body.noteLocal || "");

    if (!shop || !orderId)
        return res.status(400).json({ ok: false, error: "Missing shop or orderId" });

    await setNoteLocal({ shopDomain: shop, orderId, noteLocal });
    try { invalidateByTag("orders"); } catch { }
    return res.status(200).json({ ok: true });
}

async function handleOrderTags(req, res) {
    if (req.method !== "POST")
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const body = await readJsonBody(req);
    const shop = String(body.shop || "").toLowerCase();
    const orderId = String(body.orderId || "");
    const action = String(body.action || "add").toLowerCase();
    const tag = String(body.tag || "").trim();
    const tagsIn = Array.isArray(body.tags) ? body.tags.map((s) => String(s).trim()).filter(Boolean) : null;

    if (!shop || !orderId) return res.status(400).json({ ok: false, error: "Missing shop or orderId" });
    if (action !== "set" && !tag) return res.status(400).json({ ok: false, error: "Missing tag" });

    const nextTags = await setOrderTags({ shopDomain: shop, orderId, action, tag, tagsIn });
    try { invalidateByTag("orders"); } catch { }
    return res.status(200).json({ ok: true, tags: nextTags });
}

async function handleShipday(req, res) {
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");
    exposeDownloadHeaders(res);

    const shop = String(req.query.shop || "").trim();
    const dateQ = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);

    const all = await getOrders({ shopDomain: shop || undefined, limit: 5000 });

    const oDate = (o) => String(o.CREATED_AT || o.UPDATED_AT || "").slice(0, 10);
    const rows = all
        .filter((o) => oDate(o) === dateQ)
        .map((o) => ({
            orderNumber: String(o.ORDER_NAME || o.ORDER_ID || "").replace(/^#/, ""),
            customerName: o.SHIP_NAME || "",
            customerPhoneNumber: o.SHIP_PHONE || "",
            customerEmail: o.CUSTOMER_EMAIL || "",
            addressLine1: o.SHIP_ADDRESS1 || "",
            addressLine2: o.SHIP_ADDRESS2 || "",
            city: o.SHIP_CITY || "",
            state: o.SHIP_PROVINCE || "",
            postalCode: o.SHIP_ZIP || "",
            country: o.SHIP_COUNTRY || "",
            paymentMethod: (o.PAYMENT_GATEWAY || "").toLowerCase().includes("cod") ? "COD" : "Prepaid",
            codAmount: "",
            note: o.NOTE || "",
        }))
        .filter((r) => r.orderNumber);

    const csv = rows.length ? toCSV(rows) : "orderNumber\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shipday-${dateQ}.csv"`);
    return res.status(200).send(csv);
}

async function handlePickingList(req, res) {
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    const shop = String(req.query.shop || "").toLowerCase();
    const fromIso = req.query.from ? new Date(req.query.from) : null;
    const toIso = req.query.to ? new Date(req.query.to) : null;

    const orders = await getOrders({ shopDomain: shop || undefined, limit: 5000 });

    const ordersFiltered = orders.filter((o) => {
        const t = new Date(o.CREATED_AT || o.UPDATED_AT || 0).getTime();
        if (fromIso && t < fromIso.getTime()) return false;
        if (toIso && t > toIso.getTime()) return false;
        return true;
    });

    const orderIdSet = new Set(ordersFiltered.map((o) => String(o.ORDER_ID)));
    const orderById = new Map(ordersFiltered.map((o) => [String(o.ORDER_ID), o]));
    const orderNameById = new Map(ordersFiltered.map((o) => [String(o.ORDER_ID), o.ORDER_NAME || `#${o.ORDER_ID}`]));

    // Fetch items for each order (simple & safe)
    const allItems = [];
    for (const oid of orderIdSet) {
        const its = await getOrderItems({ shopDomain: shop, orderId: oid });
        for (const it of its) allItems.push({ ...it, ORDER_ID: oid });
    }

    const byKey = new Map();
    const now = Date.now();

    for (const it of allItems) {
        const sku = String(it.SKU || "").trim();
        const key = sku || `${it.TITLE || ""}|${it.VARIANT_TITLE || ""}`;
        const qty = Number(it.FULFILLABLE_QUANTITY ?? it.QUANTITY ?? 0);

        const orderId = String(it.ORDER_ID);
        const ord = orderById.get(orderId) || {};
        const orderName = orderNameById.get(orderId) || `#${orderId}`;

        const isExpress = /\bexpress\b/i.test(String(ord.SHIPPING_METHOD || ""));
        const created = new Date(ord.CREATED_AT || ord.UPDATED_AT || 0);
        const ageDays = Math.floor((now - created.getTime()) / 86400000);
        const shipped = /\bshipped\b/i.test(String(ord.TAGS || ""));
        const isOld = ageDays > 7 && !shipped;

        if (!byKey.has(key)) {
            byKey.set(key, {
                KEY: key,
                SKU: sku || "",
                TITLE: it.TITLE || "",
                VARIANT_TITLE: it.VARIANT_TITLE || "",
                IMAGE: it.IMAGE || "",
                TOTAL_QTY: 0,
                ORDERS: new Map(),
            });
        }

        const g = byKey.get(key);
        g.TOTAL_QTY += qty;
        g.IMAGE = g.IMAGE || it.IMAGE || "";

        const prev = g.ORDERS.get(orderName) || { IS_EXPRESS: false, IS_OLD: false, DATE: created.toISOString() };
        g.ORDERS.set(orderName, {
            NAME: orderName,
            IS_EXPRESS: prev.IS_EXPRESS || isExpress,
            IS_OLD: prev.IS_OLD || isOld,
            DATE: created.toISOString(),
        });
    }

    const items = Array.from(byKey.values())
        .map((g) => ({ ...g, ORDERS: Array.from(g.ORDERS.values()) }))
        .filter((x) => x.TOTAL_QTY > 0)
        .sort((a, b) => b.TOTAL_QTY - a.TOTAL_QTY);

    return res.status(200).json({ ok: true, items });
}

async function handleWebhookShopify(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const { SHOPIFY_WEBHOOK_SECRET, SHOPIFY_ADMIN_TOKEN } = process.env;

    const topic = req.headers["x-shopify-topic"] || "";
    const shopDomain = req.headers["x-shopify-shop-domain"] || "";
    const headerHmac = req.headers["x-shopify-hmac-sha256"] || "";

    let raw;
    try { raw = await getRawBody(req); }
    catch { return res.status(400).json({ ok: false, error: "Unable to read raw body" }); }

    if (!SHOPIFY_WEBHOOK_SECRET) return res.status(500).json({ ok: false, error: "Missing SHOPIFY_WEBHOOK_SECRET" });

    // const ok = verifyShopifyHmac(raw, SHOPIFY_WEBHOOK_SECRET, headerHmac);
    // if (!ok) return res.status(401).json({ ok: false, error: "Invalid HMAC" });
    console.log("WEBHOOK RECEIVED (NO HMAC CHECK)", req.headers["x-shopify-topic"]);

    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch { return res.status(400).json({ ok: false, error: "Invalid JSON" }); }

    const { order, lineItems } = normalizeOrderPayload(payload, shopDomain);

    let items = lineItems;
    try { items = await enrichLineItemImages(shopDomain, items, SHOPIFY_ADMIN_TOKEN); }
    catch (e) { console.error("enrichLineItemImages:", e?.message || e); }

    let action = "upsert";
    let errMsg = "";
    try {
        await upsertOrder(order);
        if (Array.isArray(items) && items.length) await writeLineItems(items, Date.now());
    } catch (e) {
        errMsg = e?.message || String(e);
    }

    // invalidate cache
    try { invalidateByTag("orders"); } catch { }

    // log webhook
    try {
        const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
        await logWebhook({
            ts: new Date().toISOString(),
            shop_domain: shopDomain,
            topic,
            order_id: order?.ORDER_ID ?? "",
            hash,
            result: action,
            error: errMsg,
        });
    } catch (e) {
        console.error("logWebhook error:", e?.message || e);
    }

    if (errMsg) return res.status(500).json({ ok: false, error: errMsg });
    return res.status(200).json({ ok: true, result: action });
}

/* ===============================
   Router main
   =============================== */
export default async function apiRouter(req, res) {
    // CORS first
    const preflight = setCors(req, res);
    if (preflight) return;

    const p = getPath(req); // starts with "/"
    // map routes
    if (p === "/" || p === "") return res.status(200).json({ ok: true });

    if (p === "/orders") return handleOrders(req, res);
    if (p === "/orders/page") return handleOrdersPage(req, res);
    if (p === "/orders/summary") return handleOrdersSummary(req, res);

    if (p === "/items" || p === "/order-items") return handleItems(req, res);

    if (p === "/orders/deliver-by") return handleSetDeliverBy(req, res);
    if (p === "/orders/note-local") return handleSetNoteLocal(req, res);
    if (p === "/orders/tags") return handleOrderTags(req, res);

    if (p === "/export/shipday" || p === "/shipday") return handleShipday(req, res);
    if (p === "/picking-list") return handlePickingList(req, res);

    if (p === "/webhooks/shopify") return handleWebhookShopify(req, res);

    return res.status(404).json({ ok: false, error: `Unknown route /api${p}` });
}

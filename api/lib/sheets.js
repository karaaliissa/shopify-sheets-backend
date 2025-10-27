// api/lib/sheets.js
import { google } from "googleapis";

const {
  GOOGLE_SHEETS_CLIENT_EMAIL,
  GOOGLE_SHEETS_PRIVATE_KEY,
  SHEET_ID,
  TAB_ORDERS = "TBL_ORDER",
  TAB_ITEMS = "TBL_ORDER_LINE_ITEM",
  TAB_LOGS = "TBL_WEBHOOK_LOG",
  TAB_SHOPS = "TBL_SHOPIFY_SHOP"
} = process.env;

const privateKey = (GOOGLE_SHEETS_PRIVATE_KEY || "").replace(/\\n/g, "\n");

function getClient() {
  const auth = new google.auth.JWT(
    GOOGLE_SHEETS_CLIENT_EMAIL,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}
export async function upsertOrderField({ shopDomain, orderId, field, value }) {
  const sheets = getClient();
  const headers = await getHeaders(sheets, TAB_ORDERS);
  const all = await getAll(TAB_ORDERS);

  const idx = all.findIndex(
    r => String(r.SHOP_DOMAIN).toLowerCase() === String(shopDomain).toLowerCase()
      && String(r.ORDER_ID) === String(orderId)
  );
  if (idx < 0) throw new Error("Order not found");

  const current = all[idx];
  const next = { ...current, [field]: value ?? "" };

  const row = objToRow(headers, next);
  const rowNumber = idx + 2;
  const endCol = String.fromCharCode(64 + headers.length);
  const range = `${TAB_ORDERS}!A${rowNumber}:${endCol}${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });
  return { ok: true };
}

async function getHeaders(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!1:1`,
  });
  return (res.data.values && res.data.values[0]) || [];
}

function rowToObj(headers, row) {
  const o = {};
  headers.forEach((h, i) => (o[h] = row[i] ?? ""));
  return o;
}
function objToRow(headers, obj) {
  return headers.map(h => (obj[h] ?? "").toString());
}

export async function getAll(tab) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: tab,
  });
  const rows = res.data.values || [];
  if (!rows.length) return [];
  const headers = rows.shift();
  return rows.map(r => rowToObj(headers, r));
}

export async function appendObjects(tab, objs) {
  if (!objs?.length) return;
  const sheets = getClient();
  const headers = await getHeaders(sheets, tab);
  const values = objs.map(o => objToRow(headers, o));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: tab,
    valueInputOption: "USER_ENTERED",
    requestBody: { values }
  });
}

export async function upsertOrder(orderObj) {
  const sheets = getClient();
  const headers = await getHeaders(sheets, TAB_ORDERS);
  const all = await getAll(TAB_ORDERS);

  const idx = all.findIndex(
    r => String(r.SHOP_DOMAIN).toLowerCase() === String(orderObj.SHOP_DOMAIN).toLowerCase()
      && String(r.ORDER_ID) === String(orderObj.ORDER_ID)
  );

  if (idx >= 0) {
    const current = all[idx];
    const incoming = new Date(orderObj.UPDATED_AT || 0).getTime() || 0;
    const existing = new Date(current.UPDATED_AT || 0).getTime() || 0;

    const tagsChanged = String(current.TAGS ?? '') !== String(orderObj.TAGS ?? '');
    const dateChanged = String(current.DELIVER_BY ?? '') !== String(orderObj.DELIVER_BY ?? '');

    if (incoming <= existing && !tagsChanged && !dateChanged) {
      return { action: "skipped-older-or-equal" };
    }

    const row = objToRow(headers, { ...current, ...orderObj });
    const rowNumber = idx + 2;
    const endCol = String.fromCharCode(64 + headers.length);
    const range = `${TAB_ORDERS}!A${rowNumber}:${endCol}${rowNumber}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
    return { action: "updated" };
  } else {
    await appendObjects(TAB_ORDERS, [orderObj]);
    return { action: "inserted" };
  }
}



export async function writeLineItems(items, batchTs) {
  if (!items?.length) return;
  const withBatch = items.map(x => ({ ...x, BATCH_TS: batchTs }));
  await appendObjects(TAB_ITEMS, withBatch);
}

export async function getLatestItems(shopDomain, orderId) {
  const all = await getAll(TAB_ITEMS);
  const rows = all.filter(r => r.SHOP_DOMAIN === shopDomain && r.ORDER_ID === String(orderId));
  if (!rows.length) return [];
  const maxBatch = Math.max(...rows.map(r => Number(r.BATCH_TS || 0)));
  return rows.filter(r => Number(r.BATCH_TS) === maxBatch);
}

export async function logWebhook(entry) {
  await appendObjects(TAB_LOGS, [entry]);
}

export const Tabs = {
  ORDERS: TAB_ORDERS,
  ITEMS: TAB_ITEMS,
  LOGS: TAB_LOGS,
  SHOPS: TAB_SHOPS,
  WORK: "TBL_WORK_ORDER",
  PRINT_QUEUE: "TBL_PRINT_QUEUE",
  STATUS_HISTORY: "TBL_STATUS_HISTORY",
};
export async function createWorkEntry(entry) {
  // expects: { WORK_ID, SHOP_DOMAIN, ORDER_ID, LINE_ID, SKU, TITLE, VARIANT_TITLE, QTY, STAGE, ASSIGNEE, START_TS, END_TS:'', STATUS:'active', NOTES:'' }
  await appendObjects(Tabs.WORK, [entry]);
}

export async function markWorkDone(workId) {
  const sheets = getClient();
  const headers = await getHeaders(sheets, Tabs.WORK);
  const all = await getAll(Tabs.WORK);
  const idx = all.findIndex(r => (r.WORK_ID || '') === workId);
  if (idx < 0) throw new Error('WORK_ID not found');

  const current = all[idx];
  const updated = {
    ...current,
    END_TS: new Date().toISOString(),
    STATUS: 'done',
  };

  const row = objToRow(headers, updated);
  const rowNumber = idx + 2; // header + 1-indexed
  const endCol = String.fromCharCode(64 + headers.length);
  const range = `${Tabs.WORK}!A${rowNumber}:${endCol}${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });

  return { ok: true };
}

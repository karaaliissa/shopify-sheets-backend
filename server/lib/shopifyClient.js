// server/lib/shopifyClient.js
import https from "https";

export function httpsReqJson(url, method = "GET", headers = {}, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {}
          resolve({ ok, status: res.statusCode, json: parsed, data });
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function shopifyGraphql(shopDomain, query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("Missing SHOPIFY_ADMIN_TOKEN");

  const url = `https://${shopDomain}/admin/api/2024-10/graphql.json`;

  const r = await httpsReqJson(
    url,
    "POST",
    { "X-Shopify-Access-Token": token },
    { query, variables }
  );

  if (!r.ok) {
    throw new Error(
      `GraphQL HTTP failed (${r.status}): ${String(r.data).slice(0, 300)}`
    );
  }

  if (r.json?.errors?.length) {
    throw new Error(
      `GraphQL errors: ${JSON.stringify(r.json.errors).slice(0, 300)}`
    );
  }

  return r.json?.data;
}

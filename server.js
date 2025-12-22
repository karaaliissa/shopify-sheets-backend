// server.js
import dotenv from "dotenv";
dotenv.config();

import http from "http";
import apiRouter from "./api/router.js";

function enhanceRes(res) {
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (obj) {
    if (!this.headersSent) this.setHeader("Content-Type", "application/json; charset=utf-8");
    this.end(JSON.stringify(obj));
    return this;
  };
  res.send = function (txt) { this.end(txt); return this; };
  return res;
}

function attachQuery(req) {
  try {
    const host = req.headers.host || "local";
    const url = new URL(req.url || "/", `http://${host}`);
    req.query = Object.fromEntries(url.searchParams.entries());
  } catch {
    req.query = {};
  }
}

const server = http.createServer((req, res) => {
  const r = enhanceRes(res);
  attachQuery(req);

  const url = req.url || "";

  if (url === "/" || url === "/health") {
    r.statusCode = 200;
    return r.end("OK");
  }

  if (url.startsWith("/api/")) {
    apiRouter(req, r).catch((err) => {
      console.error("API error:", err);
      if (!r.headersSent) r.status(500).json({ ok: false, error: String(err?.message || err) });
    });
    return;
  }

  r.statusCode = 404;
  r.setHeader("Content-Type", "text/plain; charset=utf-8");
  r.end("Not found");
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Backend listening on", port));
console.log("DB:", process.env.DATABASE_URL ? "OK" : "MISSING");

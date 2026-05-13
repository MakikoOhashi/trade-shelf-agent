import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import { runMockIngest } from "../web/vendor/shared/index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..", "web");

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(req, res) {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const pathname = decodeURIComponent(reqUrl.pathname);
  const rel = pathname === "/" ? "/index.html" : pathname;

  // Prevent path traversal.
  const abs = path.resolve(webRoot, "." + rel);
  if (!abs.startsWith(webRoot + path.sep)) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }

  try {
    const buf = await fs.readFile(abs);
    res.writeHead(200, { "content-type": contentTypeFor(abs) });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const method = String(req.method || "GET").toUpperCase();

  // Dev-only CORS (for localhost UI). In production, restrict origins explicitly.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "POST" && reqUrl.pathname === "/ingest/mock") {
    try {
      const body = await readJsonBody(req);
      const rawText = typeof body.rawText === "string" ? body.rawText : "";
      if (!rawText.trim()) {
        sendJson(res, 400, { ok: false, error: "rawText is required" });
        return;
      }

      const rawInput = {
        id: `raw-${Date.now()}`,
        source: body.source ?? "teams",
        receivedAt: new Date().toISOString(),
        senderName: body.senderName,
        senderEmail: body.senderEmail,
        channel: body.channel,
        subject: body.subject,
        rawText,
        attachmentNames: body.attachmentNames ?? [],
        status: "received",
      };

      const result = runMockIngest(rawInput);
      sendJson(res, 200, { ok: true, result });
      return;
    } catch (e) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return;
    }
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  res.end("method not allowed");
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`trade-shelf-agent listening on http://127.0.0.1:${port}`);
});

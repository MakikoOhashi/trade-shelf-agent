import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import OpenAI from "openai";
import { runMockIngest } from "../web/vendor/shared/index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..", "web");

const aiClient = new OpenAI({
  baseURL: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
});

const CLASSIFY_SYSTEM_PROMPT = [
  "You are an operations classification engine for international trade operations.",
  "Convert messy Teams or email messages into OperationalThread JSON.",
  "Return JSON only. No markdown. No explanation.",
  "",
  "Intent values must be one of:",
  "- missing_document_check",
  "- eta_change",
  "- quantity_mismatch",
  "- shipment_status_check",
  "- air_change_check",
  "- unknown",
  "",
  "Each thread must have:",
  "- id",
  "- title",
  "- intent",
  "- summary",
  "- extractedEntities",
  "- confidence",
  "",
  "extractedEntities may include:",
  "- siIds",
  "- shipmentIds",
  "- invoiceIds",
  "- supplierNames",
  "- documentTypes",
  "",
  "Rules:",
  "- Split one message into multiple threads if it contains multiple operational requests.",
  "- Normalize SI-224 to SI-2026-224 if year is not given.",
  '- If PL is mentioned, documentTypes should include "PL".',
  "- Keep each summary under 40 Japanese characters.",
  "- Return at most 3 threads.",
  "- Use short Japanese titles.",
  "- Do not include long explanations.",
  "- Use compact JSON.",
  "- Confidence must be a number between 0 and 1.",
  '- If unsure, use intent "unknown" and lower confidence.',
  "",
  "Return only:",
  "{",
  '  "threads": [...]',
  "}",
].join("\n");

const CLASSIFY_INTENTS = new Set([
  "missing_document_check",
  "eta_change",
  "quantity_mismatch",
  "shipment_status_check",
  "air_change_check",
  "unknown",
]);

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

function normalizeSiId(siId, now = new Date()) {
  const raw = String(siId || "").trim();
  if (!raw) return "";

  // Allow already-normalized values like SI-2026-224.
  const normalizedMatch = raw.match(/^SI-(\d{4})-(\d+)$/i);
  if (normalizedMatch) {
    const year = normalizedMatch[1];
    const num = normalizedMatch[2];
    return `SI-${year}-${num}`;
  }

  // Normalize SI-224 -> SI-YYYY-224 (current year).
  const simpleMatch = raw.match(/^SI-(\d+)$/i);
  if (simpleMatch) {
    const year = String(now.getFullYear());
    return `SI-${year}-${simpleMatch[1]}`;
  }

  return raw;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.3;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeThreads(parsed, rawText) {
  const threads = Array.isArray(parsed?.threads) ? parsed.threads : null;
  if (!threads) return null;

  const now = new Date();
  const raw = String(rawText || "");
  const rawHasPL = /\bPL\b/i.test(raw);
  const rawSiIds = Array.from(raw.matchAll(/\bSI-(\d{1,6})\b/gi)).map((m) =>
    normalizeSiId(m[0], now),
  );

  return threads.map((t, index) => {
    const id =
      typeof t?.id === "string" && t.id.trim()
        ? t.id.trim()
        : `llm-thread-${index + 1}`;

    const title = typeof t?.title === "string" ? t.title.trim() : "";
    const summary = typeof t?.summary === "string" ? t.summary.trim() : "";

    const intentRaw = typeof t?.intent === "string" ? t.intent.trim() : "";
    const intent = CLASSIFY_INTENTS.has(intentRaw) ? intentRaw : "unknown";

    const extracted = t?.extractedEntities && typeof t.extractedEntities === "object"
      ? t.extractedEntities
      : {};

    const siIds = toStringArray(extracted.siIds).map((v) =>
      normalizeSiId(v, now),
    );
    const shipmentIds = toStringArray(extracted.shipmentIds);
    const invoiceIds = toStringArray(extracted.invoiceIds);
    const supplierNames = toStringArray(extracted.supplierNames);
    const documentTypes = toStringArray(extracted.documentTypes);

    // Light heuristics to improve reliability for smoke tests.
    if (rawSiIds.length && siIds.length === 0) siIds.push(...rawSiIds);
    if (rawHasPL && !documentTypes.includes("PL")) documentTypes.push("PL");

    const confidence = clamp01(Number(t?.confidence));

    return {
      id,
      title: title || "Untitled",
      intent,
      summary: summary || "No summary provided",
      extractedEntities: {
        siIds,
        shipmentIds,
        invoiceIds,
        supplierNames,
        documentTypes,
      },
      confidence,
    };
  });
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

  if (method === "GET" && reqUrl.pathname === "/ai/ping") {
    try {
      const completion = await aiClient.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT,
        messages: [
          {
            role: "user",
            content: "Reply only with: pong",
          },
        ],
        temperature: 0,
      });

      const content = completion.choices?.[0]?.message?.content ?? "";

      sendJson(res, 200, {
        ok: true,
        model: process.env.AZURE_OPENAI_DEPLOYMENT,
        response: content,
      });
      return;
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { ok: false, error: String(error) });
      return;
    }
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

  if (method === "POST" && reqUrl.pathname === "/ai/classify") {
    try {
      const body = await readJsonBody(req);
      const rawText = typeof body.rawText === "string" ? body.rawText : "";
      if (!rawText.trim()) {
        sendJson(res, 400, { ok: false, error: "rawText is required" });
        return;
      }

      const userPrompt = [
        "Classify this input:",
        rawText.trim(),
        "",
        "Return compact JSON only. Maximum 3 threads.",
      ].join("\n");

      const completion = await aiClient.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT,
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 2000,
      });

      const finishReason = completion.choices?.[0]?.finish_reason;
      console.log("LLM finish_reason:", finishReason);

      const content = completion.choices?.[0]?.message?.content ?? "";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        sendJson(res, 502, {
          ok: false,
          error: "Failed to parse LLM JSON",
          finishReason,
          raw: String(content ?? ""),
        });
        return;
      }

      const normalized = normalizeThreads(parsed, rawText);
      if (!normalized) {
        sendJson(res, 502, {
          ok: false,
          error: "Invalid LLM response shape",
          raw: String(content ?? ""),
        });
        return;
      }

      sendJson(res, 200, { ok: true, threads: normalized });
      return;
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { ok: false, error: String(error) });
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

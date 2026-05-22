import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import OpenAI from "openai";
import { buildIngestResultFromThreads, resolveContext, runIngestPipeline, runMockIngest } from "../web/vendor/shared/index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..", "web");

const aiClient = new OpenAI({
  baseURL: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
});

const CLASSIFY_SYSTEM_PROMPT = [
  "You are an operations classification engine for international trade operations.",
  "Convert messy Teams or email messages into OperationalThread JSON.",
  "Return compact valid JSON only.",
  "Do not use markdown.",
  "Do not use code fences.",
  "Do not explain.",
  "Do not include prose outside JSON.",
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
  "- Maximum 3 threads.",
  "- Each title must be under 20 Japanese characters.",
  "- Each summary must be under 40 Japanese characters.",
  "- Use short Japanese titles.",
  "- Use arrays only when needed.",
  "- Do not repeat the same entity unnecessarily.",
  "- Confidence must be a number between 0 and 1.",
  '- If unsure, use intent "unknown" and lower confidence.',
  "",
  "Return ONLY this JSON shape:",
  '{"threads":[{"id":"t1","title":"...","intent":"missing_document_check","summary":"...","extractedEntities":{"siIds":[],"shipmentIds":[],"invoiceIds":[],"supplierNames":[],"documentTypes":[]},"confidence":0.0}]}',
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

  // Allow already-normalized values like SI-2026-001.
  const already = raw.match(/^SI-\d{4}-\d+/i);
  if (already) return raw.toUpperCase();

  // Normalize SI-224 / SI224 / SI 224 -> SI-YYYY-224 (pad3, current year).
  const simpleMatch = raw.match(/^SI[-\s]?(\d+)$/i);
  if (simpleMatch) {
    const year = String(now.getFullYear());
    const num = String(simpleMatch[1] || "").replace(/\D/g, "");
    if (!num) return raw.toUpperCase();
    return `SI-${year}-${num.padStart(3, "0")}`.toUpperCase();
  }

  return raw.toUpperCase();
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

function normalizeShipmentId(shipmentId, _now = new Date()) {
  const normalized = String(shipmentId ?? "").trim().toUpperCase();
  return /^SHP-\d{4}-\d{3}$/.test(normalized) ? normalized : null;
}

function uniqueStrings(values) {
  const arr = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function linkEntitiesByRules(rawText, threads) {
  const text = String(rawText || "");
  const now = new Date();

  // Avoid partial matches like "SI-2026" from "SI-2026-001".
  const siFull = Array.from(text.matchAll(/\bSI-\d{4}-\d+\b/gi)).map((m) => normalizeSiId(m[0], now));
  const siSimple = Array.from(text.matchAll(/\bSI[-\s]?(\d+)\b(?!-\d)/gi)).map((m) => normalizeSiId(`SI-${m[1]}`, now));
  const siIds = [...siFull, ...siSimple];
  const shipmentIds = Array.from(text.matchAll(/SHP-\d{4}-\d{3}/gi))
    .map((m) => normalizeShipmentId(m[0], now))
    .filter(Boolean);
  const invoiceIds = Array.from(text.matchAll(/INV[-\s]?(\d{1,8})/gi)).map((m) => `INV-${m[1]}`.toUpperCase());

  const documentTypes = [];
  if (/\bPL\b/i.test(text) || /PLまだ|PL\s*未着/i.test(text)) documentTypes.push("PL");
  if (/\bINV\b/i.test(text) || /インボイス|請求/i.test(text)) documentTypes.push("INV");
  if (/\bPO\b/i.test(text) || /発注|指図/i.test(text)) documentTypes.push("PO");

  const supplierNames = [];
  if (/\bACME\b/i.test(text)) supplierNames.push("ACME");

  const extracted = {
    siIds: uniqueStrings(siIds),
    shipmentIds: uniqueStrings(shipmentIds),
    invoiceIds: uniqueStrings(invoiceIds),
    supplierNames: uniqueStrings(supplierNames),
    documentTypes: uniqueStrings(documentTypes),
  };

  const list = Array.isArray(threads) ? threads : [];
  return list.map((t) => {
    const base = t && t.extractedEntities && typeof t.extractedEntities === "object" ? t.extractedEntities : {};
    return {
      ...t,
      extractedEntities: {
        siIds: uniqueStrings([...(base.siIds || []), ...extracted.siIds]),
        shipmentIds: uniqueStrings([...(base.shipmentIds || []), ...extracted.shipmentIds]),
        invoiceIds: uniqueStrings([...(base.invoiceIds || []), ...extracted.invoiceIds]),
        supplierNames: uniqueStrings([...(base.supplierNames || []), ...extracted.supplierNames]),
        documentTypes: uniqueStrings([...(base.documentTypes || []), ...extracted.documentTypes]),
      },
    };
  });
}

function normalizeThreads(parsed, rawText) {
  const threads = Array.isArray(parsed?.threads) ? parsed.threads : null;
  if (!threads) return null;

  const now = new Date();
  const raw = String(rawText || "");
  const rawHasPL = /\bPL\b/i.test(raw);
  const rawSiIds = Array.from(raw.matchAll(/\bSI-\d{4}-\d+\b|\bSI[-\s]?\d+\b(?!-\d)/gi)).map((m) => normalizeSiId(m[0], now));
  const rawShipmentIds = Array.from(raw.matchAll(/\bSHP-\d{4}-\d{3}\b/gi))
    .map((m) => normalizeShipmentId(m[0], now))
    .filter(Boolean);

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
    const shipmentIds = toStringArray(extracted.shipmentIds)
      .map((v) => normalizeShipmentId(v, now))
      .filter(Boolean);
    const invoiceIds = toStringArray(extracted.invoiceIds);
    const supplierNames = toStringArray(extracted.supplierNames);
    const documentTypes = toStringArray(extracted.documentTypes);

    // Light heuristics to improve reliability for smoke tests.
    if (rawSiIds.length && siIds.length === 0) siIds.push(...rawSiIds);
    if (rawShipmentIds.length && shipmentIds.length === 0)
      shipmentIds.push(...rawShipmentIds);
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

function sanitizeJsonContent(content) {
  const trimmed = String(content || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

async function classifyThreadsWithLlm(rawText) {
  const userPrompt = [
    "Classify this input:",
    String(rawText || "").trim(),
    "",
    "Return compact JSON only. No explanation. Max 3 threads. Short Japanese title and summary.",
  ].join("\n");

  const completion = await aiClient.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 3000,
  });

  const finishReason = completion.choices?.[0]?.finish_reason;
  console.log("LLM finish_reason:", finishReason);

  const content = completion.choices?.[0]?.message?.content ?? "";
  console.log("LLM raw length:", String(content).length);

  if (finishReason === "length") {
    const err = new Error("LLM output truncated");
    err.code = "LLM_TRUNCATED";
    err.finishReason = finishReason;
    err.hint = "The model output exceeded max_tokens before completing JSON.";
    err.raw = String(content ?? "");
    throw err;
  }

  const sanitized = sanitizeJsonContent(content);
  let parsed;
  try {
    parsed = JSON.parse(sanitized);
  } catch {
    const err = new Error("Failed to parse LLM JSON");
    err.code = "LLM_JSON_PARSE_FAILED";
    err.finishReason = finishReason;
    err.hint = "The model returned non-JSON or incomplete JSON.";
    err.raw = String(content ?? "");
    throw err;
  }

  const normalized = normalizeThreads(parsed, rawText);
  if (!normalized) {
    const err = new Error("Invalid LLM response shape");
    err.raw = String(content ?? "");
    throw err;
  }

  return normalized;
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
      const pendingClarifications = Array.isArray(body.pendingClarifications) ? body.pendingClarifications : [];

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

      const result = runMockIngest(rawInput, { pendingClarifications });
      sendJson(res, 200, { ok: true, result });
      return;
    } catch (e) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return;
    }
  }

  if (method === "POST" && reqUrl.pathname === "/ingest/llm") {
    try {
      const body = await readJsonBody(req);
      const rawText = typeof body.rawText === "string" ? body.rawText : "";
      if (!rawText.trim()) {
        sendJson(res, 400, { ok: false, error: "rawText is required" });
        return;
      }
      const pendingClarifications = Array.isArray(body.pendingClarifications) ? body.pendingClarifications : [];

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

      // Resolve pending clarification first, then run context check on the effective input.
      const prelim = runIngestPipeline(rawInput, { sourceLabel: "Kimi AI分類", approvalPolicy: "all", pendingClarifications });
      const contextResolution = prelim?.contextResolution || resolveContext(rawInput, { sourceLabel: "Kimi AI分類", approvalPolicy: "all" });
      if (contextResolution.status !== "resolved_enough") {
        const result = prelim;
        sendJson(res, 200, { ok: true, result });
        return;
      }

      let threads = null;
      try {
        const classifyText = prelim && prelim.rawInput && prelim.rawInput.rawText ? String(prelim.rawInput.rawText) : rawText;
        threads = await classifyThreadsWithLlm(classifyText);
      } catch (e) {
        if (e && (e.code === "LLM_TRUNCATED" || e.code === "LLM_JSON_PARSE_FAILED")) {
          const result = prelim;
          const errMsg = e && e.message ? String(e.message) : "LLM classify failed";
          if (result && Array.isArray(result.activityEvents)) {
            result.activityEvents = [
              ...result.activityEvents,
              {
                id: `act-${Date.now()}`,
                type: "failed_processing",
                occurredAt: new Date().toISOString(),
                title: "LLM fallback",
                description: `LLM classify failed: ${errMsg}`,
                sourceRawInputId: rawInput.id,
                status: "warning",
                actor: "Kimi AI分類",
              },
            ];
          }
          sendJson(res, 200, { ok: true, result });
          return;
        }
        throw e;
      }

      const classifyText = prelim && prelim.rawInput && prelim.rawInput.rawText ? String(prelim.rawInput.rawText) : rawText;
      const operationalThreads = linkEntitiesByRules(classifyText, threads).map((t) => ({
        ...t,
        rawInputId: rawInput.id,
      }));

      const result = buildIngestResultFromThreads(rawInput, operationalThreads, {
        sourceLabel: "Kimi AI分類",
        // TODO: Switch to confidence-based approval (low_confidence) after we refine the policy.
        approvalPolicy: "all",
        pendingClarifications,
      });

      sendJson(res, 200, { ok: true, result });
      return;
    } catch (e) {
      const message = e && e.message ? String(e.message) : "LLM ingest failed";
      const finishReason = e && e.finishReason ? String(e.finishReason) : undefined;
      const hint = e && e.hint ? String(e.hint) : undefined;
      const raw = e && e.raw ? String(e.raw) : undefined;

      if (e && (e.code === "LLM_TRUNCATED" || e.code === "LLM_JSON_PARSE_FAILED")) {
        sendJson(res, 502, { ok: false, error: message, finishReason, hint, raw });
        return;
      }

      sendJson(res, 502, { ok: false, error: message });
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

      const normalized = await classifyThreadsWithLlm(rawText);
      sendJson(res, 200, { ok: true, threads: normalized });
      return;
    } catch (error) {
      console.error(error);
      if (error && (error.code === "LLM_TRUNCATED" || error.code === "LLM_JSON_PARSE_FAILED")) {
        sendJson(res, 502, {
          ok: false,
          error: error.message ? String(error.message) : "LLM classify failed",
          finishReason: error.finishReason,
          hint: error.hint,
          raw: error.raw,
        });
        return;
      }

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

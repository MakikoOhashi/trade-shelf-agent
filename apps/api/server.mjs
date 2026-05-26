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

function statusKeyFromIngestStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "ok" || s === "success") return "success";
  if (s === "warning") return "warning";
  if (s === "failed" || s === "error") return "failed";
  return "processing";
}

function activityTitleJaFromType(rawType, fallback) {
  switch (String(rawType || "")) {
    case "raw_input_received":
      return "依頼受信";
    case "context_resolved":
      return "Context判定";
    case "clarification_waiting":
      return "不足情報の確認待ち";
    case "clarification_matched":
      return "確認返信を紐付け";
    case "clarification_required":
      return "追加情報が必要";
    case "human_selection_required":
      return "候補選択が必要";
    case "reminder_planned":
      return "リマインド予定";
    case "classified":
      return "AI分類";
    case "entity_linked":
      return "関連紐付け";
    case "state_transition_candidate_detected":
      return "状態遷移候補を検出";
    case "intake_resolved":
      return "Intake判定";
    case "action_planned":
      return "次アクションを判定";
    case "draft_created":
      return "下書きを生成";
    case "approval_required":
      return "承認待ちへ追加";
    case "issue_updated":
      return "Issue更新";
    case "approved":
      return "承認済み";
    case "held":
      return "保留";
    case "edited":
      return "編集済み";
    case "mock_sent":
      return "mock送信";
    case "failed_processing":
      return "処理失敗";
    default:
      return String(fallback || "活動");
  }
}

function activityEventToFeedItem(ev, { actorFallback } = {}) {
  const occurredAt = ev && ev.occurredAt ? String(ev.occurredAt) : "";
  const rawType = String(ev?.type || "");
  const type = rawType === "issue_updated" ? "issueUpdated" : rawType || "aiProcessed";
  const description = String(ev?.description || "");
  const sequence = typeof ev?.sequence === "number" ? ev.sequence : null;
  const linkedEntities = Array.isArray(ev?.linkedEntities) ? ev.linkedEntities.filter(Boolean) : [];

  const linkedDeduped = (() => {
    const seen = new Set();
    const out = [];
    for (const l of linkedEntities) {
      const entityType = String(l?.entityType || "").trim();
      const entityId = String(l?.entityId || "").trim();
      if (!entityType || !entityId) continue;
      const key = `${entityType}::${entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ entityType, entityId, confidence: l?.confidence });
    }
    return out;
  })();

  const linked = linkedDeduped.map((l) => ({
    kind: String(l?.entityType || "").toLowerCase(),
    label: String(l?.entityId || "").trim(),
  }));

  const activityTitleJa = activityTitleJaFromType(rawType, ev?.title);
  const title = description ? `${activityTitleJa}：${description}` : activityTitleJa;

  const details = [
    rawType ? `type: ${activityTitleJa}${rawType ? ` (${rawType})` : ""}` : "",
    ev?.status ? `状態: ${statusKeyFromIngestStatus(ev.status)} (${String(ev.status)})` : "",
    typeof sequence === "number" ? `順序: ${String(sequence)}` : "",
    linkedDeduped.length ? `紐付け: ${linkedDeduped.map((l) => `${l.entityType} ${l.entityId}`).join(", ")}` : "",
    description && rawType !== "raw_input_received" ? `raw detail: ${description}` : "",
  ].filter(Boolean);

  return {
    id: String(ev?.id || `act-${Date.now()}`),
    type,
    source: "ai",
    title,
    actor: String(ev?.actor || "") || String(actorFallback || "") || "mock ingest",
    occurredAt: occurredAt || new Date().toISOString(),
    sequence,
    summary: description || "",
    details,
    statusKey: statusKeyFromIngestStatus(ev?.status),
    linked,
    links: [],
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Slack Events API (hackathon demo)
 * TODO(security): verify Slack signing secret (X-Slack-Signature / X-Slack-Request-Timestamp).
 */
const slackState = {
  /**
   * @type {Array<{
   *  id: string,
   *  type: string,
   *  source: string,
   *  title: string,
   *  actor: string,
   *  occurredAt: string,
   *  at?: string,
   *  summary?: string,
   *  details?: string[],
   *  statusKey?: string,
   *  links?: any[],
   *  linked?: any[]
   * }>}
   */
  activityFeedItems: [],
  processedEventIds: new Set(),
  lastReceivedAt: null,
};

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

function hasAzureLlmEnv() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
      process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_DEPLOYMENT,
  );
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
  const method = String(req.method || "GET").toUpperCase();
  const pathname = decodeURIComponent(reqUrl.pathname);
  const rel = pathname === "/" ? "/index.html" : pathname;

  const isApiNamespace =
    pathname === "/ai" ||
    pathname.startsWith("/ai/") ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ingest" ||
    pathname.startsWith("/ingest/") ||
    pathname === "/teams" ||
    pathname.startsWith("/teams/") ||
    pathname === "/slack" ||
    pathname.startsWith("/slack/");

  // Never serve SPA fallback for API namespaces.
  if (isApiNamespace) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

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
    res.end(method === "HEAD" ? undefined : buf);
  } catch {
    const hasExtension = path.extname(pathname).length > 0;

    // SPA fallback for extensionless GET/HEAD routes (e.g. /shelf).
    if (!hasExtension && (method === "GET" || method === "HEAD")) {
      const indexPath = path.resolve(webRoot, "index.html");
      try {
        const buf = await fs.readFile(indexPath);
        res.writeHead(200, { "content-type": contentTypeFor(indexPath) });
        res.end(method === "HEAD" ? undefined : buf);
        return;
      } catch {
        // If the frontend bundle is missing, fall through to 404.
      }
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

async function ingestWithLlmOrMock({ rawInput, pendingClarifications }) {
  const pending = Array.isArray(pendingClarifications) ? pendingClarifications : [];
  if (!hasAzureLlmEnv()) {
    return runMockIngest(rawInput, { pendingClarifications: pending, sourceLabel: "mock ingest" });
  }

  const prelim = runIngestPipeline(rawInput, { sourceLabel: "Kimi AI分類", approvalPolicy: "all", pendingClarifications: pending });
  const contextResolution = prelim?.contextResolution || resolveContext(rawInput, { sourceLabel: "Kimi AI分類", approvalPolicy: "all" });
  if (contextResolution.status !== "resolved_enough") return prelim;

  const classifyText = prelim && prelim.rawInput && prelim.rawInput.rawText ? String(prelim.rawInput.rawText) : rawInput.rawText;
  const threads = await classifyThreadsWithLlm(classifyText);
  const operationalThreads = linkEntitiesByRules(classifyText, threads).map((t) => ({ ...t, rawInputId: rawInput.id }));

  return buildIngestResultFromThreads(rawInput, operationalThreads, {
    sourceLabel: "Kimi AI分類",
    approvalPolicy: "all",
    pendingClarifications: pending,
  });
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

  if (method === "GET" && reqUrl.pathname === "/api/activity") {
    sendJson(res, 200, {
      ok: true,
      items: Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems : [],
      lastReceivedAt: slackState.lastReceivedAt,
    });
    return;
  }

  if (method === "GET" && reqUrl.pathname === "/api/slack/status") {
    sendJson(res, 200, {
      ok: true,
      status: slackState.lastReceivedAt ? "connected" : "unknown",
      lastReceivedAt: slackState.lastReceivedAt,
      events: Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems.length : 0,
    });
    return;
  }

  if (method === "POST" && reqUrl.pathname === "/slack/events") {
    try {
      const body = await readJsonBody(req);

      if (body && body.type === "url_verification" && typeof body.challenge === "string") {
        // Slack URL Verification expects JSON with the challenge echoed.
        sendJson(res, 200, { challenge: body.challenge });
        return;
      }

      const eventType = body && body.type ? String(body.type) : "";
      const eventId = body && body.event_id ? String(body.event_id) : "";

      if (eventId) {
        if (slackState.processedEventIds.has(eventId)) {
          sendJson(res, 200, { ok: true, deduped: true });
          return;
        }
        slackState.processedEventIds.add(eventId);
        // Prevent unbounded growth in a long-running demo.
        if (slackState.processedEventIds.size > 5000) slackState.processedEventIds.clear();
      }

      if (eventType === "event_callback" && body && body.event && body.event.type === "message") {
        const ev = body.event || {};
        if (ev.subtype) {
          sendJson(res, 200, { ok: true, ignored: true, subtype: String(ev.subtype) });
          return;
        }
        const channelRaw = String(ev.channel || ev.channel_name || "").trim();
        const channel = channelRaw ? (channelRaw.startsWith("#") ? channelRaw : `#${channelRaw}`) : "#unknown";
        const user = String(ev.user || ev.username || "unknown").trim() || "unknown";
        const text = String(ev.text || "").trim();
        const ts = String(ev.ts || body.event_time || Date.now()).trim();

        const occurredAt = (() => {
          const n = Number(ts);
          if (Number.isFinite(n) && n > 0 && n < 4_000_000_000) return new Date(n * 1000).toISOString();
          const ms = Number(ev.event_ts);
          if (Number.isFinite(ms) && ms > 0 && ms < 4_000_000_000) return new Date(ms * 1000).toISOString();
          return new Date().toISOString();
        })();

        const id = eventId || `slack:${ts}:${Date.now()}`;
        const item = {
          id,
          type: "slackMessage",
          source: "slack",
          title: `[Slack] ${channel}`,
          actor: user,
          occurredAt,
          summary: text ? `"${text}"` : "",
          details: [text, `ts: ${ts}`],
          statusKey: "success",
          linked: [],
          links: [],
        };

        slackState.lastReceivedAt = new Date().toISOString();
        slackState.activityFeedItems = [item, ...(Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems : [])].slice(0, 200);

        // Slack expects a response within ~3 seconds; ingest runs async for demo safety.
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok");

        Promise.resolve()
          .then(async () => {
            const rawInput = {
              id: `slack-${eventId || ts || Date.now()}`,
              source: "slack",
              receivedAt: new Date().toISOString(),
              senderName: user,
              channel,
              subject: undefined,
              rawText: text,
              attachmentNames: [],
              status: "received",
            };

            const result = await ingestWithLlmOrMock({ rawInput, pendingClarifications: [] });
            const events = Array.isArray(result?.activityEvents) ? result.activityEvents.filter(Boolean) : [];
            const feedItems = events.map((evv) => activityEventToFeedItem(evv, { actorFallback: hasAzureLlmEnv() ? "Kimi AI分類" : "mock ingest" }));

            if (feedItems.length) {
              slackState.activityFeedItems = [...feedItems, ...(Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems : [])].slice(0, 400);
            }
          })
          .catch((err) => {
            const message = err && err.message ? String(err.message) : String(err);
            const failedItem = {
              id: `slack-ingest-failed:${eventId || ts}:${Date.now()}`,
              type: "failedProcessing",
              source: "ai",
              title: "処理失敗（Slack ingest）",
              actor: hasAzureLlmEnv() ? "Kimi AI分類" : "mock ingest",
              occurredAt: new Date().toISOString(),
              summary: message,
              details: [message],
              statusKey: "failed",
              linked: [],
              links: [],
            };
            slackState.activityFeedItems = [failedItem, ...(Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems : [])].slice(0, 400);
          });
        return;
      }

      // Ignore non-message events in demo mode.
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    } catch (e) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return;
    }
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
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`trade-shelf-agent listening on http://${host}:${port}`);
});

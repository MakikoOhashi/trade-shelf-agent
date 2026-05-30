import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import OpenAI from "openai";
import {
  buildIngestResultFromThreads,
  mockTradeCases,
  resolveContext,
  runIngestPipeline,
  runMockIngest,
} from "../web/vendor/shared/index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..", "web");
const webPublicRoot = path.resolve(webRoot, "public");

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
  const threadId = String(ev?.threadId || "").trim();
  const issueId = String(ev?.issueId || "").trim();
  const demoApprovalId = String(ev?.demoApprovalId || "").trim();
  const stateTransitionCandidate = ev?.stateTransitionCandidate && typeof ev.stateTransitionCandidate === "object" ? ev.stateTransitionCandidate : null;

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
    ...(threadId ? { threadId } : {}),
    ...(issueId ? { issueId } : {}),
    ...(demoApprovalId ? { demoApprovalId } : {}),
    ...(stateTransitionCandidate ? { stateTransitionCandidate } : {}),
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

async function postSlackReply({ channel, threadTs, text }) {
  const token = String(process.env.SLACK_BOT_TOKEN || "").trim();
  const channelId = String(channel || "").trim();
  const messageText = String(text || "").trim();
  const thread_ts = threadTs == null ? "" : String(threadTs).trim();

  console.log("[slack reply] attempt", {
    channel: channelId || null,
    threadTs: thread_ts || null,
    text: messageText ? `${messageText.slice(0, 280)}${messageText.length > 280 ? "…" : ""}` : null,
  });

  if (!token) {
    console.warn("[slack] SLACK_BOT_TOKEN is missing; skip chat.postMessage");
    return { ok: false, skipped: true, error: "missing_token" };
  }
  if (!channelId || !messageText) {
    console.warn("[slack] missing channel or text; skip chat.postMessage");
    return { ok: false, skipped: true, error: "missing_channel_or_text" };
  }

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: channelId,
        text: messageText,
        ...(thread_ts ? { thread_ts } : {}),
      }),
    });
    const json = await res.json().catch(() => null);
    const ok = !!(json && json.ok);
    if (!ok) {
      console.warn("[slack] chat.postMessage failed:", JSON.stringify(json || { ok: false, status: res.status }));
      return { ok: false, error: json?.error || `http_${res.status}` };
    }
    return { ok: true, ts: json.ts, channel: json.channel };
  } catch (e) {
    console.warn("[slack] chat.postMessage error:", String(e));
    return { ok: false, error: "network_error" };
  }
}

function slackErrorJaFromSlackApiError(errorRaw) {
  const err = String(errorRaw || "").trim();
  if (!err) return "unknown_error";
  if (err === "missing_token") return "SLACK_BOT_TOKEN未設定";
  if (err === "missing_channel_or_text") return "channel/thread/text不足";
  return err;
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
  /**
   * Hackathon demo approvals (unknown SI -> add to Shelf)
   * @type {Array<{
   *  id: string,
   *  type: "unknown_si_add_to_shelf",
   *  status: "pending" | "approved" | "rejected",
   *  createdAt: string,
   *  updatedAt: string,
   *  title: string,
   *  description: string,
   *  metadata: {
   *    siNumber: string,
   *    source: string,
   *    suggestedStatus: string,
   *    eta?: string,
   *    reason: string,
   *    originalMessage: string
   *  }
   * }>}
   */
  demoApprovals: [],
  /**
   * Hackathon demo created TradeCases (in-memory; optionally file-backed)
   * @type {Array<any>}
   */
  demoTradeCases: [],
  /**
   * TradeCase state overrides (file-backed) keyed by tradeCaseId
   * @type {Record<string, any>}
   */
  tradeCaseOverrides: {},
};

const TRADE_SHELF_DATA_DIR =
  process.env.TRADE_SHELF_DATA_DIR || "/home/data";
const ACTIVITY_EVENTS_FILE_PATH = path.join(TRADE_SHELF_DATA_DIR, "activity-events.json");
const DEMO_APPROVALS_FILE_PATH = path.join(TRADE_SHELF_DATA_DIR, "demo-approvals.json");
const DEMO_TRADECASES_FILE_PATH = path.join(TRADE_SHELF_DATA_DIR, "demo-trade-cases.json");
const LEGACY_DEMO_TRADECASES_FILE_PATH = path.join(TRADE_SHELF_DATA_DIR, "demo-tradecases.json");
const TRADECASE_OVERRIDES_FILE_PATH = path.join(TRADE_SHELF_DATA_DIR, "demo-trade-case-overrides.json");

function demoTradeCaseKeys(tc) {
  const id = String(tc?.id || "").trim();
  const siNumber = (() => {
    const fromSiNumbers = Array.isArray(tc?.siNumbers) ? tc.siNumbers : [];
    const picked = fromSiNumbers.find((x) => String(x ?? "").trim()) || tc?.siEntity?.siNo || "";
    return String(picked || "").trim().toUpperCase();
  })();
  const shipmentNumber = String(tc?.shipmentEntity?.id || "").trim().toUpperCase();
  return { id, siNumber, shipmentNumber };
}

function dedupeDemoTradeCases({ fromMock, fromPersisted }) {
  const mockList = Array.isArray(fromMock) ? fromMock : [];
  const persistedList = Array.isArray(fromPersisted) ? fromPersisted : [];

  const seenIds = new Set();
  const seenSiNumbers = new Set();
  const seenShipmentNumbers = new Set();

  for (const tc of mockList) {
    const { id, siNumber, shipmentNumber } = demoTradeCaseKeys(tc);
    if (id) seenIds.add(id);
    if (siNumber) seenSiNumbers.add(siNumber);
    if (shipmentNumber) seenShipmentNumbers.add(shipmentNumber);
  }

  const out = [];
  for (const tc of persistedList) {
    const { id, siNumber, shipmentNumber } = demoTradeCaseKeys(tc);
    if (!id) continue;
    if (seenIds.has(id)) continue;
    if (siNumber && seenSiNumbers.has(siNumber)) continue;
    if (shipmentNumber && seenShipmentNumbers.has(shipmentNumber)) continue;
    seenIds.add(id);
    if (siNumber) seenSiNumbers.add(siNumber);
    if (shipmentNumber) seenShipmentNumbers.add(shipmentNumber);
    out.push(tc);
  }

  return out;
}

function normalizePersistedActivitySnapshot(snapshot) {
  if (Array.isArray(snapshot)) {
    return { items: snapshot, lastReceivedAt: null };
  }

  if (!snapshot || typeof snapshot !== "object") return null;

  const items = Array.isArray(snapshot.items) ? snapshot.items : null;
  if (!items) return null;

  const lastReceivedAt =
    typeof snapshot.lastReceivedAt === "string" && snapshot.lastReceivedAt.trim()
      ? snapshot.lastReceivedAt.trim()
      : null;

  return { items, lastReceivedAt };
}

function normalizePersistedJsonListSnapshot(snapshot) {
  if (!snapshot) return null;
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot && typeof snapshot === "object" && Array.isArray(snapshot.items)) return snapshot.items;
  return null;
}

function normalizePersistedTradeCaseOverridesSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (Array.isArray(snapshot)) return null;
  if (snapshot.items && typeof snapshot.items === "object" && !Array.isArray(snapshot.items)) return snapshot.items;
  return snapshot;
}

async function tryLoadPersistedJsonList(filePath) {
  try {
    await fs.mkdir(TRADE_SHELF_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn("[demo-store] failed to create data dir:", String(error));
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizePersistedJsonListSnapshot(parsed);
    if (!normalized) throw new Error("invalid persisted shape");
    return normalized;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    console.warn("[demo-store] failed to load persisted list; using defaults:", String(error));
    return null;
  }
}

async function tryLoadPersistedTradeCaseOverrides() {
  try {
    await fs.mkdir(TRADE_SHELF_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn("[demo-store] failed to create data dir:", String(error));
  }

  try {
    const raw = await fs.readFile(TRADECASE_OVERRIDES_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizePersistedTradeCaseOverridesSnapshot(parsed);
    if (!normalized) throw new Error("invalid persisted shape");
    return normalized;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    console.warn("[demo-store] failed to load persisted tradeCase overrides; using defaults:", String(error));
    return null;
  }
}

let demoPersistChain = Promise.resolve();
function schedulePersistDemoStores() {
  const approvalsSnapshot = Array.isArray(slackState.demoApprovals) ? slackState.demoApprovals : [];
  const tradeCasesSnapshot = Array.isArray(slackState.demoTradeCases) ? slackState.demoTradeCases : [];

  demoPersistChain = demoPersistChain
    .then(async () => {
      await persistJsonListSnapshot(DEMO_APPROVALS_FILE_PATH, approvalsSnapshot);
      await persistJsonListSnapshot(DEMO_TRADECASES_FILE_PATH, tradeCasesSnapshot);
    })
    .catch(() => {});
}

let overridesPersistChain = Promise.resolve();
function schedulePersistTradeCaseOverrides() {
  const snapshot = slackState.tradeCaseOverrides && typeof slackState.tradeCaseOverrides === "object" ? slackState.tradeCaseOverrides : {};
  overridesPersistChain = overridesPersistChain.then(() => persistTradeCaseOverridesSnapshot(snapshot)).catch(() => {});
}

async function persistTradeCaseOverridesSnapshot(snapshot) {
  try {
    await fs.mkdir(TRADE_SHELF_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn("[demo-store] failed to create data dir:", String(error));
  }

  const tempPath = `${TRADECASE_OVERRIDES_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    const json = JSON.stringify(snapshot && typeof snapshot === "object" ? snapshot : {}, null, 2);
    await fs.writeFile(tempPath, json, "utf8");
    await fs.rename(tempPath, TRADECASE_OVERRIDES_FILE_PATH);
  } catch (error) {
    console.warn("[demo-store] failed to persist tradeCase overrides snapshot:", String(error));
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failures
    }
  }
}

async function persistJsonListSnapshot(filePath, items) {
  try {
    await fs.mkdir(TRADE_SHELF_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn("[demo-store] failed to create data dir:", String(error));
  }

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const json = JSON.stringify({ items: Array.isArray(items) ? items : [] }, null, 2);
    await fs.writeFile(tempPath, json, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    console.warn("[demo-store] failed to persist snapshot:", String(error));
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failures
    }
  }
}

async function tryLoadPersistedActivitySnapshot() {
  try {
    await fs.mkdir(TRADE_SHELF_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn("[activity-store] failed to create data dir:", String(error));
  }

  try {
    const raw = await fs.readFile(ACTIVITY_EVENTS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizePersistedActivitySnapshot(parsed);
    if (!normalized) throw new Error("invalid persisted shape");
    return normalized;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    console.warn("[activity-store] failed to load persisted activity; using defaults:", String(error));
    return null;
  }
}

let activityPersistChain = Promise.resolve();
function schedulePersistActivitySnapshot() {
  const snapshot = {
    items: Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems : [],
    lastReceivedAt: slackState.lastReceivedAt,
  };

  activityPersistChain = activityPersistChain
    .then(() => persistActivitySnapshot(snapshot))
    .catch(() => {});
}

async function persistActivitySnapshot(snapshot) {
  try {
    await fs.mkdir(TRADE_SHELF_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn("[activity-store] failed to create data dir:", String(error));
  }

  const tempPath = `${ACTIVITY_EVENTS_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;

  try {
    const json = JSON.stringify(snapshot, null, 2);
    await fs.writeFile(tempPath, json, "utf8");
    await fs.rename(tempPath, ACTIVITY_EVENTS_FILE_PATH);
  } catch (error) {
    console.warn("[activity-store] failed to persist activity snapshot:", String(error));
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failures
    }
  }
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

  try {
    const roots = [webPublicRoot, webRoot];
    let found = null;

    for (const root of roots) {
      const abs = path.resolve(root, "." + rel);
      if (!abs.startsWith(root + path.sep)) continue;
      try {
        const buf = await fs.readFile(abs);
        found = { abs, buf };
        break;
      } catch {
        // Try the next root.
      }
    }

    if (!found) throw new Error("not found");

    res.writeHead(200, { "content-type": contentTypeFor(found.abs) });
    res.end(method === "HEAD" ? undefined : found.buf);
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

function normalizeDemoTitle(title) {
  let s = String(title || "").trim();
  if (!s) return "";
  // Strip legacy "【輸入】" / "【三国間】" style prefixes.
  s = s.replace(/^【[^】]+】\s*/u, "");

  // One-off legacy demo titles (kept stable for UI expectations).
  if (s === "SI 1000pcs 指図済み / INV 400pcs のみ発行（数量差異）") return "INV数量差異（SI 1000pcs / INV 400pcs）";
  if (s === "出荷済み / ETA 変更（Forwarder メールあり）") return "ETA変更（Forwarder連絡あり）";
  if (s === "通関完了 / 書類完備 / 正常に完了間近") return "通関完了・書類確認済み";

  return s.trim();
}

function normalizeDemoApprovalItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  const next = { ...item };
  next.title = normalizeDemoTitle(next.title);
  return next;
}

function normalizeDemoTradeCaseItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  const next = { ...item };
  next.title = normalizeDemoTitle(next.title);

  // Migration: some demo TradeCases were persisted with SI number only (unknown SI approval flow).
  // Normalize the persisted title so downstream UIs don't need to guess.
  const siOnlyTitleRe = /^SI-\d{4}-\d+$/i;
  const siFromCase = (() => {
    const candidates = [
      next?.siNumber,
      Array.isArray(next?.siNumbers) ? next.siNumbers[0] : "",
      next?.siEntity?.siNo,
      siOnlyTitleRe.test(String(next?.title || "").trim()) ? String(next.title).trim() : "",
    ];
    for (const c of candidates) {
      const s = String(c || "").trim().toUpperCase();
      if (siOnlyTitleRe.test(s)) return s;
    }
    return "";
  })();

  const t = String(next.title || "").trim();
  if (siFromCase && (t === siFromCase || siOnlyTitleRe.test(t))) {
    next.title = `ETA変更・納期影響確認（${siFromCase}）`;
  }
  return next;
}

const persistedActivitySnapshot = await tryLoadPersistedActivitySnapshot();
if (persistedActivitySnapshot) {
  slackState.activityFeedItems = persistedActivitySnapshot.items;
  slackState.lastReceivedAt = persistedActivitySnapshot.lastReceivedAt;
}

const persistedDemoApprovals = await tryLoadPersistedJsonList(DEMO_APPROVALS_FILE_PATH);
if (persistedDemoApprovals) {
  const normalized = persistedDemoApprovals.map(normalizeDemoApprovalItem).filter(Boolean);
  const changed = JSON.stringify(normalized) !== JSON.stringify(persistedDemoApprovals);
  slackState.demoApprovals = normalized;
  if (changed) persistJsonListSnapshot(DEMO_APPROVALS_FILE_PATH, normalized);
}

const persistedDemoTradeCases =
  (await tryLoadPersistedJsonList(DEMO_TRADECASES_FILE_PATH)) ||
  (await tryLoadPersistedJsonList(LEGACY_DEMO_TRADECASES_FILE_PATH));
if (persistedDemoTradeCases) {
  const normalizedPersisted = persistedDemoTradeCases.map(normalizeDemoTradeCaseItem).filter(Boolean);
  slackState.demoTradeCases = dedupeDemoTradeCases({
    fromMock: mockTradeCases,
    fromPersisted: normalizedPersisted,
  });
  const changed = JSON.stringify(normalizedPersisted) !== JSON.stringify(persistedDemoTradeCases);
  if (changed) persistJsonListSnapshot(DEMO_TRADECASES_FILE_PATH, normalizedPersisted);
}

const persistedTradeCaseOverrides = await tryLoadPersistedTradeCaseOverrides();
if (persistedTradeCaseOverrides) {
  slackState.tradeCaseOverrides =
    persistedTradeCaseOverrides && typeof persistedTradeCaseOverrides === "object" && !Array.isArray(persistedTradeCaseOverrides)
      ? persistedTradeCaseOverrides
      : {};
}

function extractSiNumbersFromText(text) {
  const t = String(text || "");
  const now = new Date();
  // Avoid partial matches like "SI-2026" from "SI-2026-001".
  const siFull = Array.from(t.matchAll(/\bSI-\d{4}-\d+\b/gi)).map((m) => normalizeSiId(m[0], now));
  const siSimple = Array.from(t.matchAll(/\bSI[-\s]?(\d+)\b(?!-\d)/gi)).map((m) => normalizeSiId(`SI-${m[1]}`, now));
  return uniqueStrings([...siFull, ...siSimple]);
}

function extractEtaLabelFromSlackText(text) {
  const t = String(text || "");
  const m = t.match(/\bETA\b[\s\S]{0,60}\bto\b\s+([A-Za-z]{3,9}\s+\d{1,2})\b/i);
  if (m && m[1]) return String(m[1]).trim();
  const m2 = t.match(/\bETA\b\s*[:：]?\s*([A-Za-z]{3,9}\s+\d{1,2})\b/i);
  if (m2 && m2[1]) return String(m2[1]).trim();
  return "";
}

function extractReasonFromSlackText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const candidates = lines.filter((l) => /\b(eta|departure|departed|shipped|cargo)\b/i.test(l));
  const picked = (candidates.length ? candidates : lines).slice(0, 2).join(" / ");
  return picked || "Slack message indicates shipment update.";
}

function buildExistingSiNumberSet() {
  const out = new Set();
  const fromMock = Array.isArray(mockTradeCases) ? mockTradeCases : [];
  for (const tc of fromMock) {
    const siList = Array.isArray(tc?.siNumbers) ? tc.siNumbers : [];
    for (const si of siList) {
      const s = String(si || "").trim().toUpperCase();
      if (s) out.add(s);
    }
    const siEntityNo = String(tc?.siEntity?.siNo || "").trim().toUpperCase();
    if (siEntityNo) out.add(siEntityNo);
  }
  const fromDemo = Array.isArray(slackState.demoTradeCases) ? slackState.demoTradeCases : [];
  for (const tc of fromDemo) {
    const siList = Array.isArray(tc?.siNumbers) ? tc.siNumbers : [];
    for (const si of siList) {
      const s = String(si || "").trim().toUpperCase();
      if (s) out.add(s);
    }
    const siEntityNo = String(tc?.siEntity?.siNo || "").trim().toUpperCase();
    if (siEntityNo) out.add(siEntityNo);
  }
  return out;
}

function findDemoApprovalBySiNumber(siNumber) {
  const si = String(siNumber || "").trim().toUpperCase();
  if (!si) return null;
  const list = Array.isArray(slackState.demoApprovals) ? slackState.demoApprovals : [];
  return list.find((x) => String(x?.metadata?.siNumber || "").trim().toUpperCase() === si) || null;
}

function findPendingDemoApprovalBySiAndSuggestedStatus(siNumber, suggestedStatus) {
  const si = String(siNumber || "").trim().toUpperCase();
  const st = String(suggestedStatus || "").trim();
  if (!si || !st) return null;
  const list = Array.isArray(slackState.demoApprovals) ? slackState.demoApprovals : [];
  return (
    list.find((x) => {
      if (String(x?.status || "") !== "pending") return false;
      const meta = x?.metadata && typeof x.metadata === "object" ? x.metadata : {};
      const metaSi = String(meta?.siNumber || "").trim().toUpperCase();
      const metaSt = String(meta?.suggestedStatus || "").trim();
      return metaSi === si && metaSt === st;
    }) || null
  );
}

function inferSuggestedStatusFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "";

  // Minimal demo mapping -> existing shelf keys used by the frontend.
  // OK scope: 通関中 / 倉庫到着 / ETA変更
  if (t.includes("通関")) return "importCustoms";
  if (t.includes("倉庫到着") || t.includes("倉庫") || t.includes("warehouse")) return "warehouseReceived";
  if (t.includes("eta") || t.includes("到着予定") || t.includes("到着日") || t.includes("納期")) return "inTransit";

  return "";
}

function extractPrimarySiNumberFromLinkedEntities(linkedEntities, fallbackText) {
  const links = Array.isArray(linkedEntities) ? linkedEntities : [];
  for (const l of links) {
    if (String(l?.entityType || "") !== "SI") continue;
    const si = normalizeSiId(String(l?.entityId || ""), new Date());
    if (si) return si;
  }
  const fromText = extractSiNumbersFromText(String(fallbackText || ""));
  return fromText && fromText.length ? String(fromText[0] || "").trim().toUpperCase() : "";
}

function maybeEnqueueDemoApprovalFromApprovalRequiredEvent({ event, rawText }) {
  const ev = event && typeof event === "object" ? event : null;
  if (!ev || String(ev.type || "") !== "approval_required") return null;

  const siNumber = extractPrimarySiNumberFromLinkedEntities(ev.linkedEntities, rawText);
  if (!siNumber) return null;

  const suggestedStatus = inferSuggestedStatusFromText(rawText);
  if (!suggestedStatus) return null;

  const dedupeExisting = findPendingDemoApprovalBySiAndSuggestedStatus(siNumber, suggestedStatus);
  if (dedupeExisting) return dedupeExisting;

  const title = "状態更新候補";
  const description = `${siNumber} の状態を更新しますか？`;
  const approval = {
    id: `APR-STATE-${siNumber.replace(/[^A-Z0-9]/g, "")}-${suggestedStatus}-${Date.now()}`,
    type: "state_update",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title,
    description,
    metadata: {
      siNumber,
      source: "slack",
      suggestedStatus,
      eta: "",
      reason: "",
      originalMessage: String(rawText || "").trim(),
    },
  };

  upsertDemoApproval(approval);
  return approval;
}

function pushActivityItem(item) {
  slackState.activityFeedItems = [item, ...(Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems : [])].slice(0, 500);
  slackState.lastReceivedAt = new Date().toISOString();
  schedulePersistActivitySnapshot();
}

function upsertDemoApproval(approval) {
  const list = Array.isArray(slackState.demoApprovals) ? slackState.demoApprovals : [];
  const id = String(approval?.id || "").trim();
  if (!id) return;
  const idx = list.findIndex((x) => String(x?.id || "") === id);
  if (idx === -1) slackState.demoApprovals = [approval, ...list].slice(0, 200);
  else {
    const next = list.slice();
    next[idx] = approval;
    slackState.demoApprovals = next;
  }
  schedulePersistDemoStores();
}

function appendDemoTradeCase(tc) {
  const list = Array.isArray(slackState.demoTradeCases) ? slackState.demoTradeCases : [];
  const { id, siNumber, shipmentNumber } = demoTradeCaseKeys(tc);
  if (!id) return;
  if (list.some((x) => String(x?.id || "").trim() === id)) return;
  if (
    siNumber &&
    list.some((x) => {
      const keys = demoTradeCaseKeys(x);
      return keys.siNumber === siNumber;
    })
  )
    return;
  if (
    shipmentNumber &&
    list.some((x) => {
      const keys = demoTradeCaseKeys(x);
      return keys.shipmentNumber === shipmentNumber;
    })
  )
    return;
  slackState.demoTradeCases = [tc, ...list].slice(0, 200);
  schedulePersistDemoStores();
}

function nextInternalShipmentId({ now = new Date(), preferredYear } = {}) {
  const year = typeof preferredYear === "string" && preferredYear.trim() ? preferredYear.trim() : String(now.getFullYear());

  const candidates = [];
  const fromMock = Array.isArray(mockTradeCases) ? mockTradeCases : [];
  const fromDemo = Array.isArray(slackState.demoTradeCases) ? slackState.demoTradeCases : [];

  for (const tc of [...fromMock, ...fromDemo]) {
    const id = String(tc?.shipmentEntity?.id || "").trim();
    if (!id) continue;
    const m = id.match(/^SHP-(\d{4})-(\d+)\b/);
    if (!m) continue;
    candidates.push({ year: m[1], num: Number(m[2]) });
  }

  const maxForYear = candidates
    .filter((x) => x.year === year && Number.isFinite(x.num))
    .reduce((acc, x) => (x.num > acc ? x.num : acc), 0);

  const next = maxForYear + 1;
  return `SHP-${year}-${String(next).padStart(3, "0")}`;
}

function createDemoTradeCaseFromApproval(approval) {
  const siNumber = String(approval?.metadata?.siNumber || "").trim().toUpperCase();
  const eta = String(approval?.metadata?.eta || "").trim();
  const source = String(approval?.metadata?.source || "slack").trim();
  const suggestedStatus = String(approval?.metadata?.suggestedStatus || "inTransit").trim();

  const idNum = siNumber.replace(/[^0-9]/g, "") || String(Date.now());
  const id = `TC-DEMO-${idNum}`;
  const shipmentId = nextInternalShipmentId({ now: new Date(), preferredYear: "2026" });

  return {
    id,
    title: siNumber ? `ETA変更・納期影響確認（${siNumber}）` : "ETA変更・納期影響確認",
    tradeType: "import",
    siNumbers: [siNumber],
    invoiceNumbers: [],
    blNumbers: [],
    shipmentRefs: [],
    shipmentEntity: {
      id: shipmentId,
      eta: eta || "",
      shipmentState: suggestedStatus || "inTransit",
      source,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
    siEntity: {
      id: `SIE-DEMO-${idNum}`,
      siNo: siNumber,
      requestedDeliveryDate: "",
      relatedShipmentIds: [],
      relatedInvoiceNos: [],
      salesOwners: [],
    },
    supplierIds: [],
    supplier: {
      id: "SUP-DEMO",
      name: "Supplier (from Slack)",
      country: "",
      contactEmail: "",
    },
    customer: {
      id: "CUS-DEMO",
      name: "Customer",
      country: "",
      contactEmail: "",
    },
    caseProgress: {
      caseId: id,
      overallPercent: 0,
      currentStatusLabel: "Slackから新規作成",
      blockingSummary: [],
      documents: [],
      bookingSchedule: [],
      resolution: [],
    },
    timeline: [
      {
        id: `TL-${Date.now()}`,
        at: new Date().toISOString(),
        type: "createdFromSlack",
        message: `Created from Slack approval (${siNumber}) / Shipment ${shipmentId}`,
      },
    ],
    nextActions: [],
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    createdFrom: "slack",
    createdBy: "ai_agent",
  };
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

  if (method === "GET" && reqUrl.pathname === "/api/demo/approvals") {
    sendJson(res, 200, {
      ok: true,
      items: Array.isArray(slackState.demoApprovals) ? slackState.demoApprovals : [],
    });
    return;
  }

  if (method === "GET" && reqUrl.pathname === "/api/demo/tradecases") {
    sendJson(res, 200, {
      ok: true,
      items: Array.isArray(slackState.demoTradeCases) ? slackState.demoTradeCases : [],
    });
    return;
  }

  if (method === "GET" && reqUrl.pathname === "/api/demo/tradecase-overrides") {
    sendJson(res, 200, {
      ok: true,
      items: slackState.tradeCaseOverrides && typeof slackState.tradeCaseOverrides === "object" ? slackState.tradeCaseOverrides : {},
    });
    return;
  }

  if (method === "POST" && reqUrl.pathname === "/api/demo/tradecase-overrides") {
    try {
      const body = await readJsonBody(req);
      const tradeCaseId = String(body.tradeCaseId || body.id || "").trim();
      if (!tradeCaseId) {
        sendJson(res, 400, { ok: false, error: "tradeCaseId is required" });
        return;
      }

      const overrideIn = body.override && typeof body.override === "object" ? body.override : body;
      const shipmentState = typeof overrideIn.shipmentState === "string" ? overrideIn.shipmentState.trim() : "";
      const shipmentEntityState = (() => {
        const se = overrideIn.shipmentEntity && typeof overrideIn.shipmentEntity === "object" ? overrideIn.shipmentEntity : {};
        return typeof se.shipmentState === "string" ? se.shipmentState.trim() : "";
      })();

      const updatedAt = new Date().toISOString();
      const nextOverride = {
        ...(slackState.tradeCaseOverrides && typeof slackState.tradeCaseOverrides === "object" ? slackState.tradeCaseOverrides[tradeCaseId] : null),
        ...(shipmentState ? { shipmentState } : {}),
        shipmentEntity: shipmentEntityState ? { shipmentState: shipmentEntityState } : undefined,
        updatedAt,
      };

      if (!slackState.tradeCaseOverrides || typeof slackState.tradeCaseOverrides !== "object") slackState.tradeCaseOverrides = {};
      slackState.tradeCaseOverrides[tradeCaseId] = nextOverride;

      // Persist in background; never crash server on write failures.
      schedulePersistTradeCaseOverrides();

      sendJson(res, 200, { ok: true, tradeCaseId, override: nextOverride });
      return;
    } catch (e) {
      console.warn("[demo] failed to update tradeCase overrides:", String(e));
      sendJson(res, 200, { ok: false, error: "failed_to_update_override" });
      return;
    }
  }

  if (method === "POST" && reqUrl.pathname === "/api/demo/approvals/approve") {
    try {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) {
        sendJson(res, 400, { ok: false, error: "id is required" });
        return;
      }
      const list = Array.isArray(slackState.demoApprovals) ? slackState.demoApprovals : [];
      const approval = list.find((x) => String(x?.id || "") === id) || null;
      if (!approval) {
        sendJson(res, 404, { ok: false, error: "approval not found" });
        return;
      }
      if (String(approval.status) !== "pending") {
        sendJson(res, 200, { ok: true, already: true, approval });
        return;
      }

      const updated = {
        ...approval,
        status: "approved",
        updatedAt: new Date().toISOString(),
      };
      upsertDemoApproval(updated);

      const approvalType = String(updated?.type || "").trim();
      const siNumber = String(updated?.metadata?.siNumber || "").trim().toUpperCase();

      if (approvalType === "slack_clarification") {
        const channel = String(updated?.metadata?.channel || "").trim();
        const threadTs = String(updated?.metadata?.threadTs || "").trim();
        const replyText = String(updated?.metadata?.replyText || "").trim();

        console.log("[slack clarification approve]", {
          approvalId: id,
          channel,
          threadTs,
          hasToken: Boolean(String(process.env.SLACK_BOT_TOKEN || "").trim()),
        });

        const replyResult = await postSlackReply({ channel, threadTs, text: replyText }).catch((e) => {
          console.warn("[slack clarification approve] postSlackReply threw:", String(e));
          return { ok: false, error: "exception" };
        });

        const slackSendOk = Boolean(replyResult && replyResult.ok);
        const slackSendError = slackSendOk ? "" : slackErrorJaFromSlackApiError(replyResult?.error || "unknown_error");

        const nextApproval = {
          ...updated,
          metadata: {
            ...(updated?.metadata && typeof updated.metadata === "object" ? updated.metadata : {}),
            slackSendOk,
            slackSendError,
          },
          updatedAt: new Date().toISOString(),
        };
        upsertDemoApproval(nextApproval);

        pushActivityItem({
          id: `slack:clarification_sent:${id}:${Date.now()}`,
          type: "aiProcessed",
          source: "ai",
          title: slackSendOk ? "Slack返信送信済み：対象案件確認を送信しました" : `Slack返信失敗：${slackSendError || "unknown_error"}`,
          actor: "trade-shelf-agent",
          occurredAt: new Date().toISOString(),
          summary: replyText,
          details: [
            channel ? `channel: ${channel}` : "",
            threadTs ? `threadTs: ${threadTs}` : "",
            slackSendOk ? "" : `reason: ${slackSendError}`,
          ].filter(Boolean),
          statusKey: slackSendOk ? "success" : "failed",
          linked: [],
          links: [],
        });

        if (slackSendOk) {
          pushActivityItem({
            id: `slack:clarification_waiting:${id}:${Date.now()}`,
            type: "clarification_waiting",
            source: "ai",
            title: "Slack返答待ち",
            actor: "trade-shelf-agent",
            occurredAt: new Date().toISOString(),
            summary: "Slack返答待ち",
            details: [],
            statusKey: "processing",
            linked: [],
            links: [],
          });
        }

        sendJson(res, 200, { ok: slackSendOk, approval: nextApproval, tradeCase: null, slack: replyResult });
        return;
      }

      if (approvalType === "state_update") {
        const suggestedStatus = String(updated?.metadata?.suggestedStatus || "").trim();
        const list = Array.isArray(slackState.demoTradeCases) ? slackState.demoTradeCases : [];
        const idx = list.findIndex((tc) => {
          const si = String(tc?.siEntity?.siNo || (Array.isArray(tc?.siNumbers) ? tc.siNumbers[0] : "") || "").trim().toUpperCase();
          return si && si === siNumber;
        });

        if (idx !== -1) {
          const tcPrev = list[idx];
          const fromState = String(tcPrev?.shipmentEntity?.shipmentState || "").trim();
          const nextTc = {
            ...tcPrev,
            shipmentEntity: {
              ...(tcPrev?.shipmentEntity || {}),
              shipmentState: suggestedStatus || fromState,
              updatedAt: new Date().toISOString(),
            },
            caseProgress: {
              ...(tcPrev?.caseProgress || {}),
              currentStatusLabel: suggestedStatus ? `状態更新: ${suggestedStatus}` : (tcPrev?.caseProgress?.currentStatusLabel || ""),
            },
            timeline: [
              {
                id: `TL-${Date.now()}`,
                at: new Date().toISOString(),
                type: "approvedStateUpdate",
                message: `Approved state update: ${fromState || "-"} → ${suggestedStatus || "-"}`,
              },
              ...(Array.isArray(tcPrev?.timeline) ? tcPrev.timeline : []),
            ],
            updatedAt: new Date().toISOString(),
          };

          const nextList = list.slice();
          nextList[idx] = nextTc;
          slackState.demoTradeCases = nextList;
          schedulePersistDemoStores();

          const shipmentId = String(nextTc?.shipmentEntity?.id || "").trim();
          pushActivityItem({
            id: `demo:approved:${siNumber}:${Date.now()}`,
            type: "aiProcessed",
            source: "ai",
            title: `承認済み：${siNumber} の状態更新を承認しました`,
            actor: "demo approval",
            occurredAt: new Date().toISOString(),
            summary: updated.description || "approved",
            details: [`approvalId: ${updated.id}`],
            statusKey: "success",
            linked: [{ kind: "si", label: siNumber }, ...(shipmentId ? [{ kind: "shipment", label: shipmentId }] : [])],
            links: [],
          });

          pushActivityItem({
            id: `demo:state-transition:${siNumber}:${Date.now()}`,
            type: "aiProcessed",
            source: "ai",
            title: `状態更新：${siNumber} ${fromState || "-"} → ${suggestedStatus || "-"}`,
            actor: "demo approval",
            occurredAt: new Date().toISOString(),
            summary: "state transition",
            details: [`from: ${fromState || "-"}`, `to: ${suggestedStatus || "-"}`],
            statusKey: "success",
            linked: [{ kind: "si", label: siNumber }, ...(shipmentId ? [{ kind: "shipment", label: shipmentId }] : [])],
            links: [],
          });

          sendJson(res, 200, { ok: true, approval: updated, tradeCase: nextTc });
          return;
        }

        // If we don't have a TradeCase yet, treat it as a no-op approval (still approved).
        sendJson(res, 200, { ok: true, approval: updated, tradeCase: null });
        return;
      }

      // Default demo approval flow: unknown SI -> add to shelf.
      const tc = createDemoTradeCaseFromApproval(updated);
      appendDemoTradeCase(tc);

      const shipmentId = String(tc?.shipmentEntity?.id || "").trim();
      pushActivityItem({
        id: `demo:shelf-added:${siNumber}:${Date.now()}`,
        type: "aiProcessed",
        source: "ai",
        title: `Shelf追加：${siNumber} を新規案件として追加しました`,
        actor: "demo approval",
        occurredAt: new Date().toISOString(),
        summary: `Added ${siNumber}`,
        details: [`siNumber: ${siNumber}`, shipmentId ? `出荷番号：${shipmentId}` : ""].filter(Boolean),
        statusKey: "success",
        linked: [{ kind: "si", label: siNumber }, ...(shipmentId ? [{ kind: "shipment", label: shipmentId }] : [])],
        links: [],
      });

      pushActivityItem({
        id: `demo:state-transition:${siNumber}:${Date.now()}`,
        type: "aiProcessed",
        source: "ai",
        title: `状態更新：${siNumber} shippingPending → inTransit`,
        actor: "demo approval",
        occurredAt: new Date().toISOString(),
        summary: "state transition",
        details: ["from: shippingPending", "to: inTransit"],
        statusKey: "success",
        linked: [{ kind: "si", label: siNumber }, ...(shipmentId ? [{ kind: "shipment", label: shipmentId }] : [])],
        links: [],
      });

      sendJson(res, 200, { ok: true, approval: updated, tradeCase: tc });
      return;

    } catch (e) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return;
    }
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
        const subtype = ev.subtype ? String(ev.subtype) : "";
        const botId = ev.bot_id ? String(ev.bot_id) : "";
        if (subtype || botId) {
          sendJson(res, 200, { ok: true, ignored: true, subtype: subtype || null, botId: botId || null });
          return;
        }
        const channelId = String(ev.channel || "").trim();
        const channelRaw = String(ev.channel || ev.channel_name || "").trim();
        const channel = channelRaw ? (channelRaw.startsWith("#") ? channelRaw : `#${channelRaw}`) : "#unknown";
        const user = String(ev.user || ev.username || "unknown").trim() || "unknown";
        const text = String(ev.text || "").trim();
        const ts = String(ev.ts || body.event_time || Date.now()).trim();
        const threadTs = String(ev.thread_ts || ts || "").trim();

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
        schedulePersistActivitySnapshot();

        // Hackathon demo: detect unknown SI -> enqueue approval + activity entries.
        try {
          const siNumbers = extractSiNumbersFromText(text);
          if (siNumbers.length) {
            const existing = buildExistingSiNumberSet();
            for (const siNumberRaw of siNumbers) {
              const siNumber = String(siNumberRaw || "").trim().toUpperCase();
              if (!siNumber) continue;

              if (existing.has(siNumber)) continue;

              const already = findDemoApprovalBySiNumber(siNumber);
              if (already) continue;

              const eta = extractEtaLabelFromSlackText(text);
              const reason = extractReasonFromSlackText(text);

              const approval = {
                id: `APR-DEMO-${siNumber.replace(/[^A-Z0-9]/g, "")}-${Date.now()}`,
                type: "unknown_si_add_to_shelf",
                status: "pending",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                title: "新規案件候補",
                description: `${siNumber} を新規案件として Shelf に追加しますか？`,
                metadata: {
                  siNumber,
                  source: "slack",
                  suggestedStatus: "inTransit",
                  eta: eta || "",
                  reason,
                  originalMessage: text,
                },
              };

              upsertDemoApproval(approval);

              pushActivityItem({
                id: `demo:unknown-si:${siNumber}:${Date.now()}`,
                type: "aiProcessed",
                source: "ai",
                title: `未登録SIを検出：${siNumber} は Shelf に存在しません`,
                actor: "demo detector",
                occurredAt: new Date().toISOString(),
                summary: reason,
                details: [reason],
                statusKey: "awaitingApproval",
                linked: [{ kind: "si", label: siNumber }],
                links: [],
              });

              pushActivityItem({
                id: `demo:approval-required:${siNumber}:${Date.now()}`,
                type: "aiProcessed",
                source: "ai",
                title: `承認待ち：${siNumber} を新規案件として登録できます`,
                actor: "demo detector",
                occurredAt: new Date().toISOString(),
                summary: approval.description,
                details: [`approvalId: ${approval.id}`, `eta: ${eta || "-"}`],
                statusKey: "awaitingApproval",
                linked: [{ kind: "si", label: siNumber }],
                links: [],
              });
            }
          }
        } catch (e) {
          console.warn("[demo] failed to enqueue unknown SI approval:", String(e));
        }

        // Slack expects a response within ~3 seconds; ingest runs async for demo safety.
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok");

        Promise.resolve()
          .then(async () => {
            // If no SHP/SI is present, ask the requester to specify which shipment they mean.
            const hasSi = extractSiNumbersFromText(text).length > 0;
            const hasShipment = /\bSHP-\d{4}-\d{3}\b/i.test(text);
            const hasInvoice = /\bINV[-\s]?\d{1,8}\b/i.test(text);
            const needsClarification = !hasSi && !hasShipment && !hasInvoice;

            if (needsClarification) {
              const clarificationText = "どの出荷の件でしょうか？\nSHP番号 / SI番号 / INV番号 を教えてください。";
              const now = new Date().toISOString();
              const thread = threadTs || ts;

              // Keep a dedicated "確認待ち" item in server-backed demo approvals.
              // Slack reply must be sent on server-side approve (NOT here).
              try {
                const approval = {
                  id: `APR-DEMO-CLARIFY-${eventId || ts}-${Date.now()}`,
                  type: "slack_clarification",
                  status: "pending",
                  createdAt: now,
                  updatedAt: now,
                  title: "営業確認待ち（Slack）",
                  description: `Slack確認返信（承認待ち）：${clarificationText.replace(/\n/g, " ")}`,
                  metadata: {
                    source: "slack",
                    channel: channelId,
                    threadTs: thread,
                    replyText: clarificationText,
                    requester: user,
                    originalMessage: text,
                    clarificationQuestion: clarificationText,
                    slackSendOk: false,
                    slackSendError: "",
                  },
                };
                upsertDemoApproval(approval);

                pushActivityItem({
                  id: `slack:clarification_pending:${approval.id}:${Date.now()}`,
                  type: "approval_required",
                  source: "ai",
                  title: "承認待ち：Slack確認返信の送信を承認してください",
                  actor: "trade-shelf-agent",
                  occurredAt: now,
                  summary: clarificationText,
                  details: [
                    `approvalId: ${approval.id}`,
                    channel ? `channel: ${channel}` : "",
                    thread ? `threadTs: ${thread}` : "",
                  ].filter(Boolean),
                  statusKey: "awaitingApproval",
                  linked: [],
                  links: [],
                });
              } catch (e) {
                console.warn("[demo] failed to enqueue slack clarification waiting approval:", String(e));
              }

              return;
            }

            const rawInput = {
              id: `slack-${eventId || ts || Date.now()}`,
              source: "slack",
              receivedAt: new Date().toISOString(),
              senderName: user,
              channel,
              threadTs: threadTs || ts,
              subject: undefined,
              rawText: text,
              attachmentNames: [],
              status: "received",
            };

            const result = await ingestWithLlmOrMock({ rawInput, pendingClarifications: [] });
            const events = Array.isArray(result?.activityEvents) ? result.activityEvents.filter(Boolean) : [];
            const stateTransitionCandidates = Array.isArray(result?.stateTransitionCandidates)
              ? result.stateTransitionCandidates.filter(Boolean)
              : [];
            const stcById = new Map(stateTransitionCandidates.map((c) => [String(c?.id || "").trim(), c]));

            // Attach full candidate payload so the web UI can re-use existing applyStateTransitionCandidate logic
            // even when the candidate originates from server-side Slack ingest (no local ingest result).
            for (const evv of events) {
              if (!evv || String(evv.type || "") !== "state_transition_candidate_detected") continue;
              const evId = String(evv.id || "").trim();
              const candId = evId.startsWith("ACT-") ? evId.slice(4) : evId;
              const cand = candId ? stcById.get(candId) || null : null;
              if (!cand) continue;
              try {
                evv.stateTransitionCandidate = cand;
              } catch {
                // ignore (non-extensible event object)
              }
            }

            // If approval_required was generated, also register a pending demo approval item
            // so Approval Center + Agent Toast can surface it.
            try {
              for (const evv of events) {
                const created = maybeEnqueueDemoApprovalFromApprovalRequiredEvent({ event: evv, rawText: text });
                if (!created || !created.id) continue;
                // Attach for downstream UI surfaces (Activity -> Toast CTA).
                try {
                  evv.demoApprovalId = created.id;
                } catch {
                  // ignore (non-extensible event object)
                }
                const siNumber = String(created?.metadata?.siNumber || "").trim().toUpperCase();
                if (!siNumber) continue;
                pushActivityItem({
                  id: `demo:approval-created:${siNumber}:${Date.now()}`,
                  type: "aiProcessed",
                  source: "ai",
                  title: `承認待ち：${siNumber} の状態更新候補を追加しました`,
                  actor: "demo approval bridge",
                  occurredAt: new Date().toISOString(),
                  summary: created.description || created.title || "approval pending",
                  details: [`approvalId: ${created.id}`, `suggestedStatus: ${String(created?.metadata?.suggestedStatus || "")}`].filter(Boolean),
                  statusKey: "awaitingApproval",
                  linked: [{ kind: "si", label: siNumber }],
                  links: [],
                });
              }
            } catch (e) {
              console.warn("[demo] failed to create state_update demo approval:", String(e));
            }

            const feedItems = events.map((evv) =>
              activityEventToFeedItem(evv, { actorFallback: hasAzureLlmEnv() ? "Kimi AI分類" : "mock ingest" }),
            );
            if (feedItems.length) {
              slackState.activityFeedItems = [...feedItems, ...(Array.isArray(slackState.activityFeedItems) ? slackState.activityFeedItems : [])].slice(0, 400);
              schedulePersistActivitySnapshot();
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
            schedulePersistActivitySnapshot();
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

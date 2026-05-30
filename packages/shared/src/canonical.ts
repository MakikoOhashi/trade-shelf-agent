import type { EntityLink, OperationalThread, PendingClarification, RawInput } from "./domain";

function stableHash8(seed: string) {
  // FNV-1a 32-bit hash → 8 hex chars (same core as ingest.ts)
  let hash = 2166136261;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

export type CanonicalConversationResolution = {
  conversationThreadId: string;
  reason:
    | "pending_clarification_id"
    | "pending_clarification_match"
    | "sender_channel_bucket"
    | "raw_input_id";
  pendingClarificationId?: string;
};

function parseTime(value: string | undefined) {
  const s = String(value || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function canonicalNormalizeSiId(siId: string, now = new Date()) {
  const raw = String(siId || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase().replace(/\s+/g, "");

  const m1 = upper.match(/^SI-(\d{4})-(\d{3,})$/);
  if (m1) return `SI-${m1[1]}-${m1[2]}`;

  const m2 = upper.match(/^SI-(\d{3,})$/);
  if (m2) return `SI-${String(now.getFullYear())}-${String(m2[1]).padStart(3, "0")}`;

  return upper.startsWith("SI-") ? upper : "";
}

function canonicalNormalizeShipmentId(shp: string, _now = new Date()) {
  const raw = String(shp || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase().replace(/\s+/g, "");

  const m1 = upper.match(/^SHP-(\d{4})-(\d{3})$/);
  if (m1) return `SHP-${m1[1]}-${m1[2]}`;

  return "";
}

function canonicalUniqueUpper(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = String(v || "").trim().toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function canonicalExtractEntityIdsFromText(text: string) {
  const t = String(text || "");
  const now = new Date();

  // Important: avoid partial matches like "SI-2026" from "SI-2026-001".
  const siFull = Array.from(t.matchAll(/\bSI-\d{4}-\d+\b/gi)).map((m) => canonicalNormalizeSiId(m[0], now));
  const siSimple = Array.from(t.matchAll(/\bSI[-\s]?(\d+)\b(?!-\d)/gi)).map((m) => canonicalNormalizeSiId(`SI-${m[1]}`, now));
  const siNormalized = canonicalUniqueUpper([...siFull, ...siSimple]);

  const shipmentMatches = Array.from(t.matchAll(/\bSHP[-_\s]?(\d{4})[-_\s]?(\d{3})\b/gi)).map((m) =>
    canonicalNormalizeShipmentId(`SHP-${m[1]}-${m[2]}`, now),
  );
  const shipmentNormalized = canonicalUniqueUpper(shipmentMatches);

  const invMatches = Array.from(t.matchAll(/INV[-\s]?(\d{1,8})/gi)).map((m) => `INV-${m[1]}`.toUpperCase());
  const invNormalized = canonicalUniqueUpper(invMatches);

  return { siIds: siNormalized, shipmentIds: shipmentNormalized, invoiceIds: invNormalized };
}

function satisfiesMissingFields(rawText: string, missingFields: string[]) {
  const fields = Array.isArray(missingFields) ? missingFields.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!fields.length) return false;

  const entities = canonicalExtractEntityIdsFromText(rawText);
  const lower = fields.join(" ").toLowerCase();
  const needsSi = lower.includes("si");
  const needsShipment = lower.includes("shipment") || lower.includes("shp");
  const needsInv = lower.includes("inv") || lower.includes("invoice");

  const hasSi = entities.siIds.length > 0;
  const hasShipment = entities.shipmentIds.length > 0;
  const hasInv = entities.invoiceIds.length > 0;

  const isOr = lower.includes(" or ");
  if (isOr && needsSi && needsShipment) return hasSi || hasShipment;
  if (needsSi && !hasSi) return false;
  if (needsShipment && !hasShipment) return false;
  if (needsInv && !hasInv) return false;
  return hasSi || hasShipment || hasInv;
}

export function matchPendingClarification(
  input: RawInput,
  pendingClarifications: PendingClarification[],
): PendingClarification | null {
  const pending = Array.isArray(pendingClarifications) ? pendingClarifications.filter(Boolean) : [];
  if (!pending.length) return null;

  const requesterName = String(input?.senderName || "").trim();
  const sourceChannel = String(input?.channel || "").trim();
  const threadTs = String(input?.threadTs || "").trim();
  const rawText = String(input?.rawText || "");

  const candidates = pending
    .filter((p) => String(p?.status || "") === "awaiting_clarification_reply")
    .filter((p) => {
      const pn = String(p?.requesterName || "").trim();
      if (pn && requesterName && pn !== requesterName) return false;
      return true;
    })
    .filter((p) => {
      const pc = String(p?.sourceChannel || "").trim();
      if (pc && sourceChannel && pc !== sourceChannel) return false;
      return true;
    })
    .filter((p) => {
      const pt = String(p?.sourceThreadTs || "").trim();
      // If the pending clarification is thread-scoped, require an exact match to avoid
      // cross-thread clarification leakage within a channel.
      if (pt) return Boolean(threadTs && pt === threadTs);
      return true;
    })
    .filter((p) => satisfiesMissingFields(rawText, p.missingFields));

  if (!candidates.length) return null;

  const now = Date.now();
  const byRecency = (p: PendingClarification) => {
    const t = Date.parse(String(p?.createdAt || ""));
    const ts = Number.isFinite(t) ? t : now;
    return Math.abs(now - ts);
  };
  candidates.sort((a, b) => byRecency(a) - byRecency(b) || String(a.id || "").localeCompare(String(b.id || "")));
  return candidates[0] || null;
}

export function resolveCanonicalConversation(
  input: RawInput,
  options: { pendingClarifications?: PendingClarification[]; bucketMinutes?: number } = {},
): CanonicalConversationResolution {
  const pending = Array.isArray(options.pendingClarifications) ? options.pendingClarifications.filter(Boolean) : [];

  const direct = pending.find(
    (p) => String(p?.sourceRawInputId || "") === String(input?.id || "") || String(p?.matchedRawInputId || "") === String(input?.id || ""),
  );
  if (direct && direct.id) {
    return {
      conversationThreadId: `CONV:${String(direct.id).trim()}`,
      reason: "pending_clarification_id",
      pendingClarificationId: String(direct.id).trim(),
    };
  }

  const matched = matchPendingClarification(input, pending);
  if (matched && matched.id) {
    return {
      conversationThreadId: `CONV:${String(matched.id).trim()}`,
      reason: "pending_clarification_match",
      pendingClarificationId: String(matched.id).trim(),
    };
  }

  const bucketMinutes = typeof options.bucketMinutes === "number" && options.bucketMinutes > 0 ? options.bucketMinutes : 15;
  const sender = String(input?.senderName || "").trim();
  const channel = String(input?.channel || input?.source || "").trim();
  const t = parseTime(input?.receivedAt);
  if (sender && channel && t) {
    const bucket = Math.floor(t.getTime() / (bucketMinutes * 60 * 1000));
    const h = stableHash8(`near:${sender}:${channel}:${bucket}`);
    return { conversationThreadId: `CONV:NEAR-${h}`, reason: "sender_channel_bucket" };
  }

  return { conversationThreadId: `CONV:RAW-${stableHash8(String(input?.id || ""))}`, reason: "raw_input_id" };
}

export type CanonicalIssueLink = {
  issueId: string;
  reason: "linked_issue" | "candidate_from_thread";
};

export function issueCandidateIdFromThreadId(threadId: string) {
  // Keep consistent with ingest.ts: ISS-CAND-${FNV1a(threadId)} uppercased
  const h = stableHash8(String(threadId || "")).slice(-8);
  return `ISS-CAND-${h}`;
}

export function stateTransitionCandidateIdFromParts(parts: {
  rawInputId: string;
  entityId: string;
  toState: string;
}): string {
  const rawInputId = String(parts?.rawInputId || "").trim();
  const entityId = String(parts?.entityId || "").trim();
  const toState = String(parts?.toState || "").trim();
  const h = stableHash8(`stc:${rawInputId}:${entityId}:${toState}`).slice(-8);
  return `STC-${h}`;
}

export function resolveCanonicalIssueLink(
  thread: OperationalThread,
  threadLinks: EntityLink[] = [],
  mode: "candidate" | "existing_or_candidate" = "existing_or_candidate",
): CanonicalIssueLink {
  const links = Array.isArray(threadLinks) ? threadLinks.filter(Boolean) : [];
  if (mode !== "candidate") {
    const existing = links.find((l) => l?.entityType === "Issue" && String(l?.entityId || "").trim());
    if (existing && existing.entityId) return { issueId: String(existing.entityId).trim(), reason: "linked_issue" };
  }
  return { issueId: issueCandidateIdFromThreadId(String(thread?.id || "")), reason: "candidate_from_thread" };
}

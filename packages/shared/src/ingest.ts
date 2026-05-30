import type {
  ActionPlan,
  ActionType,
  ActivityEvent,
  ContextResolution,
  DraftDocument,
  EntityLink,
  TradeCase,
  PendingClarification,
  IntakeResolution,
  IssueMutation,
  MockIngestResult,
  OperationalThread,
  RawInput,
  StateTransitionCandidate,
  StateTransitionEntityType,
  StateTransitionEvidence,
  StateTransitionRisk,
} from "./domain";
import type { ActivityEventType } from "./domain";
import { matchPendingClarification, resolveCanonicalIssueLink, stateTransitionCandidateIdFromParts } from "./canonical";
import { resolveOperationalContext } from "./relationshipResolver";

function ingestStableId(prefix: string, seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function ingestHash8(seed: string) {
  // Same FNV-1a core as ingestStableId(), but returns only the 8-hex hash.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function ingestNowIso() {
  return new Date().toISOString();
}

const ACTIVITY_SEQUENCE: Record<ActivityEventType, number> = {
  raw_input_received: 10,
  context_resolved: 15,
  clarification_waiting: 16,
  clarification_matched: 18,
  clarification_required: 16,
  human_selection_required: 16,
  reminder_planned: 17,
  classified: 20,
  entity_linked: 30,
  state_transition_not_supported: 32,
  state_transition_candidate_detected: 33,
  intake_resolved: 35,
  action_planned: 40,
  approval_required: 50,
  draft_created: 45,
  issue_updated: 60,
  approved: 70,
  edited: 71,
  held: 72,
  mock_sent: 80,
  failed_processing: 90,
};

export type IngestBuildOptions = {
  sourceLabel?: string;
  approvalPolicy?: "all" | "low_confidence" | "none";
  tradeCases?: TradeCase[];
};

export type IngestPipelineOptions = IngestBuildOptions & {
  threads?: OperationalThread[];
  pendingClarifications?: PendingClarification[];
};

type StateTransitionNotice = {
  entityType: StateTransitionEntityType;
  entityId: string;
  fromState?: string;
  toState?: string;
  title: string;
  message: string;
  reason?: string;
};

const ALLOWED_SHELF_TRANSITION_STATES = new Set<string>([
  // Canonical (domain.ts ShipmentState)
  "notArranged",
  "bookingRequested",
  "shippingPending",
  "shipped",
  "inTransit",
  "arrived",
  "customsCleared",
  "completed",
  // Shelf-mapped shipment progress (apps/web/lib/shelfMapping.js)
  "exportCustoms",
  "importCustoms",
  "waitingWarehouseReceipt",
  "warehouseReceived",
]);

function addHoursIso(baseIso: string, hours: number) {
  const d = new Date(baseIso);
  if (Number.isNaN(d.getTime())) return ingestNowIso();
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

function normalizeSiId(siId: string, now = new Date()) {
  const raw = String(siId || "").trim();
  if (!raw) return "";
  // If already normalized like "SI-2026-001", return as-is (normalized casing).
  const already = raw.match(/^SI-\d{4}-\d+/i);
  if (already) return raw.toUpperCase();

  // "SI-224" / "SI224" / "SI 224" -> "SI-YYYY-224" (pad3)
  const simpleMatch = raw.match(/^SI[-\s]?(\d+)$/i);
  if (simpleMatch) {
    const year = String(now.getFullYear());
    const num = String(simpleMatch[1] || "").replace(/\D/g, "");
    if (!num) return raw.toUpperCase();
    return `SI-${year}-${num.padStart(3, "0")}`.toUpperCase();
  }

  return raw.toUpperCase();
}

function normalizeShipmentId(shipmentId: string, _now = new Date()) {
  const raw = String(shipmentId || "").trim();
  if (!raw) return "";
  const normalizedMatch = raw.match(/^SHP-(\d{4})-(\d{3})$/i);
  if (normalizedMatch) return `SHP-${normalizedMatch[1]}-${normalizedMatch[2]}`.toUpperCase();
  return "";
}

function uniqueUpper(values: string[]) {
  const arr = Array.isArray(values) ? values : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const s = String(v || "").trim();
    if (!s) continue;
    const k = s.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function extractEntityIdsFromText(text: string) {
  const t = String(text || "");
  const now = new Date();

  // Important: avoid partial matches like "SI-2026" from "SI-2026-001".
  const siFull = Array.from(t.matchAll(/\bSI-\d{4}-\d+\b/gi)).map((m) => normalizeSiId(m[0], now));
  const siSimple = Array.from(t.matchAll(/\bSI[-\s]?(\d+)\b(?!-\d)/gi)).map((m) => normalizeSiId(`SI-${m[1]}`, now));
  const siNormalized = uniqueUpper([...siFull, ...siSimple]);

  const shipmentMatches = Array.from(t.matchAll(/\bSHP[-_\s]?(\d{4})[-_\s]?(\d{3})\b/gi)).map((m) =>
    normalizeShipmentId(`SHP-${m[1]}-${m[2]}`, now),
  );
  const shipmentNormalized = uniqueUpper(shipmentMatches);

  const invMatches = Array.from(t.matchAll(/INV[-\s]?(\d{1,8})/gi)).map((m) => `INV-${m[1]}`.toUpperCase());
  const invNormalized = uniqueUpper(invMatches);

  return { siIds: siNormalized, shipmentIds: shipmentNormalized, invoiceIds: invNormalized };
}

function pendingClarificationId(seed: string) {
  return `CLR-${ingestHash8(String(seed || ""))}`.toUpperCase();
}

export function buildStateTransitionCandidates(args: {
  rawInput: RawInput;
  threads: OperationalThread[];
  entityLinks: EntityLink[];
  intakeResolutions: IntakeResolution[];
  now?: string;
}): { candidates: StateTransitionCandidate[]; notices: StateTransitionNotice[] } {
  const rawInput = args.rawInput;
  const threads = Array.isArray(args.threads) ? args.threads.filter(Boolean) : [];
  const links = Array.isArray(args.entityLinks) ? args.entityLinks.filter(Boolean) : [];
  const now = String(args.now || "").trim() || ingestNowIso();

  const candidates: StateTransitionCandidate[] = [];
  const notices: StateTransitionNotice[] = [];

  const hasStrongShippedLanguage = (text: string) => {
    const t = String(text || "").toLowerCase();
    return (
      /\b(goods have shipped|goods shipped)\b/.test(t) ||
      /\b(shipped|dispatched|departed|picked up)\b/.test(t) ||
      /(出荷|発送|搬出|集荷|出発|出港|出発しました)/.test(t)
    );
  };

  const hasUncertaintyLanguage = (text: string) => {
    const t = String(text || "").toLowerCase();
    return (
      /\b(maybe|might|expected|probably|likely|estimate|estimated)\b/.test(t) ||
      /(かも|可能性|見込み|たぶん|おそらく|予定)/.test(t)
    );
  };

  const hasQuantityMismatchLanguage = (text: string) => {
    const t = String(text || "").toLowerCase();
    return /\b(quantity mismatch|qty mismatch|short|shortage)\b/.test(t) || /(数量差異|数量.*違|不足|ショート)/.test(t);
  };

  const hasDateMismatchLanguage = (text: string) => {
    const t = String(text || "").toLowerCase();
    return /\b(date mismatch|inconsistent date|conflicting date)\b/.test(t) || /(日付.*矛盾|日程.*矛盾|日付.*違)/.test(t);
  };

  const hasMissingDocumentLanguage = (text: string) => {
    const t = String(text || "").toLowerCase();
    return (
      /\b(missing document|document missing|bl missing|invoice missing|packing list missing)\b/.test(t) ||
      /(書類不足|書類未着|未着|未入手)/.test(t)
    );
  };

  const hasExplicitShipmentIdInText = (text: string, shipmentId: string) => {
    const id = String(shipmentId || "").trim();
    if (!id) return false;
    const t = String(text || "");
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(t)) return true;
    // Allow minor formatting variations like spaces/underscores/hyphens in "SHP-2026-009"
    const flex = escaped.replace(/-/g, "[-_\\s]?");
    return new RegExp(`\\b${flex}\\b`, "i").test(t);
  };

  const detectTransitionSignal = (text: string) => {
    const t = String(text || "").toLowerCase();

    // Minimal heuristic rules for Phase 6-1.
    // Prefer more-advanced signals first (e.g. warehouse arrival > customs in progress > arrival notice).
    if (
      /\b(arrived at warehouse|warehouse arrival|warehouse arrived|warehouse received|received at warehouse)\b/.test(t) ||
      /(倉庫着|倉庫到着|倉庫に到着|倉庫へ到着|倉庫着しました|倉庫到着しました|倉庫入庫|入庫しました|倉庫受領|倉庫受け|入庫済)/.test(text)
    ) {
      return {
        fromState: "inTransit",
        // Align with Shelf lane mapping (apps/web/lib/shelfMapping.js).
        toState: "warehouseReceived",
        reason: "Slack/Teams update indicates the shipment has arrived at (or been received by) the warehouse.",
      };
    }
    if (
      /\b(customs in progress|in customs|under customs|under customs clearance|import customs)\b/.test(t) ||
      /(通関中|通関対応中|通関手続き中|輸入通関中)/.test(text)
    ) {
      return {
        fromState: "inTransit",
        toState: "arrived",
        reason: "Update indicates the shipment is at the import/customs stage.",
      };
    }
    if (/\b(shipped|dispatched|departed|picked up)\b/.test(t) || /(出荷|発送|搬出|集荷|出発|出港|出発しました)/.test(t)) {
      return {
        fromState: "shippingPending",
        toState: "inTransit",
        reason: "External update indicates goods have departed / been shipped.",
      };
    }
    if (/\b(booking confirmed|booked)\b/.test(t) || /(booking確定|ブッキング確定|ブッキング取れました)/.test(t)) {
      return {
        fromState: "bookingRequested",
        toState: "shippingPending",
        reason: "Booking has been confirmed.",
      };
    }
    if (/\b(bl issued|bill of lading issued)\b/.test(t) || /(B\/L発行|BL発行|B\/L issued)/i.test(t)) {
      return {
        fromState: "shippingPending",
        toState: "shipped",
        reason: "BL has been issued, indicating shipment has progressed to shipped.",
      };
    }
    if (/\b(arrival notice)\b/.test(t) || /(到着案内|Arrival Notice)/i.test(t)) {
      return {
        fromState: "inTransit",
        toState: "arrived",
        reason: "Arrival notice received.",
      };
    }
    if (/\b(customs cleared)\b/.test(t) || /(通関済|通関完了|輸入通関完了)/.test(t)) {
      return {
        fromState: "arrived",
        toState: "customsCleared",
        reason: "Customs clearance confirmed.",
      };
    }

    return null;
  };

  const pushCandidateOrNotice = (
    entityType: StateTransitionEntityType,
    entityId: string,
    candidate: StateTransitionCandidate,
  ) => {
    const toState = String(candidate?.toState || "").trim();
    if (toState && ALLOWED_SHELF_TRANSITION_STATES.has(toState)) {
      candidates.push(candidate);
      return;
    }

    const fromState = String(candidate?.fromState || "").trim();
    notices.push({
      entityType,
      entityId,
      fromState,
      toState,
      title: "倉庫着/状態更新を検出（自動遷移対象外）",
      message:
        "状態更新のシグナルを検出しました。ただし現在のShelfレーンでは自動遷移対象外のstateのため、棚の自動移動は行いません。",
      reason: `Unsupported toState for Shelf lanes: ${toState || "-"}`,
    });
  };

  for (const thread of threads) {
    const signal = detectTransitionSignal(`${thread.title}\n${thread.summary}\n${rawInput.rawText}`);
    if (!signal) continue;

    const threadLinks = links.filter((l) => String(l.threadId || "") === String(thread.id || ""));
    const shipmentLinks = threadLinks.filter((l) => l.entityType === "Shipment" && String(l.entityId || "").trim());
    const siLinks = threadLinks.filter((l) => l.entityType === "SI" && String(l.entityId || "").trim());

    const makeEvidence = (entityLink: EntityLink | null): StateTransitionEvidence[] => {
      const evidence: StateTransitionEvidence[] = [
        {
          sourceType: "raw_input",
          sourceId: rawInput.id,
          summary: String(thread.summary || "").trim(),
          confidence: typeof thread.confidence === "number" ? thread.confidence : undefined,
        },
      ];
      if (entityLink) {
        evidence.push({
          sourceType: "entity_link",
          sourceId: entityLink.entityId,
          summary: `Linked to ${entityLink.entityType}`,
          confidence: typeof entityLink.confidence === "number" ? entityLink.confidence : undefined,
        });
      }
      return evidence;
    };

    const scoreConfidence = (entityLink: EntityLink | null) => {
      const a = typeof thread.confidence === "number" ? thread.confidence : 0.5;
      const b = entityLink && typeof entityLink.confidence === "number" ? entityLink.confidence : 0.5;
      return Math.max(0, Math.min(1, (a + b) / 2));
    };

    const buildRisks = (entityLink: EntityLink | null, confidence: number, combinedText: string): StateTransitionRisk[] => {
      const risks: StateTransitionRisk[] = [];
      if (hasUncertaintyLanguage(combinedText)) {
        risks.push({
          type: "low_confidence",
          severity: "medium",
          summary: "Update contains uncertainty language (e.g., maybe/expected), requiring human confirmation.",
        });
      }
      if (entityLink && typeof entityLink.confidence === "number" && entityLink.confidence < 0.75) {
        risks.push({
          type: "low_confidence",
          severity: "medium",
          summary: "Entity link confidence is low or ambiguous.",
        });
      }
      if (hasQuantityMismatchLanguage(combinedText)) {
        risks.push({
          type: "quantity_mismatch",
          severity: "high",
          summary: "Potential quantity discrepancy detected in the update text.",
        });
      }
      if (hasDateMismatchLanguage(combinedText)) {
        risks.push({
          type: "date_mismatch",
          severity: "high",
          summary: "Potential date inconsistency detected in the update text.",
        });
      }
      if (hasMissingDocumentLanguage(combinedText)) {
        risks.push({
          type: "missing_document",
          severity: "high",
          summary: "Update suggests missing documents; avoid auto-apply transitions.",
        });
      }
      if (confidence < 0.8) {
        risks.push({
          type: "low_confidence",
          severity: "medium",
          summary: "Transition signal confidence is below auto-apply threshold.",
        });
      }
      return risks;
    };

    const decide = (confidence: number, risks: StateTransitionRisk[]) => {
      // `auto_apply` means this candidate is eligible for automatic application.
      // Phase 6-1 does not apply it. It only emits the candidate.
      return confidence >= 0.8 && risks.length === 0 ? ("auto_apply" as const) : ("needs_issue_candidate" as const);
    };

    const computeConfidenceAndRisks = (entityLink: EntityLink | null, combinedText: string) => {
      const base = scoreConfidence(entityLink);
      const risksPre = buildRisks(entityLink, base, combinedText);

      const shipmentId = entityLink && entityLink.entityType === "Shipment" ? String(entityLink.entityId || "").trim() : "";
      const explicitShipmentId = shipmentId ? hasExplicitShipmentIdInText(combinedText, shipmentId) : false;

      const isClearShippedUpdate =
        Boolean(shipmentId) &&
        explicitShipmentId &&
        hasStrongShippedLanguage(combinedText) &&
        !hasUncertaintyLanguage(combinedText) &&
        !hasQuantityMismatchLanguage(combinedText) &&
        !hasDateMismatchLanguage(combinedText) &&
        !hasMissingDocumentLanguage(combinedText);

      if (shipmentId && !explicitShipmentId) {
        risksPre.push({
          type: "low_confidence",
          severity: "medium",
          summary: "Shipment ID is linked, but not explicitly present in the raw input or thread summary.",
        });
      }

      let confidence = base;
      let risks = risksPre;

      if (isClearShippedUpdate) {
        confidence = Math.max(confidence, 0.85);
        risks = [];
      } else if (risks.length > 0) {
        confidence = Math.min(confidence, 0.79);
      }

      return { confidence, risks };
    };

    // Shipment-linked candidates
    for (const lnk of shipmentLinks) {
      const combinedText = `${rawInput.rawText}\n${thread.title}\n${thread.summary}`;
      const { confidence, risks } = computeConfidenceAndRisks(lnk, combinedText);
      pushCandidateOrNotice("Shipment", lnk.entityId, {
        id: stateTransitionCandidateIdFromParts({
          rawInputId: rawInput.id,
          entityId: lnk.entityId,
          toState: signal.toState,
        }),
        entityType: "Shipment",
        entityId: lnk.entityId,
        fromState: signal.fromState,
        toState: signal.toState,
        decision: decide(confidence, risks),
        confidence,
        reason: signal.reason,
        evidence: makeEvidence(lnk),
        risks,
        generatedAt: now,
      });
    }

    // SI-linked candidates (minimal support)
    for (const lnk of siLinks) {
      const combinedText = `${rawInput.rawText}\n${thread.title}\n${thread.summary}`;
      const confidence = scoreConfidence(lnk);
      const risks = buildRisks(lnk, confidence, combinedText);
      pushCandidateOrNotice("SI", lnk.entityId, {
        id: stateTransitionCandidateIdFromParts({
          rawInputId: rawInput.id,
          entityId: lnk.entityId,
          toState: signal.toState,
        }),
        entityType: "SI",
        entityId: lnk.entityId,
        fromState: signal.fromState,
        toState: signal.toState,
        decision: decide(confidence, risks),
        confidence,
        reason: signal.reason,
        evidence: makeEvidence(lnk),
        risks,
        generatedAt: now,
      });
    }
  }

  // Deduplicate by id (deterministic generation may collide across multiple threads)
  const seen = new Set<string>();
  const dedupedCandidates = candidates.filter((c) => {
    const id = String(c?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Deduplicate notices by (entityType/entityId/toState/message).
  const noticeSeen = new Set<string>();
  const dedupedNotices = notices.filter((n) => {
    const k = `${n.entityType}::${n.entityId}::${String(n.toState || "")}::${n.message}`;
    if (noticeSeen.has(k)) return false;
    noticeSeen.add(k);
    return true;
  });

  return { candidates: dedupedCandidates, notices: dedupedNotices };
}

export function resolveContext(input: RawInput, options: IngestBuildOptions = {}): ContextResolution {
  const rawText = String(input?.rawText || "").trim();
  const text = rawText.replace(/\s+/g, " ");
  const sourceLabel = options.sourceLabel || "AI";

  const entities = extractEntityIdsFromText(text);
  const siIds = Array.from(new Set(entities.siIds || [])).map((s) => String(s).toUpperCase());
  const shipmentIds = Array.from(new Set(entities.shipmentIds || [])).map((s) => String(s).toUpperCase());
  const invoiceIds = Array.from(new Set(entities.invoiceIds || [])).map((s) => String(s).toUpperCase());

  const hasEntityId = Boolean(siIds.length || shipmentIds.length || invoiceIds.length);

  const hasDocType = /\bPL\b|\bINV\b|\bBL\b|Packing\s*List|Invoice|B\/L/i.test(text) || /PLまだ|PL\s*未着/i.test(text);
  const hasSupplier = /\bACME\b/i.test(text);
  const hasPronounOnly = /(これ|あれ|それ|例の件|例の)/.test(text);
  const hasStrongStateUpdateSignal = (() => {
    const t = text.toLowerCase();
    return (
      /\b(goods have shipped|goods shipped)\b/.test(t) ||
      /\b(shipped|dispatched|departed|picked up)\b/.test(t) ||
      /\b(booking confirmed|booked)\b/.test(t) ||
      /\b(bl issued|bill of lading issued)\b/.test(t) ||
      /\b(arrival notice)\b/.test(t) ||
      /\b(arrived at warehouse|warehouse arrival|warehouse arrived|warehouse received|received at warehouse)\b/.test(t) ||
      /\b(customs in progress|in customs|under customs|under customs clearance|import customs)\b/.test(t) ||
      /(出荷|発送|搬出|集荷|出発|出港|出発しました|ブッキング確定|booking確定|到着案内|通関中|通関対応中|通関手続き中|輸入通関中|倉庫着|倉庫到着|倉庫入庫|入庫しました|倉庫受領)/.test(text)
    );
  })();

  const id = ingestStableId("CTX", `${input.id}:${rawText}`);
  const now = ingestNowIso();

  const base = {
    id,
    sourceRawInputId: input.id,
    reason: "",
    confidence: 0.6,
    sourceLabel,
  } satisfies Omit<ContextResolution, "status">;

  if (hasEntityId) {
    return {
      ...base,
      status: "resolved_enough",
      resolvedEntities: [
        ...siIds.map((entityId) => ({ entityType: "SI" as const, entityId, confidence: 0.9 })),
        ...shipmentIds.map((entityId) => ({ entityType: "Shipment" as const, entityId, confidence: 0.9 })),
        ...invoiceIds.map((entityId) => ({ entityType: "Document" as const, entityId, confidence: 0.7 })),
      ],
      reason: "対象Entityを推定できるため、後続Processorへ進めます。",
      confidence: 0.9,
    } satisfies ContextResolution;
  }

  // If we detect a strong shipment/state update signal but we cannot identify the target,
  // treat it as missing context so a follow-up (e.g. "this was SHP-2026-009") can be merged
  // via PendingClarification matching.
  if (hasStrongStateUpdateSignal) {
    return {
      ...base,
      status: "missing_context",
      missingFields: ["SI or Shipment or Invoice"],
      clarificationQuestion: "どのSI / Shipment / INV の更新でしょうか？対象番号を教えてください。",
      waitingState: "awaiting_clarification_reply",
      reminder: {
        followUpAt: addHoursIso(now, 4),
        message: "対象SIまたはShipmentが未回答です。確認してください。",
      },
      reason: "出荷/状態更新のシグナルはあるが対象が特定できないため",
      confidence: 0.8,
    } satisfies ContextResolution;
  }

  const isTooShort = text.length <= 6;
  if (hasPronounOnly || (isTooShort && !hasEntityId)) {
    return {
      ...base,
      status: "missing_context",
      missingFields: ["SI or Shipment or Invoice"],
      clarificationQuestion: "対象のSI / Shipment / INV を教えてください。",
      waitingState: "awaiting_clarification_reply",
      reminder: {
        followUpAt: addHoursIso(now, 4),
        message: "対象SIまたはShipmentが未回答です。確認してください。",
      },
      reason: "入力が短く、対象が特定できないため",
      confidence: 0.7,
    } satisfies ContextResolution;
  }

  if (hasDocType && !hasEntityId && hasSupplier) {
    return {
      ...base,
      status: "ambiguous",
      candidateEntities: [
        { entityType: "SI", entityId: "SI-2026-224", label: "SI-2026-224", confidence: 0.55 },
        { entityType: "SI", entityId: "SI-2026-225", label: "SI-2026-225", confidence: 0.52 },
      ],
      clarificationQuestion: "ACMEのPL確認は SI-2026-224 と SI-2026-225 のどちらでしょうか？",
      waitingState: "awaiting_human_selection",
      reminder: {
        followUpAt: addHoursIso(now, 4),
        message: "ACMEのPL確認対象が未選択です。対象SIを選択してください。",
      },
      reason: "候補が複数あり得るため、人間選択が必要",
      confidence: 0.65,
    } satisfies ContextResolution;
  }

  if (hasDocType && !hasEntityId) {
    return {
      ...base,
      status: "missing_context",
      missingFields: ["SI or Shipment or Invoice"],
      clarificationQuestion: "どのSI / Shipment / INV のPLでしょうか？対象番号を教えてください。",
      waitingState: "awaiting_clarification_reply",
      reminder: {
        followUpAt: addHoursIso(now, 4),
        message: "PL確認の対象SIまたはShipmentが未回答です。確認してください。",
      },
      reason: "書類名はあるが対象が特定できないため",
      confidence: 0.75,
    } satisfies ContextResolution;
  }

  const quantityMismatchLike = /INV.*PO.*違|金額.*違|数量.*違/i.test(text);
  if (quantityMismatchLike) {
    return {
      ...base,
      status: "resolved_enough",
      reason: "数量/金額差異の可能性があり、後続Processorで対象推定できるため",
      confidence: 0.7,
    } satisfies ContextResolution;
  }

  return {
    ...base,
    status: "resolved_enough",
    reason: "致命的な不足が見当たらないため、後続Processorへ進めます。",
    confidence: 0.6,
  } satisfies ContextResolution;
}

function normalizeOperationalThreads(input: RawInput, threads: OperationalThread[]): OperationalThread[] {
  const list = Array.isArray(threads) ? threads.filter(Boolean) : [];

  const normalizeThreadId = (threadId: string | undefined, index: number) => {
    const raw = String(threadId || "").trim();
    const generic = !raw || /^llm-thread-\d+$/i.test(raw) || /^thread-\d+$/i.test(raw);
    if (generic) return `${input.id}-thr-${String(index + 1).padStart(3, "0")}`;
    if (raw.includes(input.id)) return raw;
    return `${input.id}-${raw}`;
  };

  return list.map((t, index) => {
    const id = normalizeThreadId(t?.id, index);
    return {
      ...t,
      id,
      rawInputId: input.id,
    };
  });
}

function uniqueEntityCount(links: EntityLink[]) {
  const list = Array.isArray(links) ? links.filter(Boolean) : [];
  const seen = new Set<string>();
  for (const l of list) {
    const t = String(l?.entityType || "").trim();
    const id = String(l?.entityId || "").trim();
    if (!t || !id) continue;
    seen.add(`${t}::${id}`);
  }
  return seen.size;
}

function intentLabel(intent: OperationalThread["intent"]) {
  switch (intent) {
    case "missing_document_check":
      return "書類未着確認";
    case "document_status_inquiry":
      return "書類状況問い合わせ";
    case "shipment_status_check":
      return "出荷ステータス確認";
    case "eta_change":
      return "ETA変更確認";
    case "quantity_mismatch":
      return "数量差異確認";
    case "air_change_check":
      return "AIR変更確認";
    default:
      return "確認";
  }
}

function chooseThreadTitle(thread: OperationalThread, threadLinks: EntityLink[]) {
  const t1 = String(thread?.title || "").trim();
  if (t1) return t1;
  const t2 = String(thread?.summary || "").trim();
  if (t2) return t2;
  const preferredEntity = (threadLinks || []).find((l) => l?.entityType && l?.entityId);
  if (preferredEntity) return `${preferredEntity.entityType}:${preferredEntity.entityId}`;
  return "Untitled";
}

export function planNextActions(
  input: RawInput,
  threads: OperationalThread[],
  links: EntityLink[],
  intakeResolutions: IntakeResolution[],
  issueMutations: IssueMutation[],
  options: IngestBuildOptions = {},
): ActionPlan[] {
  const list = Array.isArray(threads) ? threads.filter(Boolean) : [];
  const allLinks = Array.isArray(links) ? links.filter(Boolean) : [];
  const resolutions = Array.isArray(intakeResolutions) ? intakeResolutions.filter(Boolean) : [];
  const mutations = Array.isArray(issueMutations) ? issueMutations.filter(Boolean) : [];

  const resolutionForThreadId = (threadId: string) =>
    resolutions.find((r) => String(r?.threadId || "") === String(threadId || "")) || null;

  const docHasCore = (types: unknown) => {
    const arr = Array.isArray(types) ? types : [];
    const normalized = arr.map((v) => String(v ?? "").trim().toUpperCase()).filter(Boolean);
    return normalized.includes("PL") || normalized.includes("INV") || normalized.includes("BL");
  };

  const actionTypesForThread = (thread: OperationalThread): ActionType[] => {
    const r = resolutionForThreadId(thread.id);
    const st = r ? String(r.status || "") : "";
    if (st === "status_query") return ["teams_reply_required"];
    if (st === "needs_clarification") return ["teams_reply_required"];
    if (st === "informational_only") return ["no_action"];
    switch (thread.intent) {
      case "missing_document_check": {
        const types = thread.extractedEntities?.documentTypes ?? [];
        if (docHasCore(types)) return ["supplier_confirmation_required", "email_required"];
        return ["human_review_only"];
      }
      case "document_status_inquiry": {
        return ["supplier_confirmation_required", "email_required"];
      }
      case "quantity_mismatch":
        return ["supplier_confirmation_required", "email_required"];
      case "eta_change":
        return ["teams_reply_required"];
      case "shipment_status_check":
        return ["human_review_only"];
      case "air_change_check":
        return ["teams_reply_required"];
      default:
        return ["human_review_only"];
    }
  };

  const titleForThread = (thread: OperationalThread, actionTypes: ActionType[]) => {
    const r = resolutionForThreadId(thread.id);
    const st = r ? String(r.status || "") : "";
    if (st === "status_query") return "状況返信が必要です";
    if (st === "needs_clarification") return "不足情報の確認が必要です";
    if (st === "informational_only") return "情報共有として記録";
    if (thread.intent === "missing_document_check" && actionTypes.includes("supplier_confirmation_required")) {
      return "仕入先への書類確認が必要です";
    }
    if (thread.intent === "quantity_mismatch") return "数量・金額差異の確認が必要です";
    if (actionTypes.includes("teams_reply_required")) return "社内返信の確認が必要です";
    return "人間確認が必要です";
  };

  const issueIdForMutationThread = (threadId: string) => {
    const created = mutations.find((m) => m?.threadId === threadId && m?.action === "create_issue_candidate");
    const issueId = created ? String(created.issueId || "").trim() : "";
    return issueId || undefined;
  };

  const sourceLabel = options.sourceLabel || "AI";

  return list.map((thread) => {
    const threadLinks = allLinks.filter((l) => l.threadId === thread.id);
    const actionTypes = actionTypesForThread(thread);
    const seed = `${input.id}${thread.id}${actionTypes.join(",")}`;
    return {
      id: `AP-${ingestHash8(seed)}`,
      sourceRawInputId: input.id,
      threadId: thread.id,
      issueId: issueIdForMutationThread(thread.id),
      actionTypes,
      title: titleForThread(thread, actionTypes),
      description: thread.summary || thread.title || input.rawText,
      confidence: typeof thread.confidence === "number" ? thread.confidence : 0.3,
      linkedEntities: threadLinks,
      sourceLabel,
      status: "planned",
    } satisfies ActionPlan;
  });
}

export function classifyRawInput(input: RawInput): OperationalThread[] {
  const text = String(input.rawText || "");

  const shipmentIds = Array.from(new Set((text.match(/SHP-\d{4}-\d{3}/g) || []).map((v) => String(v).trim())));

  const normalizeSi = (raw: string) => {
    const v = String(raw || "").trim().toUpperCase();
    const m1 = v.match(/^SI-(\d{4})-(\d{3})$/);
    if (m1) return `SI-${m1[1]}-${m1[2]}`;
    const m2 = v.match(/^SI-(\d{3})$/);
    if (m2) return `SI-2026-${m2[1]}`;
    return v.startsWith("SI-") ? v : "";
  };
  const siIds = Array.from(new Set((text.match(/SI-\d{4}-\d{3}|SI-\d{3}/gi) || []).map(normalizeSi).filter(Boolean)));
  const { invoiceIds } = extractEntityIdsFromText(text);

  const threads: OperationalThread[] = [];

  const addThread = (t: Omit<OperationalThread, "rawInputId">) => {
    threads.push({ ...t, rawInputId: input.id });
  };

  const wantsStatus = /状況|どうなってる|教えて|確認して|ステータス/i.test(text);

  if (/INV|インボイス|請求/i.test(text) && /PO|発注|指図/i.test(text) && /違|差|ズレ/i.test(text)) {
    addThread({
      id: `${input.id}-thr-001`,
      title: "数量・金額差異確認",
      intent: "quantity_mismatch",
      summary: "SI/PO と INV の差異確認依頼",
      extractedEntities: {
        shipmentIds,
        siIds: Array.from(siIds),
        invoiceIds: Array.from(new Set((text.match(/INV-\d+/gi) || []).map((v) => String(v).toUpperCase()))),
      },
      confidence: 0.78,
    });
  }

  const hasPlKeyword = /(?:\bPL\b|packing\s*list|パッキングリスト|パッキング)/i.test(text);
  const hasInquiryExpression =
    /(きましたか|来ましたか|届(?:い|き)た|届いて|未着|ありますか|確認|status|arrived|received|\?)/i.test(text);
  if (hasPlKeyword) {
    const intent = hasInquiryExpression ? ("document_status_inquiry" as const) : ("missing_document_check" as const);
    addThread({
      id: `${input.id}-thr-${String(threads.length + 1).padStart(3, "0")}`,
      title: hasInquiryExpression ? "PL状況確認" : "PL未着確認",
      intent,
      summary: hasInquiryExpression ? "PL到着/未着状況の問い合わせ" : "PLの未着状況を確認する依頼",
      extractedEntities: {
        shipmentIds,
        siIds: Array.from(siIds),
        invoiceIds: Array.from(invoiceIds),
        documentTypes: ["PL"],
      },
      confidence: 0.82,
    });
  }

  if (wantsStatus && Array.from(siIds).length) {
    addThread({
      id: `${input.id}-thr-${String(threads.length + 1).padStart(3, "0")}`,
      title: `${Array.from(siIds)[0]}状況確認`,
      intent: "shipment_status_check",
      summary: "SIの状況確認依頼",
      extractedEntities: {
        siIds: Array.from(siIds),
      },
      confidence: 0.72,
    });
  } else if (wantsStatus && shipmentIds.length) {
    addThread({
      id: `${input.id}-thr-${String(threads.length + 1).padStart(3, "0")}`,
      title: `${shipmentIds[0]}状況確認`,
      intent: "shipment_status_check",
      summary: "Shipmentの状況確認依頼",
      extractedEntities: {
        shipmentIds,
      },
      confidence: 0.7,
    });
  }

  if (!threads.length) {
    addThread({
      id: `${input.id}-thr-001`,
      title: "未分類依頼",
      intent: "unknown",
      summary: text,
      extractedEntities: shipmentIds.length || siIds.length ? { shipmentIds, siIds: Array.from(siIds) } : {},
      confidence: shipmentIds.length || siIds.length ? 0.55 : 0.3,
    });
  }

  return threads;
}

function intakeResolutionId(threadId: string) {
  return `INT-${ingestHash8(String(threadId || ""))}`.toUpperCase();
}

function primaryEntityForThread(thread: OperationalThread, threadLinks: EntityLink[]) {
  const si = (threadLinks || []).find((l) => l?.entityType === "SI" && l?.entityId) || null;
  if (si) return { entityType: "SI" as const, entityId: String(si.entityId) };
  const sh = (threadLinks || []).find((l) => l?.entityType === "Shipment" && l?.entityId) || null;
  if (sh) return { entityType: "Shipment" as const, entityId: String(sh.entityId) };
  const directSi = Array.isArray(thread?.extractedEntities?.siIds) ? thread.extractedEntities.siIds.find(Boolean) : "";
  if (directSi) return { entityType: "SI" as const, entityId: String(directSi) };
  const directSh = Array.isArray(thread?.extractedEntities?.shipmentIds) ? thread.extractedEntities.shipmentIds.find(Boolean) : "";
  if (directSh) return { entityType: "Shipment" as const, entityId: String(directSh) };
  return null;
}

export function resolveIntake(
  input: RawInput,
  threads: OperationalThread[],
  links: EntityLink[],
  options: IngestBuildOptions = {},
): IntakeResolution[] {
  const tList = Array.isArray(threads) ? threads.filter(Boolean) : [];
  const allLinks = Array.isArray(links) ? links.filter(Boolean) : [];
  const sourceLabel = options.sourceLabel || "AI";
  const text = String(input.rawText || "");

  const containsStatusQueryWords = /状況|どうなってる|教えて|確認して|ステータス/i.test(text);
  const containsPlStatusQueryWords =
    /(?:\bPL\b|packing\s*list|パッキングリスト|パッキング).*(きましたか|来ましたか|届(?:い|き)た|届いて|未着|ありますか|確認|status|arrived|received)/i.test(
      text,
    );
  const informational = /共有|FYI|参考|念のため|取り急ぎ/i.test(text);

  const out: IntakeResolution[] = [];

  for (const thread of tList) {
    const threadLinks = allLinks.filter((l) => l.threadId === thread.id);
    const hasSiOrShipment = threadLinks.some((l) => l.entityType === "SI" || l.entityType === "Shipment");
    const hasDocument = threadLinks.some((l) => l.entityType === "Document");
    const firstDocument = threadLinks.find((l) => l.entityType === "Document" && l.entityId) || null;
    const primary = primaryEntityForThread(thread, threadLinks);

    if (thread.intent === "shipment_status_check" && hasSiOrShipment && containsStatusQueryWords) {
      const label = primary ? `${primary.entityType}:${primary.entityId}` : "対象";
      out.push({
        id: intakeResolutionId(thread.id),
        sourceRawInputId: input.id,
        threadId: thread.id,
        status: "status_query",
        shouldCreateIssue: false,
        resolvedEntity: primary || undefined,
        statusAnswer:
          primary?.entityType === "SI"
            ? `${primary.entityId} は現在、船積準備中です。必要に応じて詳細確認してください。`
            : `Shipment ${primary?.entityId || "-"} は現在、船積準備中です。必要に応じて詳細確認してください。`,
        reason: `${label} の状況照会として処理`,
        confidence: typeof thread.confidence === "number" ? thread.confidence : 0.6,
        sourceLabel,
      } satisfies IntakeResolution);
      continue;
    }

    if (thread.intent === "document_status_inquiry" && !(hasSiOrShipment || hasDocument)) {
      out.push({
        id: intakeResolutionId(thread.id),
        sourceRawInputId: input.id,
        threadId: thread.id,
        status: "needs_clarification",
        shouldCreateIssue: false,
        missingFields: ["SI or Shipment or Invoice"],
        clarificationQuestion: "どのSI / Shipment / INV の件のPLでしょうか？対象番号を教えてください。",
        reason: "PL状況の問い合わせだが対象が特定できないため",
        confidence: typeof thread.confidence === "number" ? thread.confidence : 0.6,
        sourceLabel,
      } satisfies IntakeResolution);
      continue;
    }

    if (thread.intent === "document_status_inquiry" && (hasSiOrShipment || hasDocument || containsPlStatusQueryWords)) {
      out.push({
        id: intakeResolutionId(thread.id),
        sourceRawInputId: input.id,
        threadId: thread.id,
        status: "resolved",
        shouldCreateIssue: false,
        resolvedEntity: primary || (firstDocument ? { entityType: "Document", entityId: String(firstDocument.entityId) } : undefined),
        reason: "書類状況問い合わせ（PL）として処理",
        confidence: typeof thread.confidence === "number" ? thread.confidence : 0.6,
        sourceLabel,
      } satisfies IntakeResolution);
      continue;
    }

    if (thread.intent === "missing_document_check" && !(hasSiOrShipment || hasDocument)) {
      out.push({
        id: intakeResolutionId(thread.id),
        sourceRawInputId: input.id,
        threadId: thread.id,
        status: "needs_clarification",
        shouldCreateIssue: false,
        missingFields: ["SI or Shipment"],
        clarificationQuestion: "どのSIまたはShipmentのPLでしょうか？対象を教えてください。",
        reason: "書類名はあるが対象が特定できないため",
        confidence: typeof thread.confidence === "number" ? thread.confidence : 0.6,
        sourceLabel,
      } satisfies IntakeResolution);
      continue;
    }

    if (
      thread.intent === "quantity_mismatch" ||
      thread.intent === "eta_change" ||
      thread.intent === "air_change_check" ||
      (thread.intent === "missing_document_check" && hasSiOrShipment)
    ) {
      out.push({
        id: intakeResolutionId(thread.id),
        sourceRawInputId: input.id,
        threadId: thread.id,
        status: "issue_candidate_required",
        shouldCreateIssue: true,
        resolvedEntity: primary || undefined,
        reason: "業務上の対応が必要な可能性が高いため",
        confidence: typeof thread.confidence === "number" ? thread.confidence : 0.6,
        sourceLabel,
      } satisfies IntakeResolution);
      continue;
    }

    if (informational || thread.intent === "unknown") {
      out.push({
        id: intakeResolutionId(thread.id),
        sourceRawInputId: input.id,
        threadId: thread.id,
        status: "informational_only",
        shouldCreateIssue: false,
        reason: "情報共有として記録",
        confidence: typeof thread.confidence === "number" ? thread.confidence : 0.5,
        sourceLabel,
      } satisfies IntakeResolution);
      continue;
    }

    out.push({
      id: intakeResolutionId(thread.id),
      sourceRawInputId: input.id,
      threadId: thread.id,
      status: "needs_clarification",
      shouldCreateIssue: false,
      missingFields: ["SI or Shipment"],
      clarificationQuestion: "対象のSI、Shipment、または書類番号を教えてください。",
      reason: "解決に必要な情報が不足しているため",
      confidence: typeof thread.confidence === "number" ? thread.confidence : 0.5,
      sourceLabel,
    } satisfies IntakeResolution);
  }

  return out;
}

export function linkThreadsToEntities(threads: OperationalThread[]): EntityLink[] {
  const links: EntityLink[] = [];

  for (const thread of threads) {
    for (const shipmentId of thread.extractedEntities.shipmentIds ?? []) {
      links.push({
        id: `link-${thread.id}-shipment-${shipmentId}`,
        threadId: thread.id,
        entityType: "Shipment",
        entityId: shipmentId,
        confidence: thread.confidence,
        reason: "extracted shipment id from classified operational thread",
      });
    }

    for (const siId of thread.extractedEntities.siIds ?? []) {
      links.push({
        id: `link-${thread.id}-si-${siId}`,
        threadId: thread.id,
        entityType: "SI",
        entityId: siId,
        confidence: thread.confidence,
        reason: "extracted SI id from classified operational thread",
      });
    }

    for (const invoiceId of thread.extractedEntities.invoiceIds ?? []) {
      links.push({
        id: `link-${thread.id}-doc-${invoiceId}`,
        threadId: thread.id,
        entityType: "Document",
        entityId: invoiceId,
        confidence: thread.confidence,
        reason: "extracted invoice id from classified operational thread",
      });
    }

    if (thread.title.includes("PL未着")) {
      links.push({
        id: `link-${thread.id}-issue-ISS-0002`,
        threadId: thread.id,
        entityType: "Issue",
        entityId: "ISS-0002",
        confidence: 0.86,
        reason: "PL missing check matches existing open issue",
      });
    }
  }

  return links;
}

export function dedupeEntityLinks(links: EntityLink[]): EntityLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = [link.threadId, link.entityType, link.entityId].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildActivityEvents(
  input: RawInput,
  threads: OperationalThread[],
  links: EntityLink[],
  occurredAt: string,
  options: IngestBuildOptions = {},
  stateTransitionCandidates: StateTransitionCandidate[] = [],
  stateTransitionNotices: StateTransitionNotice[] = [],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const actor = options.sourceLabel || "AI";
  const approvalPolicy = options.approvalPolicy ?? "low_confidence";

  const sourceActorForInput = () => {
    const src = String(input.source || "").trim();
    const ch = String(input.channel || "").trim();
    const sender = String(input.senderName || "").trim();
    const srcLabel = ch || src;
    const bits = [srcLabel, sender].filter(Boolean);
    return bits.join(" / ") || actor;
  };

  events.push({
    id: ingestStableId("ACT", `${input.id}:raw_input_received`),
    type: "raw_input_received",
    occurredAt,
    sequence: ACTIVITY_SEQUENCE.raw_input_received,
    title: "依頼受信",
    description: input.rawText,
    sourceRawInputId: input.id,
    status: "ok",
    actor: sourceActorForInput(),
  });

  events.push({
    id: ingestStableId("ACT", `${input.id}:classified`),
    type: "classified",
    occurredAt,
    sequence: ACTIVITY_SEQUENCE.classified,
    title: "AI分類",
    description: (() => {
      const names = (Array.isArray(threads) ? threads : [])
        .map((t) => String(t?.title || "").trim())
        .filter(Boolean);
      if (!names.length) return "依頼を分類";
      if (names.length <= 3) return `${names.join(" / ")}を分類`;
      return `依頼を分類（${names.length}件）`;
    })(),
    sourceRawInputId: input.id,
    status: "ok",
    actor,
  });

  events.push({
    id: ingestStableId("ACT", `${input.id}:entity_linked`),
    type: "entity_linked",
    occurredAt,
    sequence: ACTIVITY_SEQUENCE.entity_linked,
    title: "関連紐付け",
    description: (() => {
      const list = (Array.isArray(links) ? links : [])
        .map((l) => String(l?.entityId || "").trim())
        .filter(Boolean);
      const uniq = Array.from(new Set(list));
      if (!uniq.length) return "関連を紐付け";
      if (uniq.length <= 3) return `${uniq.join(" / ")}に紐付け`;
      return `関連を紐付け（${uniq.length}件）`;
    })(),
    sourceRawInputId: input.id,
    linkedEntities: links,
    status: "ok",
    actor,
  });

  const notices = Array.isArray(stateTransitionNotices) ? stateTransitionNotices.filter(Boolean) : [];
  for (const notice of notices) {
    const entityType = String(notice?.entityType || "").trim();
    const entityId = String(notice?.entityId || "").trim();
    if (!entityType || !entityId) continue;
    const linked = links.filter((l) => String(l?.entityType || "") === entityType && String(l?.entityId || "").trim() === entityId);
    events.push({
      id: ingestStableId("ACT", `${input.id}:${entityType}:${entityId}:${String(notice?.toState || "")}:st_not_supported`),
      type: "state_transition_not_supported",
      occurredAt,
      sequence: ACTIVITY_SEQUENCE.state_transition_not_supported,
      title: String(notice?.title || "状態遷移: 自動対象外"),
      description: String(notice?.message || "").trim() || undefined,
      sourceRawInputId: input.id,
      linkedEntities: linked && linked.length ? linked : undefined,
      status: "warning",
      actor: "ai_agent",
    });
  }

  const stCandidates = Array.isArray(stateTransitionCandidates) ? stateTransitionCandidates.filter(Boolean) : [];
  for (const candidate of stCandidates) {
    const entityType = String(candidate?.entityType || "").trim();
    const entityId = String(candidate?.entityId || "").trim();
    const fromState = String(candidate?.fromState || "").trim();
    const toState = String(candidate?.toState || "").trim();

    const linked = (() => {
      // Reuse existing links if we can map candidate entityType into EntityType.
      if (entityType !== "Shipment" && entityType !== "SI" && entityType !== "Document") return undefined;
      return links.filter((l) => l?.entityType === entityType && String(l?.entityId || "").trim() === entityId);
    })();

    events.push({
      id: `ACT-${String(candidate?.id || "").trim() || ingestStableId("ACT", `${input.id}:${entityType}:${entityId}:${toState}:stc_detected`)}`,
      type: "state_transition_candidate_detected",
      occurredAt,
      sequence: ACTIVITY_SEQUENCE.state_transition_candidate_detected,
      title: "状態遷移候補を検出",
      description: `AI detected state transition candidate: ${entityType} ${entityId} ${fromState} → ${toState}（未適用）`,
      sourceRawInputId: input.id,
      linkedEntities: linked && linked.length ? linked : undefined,
      status: "ok",
      actor: "ai_agent",
    });
  }

  for (const thread of threads) {
    const shouldRequireApproval =
      approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
    if (!shouldRequireApproval) continue;
    const threadLinks = links.filter((l) => l.threadId === thread.id);
    const title = chooseThreadTitle(thread, threadLinks);
    events.push({
      id: ingestStableId("ACT", `${input.id}:${thread.id}:approval_required`),
      type: "approval_required",
      occurredAt,
      sequence: ACTIVITY_SEQUENCE.approval_required,
      title: "承認待ちへ追加",
      description: `${title} を承認待ちへ追加`,
      sourceRawInputId: input.id,
      threadId: thread.id,
      linkedEntities: threadLinks,
      status: "warning",
      actor,
    });
  }

  return events;
}

export function buildIssueMutations(
  input: RawInput,
  threads: OperationalThread[],
  links: EntityLink[],
  intakeResolutions: IntakeResolution[],
  options: IngestBuildOptions = {},
): IssueMutation[] {
  const mutations: IssueMutation[] = [];
  const approvalPolicy = options.approvalPolicy ?? "low_confidence";
  const sourceLabel = options.sourceLabel || "mock ingest";
  const resolutions = Array.isArray(intakeResolutions) ? intakeResolutions.filter(Boolean) : [];

  for (const thread of threads) {
    const res = resolutions.find((r) => String(r?.threadId || "") === String(thread.id || ""));
    if (res && res.shouldCreateIssue === false) continue;

    const threadLinks = links.filter((l) => l.threadId === thread.id);
    const threadTitle = chooseThreadTitle(thread, threadLinks);
    const baseFields = {
      sourceRawInputId: input.id,
      threadId: thread.id,
      linkedEntities: threadLinks,
      confidence: thread.confidence,
      sourceLabel,
    } satisfies Partial<IssueMutation>;

    if (thread.title.includes("PL未着")) {
      const issueId = resolveCanonicalIssueLink(thread, threadLinks, "candidate").issueId;
      const title = threadTitle;
      const bodyLines = [
        `依頼: ${input.senderName ?? "unknown"} (${input.source})`,
        `内容: ${input.rawText}`,
        "",
        `Thread: ${thread.title} (confidence=${thread.confidence.toFixed(2)})`,
        `Summary: ${thread.summary}`,
        "",
        `Links: ${threadLinks.map((l) => `${l.entityType}:${l.entityId}`).join(", ") || "(none)"}`,
      ];

      mutations.push({
        issueId,
        action: "create_issue_candidate",
        title,
        body: bodyLines.join("\n"),
        ...baseFields,
      });

      const shouldRequireApproval =
        approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
      if (shouldRequireApproval) {
        mutations.push({
          issueId,
          action: "mark_approval_required",
          title: `承認待ち: ${threadTitle}`,
          body: [
            "AIがこの依頼を承認待ちの対応候補として整理しました。",
            `分類: ${intentLabel(thread.intent)}`,
            `信頼度: ${thread.confidence.toFixed(2)}`,
            `元の依頼: ${input.rawText}`,
          ].join("\n"),
          ...baseFields,
        });
      }

      continue;
    }

    if (thread.title.includes("SI-224") || (thread.extractedEntities.siIds ?? []).some((s) => s.includes("224"))) {
      const siId = (thread.extractedEntities.siIds ?? [])[0] ?? "SI-UNKNOWN";
      const candidateId = resolveCanonicalIssueLink(thread, threadLinks, "candidate").issueId;
      const title = threadTitle;
      const bodyLines = [
        `依頼: ${input.senderName ?? "unknown"} (${input.source})`,
        `内容: ${input.rawText}`,
        "",
        `Thread: ${thread.title} (confidence=${thread.confidence.toFixed(2)})`,
        `Summary: ${thread.summary}`,
        "",
        `Links: ${threadLinks.map((l) => `${l.entityType}:${l.entityId}`).join(", ") || "(none)"}`,
        "",
        `SI: ${siId}`,
      ];

      mutations.push({
        issueId: candidateId,
        action: "create_issue_candidate",
        title,
        body: bodyLines.join("\n"),
        ...baseFields,
      });

      const shouldRequireApproval =
        approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
      if (shouldRequireApproval) {
        mutations.push({
          issueId: candidateId,
          action: "mark_approval_required",
          title: `承認待ち: ${threadTitle}`,
          body: [
            "AIがこの依頼を承認待ちの対応候補として整理しました。",
            `分類: ${intentLabel(thread.intent)}`,
            `信頼度: ${thread.confidence.toFixed(2)}`,
            `元の依頼: ${input.rawText}`,
          ].join("\n"),
          ...baseFields,
        });
      }

      continue;
    }

    // Default: create a candidate issue for anything else.
    const candidateId = resolveCanonicalIssueLink(thread, threadLinks, "candidate").issueId;
    mutations.push({
      issueId: candidateId,
      action: "create_issue_candidate",
      title: threadTitle,
      body: `Summary: ${thread.summary}\n\nRaw: ${input.rawText}`,
      ...baseFields,
    });

    const shouldRequireApproval =
      approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
    if (shouldRequireApproval) {
      mutations.push({
        issueId: candidateId,
        action: "mark_approval_required",
        title: `承認待ち: ${threadTitle}`,
        body: [
          "AIがこの依頼を承認待ちの対応候補として整理しました。",
          `分類: ${intentLabel(thread.intent)}`,
          `信頼度: ${thread.confidence.toFixed(2)}`,
          `元の依頼: ${input.rawText}`,
        ].join("\n"),
        ...baseFields,
      });
    }
  }

  return mutations;
}

function draftIdFromActionPlan(actionPlanId: string) {
  return `DRF-${ingestHash8(String(actionPlanId || ""))}`.toUpperCase();
}

function primarySiLabelForThread(thread: OperationalThread, threadLinks: EntityLink[]) {
  const direct = Array.isArray(thread?.extractedEntities?.siIds) ? thread.extractedEntities.siIds.find(Boolean) : "";
  if (direct) return String(direct);
  const fromLinks = (threadLinks || []).find((l) => l?.entityType === "SI" && l?.entityId);
  return fromLinks ? String(fromLinks.entityId) : "SI-UNKNOWN";
}

export function buildDraftDocuments(
  input: RawInput,
  threads: OperationalThread[],
  links: EntityLink[],
  intakeResolutions: IntakeResolution[],
  issueMutations: IssueMutation[],
  actionPlans: ActionPlan[],
  options: IngestBuildOptions = {},
): DraftDocument[] {
  const tList = Array.isArray(threads) ? threads.filter(Boolean) : [];
  const allLinks = Array.isArray(links) ? links.filter(Boolean) : [];
  const resolutions = Array.isArray(intakeResolutions) ? intakeResolutions.filter(Boolean) : [];
  const plans = Array.isArray(actionPlans) ? actionPlans.filter(Boolean) : [];
  const mutations = Array.isArray(issueMutations) ? issueMutations.filter(Boolean) : [];

  const generatedBy = options.sourceLabel || "AI";
  const generatedAt = ingestNowIso();

  const issueIdForThreadFromMutations = (threadId: string) => {
    const created = mutations.find((m) => m?.threadId === threadId && m?.action === "create_issue_candidate");
    const issueId = created ? String(created.issueId || "").trim() : "";
    return issueId || undefined;
  };

  const emailTemplate = (intent: OperationalThread["intent"], thread: OperationalThread, threadLinks: EntityLink[]) => {
    const primaryInvoiceLabelForThread = () => {
      const direct = Array.isArray(thread?.extractedEntities?.invoiceIds) ? thread.extractedEntities.invoiceIds.find(Boolean) : "";
      if (direct) return String(direct);
      const fromLinks = (threadLinks || []).find((l) => l?.entityType === "Document" && l?.entityId);
      return fromLinks ? String(fromLinks.entityId) : "";
    };

    if (intent === "missing_document_check" || intent === "document_status_inquiry") {
      const si = primarySiLabelForThread(thread, threadLinks);
      const inv = primaryInvoiceLabelForThread();
      const targetLabel = inv || si;
      return {
        subject: `Confirmation required: PL status for ${targetLabel}`,
        body: `${targetLabel} の PL状況をご確認ください。\n未発行の場合は予定日をご共有ください。`,
      };
    }
    if (intent === "quantity_mismatch") {
      return {
        subject: "Confirmation required: Quantity mismatch",
        body: "SI と INV の数量差異をご確認ください。",
      };
    }
    return {
      subject: "Confirmation required",
      body: "状況をご確認ください。",
    };
  };

  const teamsTemplate = (thread: OperationalThread) => {
    const r = resolutions.find((x) => String(x?.threadId || "") === String(thread.id || "")) || null;
    if (r && String(r.status || "") === "status_query") {
      return { body: String(r.statusAnswer || "状況をご確認ください。") };
    }
    if (r && String(r.status || "") === "needs_clarification") {
      return { body: String(r.clarificationQuestion || "対象のSI、Shipment、または書類番号を教えてください。") };
    }
    if (thread.intent === "eta_change") {
      return { body: "ETA変更を確認しました。顧客影響をご確認ください。" };
    }
    return { body: "状況を確認しました。影響をご確認ください。" };
  };

  const drafts: DraftDocument[] = [];

  for (const ap of plans) {
    const thread = tList.find((t) => String(t?.id || "") === String(ap.threadId || ""));
    if (!thread) continue;

    const types = Array.isArray(ap.actionTypes) ? ap.actionTypes.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
    if (types.includes("human_review_only")) continue;
    if (types.includes("no_action")) continue;

    const threadLinks = allLinks.filter((l) => l.threadId === ap.threadId);
    const issueId = ap.issueId || issueIdForThreadFromMutations(ap.threadId);

    const tradeCases = Array.isArray(options.tradeCases) ? options.tradeCases.filter(Boolean) : [];
    const primaryInvoiceLabelForThread = () => {
      const direct = Array.isArray(thread?.extractedEntities?.invoiceIds) ? thread.extractedEntities.invoiceIds.find(Boolean) : "";
      if (direct) return String(direct);
      const fromLinks = (threadLinks || []).find((l) => l?.entityType === "Document" && l?.entityId);
      return fromLinks ? String(fromLinks.entityId) : "";
    };

    const operationalCtx = (() => {
      const inv = primaryInvoiceLabelForThread();
      if (!inv || !tradeCases.length) return null;
      return resolveOperationalContext({ entityType: "Document", entityId: inv, tradeCases });
    })();

    const plReplyDraftBody = (() => {
      const inv = String(operationalCtx?.invoice || primaryInvoiceLabelForThread() || "").trim();
      if (!inv) return "";
      const plSt = String(operationalCtx?.plStatus || "").trim();
      if (plSt === "missing") return `${inv} に紐づくPLは未着です。\n仕入先へ確認しますか？`;
      if (plSt === "received") return `${inv} に紐づくPLは登録済みです。`;
      return `${inv} のPL状況を確認します。対象のShipment/SIが分かれば併せて教えてください。`;
    })();

    if (types.includes("email_required")) {
      const t = emailTemplate(thread.intent, thread, threadLinks);
      drafts.push({
        id: draftIdFromActionPlan(ap.id),
        sourceRawInputId: input.id,
        threadId: ap.threadId,
        issueId,
        actionPlanId: ap.id,
        channel: "email",
        to: "supplier@example.invalid",
        subject: t.subject,
        body: t.body,
        status: "drafted",
        generatedBy,
        generatedAt,
        confidence: typeof ap.confidence === "number" ? ap.confidence : 0.3,
      } satisfies DraftDocument);
    }

    if ((thread.intent === "missing_document_check" || thread.intent === "document_status_inquiry") && plReplyDraftBody) {
      drafts.push({
        id: `${draftIdFromActionPlan(ap.id)}-TEAMS-PL`,
        sourceRawInputId: input.id,
        threadId: ap.threadId,
        issueId,
        actionPlanId: ap.id,
        channel: "teams",
        body: plReplyDraftBody,
        status: "drafted",
        generatedBy,
        generatedAt,
        confidence: typeof ap.confidence === "number" ? ap.confidence : 0.3,
      } satisfies DraftDocument);
    }

    if (types.includes("teams_reply_required")) {
      const t = teamsTemplate(thread);
      drafts.push({
        id: `${draftIdFromActionPlan(ap.id)}-TEAMS`,
        sourceRawInputId: input.id,
        threadId: ap.threadId,
        issueId,
        actionPlanId: ap.id,
        channel: "teams",
        body: t.body,
        status: "drafted",
        generatedBy,
        generatedAt,
        confidence: typeof ap.confidence === "number" ? ap.confidence : 0.3,
      } satisfies DraftDocument);
    }
  }

  return drafts;
}

export function runIngestPipeline(input: RawInput, options: IngestPipelineOptions = {}): MockIngestResult {
  const pendingBase = Array.isArray(options.pendingClarifications) ? options.pendingClarifications.filter(Boolean) : [];
  const matched = matchPendingClarification(input, pendingBase);

  const matchedEntities = matched ? extractEntityIdsFromText(String(input?.rawText || "")) : null;
  const resolvedEntities = matched
    ? [
        ...(matchedEntities?.siIds || []).map((id) => ({ entityType: "SI" as const, entityId: id, confidence: 0.8 })),
        ...(matchedEntities?.shipmentIds || []).map((id) => ({ entityType: "Shipment" as const, entityId: id, confidence: 0.8 })),
        ...(matchedEntities?.invoiceIds || []).map((id) => ({ entityType: "Document" as const, entityId: id, confidence: 0.6 })),
      ]
    : [];

  const resolvedLabel = resolvedEntities.length ? resolvedEntities.map((e) => `${e.entityType}:${e.entityId}`).join(", ") : "";

  const effectiveInput: RawInput =
    matched && resolvedLabel
      ? {
          ...input,
          rawText: `${String(matched.originalRawText || "").trim()} 対象: ${resolvedLabel}`.trim(),
        }
      : input;

  const contextResolution = resolveContext(effectiveInput, options);
  const pipelineOccurredAt = input.receivedAt || ingestNowIso();
  const actor = options.sourceLabel || "AI";

  const pendingClarifications: PendingClarification[] = pendingBase.slice();
  const matchedPendingClarification: PendingClarification | undefined = (() => {
    if (!matched) return undefined;
    const updated: PendingClarification = {
      ...matched,
      status: "matched",
      matchedRawInputId: input.id,
      matchedReplyText: input.rawText,
      resolvedEntities,
      confidence: typeof matched.confidence === "number" ? matched.confidence : 0.75,
    };
    for (let i = 0; i < pendingClarifications.length; i++) {
      if (String(pendingClarifications[i]?.id || "") === String(updated.id || "")) {
        pendingClarifications[i] = updated;
        break;
      }
    }
    return updated;
  })();

  // If this run is a follow-up reply that resolves a pending clarification by identifying
  // the target entity (e.g. "That was SHP-2026-009"), we want to:
  // - keep any StateTransitionCandidate detection
  // - mark the pending clarification as matched
  // - avoid generating *new* approvals / reply drafts / approval-center items
  const isClarificationResolvedByReply = Boolean(matchedPendingClarification && resolvedLabel);

  if (contextResolution.status !== "resolved_enough") {
    const threadId = `${input.id}-ctx-001`;

    const clarification: PendingClarification = {
      id: pendingClarificationId(`${input.id}:${String(input.rawText || "")}`),
      sourceRawInputId: input.id,
      originalRawText: String(input.rawText || ""),
      requesterName: input.senderName,
      sourceChannel: input.channel,
      sourceThreadTs: input.threadTs,
      missingFields: Array.isArray(contextResolution.missingFields) ? contextResolution.missingFields : ["SI or Shipment"],
      clarificationQuestion: String(contextResolution.clarificationQuestion || "どのSIまたはShipmentでしょうか？").trim(),
      status: "awaiting_clarification_reply",
      createdAt: pipelineOccurredAt,
      followUpAt: contextResolution.reminder?.followUpAt,
      confidence: contextResolution.confidence,
    };

    pendingClarifications.push(clarification);

    const intakeResolution: IntakeResolution = {
      id: intakeResolutionId(threadId),
      sourceRawInputId: input.id,
      threadId,
      status: "needs_clarification",
      shouldCreateIssue: false,
      missingFields: contextResolution.missingFields,
      clarificationQuestion: contextResolution.clarificationQuestion,
      reason: contextResolution.reason,
      confidence: contextResolution.confidence,
      sourceLabel: actor,
    };

    const planId = `AP-${ingestHash8(`${input.id}:${threadId}:context`)}`;
    const title = contextResolution.status === "ambiguous" ? "候補選択が必要です" : "不足情報の確認が必要です";
    const actionPlan: ActionPlan = {
      id: planId,
      sourceRawInputId: input.id,
      threadId,
      actionTypes: ["teams_reply_required"],
      title,
      description: String(contextResolution.clarificationQuestion || "").trim() || input.rawText,
      confidence: contextResolution.confidence,
      linkedEntities: [],
      sourceLabel: actor,
      status: "pending_approval",
    };

    const question = String(contextResolution.clarificationQuestion || "対象を教えてください。").trim();
    const candidates = Array.isArray(contextResolution.candidateEntities) ? contextResolution.candidateEntities.filter(Boolean) : [];
    const candidateLines = candidates.length ? `\n- ${candidates.map((c) => String(c.label || c.entityId)).join("\n- ")}` : "";
    const body = `${question}${candidateLines}`.trim();

    const draft: DraftDocument = {
      id: `${draftIdFromActionPlan(actionPlan.id)}-TEAMS`,
      sourceRawInputId: input.id,
      threadId,
      actionPlanId: actionPlan.id,
      channel: "teams",
      body,
      status: "pending_approval",
      generatedBy: actor,
      generatedAt: ingestNowIso(),
      confidence: contextResolution.confidence,
    };

    const events: ActivityEvent[] = [
      {
        id: ingestStableId("ACT", `${input.id}:context_resolved`),
        type: "context_resolved",
        occurredAt: pipelineOccurredAt,
        sequence: ACTIVITY_SEQUENCE.context_resolved,
        title: "Context Resolver",
        description: contextResolution.reason,
        sourceRawInputId: input.id,
        threadId,
        status: "ok",
        actor,
      },
      {
        id: ingestStableId("ACT", `${input.id}:${clarification.id}:clarification_waiting`),
        type: "clarification_waiting",
        occurredAt: pipelineOccurredAt,
        sequence: ACTIVITY_SEQUENCE.clarification_waiting,
        title: "不足情報の確認待ち",
        description: clarification.clarificationQuestion,
        sourceRawInputId: input.id,
        threadId,
        status: "warning",
        actor,
      },
      {
        id: ingestStableId("ACT", `${input.id}:${threadId}:${contextResolution.status}`),
        type: contextResolution.status === "ambiguous" ? "human_selection_required" : "clarification_required",
        occurredAt: pipelineOccurredAt,
        sequence:
          contextResolution.status === "ambiguous"
            ? ACTIVITY_SEQUENCE.human_selection_required
            : ACTIVITY_SEQUENCE.clarification_required,
        title: contextResolution.status === "ambiguous" ? "候補選択が必要" : "追加情報が必要です",
        description: body,
        sourceRawInputId: input.id,
        threadId,
        status: "warning",
        actor,
      },
      ...(contextResolution.reminder
        ? [
            {
              id: ingestStableId("ACT", `${input.id}:${threadId}:reminder_planned:${contextResolution.reminder.followUpAt}`),
              type: "reminder_planned",
              occurredAt: pipelineOccurredAt,
              sequence: ACTIVITY_SEQUENCE.reminder_planned,
              title: "リマインド予定",
              description: contextResolution.reminder.message,
              sourceRawInputId: input.id,
              threadId,
              status: "ok",
              actor,
            } satisfies ActivityEvent,
          ]
        : []),
      {
        id: ingestStableId("ACT", `${input.id}:${threadId}:${draft.id}:draft_created`),
        type: "draft_created",
        occurredAt: pipelineOccurredAt,
        sequence: ACTIVITY_SEQUENCE.draft_created,
        title: "下書きを生成",
        description: "Teams下書きを生成",
        sourceRawInputId: input.id,
        threadId,
        status: "ok",
        actor,
      },
    ];

    return {
      rawInput: { ...input, status: "needs_context" },
      contextResolution,
      threads: [
        {
          id: threadId,
          rawInputId: input.id,
          title,
          intent: "unknown",
          summary: body,
          extractedEntities: {},
          confidence: contextResolution.confidence,
        },
      ],
      links: [],
      intakeResolutions: [intakeResolution],
      stateTransitionCandidates: [],
      activityEvents: events,
      issueMutations: [],
      actionPlans: [actionPlan],
      drafts: [draft],
      pendingClarifications,
    };
  }

  const threads = Array.isArray(options.threads) ? options.threads : classifyRawInput(effectiveInput);
  const normalizedThreads = normalizeOperationalThreads(input, threads);

  const baseLinks = linkThreadsToEntities(normalizedThreads);
  const injectedLinks: EntityLink[] = (() => {
    if (!matchedPendingClarification || !Array.isArray(matchedPendingClarification.resolvedEntities)) return [];
    const entities = matchedPendingClarification.resolvedEntities.filter(Boolean);
    if (!entities.length) return [];
    const targets = normalizedThreads.filter((t) => t && (t.intent === "missing_document_check" || t.intent === "document_status_inquiry"));
    const threadIds = (targets.length ? targets : normalizedThreads.slice(0, 1)).map((t) => String(t?.id || "").trim()).filter(Boolean);
    if (!threadIds.length) return [];
    return threadIds.flatMap((threadId) =>
      entities.map((e) => ({
        id: ingestStableId("LNK", `${threadId}:${e.entityType}:${e.entityId}:pending_clarification`),
        threadId,
        entityType: e.entityType,
        entityId: e.entityId,
        confidence: typeof e.confidence === "number" ? e.confidence : 0.75,
        reason: "resolved entity from pending clarification reply",
      })),
    );
  })();

  const linksBeforeResolver = dedupeEntityLinks([...baseLinks, ...injectedLinks]);
  const resolverLinks: EntityLink[] = (() => {
    const tradeCases = Array.isArray(options.tradeCases) ? options.tradeCases.filter(Boolean) : [];
    if (!tradeCases.length) return [];

    const out: EntityLink[] = [];
    for (const thread of normalizedThreads) {
      const threadId = String(thread?.id || "").trim();
      if (!threadId) continue;
      const threadLinks = linksBeforeResolver.filter((l) => l.threadId === threadId);
      const hasSiOrShipment = threadLinks.some((l) => l.entityType === "SI" || l.entityType === "Shipment");
      if (hasSiOrShipment) continue;

      const doc = threadLinks.find((l) => l.entityType === "Document" && l.entityId) || null;
      if (!doc) continue;

      const ctx = resolveOperationalContext({ entityType: "Document", entityId: String(doc.entityId), tradeCases });
      if (!ctx) continue;

      if (ctx.shipment) {
        out.push({
          id: ingestStableId("LNK", `${threadId}:Shipment:${ctx.shipment}:relationship_resolver`),
          threadId,
          entityType: "Shipment",
          entityId: ctx.shipment,
          confidence: typeof doc.confidence === "number" ? doc.confidence : 0.7,
          reason: `relationship resolver: ${String(doc.entityId)} -> Shipment`,
        });
      }

      if (ctx.si) {
        out.push({
          id: ingestStableId("LNK", `${threadId}:SI:${ctx.si}:relationship_resolver`),
          threadId,
          entityType: "SI",
          entityId: ctx.si,
          confidence: typeof doc.confidence === "number" ? doc.confidence : 0.7,
          reason: `relationship resolver: ${String(doc.entityId)} -> SI`,
        });
      }
    }
    return out;
  })();

  const links = dedupeEntityLinks([...linksBeforeResolver, ...resolverLinks]);
  let intakeResolutions = resolveIntake(effectiveInput, normalizedThreads, links, options);
  const shouldAutoPlanOnClarificationReply = isClarificationResolvedByReply
    ? normalizedThreads.some((t) => t.intent === "document_status_inquiry")
    : false;
  const suppressNewOutputs = isClarificationResolvedByReply && !shouldAutoPlanOnClarificationReply;

  const stateTransition = buildStateTransitionCandidates({
    rawInput: effectiveInput,
    threads: normalizedThreads,
    entityLinks: links,
    intakeResolutions,
    now: pipelineOccurredAt,
  });
  const stateTransitionCandidates = stateTransition.candidates;
  const stateTransitionNotices = stateTransition.notices;
  const issueMutations = suppressNewOutputs
    ? []
    : buildIssueMutations(effectiveInput, normalizedThreads, links, intakeResolutions, options);
  const actionPlansBase = suppressNewOutputs
    ? []
    : planNextActions(effectiveInput, normalizedThreads, links, intakeResolutions, issueMutations, options);

  const approvalPolicy = options.approvalPolicy ?? "low_confidence";
  const isApprovalRequired = (thread: OperationalThread) =>
    approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;

  const actionPlans: ActionPlan[] = suppressNewOutputs
    ? []
    : actionPlansBase.map((ap) => {
        const thread = normalizedThreads.find((t) => t.id === ap.threadId);
        if (!thread) return ap;
        const status = isApprovalRequired(thread) ? "pending_approval" : "planned";
        return { ...ap, status };
      });

  const intakeResolvedEvents: ActivityEvent[] = intakeResolutions.map((r) => {
    const threadId = String(r?.threadId || "").trim();
    const st = String(r?.status || "");
    const summary =
      st === "status_query"
        ? "状況照会として処理"
        : st === "needs_clarification"
          ? "不足情報の確認が必要"
          : st === "issue_candidate_required"
            ? "Issue候補として整理"
            : st === "informational_only"
              ? "情報共有として記録"
              : "Intakeを解決";
    return {
      id: ingestStableId("ACT", `${input.id}:${threadId}:intake_resolved`),
      type: "intake_resolved",
      occurredAt: pipelineOccurredAt,
      sequence: ACTIVITY_SEQUENCE.intake_resolved,
      title: "Intake Resolver",
      description: summary,
      sourceRawInputId: input.id,
      threadId: threadId || undefined,
      linkedEntities: threadId ? links.filter((l) => l.threadId === threadId) : undefined,
      status: "ok",
      actor,
    } satisfies ActivityEvent;
  });

  const drafts = suppressNewOutputs
    ? []
    : buildDraftDocuments(effectiveInput, normalizedThreads, links, intakeResolutions, issueMutations, actionPlans, options);
  const activityEventsBase = buildActivityEvents(
    effectiveInput,
    normalizedThreads,
    links,
    pipelineOccurredAt,
    suppressNewOutputs ? { ...options, approvalPolicy: "none" } : options,
    stateTransitionCandidates,
    stateTransitionNotices,
  );

  const contextResolvedEvent: ActivityEvent[] =
    matchedPendingClarification && resolvedLabel
      ? [
          {
            id: ingestStableId("ACT", `${input.id}:${matchedPendingClarification.id}:context_resolved`),
            type: "context_resolved",
            occurredAt: pipelineOccurredAt,
            sequence: ACTIVITY_SEQUENCE.context_resolved,
            title: "補足で対象を特定",
            description: `確認回答を受信：${String(input.rawText || "").trim() || resolvedLabel}`,
            sourceRawInputId: input.id,
            status: "ok",
            actor,
          },
        ]
      : [];

  const clarificationMatchedEvent: ActivityEvent[] =
    matchedPendingClarification && resolvedLabel
      ? [
          {
            id: ingestStableId("ACT", `${input.id}:${matchedPendingClarification.id}:clarification_matched`),
            type: "clarification_matched",
            occurredAt: pipelineOccurredAt,
            sequence: ACTIVITY_SEQUENCE.clarification_matched,
            title: "確認返信を紐付け",
            description: "対象案件を特定しました",
            sourceRawInputId: input.id,
            status: "ok",
            actor,
          },
        ]
      : [];

  const draftCreatedEvents: ActivityEvent[] = drafts.map((d) => ({
    id: ingestStableId("ACT", `${input.id}:${d.threadId}:${d.id}:draft_created`),
    type: "draft_created",
    occurredAt: pipelineOccurredAt,
    sequence: ACTIVITY_SEQUENCE.draft_created,
    title: "下書きを生成",
    description: d.channel === "email" ? "email下書きを生成" : "Teams下書きを生成",
    sourceRawInputId: input.id,
    threadId: d.threadId,
    linkedEntities: links.filter((l) => l.threadId === d.threadId),
    status: "ok",
    actor,
  }));

  const actionPlannedEvents: ActivityEvent[] = actionPlans.map((ap) => ({
    id: ingestStableId("ACT", `${input.id}:${ap.threadId}:${ap.id}:action_planned`),
    type: "action_planned",
    occurredAt: pipelineOccurredAt,
    sequence: ACTIVITY_SEQUENCE.action_planned,
    title: "次アクションを判定",
    description: ap.title,
    sourceRawInputId: input.id,
    threadId: ap.threadId,
    linkedEntities: ap.linkedEntities,
    status: "ok",
    actor,
  }));

  const issueUpdatedEvents: ActivityEvent[] = (() => {
    const list = Array.isArray(issueMutations) ? issueMutations.filter(Boolean) : [];
    if (!list.length) return [];
    const issueIds = Array.from(new Set(list.map((m) => String(m?.issueId || "").trim()).filter(Boolean)));
    const desc =
      issueIds.length <= 3
        ? `${issueIds.join(" / ")} を更新`
        : `Issueを更新（${issueIds.length}件）`;
    const hasWarning = list.some((m) => m.action === "mark_approval_required");
    return [
      {
        id: ingestStableId("ACT", `${input.id}:issue_updated:summary:${issueIds.join(",")}`),
        type: "issue_updated",
        occurredAt: pipelineOccurredAt,
        sequence: ACTIVITY_SEQUENCE.issue_updated,
        title: "Issue更新",
        description: desc,
        sourceRawInputId: input.id,
        status: hasWarning ? "warning" : "ok",
        actor,
      },
    ];
  })();

  return {
    rawInput: { ...effectiveInput, status: "linked" },
    contextResolution,
    threads: normalizedThreads,
    links,
    intakeResolutions,
    stateTransitionCandidates,
    activityEvents: [
      ...contextResolvedEvent,
      ...clarificationMatchedEvent,
      ...activityEventsBase,
      ...intakeResolvedEvents,
      ...draftCreatedEvents,
      ...actionPlannedEvents,
      ...issueUpdatedEvents,
    ],
    issueMutations,
    actionPlans,
    drafts,
    pendingClarifications,
    matchedPendingClarification,
  };
}

export function buildIngestResultFromThreads(
  input: RawInput,
  threads: OperationalThread[],
  options: IngestPipelineOptions = {},
): MockIngestResult {
  return runIngestPipeline(input, { ...options, threads });
}

export function runMockIngest(input: RawInput, options: IngestPipelineOptions = {}): MockIngestResult {
  return runIngestPipeline(input, {
    ...options,
    sourceLabel: "mock ingest",
    approvalPolicy: "low_confidence",
  });
}

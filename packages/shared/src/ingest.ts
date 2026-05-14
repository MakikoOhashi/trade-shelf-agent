import type {
  ActionPlan,
  ActionType,
  ActivityEvent,
  DraftDocument,
  EntityLink,
  IssueMutation,
  MockIngestResult,
  OperationalThread,
  RawInput,
} from "./domain";
import type { ActivityEventType } from "./domain";

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
  classified: 20,
  entity_linked: 30,
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
};

export type IngestPipelineOptions = IngestBuildOptions & {
  threads?: OperationalThread[];
};

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

function issueCandidateIdFromThread(threadId: string) {
  const h = ingestStableId("THR", threadId).slice(-8).toUpperCase();
  return `ISS-CAND-${h}`;
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

function issueIdForThread(thread: OperationalThread, threadLinks: EntityLink[], mode: "candidate" | "existing_or_candidate") {
  if (mode === "candidate") return issueCandidateIdFromThread(thread.id);
  const existingIssue = (threadLinks || []).find((l) => l?.entityType === "Issue" && String(l?.entityId || "").trim());
  return existingIssue ? String(existingIssue.entityId).trim() : issueCandidateIdFromThread(thread.id);
}

export function planNextActions(
  input: RawInput,
  threads: OperationalThread[],
  links: EntityLink[],
  issueMutations: IssueMutation[],
  options: IngestBuildOptions = {},
): ActionPlan[] {
  const list = Array.isArray(threads) ? threads.filter(Boolean) : [];
  const allLinks = Array.isArray(links) ? links.filter(Boolean) : [];
  const mutations = Array.isArray(issueMutations) ? issueMutations.filter(Boolean) : [];

  const docHasCore = (types: unknown) => {
    const arr = Array.isArray(types) ? types : [];
    const normalized = arr.map((v) => String(v ?? "").trim().toUpperCase()).filter(Boolean);
    return normalized.includes("PL") || normalized.includes("INV") || normalized.includes("BL");
  };

  const actionTypesForThread = (thread: OperationalThread): ActionType[] => {
    switch (thread.intent) {
      case "missing_document_check": {
        const types = thread.extractedEntities?.documentTypes ?? [];
        if (docHasCore(types)) return ["supplier_confirmation_required", "email_required"];
        return ["human_review_only"];
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
  if (input.rawText.includes("PLまだ")) {
    return [
      {
        id: `${input.id}-thr-001`,
        rawInputId: input.id,
        title: "PL未着確認",
        intent: "missing_document_check",
        summary: "PLの未着状況を確認する依頼",
        extractedEntities: {
          shipmentIds: ["SHP-2026-009"],
          documentTypes: ["PL"],
        },
        confidence: 0.82,
      },
      {
        id: `${input.id}-thr-002`,
        rawInputId: input.id,
        title: "SI-224確認",
        intent: "shipment_status_check",
        summary: "SI-224の状況確認依頼",
        extractedEntities: {
          siIds: ["SI-2026-224"],
        },
        confidence: 0.62,
      },
    ];
  }

  return [
    {
      id: `${input.id}-thr-001`,
      rawInputId: input.id,
      title: "未分類依頼",
      intent: "unknown",
      summary: input.rawText,
      extractedEntities: {},
      confidence: 0.3,
    },
  ];
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
  options: IngestBuildOptions = {},
): IssueMutation[] {
  const mutations: IssueMutation[] = [];
  const approvalPolicy = options.approvalPolicy ?? "low_confidence";
  const sourceLabel = options.sourceLabel || "mock ingest";

  for (const thread of threads) {
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
      const issueId = issueIdForThread(thread, threadLinks, "candidate");
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
      const candidateId = issueIdForThread(thread, threadLinks, "candidate");
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
    const candidateId = issueIdForThread(thread, threadLinks, "candidate");
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
  issueMutations: IssueMutation[],
  actionPlans: ActionPlan[],
  options: IngestBuildOptions = {},
): DraftDocument[] {
  const tList = Array.isArray(threads) ? threads.filter(Boolean) : [];
  const allLinks = Array.isArray(links) ? links.filter(Boolean) : [];
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
    if (intent === "missing_document_check") {
      const si = primarySiLabelForThread(thread, threadLinks);
      return {
        subject: `Confirmation required: PL status for ${si}`,
        body: `${si} の PL状況をご確認ください。\n未発行の場合は予定日をご共有ください。`,
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

  const teamsTemplate = (intent: OperationalThread["intent"]) => {
    if (intent === "eta_change") {
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

    const threadLinks = allLinks.filter((l) => l.threadId === ap.threadId);
    const issueId = ap.issueId || issueIdForThreadFromMutations(ap.threadId);

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

    if (types.includes("teams_reply_required")) {
      const t = teamsTemplate(thread.intent);
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
  const threads = Array.isArray(options.threads) ? options.threads : classifyRawInput(input);
  const normalizedThreads = normalizeOperationalThreads(input, threads);
  const links = dedupeEntityLinks(linkThreadsToEntities(normalizedThreads));
  const issueMutations = buildIssueMutations(input, normalizedThreads, links, options);
  const actionPlansBase = planNextActions(input, normalizedThreads, links, issueMutations, options);

  const approvalPolicy = options.approvalPolicy ?? "low_confidence";
  const isApprovalRequired = (thread: OperationalThread) =>
    approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;

  const actionPlans: ActionPlan[] = actionPlansBase.map((ap) => {
    const thread = normalizedThreads.find((t) => t.id === ap.threadId);
    if (!thread) return ap;
    const status = isApprovalRequired(thread) ? "pending_approval" : "planned";
    return { ...ap, status };
  });

  const pipelineOccurredAt = input.receivedAt || ingestNowIso();
  const activityEventsBase = buildActivityEvents(input, normalizedThreads, links, pipelineOccurredAt, options);

  const actor = options.sourceLabel || "AI";

  const drafts = buildDraftDocuments(input, normalizedThreads, links, issueMutations, actionPlans, options);

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
    rawInput: { ...input, status: "linked" },
    threads: normalizedThreads,
    links,
    activityEvents: [...activityEventsBase, ...draftCreatedEvents, ...actionPlannedEvents, ...issueUpdatedEvents],
    issueMutations,
    actionPlans,
    drafts,
  };
}

export function buildIngestResultFromThreads(
  input: RawInput,
  threads: OperationalThread[],
  options: IngestBuildOptions = {},
): MockIngestResult {
  return runIngestPipeline(input, { ...options, threads });
}

export function runMockIngest(input: RawInput): MockIngestResult {
  return runIngestPipeline(input, {
    sourceLabel: "mock ingest",
    approvalPolicy: "low_confidence",
  });
}

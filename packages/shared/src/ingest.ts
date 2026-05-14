import type { ActivityEvent, EntityLink, IssueMutation, MockIngestResult, OperationalThread, RawInput } from "./domain";

function ingestStableId(prefix: string, seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function ingestNowIso() {
  return new Date().toISOString();
}

export type IngestBuildOptions = {
  sourceLabel?: string;
  approvalPolicy?: "all" | "low_confidence" | "none";
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
  options: IngestBuildOptions = {},
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const actor = options.sourceLabel || "AI";
  const approvalPolicy = options.approvalPolicy ?? "low_confidence";
  const baseOccurredAt = input.receivedAt || ingestNowIso();
  let sequence = 1;

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
    occurredAt: baseOccurredAt,
    sequence: sequence++,
    title: "依頼受信",
    description: input.rawText,
    sourceRawInputId: input.id,
    status: "ok",
    actor: sourceActorForInput(),
  });

  events.push({
    id: ingestStableId("ACT", `${input.id}:classified`),
    type: "classified",
    occurredAt: baseOccurredAt,
    sequence: sequence++,
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
    occurredAt: baseOccurredAt,
    sequence: sequence++,
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
      occurredAt: baseOccurredAt,
      sequence: sequence++,
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

export function buildIngestResultFromThreads(
  input: RawInput,
  threads: OperationalThread[],
  options: IngestBuildOptions = {},
): MockIngestResult {
  const normalizedThreads = normalizeOperationalThreads(input, threads);
  const links = dedupeEntityLinks(linkThreadsToEntities(normalizedThreads));
  const activityEvents = buildActivityEvents(input, normalizedThreads, links, options);
  const issueMutations = buildIssueMutations(input, normalizedThreads, links, options);

  const baseOccurredAt = input.receivedAt || ingestNowIso();
  const maxSeq = activityEvents.reduce((m, e) => Math.max(m, typeof e?.sequence === "number" ? e.sequence : 0), 0);
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
        occurredAt: baseOccurredAt,
        sequence: maxSeq + 1,
        title: "Issue更新",
        description: desc,
        sourceRawInputId: input.id,
        status: hasWarning ? "warning" : "ok",
        actor: options.sourceLabel || "AI",
      },
    ];
  })();

  return {
    rawInput: { ...input, status: "linked" },
    threads: normalizedThreads,
    links,
    activityEvents: [...activityEvents, ...issueUpdatedEvents],
    issueMutations,
  };
}

export function runMockIngest(input: RawInput): MockIngestResult {
  const threads = classifyRawInput(input);
  return buildIngestResultFromThreads(input, threads, {
    sourceLabel: "mock ingest",
    approvalPolicy: "low_confidence",
  });
}

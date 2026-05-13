import type { ActivityEvent, EntityLink, MockIngestResult, OperationalThread, RawInput } from "./domain";

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

export function classifyRawInput(input: RawInput): OperationalThread[] {
  if (input.rawText.includes("PLまだ")) {
    return [
      {
        id: "thread-001",
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
        id: "thread-002",
        rawInputId: input.id,
        title: "SI-224確認",
        intent: "shipment_status_check",
        summary: "SI-224の状況確認依頼",
        extractedEntities: {
          siIds: ["SI-2026-224"],
        },
        confidence: 0.74,
      },
    ];
  }

  return [
    {
      id: `thread-${input.id}`,
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

export function buildActivityEvents(input: RawInput, threads: OperationalThread[], links: EntityLink[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  events.push({
    id: ingestStableId("ACT", `${input.id}:raw_input_received`),
    type: "raw_input_received",
    occurredAt: input.receivedAt || ingestNowIso(),
    title: "Raw input received",
    description: input.rawText.slice(0, 200),
    sourceRawInputId: input.id,
    status: "ok",
  });

  events.push({
    id: ingestStableId("ACT", `${input.id}:classified`),
    type: "classified",
    occurredAt: ingestNowIso(),
    title: `Classified into ${threads.length} thread(s)`,
    sourceRawInputId: input.id,
    status: "ok",
  });

  events.push({
    id: ingestStableId("ACT", `${input.id}:entity_linked`),
    type: "entity_linked",
    occurredAt: ingestNowIso(),
    title: `Linked ${links.length} entit${links.length === 1 ? "y" : "ies"}`,
    sourceRawInputId: input.id,
    linkedEntities: links,
    status: "ok",
  });

  for (const thread of threads) {
    if (thread.confidence >= 0.7) continue;
    events.push({
      id: ingestStableId("ACT", `${input.id}:${thread.id}:approval_required`),
      type: "approval_required",
      occurredAt: ingestNowIso(),
      title: "Approval required",
      description: `Low confidence thread (${thread.confidence.toFixed(2)}): ${thread.title}`,
      sourceRawInputId: input.id,
      threadId: thread.id,
      linkedEntities: links.filter((l) => l.threadId === thread.id),
      status: "warning",
    });
  }

  return events;
}

export function buildIssueMutations(
  input: RawInput,
  threads: OperationalThread[],
  links: EntityLink[],
): MockIngestResult["issueMutations"] {
  const mutations: MockIngestResult["issueMutations"] = [];

  for (const thread of threads) {
    const threadLinks = links.filter((l) => l.threadId === thread.id);

    if (thread.title.includes("PL未着")) {
      const shipmentIds = thread.extractedEntities.shipmentIds ?? [];
      const title = `PL未着確認: ${shipmentIds[0] ?? "shipment unknown"}`;
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
        issueId: "ISS-0002",
        action: "append_comment",
        title,
        body: bodyLines.join("\n"),
      });

      if (thread.confidence < 0.7) {
        mutations.push({
          issueId: "ISS-0002",
          action: "mark_approval_required",
          title: "Approval required: low confidence classification",
          body: `Thread ${thread.id} confidence=${thread.confidence.toFixed(2)} for "${thread.title}"`,
        });
      }

      continue;
    }

    if (thread.title.includes("SI-224") || (thread.extractedEntities.siIds ?? []).some((s) => s.includes("224"))) {
      const siId = (thread.extractedEntities.siIds ?? [])[0] ?? "SI-UNKNOWN";
      const candidateId = `ISS-CAND-${ingestStableId("SI", siId).slice(-6).toUpperCase()}`;
      const title = `SI確認: ${siId}`;
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
        issueId: candidateId,
        action: "create_issue_candidate",
        title,
        body: bodyLines.join("\n"),
      });

      if (thread.confidence < 0.7) {
        mutations.push({
          issueId: candidateId,
          action: "mark_approval_required",
          title: "Approval required: low confidence classification",
          body: `Thread ${thread.id} confidence=${thread.confidence.toFixed(2)} for "${thread.title}"`,
        });
      }

      continue;
    }

    // Default: create a candidate issue for anything else.
    const candidateId = `ISS-CAND-${ingestStableId("THR", thread.id).slice(-6).toUpperCase()}`;
    mutations.push({
      issueId: candidateId,
      action: "create_issue_candidate",
      title: `Thread: ${thread.title}`,
      body: `Summary: ${thread.summary}\n\nRaw: ${input.rawText}`,
    });
  }

  return mutations;
}

export function runMockIngest(input: RawInput): MockIngestResult {
  const threads = classifyRawInput(input);
  const links = linkThreadsToEntities(threads);
  const activityEvents = buildActivityEvents(input, threads, links);
  const issueMutations = buildIssueMutations(input, threads, links);

  const issueUpdatedEvents: ActivityEvent[] = issueMutations.map((m) => ({
    id: ingestStableId("ACT", `${input.id}:issue_updated:${m.issueId}:${m.action}:${m.title}`),
    type: "issue_updated",
    occurredAt: ingestNowIso(),
    title: `${m.action}: ${m.issueId}`,
    description: m.title,
    sourceRawInputId: input.id,
    status: m.action === "mark_approval_required" ? "warning" : "ok",
  }));

  return {
    rawInput: { ...input, status: "linked" },
    threads,
    links,
    activityEvents: [...activityEvents, ...issueUpdatedEvents],
    issueMutations,
  };
}

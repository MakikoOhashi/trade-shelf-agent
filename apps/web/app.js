import { analyzeImpact, detectIncidents, mockTradeCases, proposeActions } from "@trade-shelf/shared";

const API_BASE_URL = window.TRADE_SHELF_API_BASE_URL || "http://127.0.0.1:3000";

const movementShelfDefs = [
  { key: "notArranged", label: "未手配" },
  { key: "preparingShipment", label: "出荷準備中" },
  { key: "readyToShip", label: "出荷待ち" },
  { key: "exportCustoms", label: "輸出通関中" },
  { key: "inTransit", label: "海上/航空輸送中" },
  { key: "importCustoms", label: "輸入通関中" },
  { key: "waitingWarehouseReceipt", label: "倉庫入荷待ち" },
  { key: "warehouseReceived", label: "倉庫入荷済み" },
  { key: "completed", label: "完了" },
];

const shelves = movementShelfDefs.map((d) => d.key);
const shelfLabelByKey = Object.fromEntries(movementShelfDefs.map((d) => [d.key, d.label]));

const movementStageOrder = movementShelfDefs.map((d) => d.key);
const movementStageRank = Object.fromEntries(movementStageOrder.map((k, i) => [k, i]));

const state = {
  inboxItems: [],
  tradeCases: [],
  shelfItems: [],
  /**
   * 「変更・確認依頼」: raw request inbox (mock)
   * @type {Array<any>}
   */
  rawRequests: [],
  /**
   * Mock ingest input (Requests page)
   * @type {string}
   */
  ingestInputText: "",
  /**
   * Mock ingest loading state (Requests page)
   * @type {boolean}
   */
  ingestLoading: false,
  /**
   * Mock ingest error text (Requests page)
   * @type {string}
   */
  ingestError: "",
  /**
   * Latest mock ingest result payload (Requests page)
   * @type {any}
   */
  latestIngestResult: null,
  /**
   * Active raw request id in Requests page
   * @type {string | null}
   */
  activeRawRequestId: null,
  /**
   * Active operational thread id in Requests page
   * @type {string | null}
   */
  activeOperationalThreadId: null,
  /**
   * Operational Thread modal open state (Requests page)
   * @type {boolean}
   */
  isOperationalThreadModalOpen: false,
  proposalApprovalStatusById: {},
  modalTradeCaseId: null,
  /**
   * Issues（AI承認センター）で開いている Issue detail の tradeCaseId
   * @type {string | null}
   */
  activeIssueId: null,
  /**
   * tradeCaseId -> sequential issue number (1-based)
   * @type {Record<string, number>}
   */
  issueSeqByTradeCaseId: {},
  /**
   * New TOP (GitHub-like) active tab
   * @type {"shelf" | "issues" | "requests" | "activity" | "documents" | "settings"}
   */
  topActiveTab: "shelf",
  /**
   * Activity Feed items (mock)
   * @type {Array<any>}
   */
  activityFeedItems: [],
  /**
   * Latest Issue mutations (mock ingest)
   * @type {Array<any>}
   */
  issueMutationItems: [],
  /**
   * Activity Feed filter key
   * @type {"all" | "teams" | "email" | "aiProcessed" | "awaitingApproval" | "failed" | "supplierReply"}
   */
  activityFilterKey: "all",
  /**
   * Shelf view mode toggle state
   * @type {"si" | "shipments"}
   */
  shelfViewMode: "si",
  /**
   * Resolution Decision Tree の branch 選択状態（branch.value）
   * @type {string | null}
   */
  selectedDecisionBranch: null,
  /**
   * Resolution Decision Tree の branch commit 状態（nodeId -> branchValue）
   * @type {Record<string, string>}
   */
  committedDecisionBranchByNodeId: {},
  /**
   * Decision Workspace の右ドロワ表示状態
   * @type {null | "inventory" | "salesCommitments" | "inboundPlans" | "similarPastCases" | "supplierReliability" | "stakeholderResponses" | "documentStatus"}
   */
  activeContextDrawer: null,
  /**
   * TradeCase は単一の固定ファイル単位ではなく、
   * SI / Invoice / Supplier / Incident / Shipment など複数の View Lens から再構成される operations graph として扱う。
   * UI はその graph をどの切り口で見るかを切り替える。
   *
   * @type {"case" | "si" | "invoice" | "bl" | "supplier" | "incident"}
   */
  currentViewLens: "case",
  /**
   * Workspace（Shipment / SI）内の Document Viewer UI state
   * @type {Record<string, { activeDocId: string | null, activePageByDocId: Record<string, number> }>}
   */
  workspaceUiByModalId: {},
  /**
   * Documents / Evidence Archive filter chip key
   * @type {"all" | "documents" | "emails" | "teams" | "issues" | "sentLogs" | "decisions" | "aiLogs"}
   */
  evidenceFilterKey: "all",
  /**
   * Documents / Evidence Archive search query
   * @type {string}
   */
  evidenceSearchQuery: "",
};

const newTopTabs = [
  { key: "shelf", label: "棚", subLabel: "Shelf" },
  { key: "issues", label: "AI承認センター", subLabel: "Approvals" },
  { key: "requests", label: "変更・確認依頼", subLabel: "Requests" },
  { key: "activity", label: "活動ログ", subLabel: "Activity" },
  { key: "documents", label: "Documents", subLabel: "" },
  { key: "settings", label: "Settings", subLabel: "" },
];

const shipmentStageLabels = [
  "出荷指図",
  "仕入先出発〜仕入先港着",
  "輸出通関手続き",
  "船積輸送中（洋上）",
  "港着〜輸入通関手続き",
  "営業倉庫へ輸送中",
  "営業倉庫着（在庫化）",
];

function shipmentStageIndexFromState(shipmentState) {
  const s = String(shipmentState || "");
  if (s === "warehouseReceived" || s === "completed") return 6;
  if (s === "waitingWarehouseReceipt") return 5;
  if (s === "customsCleared" || s === "arrived" || s === "importCustoms") return 4;
  if (s === "inTransit") return 3;
  if (s === "exportCustoms") return 2;
  if (s === "shipped") return 1;
  return 0;
}

function openShipmentWorkspace(tradeCaseId) {
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  if (!tc) return;
  state.modalTradeCaseId = tc.id;
  openWorkspaceModal("shipment-workspace-modal", { title: "Shipment Workspace", bodyHtml: renderShipmentWorkspace(tc), tradeCaseId: tc.id });
}

function openSiWorkspace(tradeCaseId) {
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  if (!tc) return;
  state.modalTradeCaseId = tc.id;
  openWorkspaceModal("si-workspace-modal", { title: "SI Workspace", bodyHtml: renderSiWorkspace(tc), tradeCaseId: tc.id });
}

function openNewWindow(url) {
  const u = String(url || "").trim();
  if (!u) return;
  try {
    window.open(u, "_blank", "noopener,noreferrer");
  } catch {
    window.open(u, "_blank");
  }
}

function openIngestionModal() {
  const modal = document.getElementById("ingestion-modal");
  if (!modal) return;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeIngestionModal() {
  const modal = document.getElementById("ingestion-modal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

async function submitMockIngest(rawText) {
  const response = await fetch(`${API_BASE_URL}/ingest/mock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "teams",
      senderName: "営業A",
      channel: "Teams",
      rawText,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Mock ingest failed: ${response.status}`);
  }

  return response.json();
}

function prependUniqueById(existing, incoming) {
  const add = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  const base = Array.isArray(existing) ? existing.filter(Boolean) : [];
  const out = [];
  const seen = new Set();
  for (const it of [...add, ...base]) {
    const id = it && it.id ? String(it.id) : "";
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

function statusKeyFromIngestStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "ok" || s === "success") return "success";
  if (s === "warning") return "warning";
  if (s === "failed" || s === "error") return "failed";
  return "processing";
}

function activityEventToFeedItem(ev) {
  const occurredAt = ev && ev.occurredAt ? String(ev.occurredAt) : "";
  const at = occurredAt ? formatLocalTime(occurredAt) : formatLocalTime(nowIso());
  const rawType = String(ev?.type || "");
  const type = rawType === "issue_updated" ? "issueUpdated" : rawType || "aiProcessed";
  const title = String(ev?.title || rawType || "Activity");
  const description = String(ev?.description || "");
  const status = String(ev?.status || "");
  const linkedEntities = Array.isArray(ev?.linkedEntities) ? ev.linkedEntities.filter(Boolean) : [];

  const linked = linkedEntities.map((l) => ({
    kind: String(l?.entityType || ""),
    label: `${String(l?.entityType || "")} ${String(l?.entityId || "")}`.trim(),
  }));

  const linkedText = linkedEntities.length
    ? `Linked: ${linkedEntities
        .map((l) => {
          const et = String(l?.entityType || "");
          const eid = String(l?.entityId || "");
          const cf = typeof l?.confidence === "number" ? l.confidence : null;
          const cfText = typeof cf === "number" && Number.isFinite(cf) ? ` (${cf.toFixed(2)})` : "";
          return `${et} ${eid}${cfText}`.trim();
        })
        .join(", ")}`
    : "";

  const details = [
    `type: ${type || "-"}`,
    description ? `description: ${description}` : "",
    status ? `status: ${status}` : "",
    linkedText,
  ].filter(Boolean);

  return {
    id: String(ev?.id || `act-${shortId()}`),
    type,
    source: "ai",
    title,
    actor: "mock ingest",
    at,
    summary: description || title,
    details,
    statusKey: statusKeyFromIngestStatus(status),
    linked,
    links: [],
  };
}

function getMockEvidenceArchiveItems() {
  const tcBySi = (siNo) =>
    (Array.isArray(state.tradeCases) ? state.tradeCases : []).find((c) => c && c.siEntity && String(c.siEntity.siNo) === String(siNo)) || null;

  const tc1 = tcBySi("SI-2026-001");
  const tc1Id = tc1 && tc1.id ? String(tc1.id) : "";

  return [
    {
      id: "ev-doc-inv-1122",
      type: "Document",
      title: "INV-1122 Commercial Invoice",
      description: "Supplier invoice with quantity mismatch",
      linked: [
        { kind: "si", label: "SI-2026-001", tradeCaseId: tc1Id },
        { kind: "shipment", label: "SHP-2026-009", tradeCaseId: tc1Id },
      ],
      source: "Workspace",
      date: "2026-05-12",
      tags: ["invoice", "quantity mismatch"],
      preview: {
        kind: "document",
        body: "（mock）Commercial invoice preview\n- Supplier: ACME Components (Shenzhen)\n- Qty: 400pcs\n- Note: SI指図 1000pcs と差異あり",
      },
    },
    {
      id: "ev-doc-archived-contract-2025",
      type: "Document",
      title: "Supplier Contract (2025) – Archived",
      description: "Archived supplier contract PDF for reference",
      linked: [],
      source: "Workspace",
      date: "2025-12-02",
      tags: ["contract", "archived"],
      archived: true,
      preview: {
        kind: "document",
        body: "（mock）Archived contract preview\n- Counterparty: ACME Components\n- Term: 2025-01-01 ~ 2025-12-31\n- Notes: stored for audit/reference",
      },
    },
    {
      id: "ev-email-pl-pending",
      type: "Email",
      title: "Re: PL pending for SHP-2026-009",
      description: "Supplier says PL will be sent within 24 hours",
      linked: [{ kind: "shipment", label: "SHP-2026-009", tradeCaseId: tc1Id }],
      source: "Outlook",
      date: "2026-05-11",
      tags: ["supplier", "PL missing"],
      preview: {
        kind: "message",
        from: "sales@acme-components.example",
        to: "ops@your-company.example",
        subject: "Re: PL pending for SHP-2026-009",
        body: "（mock）PL is being updated. We will send the revised Packing List within 24 hours.",
      },
    },
    {
      id: "ev-teams-sales-a",
      type: "Teams",
      title: "営業A: PLまだ？",
      description: "Sales asks for PL ETA to reply to customer",
      linked: [{ kind: "issue", label: "ISS-0002", tradeCaseId: tc1Id }],
      source: "Teams",
      date: "2026-05-11",
      tags: ["sales request"],
      preview: {
        kind: "message",
        from: "営業A",
        subject: "Teams message",
        body: "（mock）PLまだ？顧客から急かされてます。いつ頃になりそう？",
      },
    },
    {
      id: "ev-issue-0001",
      type: "Issue",
      title: "ISS-0001 INV数量差異",
      description: "Issue tracking for invoice/SI quantity mismatch",
      linked: [{ kind: "si", label: "SI-2026-001", tradeCaseId: tc1Id }],
      source: "Issues",
      date: "2026-05-10",
      tags: ["issue", "approval"],
      tradeCaseId: tc1Id,
    },
    {
      id: "ev-sent-supplier-confirm",
      type: "Sent log",
      title: "Supplier confirmation email sent",
      description: "Confirmation request sent to supplier regarding mismatch",
      linked: [{ kind: "issue", label: "ISS-0001", tradeCaseId: tc1Id }],
      source: "Email (sent)",
      date: "2026-05-10",
      tags: ["sent", "supplier"],
      preview: {
        kind: "message",
        from: "ops@your-company.example",
        subject: "Sent log",
        body: "（mock）Sent confirmation request to supplier regarding invoice/SI quantity mismatch.",
      },
    },
    {
      id: "ev-decision-split-shipment",
      type: "Decision log",
      title: "分納として記録し次便確認",
      description: "Decision: record as split shipment and confirm next batch",
      linked: [{ kind: "si", label: "SI-2026-001", tradeCaseId: tc1Id }],
      source: "Decision log",
      date: "2026-05-10",
      tags: ["decision"],
      preview: {
        kind: "message",
        from: "ops-user",
        subject: "Decision record",
        body: "（mock）分納として記録。残600pcsは次便での補充可否を確認し、営業へ暫定共有。",
      },
    },
    {
      id: "ev-ai-classification-split",
      type: "AI classification",
      title: "Supplier reply classified as split shipment",
      description: "AI classified supplier reply as split shipment (confidence 0.82)",
      linked: [{ kind: "shipment", label: "SHP-2026-009", tradeCaseId: tc1Id }],
      source: "AI agent",
      date: "2026-05-10",
      tags: ["AI classification"],
      preview: {
        kind: "message",
        from: "trade-shelf-agent",
        subject: "Classification result",
        body: "（mock）Classified supplier reply as: split shipment (partial invoice). Confidence: 0.82",
      },
    },
  ];
}

function getActiveOperationalThread() {
  const raw =
    (Array.isArray(state.rawRequests) ? state.rawRequests : []).find((r) => r && r.id === state.activeRawRequestId) || null;
  const threads = Array.isArray(raw?.aiThreads) ? raw.aiThreads : [];
  const activeThreadId = state.activeOperationalThreadId || (threads[0] && threads[0].id) || null;
  const thr = threads.find((t) => t && t.id === activeThreadId) || null;
  return { raw, thr };
}

function renderOperationalThreadTimeline(thr) {
  if (!thr) return `<div class="nt-muted">Select a thread</div>`;
  const messages = Array.isArray(thr.messages) ? thr.messages.filter(Boolean) : [];

  const evidenceHtml = (ev) => {
    const list = Array.isArray(ev) ? ev.filter(Boolean) : [];
    if (!list.length) return "";
    return `<div class="thread-message__evidence">${list
      .map((e) => {
        const label = escapeHtml(String(e.label || ""));
        const url = String(e.url || "").trim();
        const inner = url
          ? `<a class="evidence-chip" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`
          : `<span class="evidence-chip">${label}</span>`;
        return inner;
      })
      .join("")}</div>`;
  };

  const proposedActionHtml = (m) => {
    if (!m || !m.proposedAction) return "";
    const pa = m.proposedAction;
    const stateLabel = String(m.proposedActionState || "pending");
    const isDone = stateLabel === "sent" || stateLabel === "approved";

    const draft = String(pa.draftBody || "").trim();
    const draftHtml = draft ? `<pre class="proposed-action-card__draft">${escapeHtml(draft)}</pre>` : "";
    const footHtml = isDone ? `<div class="proposed-action-card__status">Status: ${escapeHtml(stateLabel)}</div>` : "";

    return `<div class="proposed-action-card" data-proposed-action-card="1">
      <div class="proposed-action-card__head">
        <div class="proposed-action-card__title">${escapeHtml(String(pa.label || "Proposed action"))}</div>
        <div class="proposed-action-card__meta muted">${escapeHtml(String(pa.type || ""))}</div>
      </div>
      ${draftHtml}
      <div class="proposed-action-card__actions">
        <button class="btn btn--primary btn--small" type="button" data-op-thread-action="approve" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String(m.id || ""))}" ${isDone ? "disabled" : ""}>Approve send</button>
        <button class="btn btn--ghost btn--small" type="button" data-op-thread-action="edit" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String(m.id || ""))}">Edit draft</button>
        <button class="btn btn--ghost btn--small" type="button" data-op-thread-action="hold" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String(m.id || ""))}">Hold</button>
      </div>
      ${footHtml}
    </div>`;
  };

  if (!messages.length) return `<div class="nt-muted">No conversation yet</div>`;
  return messages
    .map((m, idx) => {
      const role = String(m.role || "");
      const isAgent = role === "agent";
      const who = escapeHtml(String(m.sender || ""));
      const text = escapeHtml(String(m.text || ""));
      const at = m.createdAt ? formatLocalTime(m.createdAt) : "";
      const atHtml = at ? `<div class="thread-message__at">${escapeHtml(at)}</div>` : "";
      const cls = `thread-message ${isAgent ? "thread-message--agent" : "thread-message--requester"}`;
      const tail = idx === messages.length - 1 ? " thread-message--latest" : "";
      return `<div class="${cls}${tail}">
        <div class="thread-message__bubble">
          <div class="thread-message__sender">${who}</div>
          <div class="thread-message__text">${text}</div>
          ${evidenceHtml(m.evidence)}
          ${proposedActionHtml(m)}
        </div>
        ${atHtml}
      </div>`;
    })
    .join("");
}

function findLatestProposedActionMessage(thr) {
  const messages = thr && Array.isArray(thr.messages) ? thr.messages.filter(Boolean) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.proposedAction) return m;
  }
  return null;
}

function renderOperationalThreadModalBody(thr) {
  if (!thr) return `<div class="nt-muted">Select a thread</div>`;
  const title = String(thr.title || "Operational Thread");
  const status = String(thr.status || "—");
  const confidence = String(thr.confidence || "—");

  const linked = [
    thr.linkedShipmentId ? `Shipment: ${thr.linkedShipmentId}` : "",
    thr.linkedSiNo ? `SI: ${thr.linkedSiNo}` : "",
    thr.linkedIssueId ? `Issue: ${thr.linkedIssueId}` : "",
    thr.linkedCustomer ? `Customer: ${thr.linkedCustomer}` : "",
    `Status: ${status}`,
    `Confidence: ${confidence}`,
  ].filter(Boolean);

  const msg = findLatestProposedActionMessage(thr);
  const hasProposed = Boolean(msg && msg.id);

  return `<div class="op-thread-modal">
    <div class="op-thread-modal__head">
      <div class="op-thread-modal__title">${escapeHtml(title)}</div>
      <div class="op-thread-modal__meta">
        ${linked.map((x) => `<span class="mini-chip">${escapeHtml(x)}</span>`).join("")}
      </div>
    </div>

    <div class="op-thread-modal__grid">
      <div class="op-thread-modal__timeline" aria-label="Conversation timeline">
        ${renderOperationalThreadTimeline(thr)}
      </div>
      <aside class="op-thread-modal__links" aria-label="Related links">
        <div class="op-thread-modal__links-title">Related links</div>
        <button class="btn btn--ghost btn--small" type="button" data-req-action="openShipment" data-req-thread="${escapeHtml(
          String(thr.id || ""),
        )}">Shipment Workspace</button>
        <button class="btn btn--ghost btn--small" type="button" data-req-action="openSi" data-req-thread="${escapeHtml(
          String(thr.id || ""),
        )}">SI Workspace</button>
        <button class="btn btn--ghost btn--small" type="button" data-req-action="openIssue" data-req-thread="${escapeHtml(
          String(thr.id || ""),
        )}">Open related Issue</button>
      </aside>
    </div>

    <div class="op-thread-modal__actions" aria-label="Thread actions">
      <div class="op-thread-modal__actions-left">
        <button class="btn btn--primary btn--small ${hasProposed ? "" : "is-disabled"}" type="button" data-op-thread-action="approve" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String((msg && msg.id) || ""))}" ${hasProposed ? "" : "aria-disabled=\"true\""}>Approve send</button>
        <button class="btn btn--ghost btn--small ${hasProposed ? "" : "is-disabled"}" type="button" data-op-thread-action="edit" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String((msg && msg.id) || ""))}" ${hasProposed ? "" : "aria-disabled=\"true\""}>Edit draft</button>
        <button class="btn btn--ghost btn--small ${hasProposed ? "" : "is-disabled"}" type="button" data-op-thread-action="hold" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String((msg && msg.id) || ""))}" ${hasProposed ? "" : "aria-disabled=\"true\""}>Hold</button>
      </div>
      <div class="op-thread-modal__actions-right">
        <button class="btn btn--primary btn--small" type="button" data-req-action="addComment" data-req-thread="${escapeHtml(
          String(thr.id || ""),
        )}">Add to Issue</button>
        <button class="btn btn--ghost btn--small" type="button" data-req-action="openIssue" data-req-thread="${escapeHtml(
          String(thr.id || ""),
        )}">Open related Issue</button>
      </div>
    </div>
  </div>`;
}

function syncOperationalThreadModal() {
  const modal = document.getElementById("operational-thread-modal");
  const body = document.getElementById("operational-thread-modal-body");
  if (!modal || !body) return;

  if (!state.isOperationalThreadModalOpen) {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    body.innerHTML = "";
    return;
  }

  const { thr } = getActiveOperationalThread();
  body.innerHTML = renderOperationalThreadModalBody(thr);
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeOperationalThreadModal() {
  state.isOperationalThreadModalOpen = false;
  syncOperationalThreadModal();
}

function agentRunApproveSend(tradeCaseId) {
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  const run = tc && tc.resolutionAgentRun ? tc.resolutionAgentRun : null;
  if (!tc || !run) return false;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const current = steps.find((s) => s && s.id === run.currentStepId) || null;
  if (!current || !current.requiresHumanApproval) return false;

  const nowIso = new Date().toISOString();
  current.status = "sent";
  current.approvedBy = "human";
  current.approvedAt = nowIso;

  recordTimelineEvent(tradeCaseId, {
    id: shortId(),
    at: nowIso,
    type: "sentLog",
    label: "Sent log",
    message: `（mock）送信済み: ${current.actionType || current.id}`,
  });

  const waitStep = steps.find((s) => s && s.id === "step-wait-supplier-reply") || null;
  if (waitStep && waitStep.status === "waitingReply") {
    run.currentStepId = waitStep.id;
    run.status = "waitingExternalReply";
    run.progressPercent = Math.max(run.progressPercent || 0, 45);
    run.nextHumanAction = undefined;
  } else {
    run.status = "waitingExternalReply";
    run.progressPercent = Math.max(run.progressPercent || 0, 45);
    run.nextHumanAction = undefined;
  }

  recordTimelineEvent(tradeCaseId, {
    id: shortId(),
    at: nowIso,
    type: "statusChange",
    label: "Status change",
    message: "Status: requires approval → waiting supplier reply",
  });

  recordHumanIntervention(tradeCaseId, {
    actionType: "agentRunApproveSend",
    label: "Agent Run: Approve & Send",
    note: `step:${current.id}`,
  });
  log(`送信（mock）: ${current.id}`);
  return true;
}

function agentRunHold(tradeCaseId) {
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  const run = tc && tc.resolutionAgentRun ? tc.resolutionAgentRun : null;
  if (!tc || !run) return false;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const current = steps.find((s) => s && s.id === run.currentStepId) || null;
  if (!current) return false;
  current.status = "held";
  run.status = "waitingHumanApproval";
  recordTimelineEvent(tradeCaseId, {
    id: shortId(),
    at: nowIso(),
    type: "statusChange",
    label: "Status change",
    message: "Status: requires approval → on hold",
  });
  run.nextHumanAction = {
    label: "保留を解除して承認",
    description: "保留中です。内容を確認し、送信する場合は承認してください。",
    actionType: current.actionType || "humanApproval",
  };
  recordHumanIntervention(tradeCaseId, { actionType: "agentRunHold", label: "Agent Run: Hold", note: `step:${current.id}` });
  log(`保留: ${current.id}`);
  return true;
}

function agentRunEdit(tradeCaseId) {
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  const run = tc && tc.resolutionAgentRun ? tc.resolutionAgentRun : null;
  if (!tc || !run) return false;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const current = steps.find((s) => s && s.id === run.currentStepId) || null;
  const msg = current && current.proposedMessage ? current.proposedMessage : null;
  if (!current || !msg) return false;
  const nextBody = window.prompt("Edit message body（mock）", String(msg.body || ""));
  if (typeof nextBody === "string") msg.body = nextBody;
  recordTimelineEvent(tradeCaseId, {
    id: shortId(),
    at: nowIso(),
    type: "draftEdit",
    label: "Draft updated",
    message: "Draft was edited (mock).",
  });
  recordHumanIntervention(tradeCaseId, { actionType: "agentRunEdit", label: "Agent Run: Edit", note: `step:${current.id}` });
  log(`修正（mock）: ${current.id}`);
  return true;
}

function renderNewTop() {
  const tab = state.topActiveTab || "shelf";

  const navIconByKey = {
    shelf: "🗂️",
    issues: "⚠️",
    requests: "💬",
    activity: "📡",
    documents: "📚",
    settings: "⚙️",
  };

  const navHtml = `<nav class="top-nav" aria-label="Primary">
    ${newTopTabs
      .map((t) => {
        const active = t.key === tab;
        const icon = navIconByKey[t.key] || "•";
        const primary = String(t.label || "");
        const sub = String(t.subLabel || "");
        return `<button class="top-nav__item ${active ? "top-nav__item--active" : ""}" type="button" data-nt-tab="${escapeHtml(
          t.key,
        )}" aria-current="${active ? "page" : "false"}">
          <span class="top-nav__icon" aria-hidden="true">${escapeHtml(icon)}</span>
          <span class="top-nav__text">
            <span class="top-nav__primary">${escapeHtml(primary)}</span>
            ${sub ? `<span class="top-nav__sub">${escapeHtml(sub)}</span>` : ""}
          </span>
        </button>`;
      })
      .join("")}
  </nav>`;

  const shipments = Array.isArray(state.tradeCases) ? state.tradeCases.filter(Boolean) : [];

  const todayYmd = () => new Date().toISOString().slice(0, 10);

  const isOverdueYmd = (ymd) => {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return false;
    return String(ymd) < todayYmd();
  };

  const deriveBlockerLabels = (tc) => {
    const out = [];
    const blockingSummary = Array.isArray(tc?.caseProgress?.blockingSummary) ? tc.caseProgress.blockingSummary.filter(Boolean) : [];
    for (const s of blockingSummary) out.push(String(s));

    const docs = Array.isArray(tc?.caseProgress?.documents) ? tc.caseProgress.documents : [];
    for (const d of docs) {
      if (!d || !d.blocking) continue;
      const label = String(d.label || d.id || "doc");
      const status = String(d.status || "");
      if (status.includes("missing")) out.push(`${label} missing`);
      else if (status.includes("needsFix")) out.push(`${label} needs fix`);
      else if (status) out.push(`${label} ${status}`);
      else out.push(label);
    }

    const uniq = [];
    const seen = new Set();
    for (const x of out) {
      const k = String(x).trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      uniq.push(k);
    }
    return uniq;
  };

  const hasHighIssues = (tc) => {
    const incidents = Array.isArray(tc?.incidents) ? tc.incidents : [];
    for (const i of incidents) {
      if (!i || i.status === "resolved") continue;
      const s = String(i.severity || "").toLowerCase();
      if (s === "critical" || s === "high") return true;
    }
    return false;
  };

  const renderShelfCard = (viewType, tc, opts = {}) => {
    const isShipment = viewType === "shipments";
    const sh = tc && tc.shipmentEntity ? tc.shipmentEntity : null;
    const si = tc && tc.siEntity ? tc.siEntity : null;

    const idText = isShipment ? String(sh?.id || "Planned Shipment") : String(si?.siNo || "-");

    const salesCommitments = Array.isArray(tc?.decisionContext?.salesCommitments) ? tc.decisionContext.salesCommitments : [];
    const partyName = isShipment
      ? String(tc?.supplier?.name || "Supplier")
      : String(salesCommitments[0]?.customerName || tc?.customer?.name || tc?.supplier?.name || "Customer");

    const dueYmd = isShipment ? String(sh?.eta || "") : String(si?.requestedDeliveryDate || "");
    const dueLabel = isShipment ? (dueYmd ? `ETA ${dueYmd}` : "ETA未定") : dueYmd ? `delivery ${dueYmd}` : "delivery未定";

    const blockers = deriveBlockerLabels(tc);
    const blockerCount = blockers.length;
    const maxTags = 3;
    const tagList = blockers.slice(0, maxTags);
    const moreCount = Math.max(0, blockerCount - tagList.length);
    const tagsHtml = [
      ...tagList.map((t) => `<span class="nt-badge is-blocker">${escapeHtml(t)}</span>`),
      ...(moreCount > 0 ? [`<span class="nt-badge is-more">+${moreCount} more</span>`] : []),
    ].join("");

    const percentRaw = typeof tc?.caseProgress?.overallPercent === "number" ? tc.caseProgress.overallPercent : 0;
    const percent = Math.max(0, Math.min(100, Math.round(percentRaw)));

    const overdue = isOverdueYmd(dueYmd);
    const blocked = blockerCount > 0;
    const high = hasHighIssues(tc);

    const cardClass = ["shelf-card", overdue ? "is-overdue" : "", blocked ? "is-blocked" : "", high ? "is-high" : ""]
      .filter(Boolean)
      .join(" ");

    const openAttr = isShipment ? `data-open-shipment="${escapeHtml(tc.id)}"` : `data-open-si="${escapeHtml(tc.id)}"`;

    return `<article class="${cardClass}" role="button" tabindex="0" ${openAttr}>
      <div class="shelf-card__top">
        <div class="shelf-card__id">${escapeHtml(idText)}</div>
      </div>
      <div class="shelf-card__party nt-muted">${escapeHtml(partyName)}</div>
      <div class="shelf-card__meta nt-muted">${escapeHtml(dueLabel)}</div>
      ${tagsHtml ? `<div class="shelf-card__tags">${tagsHtml}</div>` : ""}
      <div class="nt-progress">
        <div class="nt-progress__bar" aria-hidden="true"><div class="nt-progress__fill" style="width:${percent}%"></div></div>
        <div class="nt-progress__label">${percent}%</div>
      </div>
    </article>`;
  };

  const renderShelfRow = (row) => {
    const { stageLabel, cardsHtml, count, overdueCount, blockerCount } = row;
    const metaBits = [
      blockerCount > 0 ? `<span class="shelf-row__pill is-blocker">⚠ blocker ${blockerCount}</span>` : `<span class="shelf-row__pill">blocker 0</span>`,
      overdueCount > 0 ? `<span class="shelf-row__pill is-overdue">⏰ overdue ${overdueCount}</span>` : `<span class="shelf-row__pill">overdue 0</span>`,
    ].join("");

    return `<div class="shelf-row">
      <div class="shelf-row__header">
        <div class="shelf-row__title">
          ${escapeHtml(stageLabel)} <span class="stage-count">${count}</span>
        </div>
        <div class="shelf-row__meta">${metaBits}</div>
      </div>
      <div class="shelf-row__body" role="region" aria-label="${escapeHtml(stageLabel)} shelf">
        <div class="shelf-row__rail">
          ${cardsHtml || `<div class="nt-muted shelf-row__empty">No records</div>`}
        </div>
      </div>
    </div>`;
  };

  const renderShelfBoard = (viewType) => {
    const isShipment = viewType === "shipments";
    const stages = shipmentStageLabels.map((label, idx) => ({ label, idx }));

    const rowsHtml = stages
      .map(({ label, idx }) => {
        const stageItems = shipments
          .filter((tc) => {
            if (!tc) return false;
            if (isShipment) {
              const sh = tc.shipmentEntity;
              return shipmentStageIndexFromState(sh?.shipmentState) === idx;
            }

            if (!tc.siEntity) return false;
            const si = tc.siEntity;
            let sIdx = 0;
            const relIds = si.relatedShipmentIds || [];
            if (relIds.length > 0) {
              const relStageIndices = relIds.map((id) => {
                const shTc = shipments.find((x) => x?.shipmentEntity?.id === id);
                return shTc ? shipmentStageIndexFromState(shTc.shipmentEntity.shipmentState) : 0;
              });
              sIdx = Math.min(...relStageIndices);
            }
            return sIdx === idx;
          })
          .sort((a, b) => {
            const da = isShipment ? String(a?.shipmentEntity?.eta || "") : String(a?.siEntity?.requestedDeliveryDate || "");
            const db = isShipment ? String(b?.shipmentEntity?.eta || "") : String(b?.siEntity?.requestedDeliveryDate || "");
            return da.localeCompare(db);
          });

        let overdueCount = 0;
        let blockerCount = 0;
        for (const tc of stageItems) {
          const blockers = deriveBlockerLabels(tc);
          if (blockers.length) blockerCount += 1;
          const due = isShipment ? tc?.shipmentEntity?.eta : tc?.siEntity?.requestedDeliveryDate;
          if (isOverdueYmd(due)) overdueCount += 1;
        }

        const cardsHtml = stageItems.map((tc) => renderShelfCard(viewType, tc, { stageIndex: idx })).join("");
        return renderShelfRow({ stageLabel: label, cardsHtml, count: stageItems.length, overdueCount, blockerCount });
      })
      .join("");

    return `<section class="shelf-board" aria-label="${isShipment ? "Shipments Shelf" : "SI Shelf"}">${rowsHtml}</section>`;
  };

  const renderShipments = () => {
    return renderShelfBoard("shipments");
  };

  const renderSi = () => {
    return renderShelfBoard("si");
  };

  const renderShelf = () => {
    const mode = state.shelfViewMode === "shipments" ? "shipments" : "si";
    const toggleHtml = `<div class="nt-seg" role="tablist" aria-label="Shelf view mode">
      <button class="nt-seg__btn ${mode === "si" ? "is-active" : ""}" type="button" data-shelf-view="si" role="tab" aria-selected="${
        mode === "si" ? "true" : "false"
      }">SI View（出荷指図）</button>
      <button class="nt-seg__btn ${mode === "shipments" ? "is-active" : ""}" type="button" data-shelf-view="shipments" role="tab" aria-selected="${
        mode === "shipments" ? "true" : "false"
      }">Shipment View（船積）</button>
    </div>`;

    const descriptionHtml = `<div class="nt-shelf-desc nt-muted">同じオペレーション棚を、出荷指図単位または船積単位で切り替えて確認します。</div>`;

    const boardHtml = mode === "si" ? renderSi() : renderShipments();
    return `<section class="nt-shelf" aria-label="Shelf">
      <div class="nt-shelf-top">
        ${toggleHtml}
        ${descriptionHtml}
      </div>
      ${boardHtml}
    </section>`;
  };

  const renderIssues = () => {
    const severityScore = { critical: 4, high: 3, medium: 2, low: 1 };
    const maxSeverity = (list) => {
      const incs = Array.isArray(list) ? list : [];
      let best = "low";
      for (const i of incs) {
        const s = String(i?.severity || "low").toLowerCase();
        if ((severityScore[s] || 0) > (severityScore[best] || 0)) best = s;
      }
      return best;
    };

    const issueNoForCase = (tcId) => {
      const n = state.issueSeqByTradeCaseId && typeof state.issueSeqByTradeCaseId[tcId] === "number" ? state.issueSeqByTradeCaseId[tcId] : null;
      const nn = typeof n === "number" && Number.isFinite(n) ? n : 0;
      return `ISS-${String(Math.max(0, nn)).padStart(4, "0")}`;
    };

    const relativeUpdatedText = (iso) => {
      if (!iso) return "-";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "-";
      const diffMs = Date.now() - d.getTime();
      const min = Math.max(0, Math.round(diffMs / 60000));
      if (min < 60) return `updated ${min}min ago`;
      const hr = Math.round(min / 60);
      if (hr < 24) return `updated ${hr}h ago`;
      const day = Math.round(hr / 24);
      return `updated ${day}d ago`;
    };

    const computeLastUpdatedIso = (tc) => {
      const timeline = Array.isArray(tc && tc.timeline) ? tc.timeline : [];
      const atList = timeline.map((x) => (x && x.at ? String(x.at) : "")).filter(Boolean);
      let best = atList.length ? atList[0] : "";
      for (const at of atList) {
        if (!best) best = at;
        if (String(at) > String(best)) best = at;
      }
      if (best) return best;
      const eta = tc?.shipmentEntity?.eta ? String(tc.shipmentEntity.eta) : "";
      if (eta && /^\d{4}-\d{2}-\d{2}$/.test(eta)) return `${eta}T00:00:00.000Z`;
      return "";
    };

    const buildIssueForCase = (tc) => {
      if (!tc) return null;
      const incidents = Array.isArray(tc?.incidents) ? tc.incidents : detectIncidents(tc);
      const activeIncidents = incidents.filter((i) => i && i.status !== "resolved");
      const blocking = Array.isArray(tc?.caseProgress?.blockingSummary) ? tc.caseProgress.blockingSummary.filter(Boolean) : [];
      const run = tc && tc.resolutionAgentRun ? tc.resolutionAgentRun : null;
      const steps = run && Array.isArray(run.steps) ? run.steps : [];
      const current = run && run.currentStepId ? steps.find((s) => s && s.id === run.currentStepId) : null;

      const missingDocs = Array.isArray(tc?.decisionContext?.documentStatus)
        ? tc.decisionContext.documentStatus.filter((d) => d && String(d.status || "").toLowerCase().includes("missing"))
        : [];

      const title = tc?.title || tc?.siEntity?.siNo || tc?.shipmentEntity?.id || `Case ${tc.id}`;
      const severity = maxSeverity(activeIncidents);

      // Status bucket
      let statusKey = "completed";
      let aiProposal = "完了（要対応なし）";
      let why = "アクション対象がありません。";
      let draft = null;

      const requiresApproval = Boolean(current && current.requiresHumanApproval && current.proposedMessage && current.status !== "sent");
      if (requiresApproval) {
        statusKey = "requiresApproval";
        const msg = current.proposedMessage;
        draft = {
          channel: msg.channel || "-",
          to: Array.isArray(msg.to) ? msg.to : [],
          subject: msg.subject || "",
          body: msg.body || "",
        };
        aiProposal = run?.nextHumanAction?.description || "外部送信文面を作成しました。承認してください。";
        const mismatch = activeIncidents.find((i) => i && i.type === "invoiceQuantityMismatch") || null;
        if (mismatch) {
          why = "INV と SI の数量差異を検知。顧客納期へ影響しうるため。";
        } else if (missingDocs.length) {
          why = "必須書類が未着。出荷/納期へ影響しうるため。";
        } else {
          why = "外部送信前は人間承認が必要なため。";
        }
      } else if (run && (run.status === "waitingExternalReply" || run.status === "waitingExternal")) {
        statusKey = "waitingExternal";
        aiProposal = "外部回答を待機中（仕入先/営業など）";
        why = "前ステップの依頼に対する返答待ちです。";
      } else if (blocking.length || missingDocs.length) {
        statusKey = "blocked";
        const blockText = blocking[0] || (missingDocs[0] ? `${missingDocs[0].docType} missing` : "blocked");
        aiProposal = `ブロック解除の確認: ${blockText}`;
        why = "期限/書類不足などにより進行が止まっています。";
      } else if (activeIncidents.length) {
        statusKey = "requiresApproval";
        const top = activeIncidents.slice().sort((a, b) => (severityScore[String(b?.severity || "low")] || 0) - (severityScore[String(a?.severity || "low")] || 0))[0];
        aiProposal = top ? `状況確認と方針決定: ${top.title || incidentTitleJa(top)}` : "状況確認と方針決定";
        why = "異常検知（インシデント）があります。";
      }

      const updatedAt = computeLastUpdatedIso(tc);
      return {
        id: tc.id,
        tradeCaseId: tc.id,
        issueNo: issueNoForCase(tc.id),
        title,
        severity,
        statusKey,
        aiProposal,
        why,
        draft,
        siNo: tc?.siEntity?.siNo || (Array.isArray(tc?.siNumbers) ? tc.siNumbers[0] : ""),
        shipmentId: tc?.shipmentEntity?.id || (Array.isArray(tc?.shipmentRefs) ? tc.shipmentRefs[0] : ""),
        updatedAt,
        updatedText: relativeUpdatedText(updatedAt),
        commentCount: Array.isArray(tc?.timeline) ? tc.timeline.length : 0,
      };
    };

    const allCases = Array.isArray(state.tradeCases) ? state.tradeCases.filter(Boolean) : [];
    const issues = allCases.map(buildIssueForCase).filter(Boolean);

    const statusTextByKey = {
      requiresApproval: "requires approval",
      blocked: "blocked",
      waitingExternal: "waiting supplier",
      completed: "completed",
    };

    const statusIcon = (k) => {
      const map = { requiresApproval: "○", blocked: "●", waitingExternal: "◑", completed: "✓" };
      return map[k] || "○";
    };

    const issueRow = (it) => {
      const sev = String(it.severity || "low").toLowerCase();
      const sevClass = sev === "critical" || sev === "high" ? "is-high" : sev === "medium" ? "is-medium" : "is-low";
      const statusText = statusTextByKey[it.statusKey] || it.statusKey;
      const linkText = [it.siNo, it.shipmentId].filter(Boolean).join(" / ") || "-";
      const cc = typeof it.commentCount === "number" ? it.commentCount : 0;
      return `<div class="issue-row" role="button" tabindex="0" data-issue-open="${escapeHtml(it.tradeCaseId)}">
        <div class="issue-row__left">
          <div class="issue-row__icon" aria-hidden="true">${escapeHtml(statusIcon(it.statusKey))}</div>
          <div class="issue-row__title">${escapeHtml(it.title)}</div>
        </div>
        <div class="issue-row__right">
          <div class="issue-row__meta">
            <span class="issue-pill nt-mono">#${escapeHtml(it.issueNo)}</span>
            <span class="issue-pill ${sevClass}">${escapeHtml(sev.toUpperCase())}</span>
            <span class="issue-pill">${escapeHtml(statusText)}</span>
            <span class="issue-pill">${escapeHtml(linkText)}</span>
            <span class="issue-pill">${escapeHtml(it.updatedText || "-")}</span>
            <span class="issue-pill nt-mono">${escapeHtml(String(cc))} comments</span>
          </div>
        </div>
      </div>`;
    };

    const pendingMutations = Array.isArray(state.issueMutationItems) ? state.issueMutationItems.filter(Boolean) : [];

    const actionLabel = (a) => {
      const v = String(a || "");
      if (v === "append_comment") return "既存Issue更新";
      if (v === "create_issue_candidate") return "新規Issue候補";
      if (v === "mark_approval_required") return "承認待ち";
      return v || "-";
    };

    const renderPendingMutations = () => {
      if (!pendingMutations.length) return "";
      const rows = pendingMutations
        .slice()
        .map((m) => {
          const issueId = String(m?.issueId || "");
          const action = String(m?.action || "");
          const title = String(m?.title || "");
          const body = String(m?.body || "");
          return `<div class="pending-mutations__item">
            <div class="pending-mutations__top">
              <span class="pending-mutations__issue nt-mono">${escapeHtml(issueId || "-")}</span>
              <span class="pending-mutations__action">${escapeHtml(actionLabel(action))}</span>
            </div>
            <div class="pending-mutations__title">${escapeHtml(title || "-")}</div>
            ${body ? `<pre class="pending-mutations__body">${escapeHtml(body)}</pre>` : ""}
          </div>`;
        })
        .join("");
      return `<section class="pending-mutations" aria-label="Pending AI mutations">
        <div class="pending-mutations__h">Pending AI mutations</div>
        ${rows}
      </section>`;
    };

    const renderIssueList = () => {
      const sorted = issues
        .slice()
        .sort((a, b) => {
          const sa = severityScore[String(a?.severity || "low").toLowerCase()] || 0;
          const sb = severityScore[String(b?.severity || "low").toLowerCase()] || 0;
          if (sb !== sa) return sb - sa;
          const ua = String(a?.updatedAt || "");
          const ub = String(b?.updatedAt || "");
          if (ub !== ua) return ub > ua ? 1 : -1;
          return String(a?.issueNo || "").localeCompare(String(b?.issueNo || ""));
        });
      const body = sorted.length ? sorted.map(issueRow).join("") : `<div class="nt-muted">No items</div>`;
      return `<section class="issue-list" aria-label="Issues list">${renderPendingMutations()}${body}</section>`;
    };

    const renderTimelineItem = (item) => {
      const t = String(item?.type || "");
      const at = item?.at ? formatLocalTime(item.at) : "";
      const label = item?.label ? String(item.label) : t || "comment";
      const body = item?.bodyHtml ? String(item.bodyHtml) : escapeHtml(String(item?.message || ""));
      const actor = item?.actor ? String(item.actor) : "";
      const meta = [label, actor].filter(Boolean).join(" ・ ");
      return `<div class="issue-timeline-item ${escapeHtml(`tl-${t || "comment"}`)}">
        <div class="issue-timeline-item__dot" aria-hidden="true"></div>
        <div class="issue-timeline-item__card">
          <div class="issue-timeline-item__meta">
            <span class="issue-timeline-item__label">${escapeHtml(meta || "-")}</span>
            ${at ? `<span class="issue-timeline-item__at">${escapeHtml(at)}</span>` : ""}
          </div>
          <div class="issue-timeline-item__body">${body}</div>
        </div>
      </div>`;
    };

	    const renderIssueDetail = (tradeCaseId) => {
	      const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
	      const it = issues.find((x) => x && x.tradeCaseId === tradeCaseId) || null;
	      if (!tc || !it) return `<div class="nt-muted">Issue not found</div>`;

	      const statusText = statusTextByKey[it.statusKey] || it.statusKey;
	      const statusJaByKey = {
	        requiresApproval: "人間承認待ち",
	        blocked: "ブロック中",
	        waitingExternal: "外部回答待ち",
	        completed: "完了",
	      };
	      const sev = String(it.severity || "low").toLowerCase();
	      const sevClass = sev === "critical" || sev === "high" ? "is-high" : sev === "medium" ? "is-medium" : "is-low";

	      const rawTimeline = Array.isArray(tc.timeline) ? tc.timeline.slice() : [];

	      const derived = [];
	      derived.push({
	        id: `ai-class:${tradeCaseId}`,
	        at: it.updatedAt || nowIso(),
        type: "aiClassification",
        label: "AI comment",
        actor: "trade-shelf-agent",
        message: it.why || "classified",
      });

	      if (it.statusKey === "requiresApproval" && it.draft && it.draft.body) {
	        const derivedAt = it.updatedAt || nowIso();
	        derived.push({
	          id: `draft-prop:${tradeCaseId}`,
	          at: derivedAt,
	          type: "draftProposal",
	          label: "Draft proposal",
	          actor: "trade-shelf-agent",
	          message: it.aiProposal || "Draft proposal ready.",
	        });
	        derived.push({
	          id: `email-draft:${tradeCaseId}`,
	          at: derivedAt,
	          type: "emailDraft",
	          label: "Email draft",
	          actor: "trade-shelf-agent",
	          bodyHtml: `<div class="issue-email-draft">
	            <div class="kv">
              <span class="muted">channel</span> ${escapeHtml(String(it.draft.channel || "-"))}
              <span class="muted">to</span> ${escapeHtml((it.draft.to || []).join(", ") || "-")}
              ${it.draft.subject ? `<span class="muted">subject</span> ${escapeHtml(String(it.draft.subject))}` : ""}
            </div>
            <pre class="pre pre--compact">${escapeHtml(String(it.draft.body || ""))}</pre>
            <div class="issue-actions">
              <button class="btn btn--primary btn--small" type="button" data-issue-approve="${escapeHtml(it.tradeCaseId)}">Approve send</button>
              <button class="btn btn--small" type="button" data-issue-edit="${escapeHtml(it.tradeCaseId)}">Edit draft</button>
              <button class="btn btn--small" type="button" data-issue-hold="${escapeHtml(it.tradeCaseId)}">Hold</button>
            </div>
          </div>`,
        });
      }

      const allTimeline = derived.concat(
        rawTimeline.map((x) => ({
          id: x?.id || shortId(),
          at: x?.at || "",
          type: x?.type || "comment",
          label: x?.label || x?.type || "comment",
          actor: x?.actor || "",
          message: x?.message || "",
        })),
      );

	      allTimeline.sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || "")));
	      const timelineHtml = allTimeline.length ? allTimeline.map(renderTimelineItem).join("") : `<div class="nt-muted">No timeline yet</div>`;

	      const lastAtRaw = allTimeline.length ? String(allTimeline[allTimeline.length - 1]?.at || "") : "";
	      const lastAtText = lastAtRaw ? formatLocalTime(lastAtRaw) : it.updatedAt ? formatLocalTime(it.updatedAt) : "-";

	      const labels = [];
	      const incs = Array.isArray(tc.incidents) ? tc.incidents : [];
	      for (const i of incs) {
	        const type = String(i?.type || "");
        if (type === "invoiceQuantityMismatch") labels.push("quantity mismatch");
        if (type === "missingDocument") labels.push("missing document");
        if (type === "deliveryRisk") labels.push("delivery risk");
      }
      const labelHtml = labels.length ? labels.slice(0, 5).map((x) => `<span class="issue-label">${escapeHtml(x)}</span>`).join("") : `<span class="nt-muted">-</span>`;

	      const assignee = it.statusKey === "waitingExternal" ? "Supplier waiting" : it.statusKey === "requiresApproval" ? "Ops user" : "AI Agent";

	      const dueDate = tc?.siEntity?.requestedDeliveryDate ? String(tc.siEntity.requestedDeliveryDate) : "";
	      const overdue = dueDate && new Date(dueDate).getTime() < new Date().setHours(0, 0, 0, 0);
      const dueHtml = dueDate
        ? `<div class="issue-sidebar-row"><div class="issue-sidebar__k">Deadline / SLA</div><div class="issue-sidebar__v">${escapeHtml(dueDate)} ${
            overdue ? `<span class="issue-overdue">OVERDUE</span>` : ""
          }</div></div>`
        : `<div class="issue-sidebar-row"><div class="issue-sidebar__k">Deadline / SLA</div><div class="issue-sidebar__v">-</div></div>`;

      const siNo = String(tc?.siEntity?.siNo || (Array.isArray(tc?.siNumbers) ? tc.siNumbers[0] : "") || "SI-2026-001");
      const shipmentId = String(tc?.shipmentEntity?.id || (Array.isArray(tc?.shipmentRefs) ? tc.shipmentRefs[0] : "") || "SHP-2026-009");
      const invoiceNo = String(tc?.invoiceNumbers?.[0]?.invoiceNo || (Array.isArray(tc?.shipmentEntity?.supplierInvoices) ? tc.shipmentEntity.supplierInvoices[0] : "") || "INV-1122");

      const relatedItems = [
        {
          key: "siWorkspace",
          label: "SI Workspace",
          badge: "SI",
          newUrl: `/mock/workspace/si/${encodeURIComponent(siNo)}`,
          hereDataAttr: `data-issue-open-si="${escapeHtml(it.tradeCaseId)}"`,
        },
        {
          key: "shipmentWorkspace",
          label: "Shipment Workspace",
          badge: "SHP",
          newUrl: `/mock/workspace/shipment/${encodeURIComponent(shipmentId)}`,
          hereDataAttr: `data-issue-open-shipment="${escapeHtml(it.tradeCaseId)}"`,
        },
        {
          key: "salesInventoryBalance",
          label: "Sales / Inventory Balance",
          badge: "BI",
          newUrl: `/mock/sales-inventory-balance/${encodeURIComponent(siNo)}`,
        },
        {
          key: "inboundSchedule",
          label: "Inbound Schedule",
          badge: "SHP",
          newUrl: `/mock/inbound-schedule/${encodeURIComponent(shipmentId)}`,
        },
        {
          key: "relatedInvoice",
          label: "Related Invoice",
          badge: "INV",
          newUrl: `/mock/documents/invoice/${encodeURIComponent(invoiceNo)}`,
        },
        {
          key: "relatedDocuments",
          label: "Related Documents",
          badge: "DOC",
          newUrl: `/mock/documents?shipment=${encodeURIComponent(shipmentId)}`,
        },
        {
          key: "caseDetail",
          label: "Case detail",
          badge: "CASE",
          newUrl: `/mock/case/${encodeURIComponent(it.tradeCaseId)}`,
          hereDataAttr: `data-issue-open-case="${escapeHtml(it.tradeCaseId)}"`,
        },
      ];

      const relatedLinksHtml = `<div class="issue-sidebar-row">
        <div class="issue-sidebar__k">Related links</div>
        <div class="issue-sidebar__v issue-sidebar-links issue-related-links">
          ${relatedItems
            .map((x) => {
              const badge = x.badge ? `<span class="issue-related-badge">${escapeHtml(x.badge)}</span>` : "";
              const openHere = x.hereDataAttr
                ? `<button class="issue-related-here" type="button" ${x.hereDataAttr} aria-label="Open here (modal)">Open here</button>`
                : "";
              return `<div class="issue-related-row">
                <button class="issue-related-item" type="button" data-issue-open-new="${escapeHtml(x.newUrl)}" aria-label="Open in new tab">
                  <span class="issue-related-label">${escapeHtml(x.label)}</span>
                  ${badge}
                  <span class="issue-related-ext" aria-hidden="true">↗</span>
                </button>
                ${openHere}
              </div>`;
            })
            .join("")}
        </div>
      </div>`;

	      const externalStatus = it.statusKey === "waitingExternal" ? "waiting supplier" : it.statusKey === "requiresApproval" ? "email draft" : "—";

	      const statusJa = statusJaByKey[it.statusKey] || String(statusText || it.statusKey || "-");
	      const canAct = it.statusKey === "requiresApproval" && it.draft && it.draft.body;
	      const pendingApprovalText = canAct
	        ? String(it.draft.channel || "").toLowerCase() === "email"
	          ? "仕入先確認メールの送信"
	          : "外部送信の承認"
	        : "-";
	      const currentProposalText = it.aiProposal || "-";
	      const nextActionText =
	        it.statusKey === "requiresApproval"
	          ? "Approve / Edit / Hold"
	          : it.statusKey === "waitingExternal"
	            ? "待機（外部回答）"
	            : it.statusKey === "blocked"
	              ? "ブロック解除の確認"
	              : "—";

	      const currentStatusHtml = `<section class="issue-current-status ${sevClass}" aria-label="Current Status">
	        <div class="issue-current-title">Current Status</div>
	        <div class="issue-current-rows">
	          <div class="issue-current-row"><span class="k">Status</span><span class="v">${escapeHtml(statusJa)}</span></div>
	          <div class="issue-current-row issue-current-row--pending"><span class="k">Pending approval</span><span class="v">${escapeHtml(pendingApprovalText)}</span></div>
	          <div class="issue-current-row"><span class="k">AI proposal</span><span class="v">${escapeHtml(currentProposalText)}</span></div>
	        </div>
	        <div class="issue-current-actions" aria-label="Next actions">
	          <button class="btn btn--primary btn--small" type="button" data-issue-approve="${escapeHtml(it.tradeCaseId)}" ${canAct ? "" : "disabled"}>Approve</button>
	          <button class="btn btn--small" type="button" data-issue-edit="${escapeHtml(it.tradeCaseId)}" ${canAct ? "" : "disabled"}>Edit draft</button>
	          <button class="btn btn--small" type="button" data-issue-hold="${escapeHtml(it.tradeCaseId)}">Hold</button>
	        </div>
	      </section>`;

	      const metaPanelHtml = `<aside class="issue-meta-panel issue-meta-panel--sticky" aria-label="Meta Panel">
          <div class="issue-sidebar-row"><div class="issue-sidebar__k">Assignee / Owner</div><div class="issue-sidebar__v">${escapeHtml(assignee)}</div></div>
          <div class="issue-sidebar-row"><div class="issue-sidebar__k">Labels</div><div class="issue-sidebar__v">${labelHtml}</div></div>
          ${relatedLinksHtml}
          <div class="issue-sidebar-row"><div class="issue-sidebar__k">External status</div><div class="issue-sidebar__v">${escapeHtml(externalStatus)}</div></div>
          ${dueHtml}
        </aside>`;

	      return `<section class="issue-detail" aria-label="Issue detail">
          <div class="issue-detail-layout" aria-label="Issue detail layout">
            <div class="issue-main-column" aria-label="Issue conversation">
              <div class="issue-detail__top">
                <button class="btn btn--small btn--ghost" type="button" data-issue-back="1">← Back</button>
                <div class="issue-detail__title">
                  <div class="issue-detail__h">${escapeHtml(it.title)}</div>
                  <div class="issue-detail__sub">
                    <span class="issue-pill nt-mono">#${escapeHtml(it.issueNo)}</span>
                    <span class="issue-pill ${sevClass}">${escapeHtml(sev.toUpperCase())}</span>
                    <span class="issue-pill">${escapeHtml(statusText)}</span>
                  </div>
                </div>
              </div>
              ${currentStatusHtml}
              <section class="detail-section issue-timeline-section" aria-label="Timeline">
                <h3 class="detail-section__title">Timeline / 対応履歴</h3>
                <div class="nt-muted">古い順に記録。現在の対応は上部の Current Status を確認。</div>
                <div class="issue-timeline">${timelineHtml}</div>
                <div class="issue-comment">
                  <div class="issue-comment__label">Comment</div>
                  <textarea class="issue-comment__box" rows="3" placeholder="手動メモ・補足・判断理由を残す" data-issue-comment-box="1"></textarea>
                  <div class="issue-comment__actions">
                    <button class="btn btn--primary btn--small" type="button" data-issue-add-comment="${escapeHtml(it.tradeCaseId)}">Add comment</button>
                  </div>
                </div>
              </section>
            </div>
            <div class="issue-sidebar-column" aria-label="Issue sidebar">
              ${metaPanelHtml}
            </div>
          </div>
      </section>`;
    };

    if (state.activeIssueId) return renderIssueDetail(state.activeIssueId);
    return renderIssueList();
  };

  const renderPlaceholder = (title) => `<div class="nt-placeholder">
    <div class="nt-placeholder__title">${escapeHtml(title)}</div>
    <div class="nt-muted">（mock）</div>
  </div>`;

  const renderDocumentsEvidenceArchive = () => {
    const evidenceItems = getMockEvidenceArchiveItems();

    const filterKey = state.evidenceFilterKey || "all";
    const q = String(state.evidenceSearchQuery || "").trim().toLowerCase();

    const sidebarDefs = [
      { key: "all", label: "All", icon: "🏠" },
      { key: "documents", label: "Documents", icon: "📄" },
      { key: "emails", label: "Emails", icon: "✉️" },
      { key: "teams", label: "Teams", icon: "💬" },
      { key: "issues", label: "Issues", icon: "⚠️" },
      { key: "sentLogs", label: "Sent logs", icon: "📤" },
      { key: "decisions", label: "Decisions", icon: "✅" },
      { key: "aiLogs", label: "AI logs", icon: "🤖" },
      { key: "archived", label: "Archived", icon: "🗄️" },
    ];

    const matchesFilter = (item) => {
      if (!item) return false;
      if (filterKey === "archived") return Boolean(item.archived);
      const t = String(item.type || "");
      if (filterKey === "documents") return t === "Document";
      if (filterKey === "emails") return t === "Email";
      if (filterKey === "teams") return t === "Teams";
      if (filterKey === "issues") return t === "Issue";
      if (filterKey === "sentLogs") return t === "Sent log";
      if (filterKey === "decisions") return t === "Decision log";
      if (filterKey === "aiLogs") return t === "AI classification";
      return true;
    };

    const matchesQuery = (item) => {
      if (!q) return true;
      const linkedText = Array.isArray(item.linked) ? item.linked.map((x) => String(x.label || "")).join(" ") : "";
      const tagText = Array.isArray(item.tags) ? item.tags.join(" ") : "";
      const hay = `${item.type || ""} ${item.title || ""} ${item.description || ""} ${linkedText} ${item.source || ""} ${item.date || ""} ${tagText}`.toLowerCase();
      return hay.includes(q);
    };

    const filtered = evidenceItems.filter((it) => matchesFilter(it) && matchesQuery(it));

    const rowsHtml = filtered
      .map((it) => {
        const type = String(it.type || "");
        const typeSlug = type.toLowerCase().replace(/\s+/g, "-");
        const desc = String(it.description || "").trim();
        const linkedHtml = (Array.isArray(it.linked) ? it.linked : [])
          .map((x) => {
            const label = String(x && x.label ? x.label : "");
            const tcId = String(x && x.tradeCaseId ? x.tradeCaseId : "");
            const kind = String(x && x.kind ? x.kind : "");
            if (kind === "shipment" && tcId) {
              return `<button class="evidence-linked-chip" type="button" data-open-shipment="${escapeHtml(tcId)}">${escapeHtml(label)}</button>`;
            }
            if (kind === "si" && tcId) {
              return `<button class="evidence-linked-chip" type="button" data-open-si="${escapeHtml(tcId)}">${escapeHtml(label)}</button>`;
            }
            if (kind === "issue" && tcId) {
              return `<button class="evidence-linked-chip" type="button" data-evidence-open-issue="${escapeHtml(tcId)}">${escapeHtml(label)}</button>`;
            }
            return `<span class="evidence-linked-chip is-static">${escapeHtml(label || "—")}</span>`;
          })
          .join("");

        const tagsHtml = (Array.isArray(it.tags) ? it.tags : [])
          .map((t) => `<span class="evidence-tag">${escapeHtml(String(t))}</span>`)
          .join("");

        const metaBits = [it.date ? `Updated ${String(it.date)}` : "", it.source ? String(it.source) : ""].filter(Boolean);
        const metaText = metaBits.join(" · ");

        return `<div class="evidence-row" role="row" data-evidence-row="1">
          <div class="evidence-row__left" role="cell">
            <div class="evidence-row__title">
              <span class="evidence-row__title-text">${escapeHtml(String(it.title || "—"))}</span>
              <span class="evidence-type-badge evidence-type-badge--${escapeHtml(typeSlug)}">${escapeHtml(type)}</span>
            </div>
            <div class="evidence-row__linked">${linkedHtml || `<span class="muted">—</span>`}</div>
            ${desc ? `<div class="evidence-row__desc">${escapeHtml(desc)}</div>` : ""}
            <div class="evidence-row__tags evidence-tags">${tagsHtml || `<span class="muted">—</span>`}</div>
            <div class="evidence-row__meta">${escapeHtml(metaText || "")}</div>
          </div>
          <div class="evidence-row__right" role="cell">
            <button class="btn btn--ghost btn--small" type="button" data-evidence-open="${escapeHtml(String(it.id || ""))}">Open</button>
          </div>
        </div>`;
      })
      .join("");

    const emptyHtml = `<div class="evidence-empty">No evidence found.</div>`;

    const sidebarHtml = sidebarDefs
      .map((d) => {
        const active = String(d.key) === String(filterKey);
        return `<button class="evidence-sidebar-item ${active ? "evidence-sidebar-item--active" : ""}" type="button" data-evidence-filter="${escapeHtml(
          String(d.key),
        )}">
          <span class="evidence-sidebar-item__icon" aria-hidden="true">${escapeHtml(String(d.icon || ""))}</span>
          <span class="evidence-sidebar-item__label">${escapeHtml(String(d.label || ""))}</span>
        </button>`;
      })
      .join("");

    const totalCount = Array.isArray(evidenceItems) ? evidenceItems.length : 0;

    return `<section class="evidence-archive" aria-label="Documents Evidence Archive">
      <div class="evidence-page-layout" aria-label="Evidence page layout">
        <nav class="evidence-sidebar" aria-label="Evidence categories">
          ${sidebarHtml}
        </nav>
        <div class="evidence-main" aria-label="Evidence main">
          <div class="evidence-main__head">
            <div>
              <div class="evidence-main__title">Documents / Evidence Archive</div>
              <div class="evidence-main__sub muted">書類・メール・Teams・Issue・送信ログ・判断ログの横断アーカイブ。</div>
            </div>
            <div class="evidence-main__count nt-mono">${escapeHtml(String(filtered.length))} / ${escapeHtml(String(totalCount))}</div>
          </div>

          <div class="evidence-search" aria-label="Search evidence">
            <input class="evidence-search__input" type="search" value="${escapeHtml(
              String(state.evidenceSearchQuery || ""),
            )}" placeholder="Search documents, emails, issues, shipments, SI..." data-evidence-search="1" />
          </div>

          <div class="evidence-list" role="table" aria-label="Evidence list">
            <div class="evidence-list-header" role="row">
              <div class="evidence-list-header__left" role="columnheader">Evidence</div>
              <div class="evidence-list-header__right" role="columnheader"></div>
            </div>
            ${rowsHtml || emptyHtml}
          </div>
        </div>
      </div>
    </section>`;
  };

  const renderActivityFeedPage = () => {
    const filterKey = state.activityFilterKey || "all";
    const itemsRaw = Array.isArray(state.activityFeedItems) ? state.activityFeedItems.filter(Boolean) : [];
    const items = itemsRaw
      .slice()
      .sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")));

    const filterDefs = [
      { key: "all", label: "All" },
      { key: "teams", label: "Teams" },
      { key: "email", label: "Email" },
      { key: "aiProcessed", label: "AI processed" },
      { key: "awaitingApproval", label: "Awaiting approval" },
      { key: "failed", label: "Failed" },
      { key: "supplierReply", label: "Supplier reply" },
    ];

    const matchesFilter = (it) => {
      const src = String(it?.source || "").toLowerCase();
      const t = String(it?.type || "").toLowerCase();
      const status = String(it?.statusKey || "").toLowerCase();
      if (filterKey === "teams") return src === "teams";
      if (filterKey === "email") return src === "email";
      if (filterKey === "aiProcessed") return t === "aiprocessed" || t === "issueupdated" || t === "issueresolved";
      if (filterKey === "awaitingApproval") return status === "awaitingapproval" || status === "waitingapproval";
      if (filterKey === "failed") return status === "failed" || t === "failedprocessing";
      if (filterKey === "supplierReply") return t === "supplierreply";
      return true;
    };

    const filtered = items.filter(matchesFilter);

    const statusDotClass = (it) => {
      const k = String(it?.statusKey || "").toLowerCase();
      if (k === "success") return "is-success";
      if (k === "warning") return "is-warning";
      if (k === "failed") return "is-failed";
      if (k === "processing") return "is-processing";
      if (k === "awaitingapproval" || k === "waitingapproval") return "is-warning";
      return "is-processing";
    };

    const renderLinks = (it) => {
      const links = Array.isArray(it?.links) ? it.links.filter(Boolean) : [];
      if (!links.length) return "";
      const html = links
        .map((l) => {
          const label = String(l.label || "Open");
          const href = String(l.href || "").trim() || "#";
          return `<a class="activity-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
        })
        .join("");
      return `<div class="activity-links" aria-label="Actions">${html}</div>`;
    };

    const renderLinked = (it) => {
      const linked = Array.isArray(it?.linked) ? it.linked.filter(Boolean) : [];
      if (!linked.length) return "";
      const chips = linked
        .map((x) => `<span class="activity-chip">${escapeHtml(String(x.label || x.kind || ""))}</span>`)
        .join("");
      return `<div class="activity-linked" aria-label="Linked">${chips}</div>`;
    };

    const renderItem = (it) => {
      const title = String(it?.title || "");
      const actor = String(it?.actor || "");
      const at = String(it?.at || "");
      const summary = String(it?.summary || "");
      const details = Array.isArray(it?.details) ? it.details.filter(Boolean) : [];
      const detailsHtml = details.length
        ? `<ul class="activity-details">${details.map((d) => `<li>${escapeHtml(String(d))}</li>`).join("")}</ul>`
        : "";

      return `<article class="activity-item" aria-label="Activity item">
        <div class="activity-tl" aria-hidden="true">
          <div class="activity-line"></div>
          <div class="activity-dot ${escapeHtml(statusDotClass(it))}"></div>
        </div>
        <div class="activity-card">
          <div class="activity-meta">
            <div class="activity-meta__left">
              <span class="activity-kind">${escapeHtml(title || "-")}</span>
              ${actor ? `<span class="activity-actor">${escapeHtml(actor)}</span>` : ""}
            </div>
            <div class="activity-meta__right">${escapeHtml(at)}</div>
          </div>
          ${summary ? `<div class="activity-summary">${escapeHtml(summary)}</div>` : ""}
          ${detailsHtml}
          ${renderLinked(it)}
          ${renderLinks(it)}
        </div>
      </article>`;
    };

    const filterBarHtml = `<div class="activity-filterbar" role="toolbar" aria-label="Filters">
      ${filterDefs
        .map((d) => {
          const active = String(d.key) === String(filterKey);
          return `<button class="activity-filter ${active ? "is-active" : ""}" type="button" data-activity-filter="${escapeHtml(
            String(d.key),
          )}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(String(d.label))}</button>`;
        })
        .join("")}
    </div>`;

    const feedHtml = filtered.length
      ? filtered.map(renderItem).join("")
      : `<div class="activity-empty nt-muted">No activities.</div>`;

    const headerHtml = `<header class="activity-head" aria-label="Feed header">
      <div class="activity-head__title">活動ログ</div>
      <div class="activity-head__sub nt-muted">AI・Teams・メールの処理ログを時系列で監視します。</div>
    </header>`;

    const queueCounts = (() => {
      let awaitingClassification = 0;
      let awaitingApproval = 0;
      let failedProcessing = 0;
      for (const it of items) {
        const s = String(it?.statusKey || "").toLowerCase();
        const t = String(it?.type || "").toLowerCase();
        if (s === "awaitingclassification") awaitingClassification++;
        if (s === "awaitingapproval" || s === "waitingapproval") awaitingApproval++;
        if (s === "failed" || t === "failedprocessing") failedProcessing++;
      }
      return { awaitingClassification, awaitingApproval, failedProcessing };
    })();

    const railHtml = `<aside class="activity-rail" aria-label="System rail">
      <section class="activity-rail__section" aria-label="AI Queue">
        <div class="activity-rail__h">AI Queue</div>
        <div class="activity-rail__kv"><span class="k">awaiting classification</span><span class="v nt-mono">${escapeHtml(
          String(queueCounts.awaitingClassification),
        )}</span></div>
        <div class="activity-rail__kv"><span class="k">awaiting approval</span><span class="v nt-mono">${escapeHtml(
          String(queueCounts.awaitingApproval),
        )}</span></div>
        <div class="activity-rail__kv"><span class="k">failed processing</span><span class="v nt-mono">${escapeHtml(
          String(queueCounts.failedProcessing),
        )}</span></div>
      </section>

      <section class="activity-rail__section" aria-label="Recent escalations">
        <div class="activity-rail__h">Recent escalations</div>
        <ul class="activity-rail__list">
          <li>ETA changed</li>
          <li>INV mismatch</li>
          <li>PL missing</li>
        </ul>
      </section>

      <section class="activity-rail__section" aria-label="Supplier waiting replies">
        <div class="activity-rail__h">Supplier waiting replies</div>
        <ul class="activity-rail__list">
          <li>ACME Components</li>
          <li>Orion Plastics</li>
        </ul>
      </section>

      <section class="activity-rail__section" aria-label="Unlinked inputs">
        <div class="activity-rail__h">Unlinked inputs</div>
        <div class="nt-muted">AIが紐付けできなかったもの。</div>
        <ul class="activity-rail__list">
          <li>unknown shipment reference</li>
          <li>unreadable attachment</li>
        </ul>
        <button class="btn btn--small" type="button" data-activity-attach-manual="1">Attach manually</button>
      </section>
    </aside>`;

    return `<section class="activity-page" aria-label="Activity Feed page">
      <div class="activity-layout" aria-label="Activity layout">
        <div class="activity-feed" aria-label="Feed">
          ${headerHtml}
          ${filterBarHtml}
          <div class="activity-stream" aria-label="Activity stream">${feedHtml}</div>
        </div>
        ${railHtml}
      </div>
    </section>`;
  };

  const renderRequests = () => {
    const list = Array.isArray(state.rawRequests) ? state.rawRequests.filter(Boolean) : [];
    const activeRawId = state.activeRawRequestId || (list[0] && list[0].id) || null;
    const activeRaw = list.find((r) => r && r.id === activeRawId) || null;
    const threads = Array.isArray(activeRaw?.aiThreads) ? activeRaw.aiThreads.filter(Boolean) : [];
    const activeThreadId = state.activeOperationalThreadId || (threads[0] && threads[0].id) || null;
    const activeThread = threads.find((t) => t && t.id === activeThreadId) || null;

    const sourceLabel = (s) => {
      const v = String(s || "").toLowerCase();
      if (v === "teams") return "Teams";
      if (v === "web") return "Web";
      if (v === "email") return "Email";
      if (v === "manualmemo") return "Manual memo";
      return v || "-";
    };

    const resolveTradeCaseIdForThread = (t) => {
      if (!t) return null;
      if (t.tradeCaseId) return String(t.tradeCaseId);
      const shipmentId = String(t.linkedShipmentId || "");
      const siNo = String(t.linkedSiNo || "");
      if (shipmentId) {
        const tc = state.tradeCases.find((c) => c && c.shipmentEntity && String(c.shipmentEntity.id) === shipmentId) || null;
        if (tc && tc.id) return tc.id;
      }
      if (siNo) {
        const tc = state.tradeCases.find((c) => c && c.siEntity && String(c.siEntity.siNo) === siNo) || null;
        if (tc && tc.id) return tc.id;
      }
      return null;
    };

    const rawCardsHtml = list
      .map((r) => {
        const isActive = r && r.id === activeRawId;
        const from = String(r.from || "-");
        const text = String(r.text || "");
        const at = String(r.receivedAt || "");
        const src = sourceLabel(r.source);
        return `<button class="req-card ${isActive ? "is-active" : ""}" type="button" data-raw-request-open="${escapeHtml(r.id)}">
          <div class="req-card__meta">
            <div class="req-card__from">${escapeHtml(from)}</div>
            <div class="req-card__right">
              <span class="req-pill">${escapeHtml(src)}</span>
              <span class="req-card__at">${escapeHtml(at)}</span>
            </div>
          </div>
          <div class="req-card__text">${escapeHtml(text)}</div>
        </button>`;
      })
      .join("");

    const threadCardsHtml = threads
      .map((t) => {
        const isActive = t && t.id === activeThreadId;
        const title = String(t.title || "Thread");
        const status = String(t.status || "");
        const linked = [
          t.linkedShipmentId ? `Shipment: ${t.linkedShipmentId}` : "",
          t.linkedSiNo ? `SI: ${t.linkedSiNo}` : "",
          t.linkedIssueId ? `Issue: ${t.linkedIssueId}` : "",
          t.linkedCustomer ? `Customer: ${t.linkedCustomer}` : "",
        ].filter(Boolean);
        const action = String(t.action || "");
        return `<button class="op-thread ${isActive ? "is-active" : ""}" type="button" data-operational-thread-open="${escapeHtml(
          t.id,
        )}">
          <div class="op-thread__h">${escapeHtml(title)}</div>
          ${linked.length ? `<div class="op-thread__links">${linked.map((x) => `<span class="mini-chip">${escapeHtml(x)}</span>`).join("")}</div>` : ""}
          <div class="op-thread__foot">
            <div class="op-thread__status">${escapeHtml(status || "—")}</div>
            <div class="op-thread__action">${escapeHtml(action)}</div>
          </div>
        </button>`;
      })
      .join("");

    const tcId = resolveTradeCaseIdForThread(activeThread);
    const canOpenIssue = Boolean(tcId);
    const canOpenShipment = Boolean(activeThread && activeThread.linkedShipmentId);
    const canOpenSi = Boolean(activeThread && activeThread.linkedSiNo);

    const actionHtml = activeThread
      ? `<div class="req-actions">
          <div class="req-actions__head">
            <div class="req-actions__title">Actions</div>
            <div class="req-actions__sub muted">${escapeHtml(String(activeThread.title || ""))}</div>
          </div>
          <div class="req-actions__body">
            <button class="btn btn--ghost btn--small ${canOpenIssue ? "" : "is-disabled"}" type="button" data-req-action="openIssue" data-req-thread="${escapeHtml(
              activeThread.id,
            )}" ${canOpenIssue ? "" : "aria-disabled=\"true\""}>Open related Issue</button>
            <button class="btn btn--ghost btn--small ${canOpenSi ? "" : "is-disabled"}" type="button" data-req-action="openSi" data-req-thread="${escapeHtml(
              activeThread.id,
            )}" ${canOpenSi ? "" : "aria-disabled=\"true\""}>Open SI Workspace</button>
            <button class="btn btn--ghost btn--small ${canOpenShipment ? "" : "is-disabled"}" type="button" data-req-action="openShipment" data-req-thread="${escapeHtml(
              activeThread.id,
            )}" ${canOpenShipment ? "" : "aria-disabled=\"true\""}>Open Shipment Workspace</button>
            <div class="req-actions__divider"></div>
            <button class="btn btn--primary btn--small" type="button" data-req-action="createIssue" data-req-thread="${escapeHtml(
              activeThread.id,
            )}">Create Issue</button>
            <button class="btn btn--primary btn--small" type="button" data-req-action="addComment" data-req-thread="${escapeHtml(
              activeThread.id,
            )}">Add comment to existing Issue</button>
            <button class="btn btn--primary btn--small" type="button" data-req-action="draftTeams" data-req-thread="${escapeHtml(
              activeThread.id,
            )}">Draft Teams reply</button>
            <button class="btn btn--primary btn--small" type="button" data-req-action="draftEmail" data-req-thread="${escapeHtml(
              activeThread.id,
            )}">Draft supplier push email</button>
          </div>
        </div>`
      : `<div class="req-actions"><div class="nt-muted">Select a thread</div></div>`;

    const ingestResult = state.latestIngestResult;
    const ingestThreads = Array.isArray(ingestResult?.threads) ? ingestResult.threads.filter(Boolean) : [];
    const ingestLinks = Array.isArray(ingestResult?.links) ? ingestResult.links.filter(Boolean) : [];
    const ingestEvents = Array.isArray(ingestResult?.activityEvents) ? ingestResult.activityEvents.filter(Boolean) : [];
    const ingestMutations = Array.isArray(ingestResult?.issueMutations) ? ingestResult.issueMutations.filter(Boolean) : [];

    const ingestSummaryHtml = ingestResult
      ? `<div class="ingest-result" aria-label="Latest ingest result">
          <div class="ingest-result__stats">
            <div><span class="k">OperationalThreads</span><span class="v nt-mono">${escapeHtml(String(ingestThreads.length))}</span></div>
            <div><span class="k">EntityLinks</span><span class="v nt-mono">${escapeHtml(String(ingestLinks.length))}</span></div>
            <div><span class="k">ActivityEvents</span><span class="v nt-mono">${escapeHtml(String(ingestEvents.length))}</span></div>
            <div><span class="k">IssueMutations</span><span class="v nt-mono">${escapeHtml(String(ingestMutations.length))}</span></div>
          </div>
          ${
            ingestThreads.length
              ? `<div class="ingest-result__threads">
                  <div class="ingest-result__h">Threads</div>
                  <ul class="ingest-result__list">${ingestThreads
                    .map((t) => `<li>${escapeHtml(String(t?.title || t?.id || "Thread"))}</li>`)
                    .join("")}</ul>
                </div>`
              : ""
          }
        </div>`
      : "";

    return `<section class="req-page" aria-label="Change & Check Requests">
      <div class="req-title">
        <div class="req-title__h">変更・確認依頼</div>
        <div class="req-title__sub">TeamsやWebからの雑な依頼を、AIが業務単位へ整理します。</div>
      </div>

      <div class="ingest-form" aria-label="Mock ingest form">
        <div class="ingest-form__head">
          <div class="ingest-form__title">変更・確認依頼を取り込む</div>
          <div class="ingest-form__sub muted">Teamsやメールで来る雑な依頼を、AIが業務単位に分解してIssueとActivityへ反映します。</div>
        </div>
        <textarea class="ingest-textarea" rows="3" placeholder="PLまだ？あとSI-224も確認して" data-ingest-input="1">${escapeHtml(
          String(state.ingestInputText || ""),
        )}</textarea>
        <div class="ingest-form__actions">
          <button class="btn btn--primary" type="button" data-ingest-submit="1" ${
            state.ingestLoading ? "disabled" : ""
          }>mock ingest 実行</button>
          <button class="btn btn--ghost" type="button" data-ingest-sample="1" ${state.ingestLoading ? "disabled" : ""}>サンプルを入れる</button>
          ${state.ingestLoading ? `<span class="ingest-loading nt-muted">loading...</span>` : ""}
        </div>
        ${state.ingestError ? `<div class="ingest-error">${escapeHtml(String(state.ingestError))}</div>` : ""}
        ${ingestSummaryHtml}
      </div>

      <div class="req-compose" aria-label="Request input">
        <textarea class="req-compose__box" rows="2" placeholder="例: PLまだ？ SI-224も確認して。営業Aへ返事しておいて" data-requests-input="1"></textarea>
        <div class="req-compose__actions">
          <button class="btn btn--primary" type="button" data-requests-add="1">AIに整理させる</button>
        </div>
      </div>

      <div class="req-grid" aria-label="Requests layout">
        <div class="req-col req-col--left" aria-label="Raw requests">
          <div class="req-col__head">Raw conversation / request inbox</div>
          <div class="req-list">${rawCardsHtml || `<div class="nt-muted">No requests</div>`}</div>
        </div>
        <div class="req-col req-col--center" aria-label="Operational threads">
          <div class="req-col__head">AIが分解した operational threads</div>
          <div class="op-list">${threadCardsHtml || `<div class="nt-muted">Select a request</div>`}</div>
        </div>
        <div class="req-col req-col--right" aria-label="Linked entities / actions">
          <div class="req-col__head">Linked entities / actions</div>
          ${actionHtml}
        </div>
      </div>
    </section>`;
  };

  const mainHtml =
    tab === "shelf"
      ? renderShelf()
      : tab === "issues"
        ? renderIssues()
        : tab === "requests"
          ? renderRequests()
          : tab === "activity"
            ? renderActivityFeedPage()
        : tab === "documents"
          ? renderDocumentsEvidenceArchive()
          : renderPlaceholder("Settings");

  return `
    <div class="new-top">
      <header class="top-header">
        <div class="top-header__brand">Trade Shelf Agent</div>
        <div class="top-header__actions">
          <button class="top-header__action-btn" type="button" data-open-ingestion="1" aria-label="Ingestion settings" title="Ingestion settings">
            <span class="top-header__action-icon" aria-hidden="true">⚙</span>
          </button>
        </div>
      </header>
      ${navHtml}
      <main class="nt-main" aria-label="Main">${mainHtml}</main>
    </div>
  `;
}

function renderApp() {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = renderNewTop();
  syncOperationalThreadModal();
}

function handleOperationalThreadAction({ action, threadId, messageId }) {
  const raw =
    (Array.isArray(state.rawRequests) ? state.rawRequests : []).find((r) => r && r.id === state.activeRawRequestId) || null;
  const threads = Array.isArray(raw?.aiThreads) ? raw.aiThreads : [];
  const thr = threads.find((t) => t && t.id === threadId) || null;
  const msg = thr && Array.isArray(thr.messages) ? thr.messages.find((m) => m && m.id === messageId) : null;

  const findTcId = () => {
    if (!thr) return null;
    const shipmentId = String(thr.linkedShipmentId || "");
    const siNo = String(thr.linkedSiNo || "");
    if (thr.tradeCaseId) return String(thr.tradeCaseId);
    if (shipmentId) {
      const tc = state.tradeCases.find((c) => c && c.shipmentEntity && String(c.shipmentEntity.id) === shipmentId) || null;
      return tc && tc.id ? tc.id : null;
    }
    if (siNo) {
      const tc = state.tradeCases.find((c) => c && c.siEntity && String(c.siEntity.siNo) === siNo) || null;
      return tc && tc.id ? tc.id : null;
    }
    return null;
  };

  if (!thr || !msg || !msg.proposedAction) {
    window.alert("(mock) Proposed action not found.");
    return;
  }

  if (action === "edit") {
    const current = String(msg.proposedAction.draftBody || "");
    const next = window.prompt("Edit draft（mock）", current);
    if (typeof next === "string") {
      msg.proposedAction.draftBody = next;
      msg.proposedActionState = "edited";
      renderApp();
    }
    return;
  }

  if (action === "hold") {
    msg.proposedActionState = "held";
    thr.status = "on hold";
    thr.action = "Hold";
    renderApp();
    return;
  }

  if (action === "approve") {
    msg.proposedActionState = "sent";
    thr.status = "sent";
    thr.action = "Supplier push sent";

    const tcId = findTcId();
    if (tcId) {
      recordHumanIntervention(tcId, {
        actionType: "sendSupplierPush",
        label: "Supplier push email sent（mock）",
        note: `thread: ${String(thr.title || "-")}`,
      });
    }

    renderApp();
    return;
  }
}

function handleRequestsAction({ action, threadId }) {
  const raw =
    (Array.isArray(state.rawRequests) ? state.rawRequests : []).find((r) => r && r.id === state.activeRawRequestId) || null;
  const threads = Array.isArray(raw?.aiThreads) ? raw.aiThreads : [];
  const thr = threads.find((t) => t && t.id === threadId) || null;

  if (!thr) {
    window.alert("Thread not found in mock data.");
    return;
  }

  const findTcId = () => {
    if (!thr) return null;
    const shipmentId = String(thr.linkedShipmentId || "");
    const siNo = String(thr.linkedSiNo || "");
    if (thr.tradeCaseId) return String(thr.tradeCaseId);
    if (shipmentId) {
      const tc = state.tradeCases.find((c) => c && c.shipmentEntity && String(c.shipmentEntity.id) === shipmentId) || null;
      return tc && tc.id ? tc.id : null;
    }
    if (siNo) {
      const tc = state.tradeCases.find((c) => c && c.siEntity && String(c.siEntity.siNo) === siNo) || null;
      return tc && tc.id ? tc.id : null;
    }
    return null;
  };

  if (action === "openShipment") {
    const shipmentId = thr && thr.linkedShipmentId ? String(thr.linkedShipmentId) : "";
    const tc = state.tradeCases.find((c) => c && c.shipmentEntity && String(c.shipmentEntity.id) === shipmentId) || null;
    if (tc && tc.id) openShipmentWorkspace(tc.id);
    else window.alert("No related Shipment workspace found in mock data.");
    return;
  }

  if (action === "openSi") {
    const siNo = thr && thr.linkedSiNo ? String(thr.linkedSiNo) : "";
    const tc = state.tradeCases.find((c) => c && c.siEntity && String(c.siEntity.siNo) === siNo) || null;
    if (tc && tc.id) openSiWorkspace(tc.id);
    else window.alert("No related SI workspace found in mock data.");
    return;
  }

  if (action === "openIssue") {
    const tcId = findTcId();
    if (tcId) {
      state.topActiveTab = "issues";
      state.activeIssueId = tcId;
      state.isOperationalThreadModalOpen = false;
      renderApp();
    } else {
      window.alert("No related Issue found in mock data.");
    }
    return;
  }

  if (action === "createIssue") {
    const tcId = findTcId();
    window.alert(`(mock) Create Issue\nthread: ${thr ? thr.title : "-"}\n${tcId ? `tradeCaseId: ${tcId}` : ""}`.trim());
    return;
  }

  if (action === "addComment") {
    const tcId = findTcId();
    if (!tcId) {
      window.alert("(mock) No related Issue to comment on.");
      return;
    }
    const comment = window.prompt("Add comment（mock）", `Request: ${(raw && raw.text) || ""}`.trim());
    if (typeof comment === "string" && comment.trim()) {
      recordTimelineEvent(tcId, {
        id: shortId(),
        at: nowIso(),
        type: "humanComment",
        label: "Human comment",
        actor: "ops-user",
        message: comment.trim(),
      });
      state.topActiveTab = "issues";
      state.activeIssueId = tcId;
      state.isOperationalThreadModalOpen = false;
      renderApp();
    }
    return;
  }

  if (action === "draftTeams") {
    const draft = `（ドラフト）\n了解です。確認して折り返します。\n- 対象: ${thr ? thr.title : "-"}\n- 依頼: ${(raw && raw.text) || "-"}`.trim();
    window.prompt("Draft Teams reply（mock）", draft);
    return;
  }

  if (action === "draftEmail") {
    const draft = `Subject: Urgent follow-up request\n\nHello,\nCould you please confirm the latest status?\n\nContext:\n- ${thr ? thr.title : "-"}\n- Request: ${(raw && raw.text) || "-"}`.trim();
    window.prompt("Draft supplier push email（mock）", draft);
    return;
  }
}

function ensureShelvesDom() {
  const root = document.getElementById("shelves");
  if (!root) return;
  const current = Array.from(root.querySelectorAll(".shelf")).map((el) => el.getAttribute("data-shelf")).filter(Boolean);
  const needsRebuild = current.length !== shelves.length || shelves.some((k, i) => current[i] !== k);
  if (!needsRebuild) return;

  root.innerHTML = "";
  for (const def of movementShelfDefs) {
    const el = document.createElement("div");
    el.className = "shelf";
    el.setAttribute("data-shelf", def.key);
    el.innerHTML = `
      <div class="shelf__head">
        <div class="shelf__title"></div>
        <div class="shelf__count" data-count>0</div>
      </div>
      <div class="shelf__body" data-body></div>
    `;
    el.querySelector(".shelf__title").textContent = def.label;
    root.appendChild(el);
  }
}

function getTradeCaseById(id) {
  return state.tradeCases.find((c) => c && c.id === id) || null;
}

function recordTimelineEvent(tradeCaseId, event) {
  const tc = getTradeCaseById(tradeCaseId);
  if (!tc) return;
  if (!Array.isArray(tc.timeline)) tc.timeline = [];
  tc.timeline.unshift(event);
}

function recordDecisionTreeActivity(tradeCaseId, { label, nextTitle, note }) {
  const at = nowIso();
  recordTimelineEvent(tradeCaseId, {
    id: shortId(),
    at,
    type: "decisionTree",
    message: `Decision Tree: ${label || "-"} route selected → ${nextTitle || "-"}`,
    label: "Decision Tree",
    note: note || "",
  });
}

function recordHumanIntervention(tradeCaseId, { actionType, label, note }) {
  const actor = "ops-user";
  const at = nowIso();
  recordTimelineEvent(tradeCaseId, {
    id: shortId(),
    at,
    type: "humanIntervention",
    message: `${actor} が ${label} を記録しました`,
    actor,
    actionType,
    label,
    note: note || "",
  });
}

function nowIso() {
  return new Date().toISOString();
}

function formatLocalTime(iso) {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function shortId() {
  return Math.random().toString(16).slice(2, 10);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function classifyToShelf(text) {
  const t = String(text || "").toLowerCase();
  if (/(完了|done|closed)/i.test(text)) return "完了";
  if (/(不足|missing|need|lack)/i.test(text)) return "書類不足";
  if (/(reply|返信待ち|返事待ち|re:)/i.test(text)) return "返信待ち";
  if (/(customs|通関)/i.test(text)) return "通関中";
  if (/(si\b|shipping instruction|shipment|出荷)/i.test(text)) return "出荷待ち";
  if (/(inv\b|invoice)/i.test(text)) return "通関中";
  return "出荷待ち";
}

function classifyTradeCaseToShelf(tradeCase) {
  const stage = deriveMovementStageFromShipmentState(tradeCase && tradeCase.shipmentState);
  return stage || "notArranged";
}

function tradeTypeLabelJa(tradeType) {
  const t = String(tradeType || "");
  const map = {
    import: "輸入",
    export: "輸出",
    domestic: "国内",
  };
  return map[t] || t || "-";
}

function shipmentStateLabelJa(shipmentState) {
  const s = String(shipmentState || "");
  const map = {
    notArranged: "未手配",
    bookingRequested: "ブッキング依頼中",
    shippingPending: "出荷前確認中",
    shipped: "出荷済み",
    inTransit: "輸送中",
    arrived: "到着",
    customsCleared: "通関済み",
    delivered: "納品済み",
    completed: "完了",
  };
  return map[s] || s || "-";
}

function deriveMovementStageFromShipmentState(shipmentState) {
  const s = String(shipmentState || "");
  const map = {
    notArranged: "notArranged",
    bookingRequested: "preparingShipment",
    shippingPending: "readyToShip",
    shipped: "exportCustoms",
    inTransit: "inTransit",
    arrived: "importCustoms",
    customsCleared: "waitingWarehouseReceipt",
    delivered: "warehouseReceived",
    completed: "completed",
  };
  return map[s] || "notArranged";
}

function pickMostAdvancedMovementStage(stages) {
  const list = Array.isArray(stages) ? stages : [];
  let best = "notArranged";
  let bestRank = movementStageRank[best] ?? 0;
  for (const x of list) {
    const k = String(x || "");
    const r = movementStageRank[k];
    if (typeof r === "number" && r > bestRank) {
      best = k;
      bestRank = r;
    }
  }
  return best;
}

function isStageAtLeast(stage, minStage) {
  const a = movementStageRank[String(stage || "")] ?? 0;
  const b = movementStageRank[String(minStage || "")] ?? 0;
  return a >= b;
}

function shelfTitleForViewLens(viewLens) {
  const v = String(viewLens || "case");
  const map = {
    case: "Shelf（案件別）",
    si: "Shelf（SI別）",
    invoice: "Shelf（INV別）",
    bl: "Shelf（BL別）",
    supplier: "Shelf（仕入先別）",
    incident: "Shelf（インシデント別）",
  };
  return map[v] || map.case;
}

function pickLatestUpdatedAt(isoList) {
  const list = Array.isArray(isoList) ? isoList : [];
  const sorted = list
    .filter(Boolean)
    .map((x) => String(x))
    .slice()
    .sort((a, b) => b.localeCompare(a));
  return sorted[0] || "";
}

function uniqStrings(xs) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(xs) ? xs : []) {
    const v = String(x || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function incidentTitleJa(incident) {
  const t = String(incident && incident.type ? incident.type : "");
  const map = {
    invoiceQuantityMismatch: "INV数量差異",
    missingDocument: "書類不足",
    delayedShipment: "出荷遅延",
    etaChanged: "ETA変更",
    supplierNoResponse: "仕入先未返信",
    partialShipment: "分納/部分出荷",
    marginRisk: "利益リスク",
    duplicateCase: "重複ケース",
    staleCase: "要更新",
  };
  return map[t] || (incident && incident.summary ? String(incident.summary).slice(0, 24) : "Incident");
}

function computeShortageFromIncidents(incidents) {
  const list = Array.isArray(incidents) ? incidents : [];
  const mismatch = list.find((i) => i && i.type === "invoiceQuantityMismatch" && i.status !== "resolved") || null;
  const details = mismatch && mismatch.details && typeof mismatch.details === "object" ? mismatch.details : null;
  const siQty = typeof details?.siQuantity === "number" ? details.siQuantity : null;
  const invQty = typeof details?.invoiceQuantity === "number" ? details.invoiceQuantity : null;
  if (typeof siQty === "number" && typeof invQty === "number") return Math.max(0, siQty - invQty);
  return null;
}

function classifyShelfItemToBucket(shelfItem) {
  const sourceCases = Array.isArray(shelfItem && shelfItem.sourceCases) ? shelfItem.sourceCases : [];
  const stages = sourceCases.map((c) => deriveMovementStageFromShipmentState(c ? c.shipmentState : "")).filter(Boolean);
  return pickMostAdvancedMovementStage(stages);
}

function deriveAlerts(incidents, movementStage) {
  const list = Array.isArray(incidents) ? incidents : [];
  const stage = String(movementStage || "notArranged");

  /** @type {Array<{type:string,label:string,severity:"low"|"medium"|"high"|"critical"}>} */
  const out = [];
  const pushOnce = (a) => {
    if (!a || !a.type) return;
    if (out.some((x) => x && x.type === a.type && x.label === a.label)) return;
    out.push(a);
  };

  for (const inc of list) {
    if (!inc || inc.status === "resolved") continue;
    const t = String(inc.type || "");

    if (t === "missingDocument") {
      if (stage === "importCustoms") {
        pushOnce({ type: "documentMissing", label: "通関リスク: 書類未着", severity: "critical" });
      } else if (isStageAtLeast(stage, "inTransit")) {
        pushOnce({ type: "documentMissing", label: "貨物進行中: 書類不足", severity: "critical" });
      } else {
        pushOnce({ type: "documentMissing", label: "書類不足", severity: isStageAtLeast(stage, "exportCustoms") ? "high" : "high" });
      }
      continue;
    }

    if (t === "supplierNoResponse") {
      pushOnce({ type: "waitingReply", label: "返信待ち", severity: "medium" });
      continue;
    }

    if (t === "invoiceQuantityMismatch") {
      if (isStageAtLeast(stage, "warehouseReceived")) {
        pushOnce({ type: "quantityMismatch", label: "入荷差異リスク", severity: "critical" });
      } else {
        pushOnce({ type: "quantityMismatch", label: "数量差異", severity: "high" });
      }
      continue;
    }

    if (t === "etaChanged") {
      pushOnce({ type: "etaChanged", label: "ETA変更", severity: "medium" });
      continue;
    }

    if (t === "partialShipment") {
      pushOnce({ type: "partialShipment", label: "分納確認", severity: "medium" });
      continue;
    }
  }

  return out;
}

function deriveShelfItemsByLens(cases, viewLens) {
  const lens = String(viewLens || "case");
  const tradeCases = Array.isArray(cases) ? cases : [];

  /** @type {Array<{
   *  id: string,
   *  lens: string,
   *  title: string,
   *  subtitle: string,
   *  statusBucket: string,
   *  movementStage: string,
   *  alerts: any[],
   *  sourceCaseIds: string[],
   *  sourceCases: any[],
   *  relatedRefs: Record<string, any>,
   *  incidents: any[],
   *  updatedAt: string
   * }>} */
  const items = [];

  if (lens === "case") {
    for (const c of tradeCases) {
      const supplierName = c && c.supplier && c.supplier.name ? c.supplier.name : "-";
      const updated = c && c.updatedAt ? formatLocalTime(c.updatedAt) : "-";
      const tradeTypeJa = tradeTypeLabelJa(c.tradeType);
      const shipmentStateJa = shipmentStateLabelJa(c.shipmentState);
      const incidents = Array.isArray(c && c.incidents) ? c.incidents : [];
      const movementStage = classifyTradeCaseToShelf(c);
      items.push({
        id: `case:${c.id}`,
        lens,
        title: c.title,
        subtitle: `${supplierName} ・ ${tradeTypeJa} ・ ${shipmentStateJa} ・ Updated ${updated} / incidents: ${
          incidents.length ? `あり(${incidents.length})` : "なし"
        }`,
        statusBucket: movementStage,
        movementStage,
        alerts: deriveAlerts(incidents, movementStage),
        sourceCaseIds: [c.id],
        sourceCases: [c],
        relatedRefs: { caseId: c.id },
        incidents,
        updatedAt: c.updatedAt || "",
      });
    }
    return items;
  }

  if (lens === "si") {
    const bySi = new Map();
    for (const c of tradeCases) {
      const siNumbers = Array.isArray(c && c.siNumbers) ? c.siNumbers : [];
      for (const siNo of siNumbers) {
        const key = String(siNo);
        if (!key) continue;
        if (!bySi.has(key)) bySi.set(key, { siNo: key, sourceCases: [], invoices: [], bls: [], incidents: [] });
        const entry = bySi.get(key);
        entry.sourceCases.push(c);
        entry.bls.push(...(Array.isArray(c.blNumbers) ? c.blNumbers : []));
        entry.invoices.push(...(Array.isArray(c.invoiceNumbers) ? c.invoiceNumbers : []));
        entry.incidents.push(...(Array.isArray(c.incidents) ? c.incidents : []));
      }
    }

    for (const [siNo, entry] of bySi.entries()) {
      const sourceCases = entry.sourceCases;
      const sourceCaseIds = sourceCases.map((c) => c.id);
      const supplierName = sourceCases[0] && sourceCases[0].supplier && sourceCases[0].supplier.name ? sourceCases[0].supplier.name : "-";
      const invoiceNos = uniqStrings(entry.invoices.map((inv) => (inv ? inv.invoiceNo : "")));
      const shortage = computeShortageFromIncidents(entry.incidents);
      const hasIncident = entry.incidents.some((i) => i && i.status !== "resolved");
      const updatedAt = pickLatestUpdatedAt(sourceCases.map((c) => c.updatedAt));

      const subtitleBits = [
        supplierName !== "-" ? supplierName : null,
        invoiceNos.length ? `INV ${invoiceNos.length}件` : "INV 0件",
        typeof shortage === "number" ? `shortage ${shortage}pcs` : null,
        hasIncident ? "incident あり" : null,
      ].filter(Boolean);

      const shelfItem = {
        id: `si:${siNo}`,
        lens,
        title: siNo,
        subtitle: subtitleBits.join(" ・ "),
        statusBucket: "notArranged",
        sourceCaseIds,
        sourceCases,
        relatedRefs: { siNo, invoiceNos, blNumbers: uniqStrings(entry.bls) },
        incidents: entry.incidents,
        updatedAt,
      };
      shelfItem.movementStage = classifyShelfItemToBucket(shelfItem);
      shelfItem.statusBucket = shelfItem.movementStage;
      shelfItem.alerts = deriveAlerts(shelfItem.incidents, shelfItem.movementStage);
      items.push(shelfItem);
    }
    return items;
  }

  if (lens === "invoice") {
    for (const c of tradeCases) {
      const invs = Array.isArray(c && c.invoiceNumbers) ? c.invoiceNumbers : [];
      for (const inv of invs) {
        if (!inv || !inv.invoiceNo) continue;
        const invoiceNo = String(inv.invoiceNo);
        const isSupplierInvoice = inv.type === "supplierInvoice";
        const typeLabel = isSupplierInvoice ? "Supplier Invoice" : "Switch Invoice";
        const relatedSiNo = inv.relatedSiNo ? String(inv.relatedSiNo) : "";
        const qty = typeof inv.qty === "number" ? inv.qty : null;
        const hasMismatch = (Array.isArray(c.incidents) ? c.incidents : []).some(
          (i) => i && i.type === "invoiceQuantityMismatch" && i.status !== "resolved",
        );

        const subtitleBits = [
          typeLabel,
          relatedSiNo || null,
          typeof qty === "number" ? `${qty}pcs` : null,
          hasMismatch ? "数量差異あり" : null,
        ].filter(Boolean);

        const shelfItem = {
          id: `inv:${invoiceNo}`,
          lens,
          title: invoiceNo,
          subtitle: subtitleBits.join(" ・ "),
          statusBucket: "notArranged",
          sourceCaseIds: [c.id],
          sourceCases: [c],
          relatedRefs: { invoiceNo, type: inv.type, relatedSiNo },
          incidents: Array.isArray(c.incidents) ? c.incidents : [],
          updatedAt: c.updatedAt || "",
        };
        shelfItem.movementStage = classifyShelfItemToBucket(shelfItem);
        shelfItem.statusBucket = shelfItem.movementStage;
        shelfItem.alerts = deriveAlerts(shelfItem.incidents, shelfItem.movementStage);
        items.push(shelfItem);
      }
    }
    return items;
  }

  if (lens === "bl") {
    const byBl = new Map();
    for (const c of tradeCases) {
      const blNumbers = Array.isArray(c && c.blNumbers) ? c.blNumbers : [];
      for (const blNo of blNumbers) {
        const key = String(blNo);
        if (!key) continue;
        if (!byBl.has(key)) byBl.set(key, { blNo: key, sourceCases: [], incidents: [], siNos: [], invoices: [] });
        const entry = byBl.get(key);
        entry.sourceCases.push(c);
        entry.incidents.push(...(Array.isArray(c.incidents) ? c.incidents : []));
        entry.siNos.push(...(Array.isArray(c.siNumbers) ? c.siNumbers : []));
        entry.invoices.push(...(Array.isArray(c.invoiceNumbers) ? c.invoiceNumbers : []));
      }
    }

    for (const [blNo, entry] of byBl.entries()) {
      const sourceCases = entry.sourceCases;
      const siNos = uniqStrings(entry.siNos);
      const invoiceNos = uniqStrings(entry.invoices.map((inv) => (inv ? inv.invoiceNo : "")));
      const updatedAt = pickLatestUpdatedAt(sourceCases.map((c) => c.updatedAt));
      const shipmentStateJa = sourceCases[0] ? shipmentStateLabelJa(sourceCases[0].shipmentState) : "-";

      const subtitleBits = [
        siNos[0] || null,
        `INV ${invoiceNos.length}件`,
        shipmentStateJa !== "-" ? shipmentStateJa : null,
      ].filter(Boolean);

      const shelfItem = {
        id: `bl:${blNo}`,
        lens,
        title: blNo,
        subtitle: subtitleBits.join(" ・ "),
        statusBucket: "notArranged",
        sourceCaseIds: sourceCases.map((c) => c.id),
        sourceCases,
        relatedRefs: { blNo, siNos, invoiceNos },
        incidents: entry.incidents,
        updatedAt,
      };
      shelfItem.movementStage = classifyShelfItemToBucket(shelfItem);
      shelfItem.statusBucket = shelfItem.movementStage;
      shelfItem.alerts = deriveAlerts(shelfItem.incidents, shelfItem.movementStage);
      items.push(shelfItem);
    }
    return items;
  }

  if (lens === "supplier") {
    const bySupplier = new Map();
    for (const c of tradeCases) {
      const name = c && c.supplier && c.supplier.name ? String(c.supplier.name) : "-";
      if (!bySupplier.has(name)) bySupplier.set(name, { name, sourceCases: [], incidents: [] });
      const entry = bySupplier.get(name);
      entry.sourceCases.push(c);
      entry.incidents.push(...(Array.isArray(c.incidents) ? c.incidents : []));
    }

    for (const [name, entry] of bySupplier.entries()) {
      const sourceCases = entry.sourceCases;
      const openCases = sourceCases.filter((c) => c && c.shipmentState !== "completed").length;
      const unresolvedIncidents = entry.incidents.filter((i) => i && i.status !== "resolved");
      const missingDoc = unresolvedIncidents.some((i) => i && i.type === "missingDocument");
      const updatedAt = pickLatestUpdatedAt(sourceCases.map((c) => c.updatedAt));

      const subtitleBits = [
        `Open cases ${openCases}件`,
        `incidents ${unresolvedIncidents.length}件`,
        missingDoc ? "書類不足あり" : null,
      ].filter(Boolean);

      const shelfItem = {
        id: `supplier:${name}`,
        lens,
        title: name,
        subtitle: subtitleBits.join(" ・ "),
        statusBucket: "notArranged",
        sourceCaseIds: sourceCases.map((c) => c.id),
        sourceCases,
        relatedRefs: { supplierName: name, caseIds: sourceCases.map((c) => c.id) },
        incidents: entry.incidents,
        updatedAt,
      };
      shelfItem.movementStage = classifyShelfItemToBucket(shelfItem);
      shelfItem.statusBucket = shelfItem.movementStage;
      shelfItem.alerts = deriveAlerts(shelfItem.incidents, shelfItem.movementStage);
      items.push(shelfItem);
    }
    return items;
  }

  if (lens === "incident") {
    for (const c of tradeCases) {
      const incs = Array.isArray(c && c.incidents) ? c.incidents : [];
      const siNos = uniqStrings(Array.isArray(c.siNumbers) ? c.siNumbers : []);
      const invoiceNos = uniqStrings((Array.isArray(c.invoiceNumbers) ? c.invoiceNumbers : []).map((inv) => (inv ? inv.invoiceNo : "")));
      const shortage = computeShortageFromIncidents(incs);

      for (const inc of incs) {
        if (!inc) continue;
        const title = incidentTitleJa(inc);
        const subtitleBits = [
          siNos[0] || null,
          invoiceNos.length ? `INV ${invoiceNos.join("/")}` : null,
          typeof shortage === "number" ? `shortage ${shortage}pcs` : null,
        ].filter(Boolean);

      const shelfItem = {
        id: `incident:${inc.id}`,
        lens,
        title,
        subtitle: subtitleBits.join(" ・ "),
        statusBucket: "notArranged",
        sourceCaseIds: [c.id],
        sourceCases: [c],
        relatedRefs: { incidentId: inc.id, incidentType: inc.type, siNos, invoiceNos },
        incidents: [inc],
        updatedAt: c.updatedAt || "",
      };
      shelfItem.movementStage = classifyShelfItemToBucket(shelfItem);
      shelfItem.statusBucket = shelfItem.movementStage;
      shelfItem.alerts = deriveAlerts(shelfItem.incidents, shelfItem.movementStage);
      items.push(shelfItem);
    }
  }
  return items;
}

  return items;
}

function recomputeShelfItems() {
  state.shelfItems = deriveShelfItemsByLens(state.tradeCases, state.currentViewLens);
}

function renderShelfHeader() {
  const titleEl = document.getElementById("shelf-title");
  if (titleEl) titleEl.textContent = shelfTitleForViewLens(state.currentViewLens);

  const root = document.getElementById("view-lens");
  if (!root) return;
  const btns = root.querySelectorAll("[data-view-lens]");
  for (const btn of btns) {
    const lens = btn.getAttribute("data-view-lens");
    const isActive = lens === state.currentViewLens;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
}

function guessTitle(payload) {
  if (!payload) return "Untitled";
  if (payload.kind === "file") return payload.name || "File";
  if (payload.kind === "text") {
    const firstLine = String(payload.text || "").split("\n")[0].trim();
    return firstLine ? firstLine.slice(0, 60) : "Text";
  }
  return "Item";
}

function summarize(payload) {
  if (!payload) return "";
  if (payload.kind === "file") {
    const size = typeof payload.size === "number" ? `${Math.ceil(payload.size / 1024)} KB` : "";
    return [payload.type, size].filter(Boolean).join(" · ");
  }
  if (payload.kind === "text") {
    return String(payload.text || "").trim().slice(0, 160);
  }
  return "";
}

function log(text) {
  const logItems = document.getElementById("log-items");
  const iso = nowIso();
  const row = document.createElement("div");
  row.className = "log__item";
  row.innerHTML = `<div class="log__time">${formatLocalTime(iso)}</div><div class="log__text"></div>`;
  row.querySelector(".log__text").textContent = text;
  logItems.prepend(row);
}

function updateCounts() {
  const inboxCount = document.getElementById("inbox-count");
  if (inboxCount) inboxCount.textContent = `${state.inboxItems.length} items`;

  // Ingestion status card counts
  const synced = state.inboxItems.length;
  const pending = state.inboxItems.filter((i) => i && i.payload && i.payload.kind === "text").length;
  const needsReview = state.inboxItems.filter((i) => i && i.payload && i.payload.needsReview).length;

  const elSynced = document.getElementById("synced-count");
  if (elSynced) elSynced.textContent = String(synced);
  const elPending = document.getElementById("pending-count");
  if (elPending) elPending.textContent = String(pending);
  const elNeeds = document.getElementById("needs-review-count");
  if (elNeeds) elNeeds.textContent = String(needsReview);
  const elLast = document.getElementById("last-synced");
  if (elLast) elLast.textContent = state.lastSynced ? formatLocalTime(state.lastSynced) : "-";

  recomputeShelfItems();
  ensureShelvesDom();
  for (const shelfName of shelves) {
    const el = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-count]`);
    if (!el) continue;
    const count = state.shelfItems.filter((it) => it && it.statusBucket === shelfName).length;
    el.textContent = String(count);
  }
}

function renderInbox() {
  const root = document.getElementById("inbox-items");
  root.innerHTML = "";
  for (const item of state.inboxItems.slice().reverse()) {
    const el = document.createElement("div");
    el.className = "item";
    const title = guessTitle(item.payload);
    el.innerHTML = `
      <div class="item__title"></div>
      <div class="item__meta">
        <span class="pill"></span>
        <span class="pill"></span>
      </div>
    `;
    el.querySelector(".item__title").textContent = title;
    const pills = el.querySelectorAll(".pill");
    pills[0].textContent = item.payload.kind.toUpperCase();
    pills[1].textContent = formatLocalTime(item.createdAt);
    root.appendChild(el);
  }
}

function renderShelves() {
  recomputeShelfItems();
  ensureShelvesDom();
  for (const shelfName of shelves) {
    const body = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-body]`);
    if (!body) continue;
    body.innerHTML = "";
    const items = state.shelfItems.filter((it) => it && it.statusBucket === shelfName).slice().reverse();
    for (const shelfItem of items) {
      const card = document.createElement("div");
      card.className = "card";
      const alerts = Array.isArray(shelfItem.alerts) ? shelfItem.alerts : [];
      const hasSevereAlert = alerts.some((a) => a && (a.severity === "high" || a.severity === "critical"));
      if (hasSevereAlert) card.classList.add("card--incident");
      card.dataset.id = shelfItem.id;
      card.innerHTML = `<div class="card__title"></div><div class="card__body"></div><div class="card__badges"></div>`;
      card.querySelector(".card__title").textContent = shelfItem.title;
      card.querySelector(".card__body").textContent = shelfItem.subtitle || "";
      const badgesEl = card.querySelector(".card__badges");
      if (badgesEl && alerts.length) {
        for (const a of alerts) {
          if (!a || !a.label) continue;
          const pill = document.createElement("span");
          pill.className = `pill pill--mini ${a.severity ? `pill--${a.severity}` : ""}`.trim();
          pill.textContent = a.label;
          badgesEl.appendChild(pill);
        }
      }
      card.addEventListener("click", () => {
        const caseId = Array.isArray(shelfItem.sourceCaseIds) ? shelfItem.sourceCaseIds[0] : "";
        const tc = caseId ? getTradeCaseById(caseId) : null;
        if (!tc) return;
        // TODO: Lens item（SI/INV/BL/Supplier/Incident）ごとの専用詳細ビューを追加する（現状は sourceCaseIds[0] を開く）
        openTradeCaseDetail(tc);
      });
      body.appendChild(card);
    }
  }
}

function addItem(payload) {
  const createdAt = nowIso();
  const id = shortId();
  state.inboxItems.push({ id, createdAt, payload });
  // record last synced time for ingestion status
  state.lastSynced = createdAt;

  const title = guessTitle(payload);
  updateCounts();
  renderInbox();

  log(`投入: 「${title}」→ Inbox に格納`);
}

function openModal({ title, bodyText, bodyHtml }) {
  const modal = document.getElementById("modal");
  const modalTitle = modal.querySelector(".modal__title");
  const modalBody = document.getElementById("modal-body");
  if (modalTitle) modalTitle.textContent = title || "案件詳細";
  if (typeof bodyHtml === "string") {
    modalBody.innerHTML = bodyHtml;
  } else {
    modalBody.textContent = bodyText;
  }
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  state.modalTradeCaseId = null;
  state.activeContextDrawer = null;
}

function openWorkspaceModal(modalId, { title, bodyHtml, tradeCaseId }) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  const modalTitle = modal.querySelector(".modal__title");
  const body = modal.querySelector(".modal__body");
  if (modalTitle) modalTitle.textContent = title || "";
  if (body) body.innerHTML = typeof bodyHtml === "string" ? bodyHtml : "";
  // Workspace modal body is interactive; keep the currently opened tradeCase id on the modal.
  const idToSet = tradeCaseId || state.modalTradeCaseId;
  if (idToSet) modal.setAttribute("data-tradecase-id", String(idToSet));
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeWorkspaceModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  modal.removeAttribute("data-tradecase-id");
}

function isAnyWorkspaceModalOpen() {
  const shipment = document.getElementById("shipment-workspace-modal");
  const si = document.getElementById("si-workspace-modal");
  return Boolean((shipment && shipment.classList.contains("is-open")) || (si && si.classList.contains("is-open")));
}

function getWorkspaceUi(modalId) {
  if (!state.workspaceUiByModalId[modalId]) {
    state.workspaceUiByModalId[modalId] = { activeDocId: null, activePageByDocId: {}, zoomByDocId: {}, showMarkers: true };
  }
  return state.workspaceUiByModalId[modalId];
}

function ensureWorkspaceUiDefaults(modalId, documents) {
  const ui = getWorkspaceUi(modalId);
  const docIds = Array.isArray(documents) ? documents.map((d) => d && d.id).filter(Boolean) : [];
  if (!docIds.length) return ui;

  // keep activeDocId if still valid; otherwise pick the first available doc
  if (!ui.activeDocId || !docIds.includes(ui.activeDocId)) ui.activeDocId = docIds[0];

  for (const id of docIds) {
    if (typeof ui.activePageByDocId[id] !== "number") ui.activePageByDocId[id] = 0;
    if (typeof ui.zoomByDocId[id] !== "number") ui.zoomByDocId[id] = 100;
  }
  return ui;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function renderDocumentViewer(documents, { modalId, viewerKey }) {
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const ui = ensureWorkspaceUiDefaults(modalId, docs);
  const activeDoc = docs.find((d) => d && d.id === ui.activeDocId) || docs[0] || null;
  const activeDocId = activeDoc ? activeDoc.id : null;

  const tabsHtml = `
    <div class="document-tabs" role="tablist" aria-label="Documents">
      ${docs
        .map((d) => {
          const isActive = Boolean(activeDocId && d.id === activeDocId);
          const label = d.label || d.id;
          const isMissing = d.status === "missing";
          return `<button class="document-tab ${isActive ? "is-active" : ""} ${isMissing ? "is-missing" : ""}" type="button" role="tab"
            aria-selected="${isActive ? "true" : "false"}"
            data-doc-tab="${escapeHtml(d.id)}"
            data-workspace-viewer="${escapeHtml(viewerKey)}"
          >${escapeHtml(label)}${isMissing ? ` <span class="pill pill--mini pill--warn">missing</span>` : ""}</button>`;
        })
        .join("")}
    </div>
  `;

  const pageCount = activeDoc && Array.isArray(activeDoc.mockPages) ? activeDoc.mockPages.length : 1;
  const activePageIdxRaw = activeDocId ? ui.activePageByDocId[activeDocId] : 0;
  const activePageIdx = clamp(typeof activePageIdxRaw === "number" ? activePageIdxRaw : 0, 0, Math.max(0, pageCount - 1));
  if (activeDocId) ui.activePageByDocId[activeDocId] = activePageIdx;

  const zoomRaw = activeDocId ? ui.zoomByDocId[activeDocId] : 100;
  const zoom = clamp(typeof zoomRaw === "number" ? zoomRaw : 100, 80, 160);
  if (activeDocId) ui.zoomByDocId[activeDocId] = zoom;

  const showMarkers = ui.showMarkers !== false;

  let pageHtml = `<div class="paper-page"><div class="muted">No document</div></div>`;
  let markersHtml = "";
  if (activeDoc) {
    if (activeDoc.status === "missing") {
      pageHtml = `
        <div class="paper-page">
          <div class="paper-page__title">PACKING LIST</div>
          <div class="paper-page__sub">Status: <span class="pill pill--mini pill--warn">Missing</span></div>
          <div class="paper-page__block">
            <div class="paper-annotation">
              <div class="paper-annotation__title">AI Note</div>
              <div class="paper-annotation__body">Packing List has not been received. Customs preparation may be blocked.</div>
            </div>
          </div>
        </div>
      `;
      const missingMarkers = [
        { kind: "warn", x: 72, y: 18, text: "⚠ PL missing" },
        { kind: "note", x: 14, y: 66, text: "Supplier follow-up" },
      ];
      markersHtml = showMarkers
        ? missingMarkers
            .map((m) => `<div class="paper-marker paper-marker--${escapeHtml(m.kind)}" style="left:${escapeHtml(String(m.x))}%;top:${escapeHtml(String(m.y))}%">${escapeHtml(m.text)}</div>`)
            .join("")
        : "";
    } else {
      const pages = Array.isArray(activeDoc.mockPages) && activeDoc.mockPages.length ? activeDoc.mockPages : [{ title: activeDoc.title || activeDoc.type, rows: [] }];
      const p = pages[activePageIdx] || pages[0];
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const markers = Array.isArray(p.markers) ? p.markers : [];
      markersHtml = showMarkers
        ? markers
            .map((m) => {
              const kind = m && m.kind ? String(m.kind) : "note";
              const x = typeof m?.x === "number" ? m.x : 12;
              const y = typeof m?.y === "number" ? m.y : 12;
              const text = m && m.text ? String(m.text) : "";
              return `<div class="paper-marker paper-marker--${escapeHtml(kind)}" style="left:${escapeHtml(String(x))}%;top:${escapeHtml(String(y))}%">${escapeHtml(text)}</div>`;
            })
            .join("")
        : "";
      pageHtml = `
        <div class="paper-page">
          <div class="paper-page__title">${escapeHtml(p.title || activeDoc.title || activeDoc.type || activeDoc.label || activeDoc.id)}</div>
          ${p.subtitle ? `<div class="paper-page__sub">${escapeHtml(p.subtitle)}</div>` : ""}
          <div class="paper-page__grid">
            ${rows
              .map((r) => {
                const key = r && r.k != null ? String(r.k) : "";
                const value = r && r.v != null ? String(r.v) : "";
                const note = r && r.note ? String(r.note) : "";
                const warn = r && r.warn ? String(r.warn) : "";
                return `<div class="paper-row">
                  <div class="paper-row__k">${escapeHtml(key)}</div>
                  <div class="paper-row__v">${escapeHtml(value)}${warn ? ` <span class="pill pill--mini pill--warn">${escapeHtml(warn)}</span>` : ""}</div>
                  ${note ? `<div class="paper-row__note">${escapeHtml(note)}</div>` : ""}
                </div>`;
              })
              .join("")}
          </div>
          ${
            p.annotation
              ? `<div class="paper-annotation">
                  <div class="paper-annotation__title">Annotation</div>
                  <div class="paper-annotation__body">${escapeHtml(p.annotation)}</div>
                </div>`
              : ""
          }
          ${markersHtml ? `<div class="paper-overlay" aria-hidden="true">${markersHtml}</div>` : ""}
        </div>
      `;
    }
  }

  const thumbsHtml = `
    <div class="page-thumbs" aria-label="Page thumbnails">
      ${Array.from({ length: pageCount })
        .map((_, idx) => {
          const isActive = idx === activePageIdx;
          return `<button class="page-thumb ${isActive ? "is-active" : ""}" type="button"
            data-doc-thumb="${idx}"
            data-workspace-viewer="${escapeHtml(viewerKey)}"
            aria-label="page ${idx + 1}"
          ><span class="page-thumb__num">${idx + 1}</span></button>`;
        })
        .join("")}
    </div>
  `;

  const toolsHtml = `
    <div class="document-tools" aria-label="Viewer tools">
      <button class="btn btn--ghost btn--mini" type="button" data-doc-zoom="-10" data-workspace-viewer="${escapeHtml(viewerKey)}" aria-label="Zoom out">−</button>
      <div class="document-tools__zoom">${zoom}%</div>
      <button class="btn btn--ghost btn--mini" type="button" data-doc-zoom="10" data-workspace-viewer="${escapeHtml(viewerKey)}" aria-label="Zoom in">＋</button>
      <button class="btn btn--ghost btn--mini" type="button" data-doc-marker-toggle="1" data-workspace-viewer="${escapeHtml(viewerKey)}" aria-label="Toggle annotations">${showMarkers ? "Annotations: ON" : "Annotations: OFF"}</button>
    </div>
  `;

  const controlsHtml = `
    <div class="page-controls">
      <button class="btn btn--ghost btn--mini" type="button" data-doc-prev="1" data-workspace-viewer="${escapeHtml(viewerKey)}" ${activePageIdx <= 0 ? "disabled" : ""}>前のページ</button>
      <div class="page-controls__count">page ${activePageIdx + 1} / ${pageCount}</div>
      <button class="btn btn--ghost btn--mini" type="button" data-doc-next="1" data-workspace-viewer="${escapeHtml(viewerKey)}" ${activePageIdx >= pageCount - 1 ? "disabled" : ""}>次のページ</button>
    </div>
  `;

  return `
    <div class="document-viewer" data-doc-viewer="${escapeHtml(viewerKey)}">
      <div class="document-viewer__top">
        ${tabsHtml}
        ${toolsHtml}
      </div>
      <div class="document-stage" role="region" aria-label="Document stage">
        ${thumbsHtml}
        <div class="paper-viewport">
          <div class="paper-document" role="document" aria-label="Document page" style="--paper-zoom:${escapeHtml(String(zoom / 100))}">
            ${pageHtml}
          </div>
        </div>
      </div>
      ${controlsHtml}
    </div>
  `;
}

function buildShipmentWorkspaceDocuments(tradeCase) {
  const sh = tradeCase && tradeCase.shipmentEntity ? tradeCase.shipmentEntity : null;
  const si = tradeCase && tradeCase.siEntity ? tradeCase.siEntity : null;
  const incidents = detectIncidents(tradeCase);
  const mismatch = incidents.find((i) => i && i.type === "invoiceQuantityMismatch") || null;
  const details = mismatch && mismatch.details && typeof mismatch.details === "object" ? mismatch.details : null;
  const siQty = typeof details?.siQuantity === "number" ? details.siQuantity : null;
  const invQty = typeof details?.invoiceQuantity === "number" ? details.invoiceQuantity : null;

  return [
    {
      id: "inv-1122",
      label: "INV-1122",
      type: "Invoice",
      title: "Commercial Invoice",
      mockPages: [
        {
          title: "COMMERCIAL INVOICE",
          subtitle: "Mock / paper view",
          rows: [
            { k: "Invoice No", v: "INV-1122" },
            { k: "Supplier", v: "ACME Components (Shenzhen)" },
            { k: "SI No", v: si?.siNo || "SI-2026-001" },
            { k: "BL", v: sh?.blNo || "BL-SZX-7781" },
            { k: "Item", v: "UC-1M-BK" },
            { k: "Qty", v: invQty != null ? `${invQty} pcs` : "400 pcs", warn: siQty != null && invQty != null && siQty !== invQty ? `⚠ SI ${siQty}pcs` : "" },
            { k: "Amount", v: "USD 12,800.00" },
          ],
          annotation: siQty != null && invQty != null && siQty !== invQty ? "⚠ Quantity mismatch detected" : "",
          markers:
            siQty != null && invQty != null && siQty !== invQty
              ? [
                  { kind: "warn", x: 72, y: 34, text: "⚠ Qty mismatch" },
                  { kind: "note", x: 16, y: 72, text: "Confirm split shipment?" },
                ]
              : [{ kind: "note", x: 16, y: 72, text: "Check customer impact" }],
        },
      ],
    },
    {
      id: "pl-missing",
      label: "PL",
      type: "Packing List",
      status: "missing",
    },
    {
      id: "bl-szx-7781",
      label: "BL-SZX-7781",
      type: "B/L",
      title: "Bill of Lading",
      mockPages: [
        {
          title: "BILL OF LADING",
          subtitle: "Mock / paper view",
          rows: [
            { k: "B/L No", v: sh?.blNo || "BL-SZX-7781" },
            { k: "Booking No", v: sh?.bookingNo || "BK-44521" },
            { k: "Container", v: sh?.containerNo || "TCLU1234567" },
            { k: "ETD", v: sh?.etd || "2026-05-03" },
            { k: "ETA", v: sh?.eta || "2026-05-10" },
            { k: "POL → POD", v: "Shenzhen → Tokyo" },
          ],
          markers: [{ kind: "pin", x: 18, y: 18, text: "Vessel schedule" }],
        },
      ],
    },
  ];
}

function buildSiWorkspaceDocuments(tradeCase) {
  const si = tradeCase && tradeCase.siEntity ? tradeCase.siEntity : null;
  const salesCommitments = Array.isArray(tradeCase?.decisionContext?.salesCommitments) ? tradeCase.decisionContext.salesCommitments : [];
  const first = salesCommitments[0] || null;

  return [
    {
      id: "si-2026-001",
      label: "SI-2026-001",
      type: "Shipping Instruction",
      title: "Shipping Instruction",
      mockPages: [
        {
          title: "SHIPPING INSTRUCTION",
          subtitle: "Mock / paper view",
          rows: [
            { k: "SI No", v: si?.siNo || "SI-2026-001" },
            { k: "Requested delivery", v: si?.requestedDeliveryDate || "2026-05-20" },
            { k: "Customer", v: first?.customerName || "Example Customer" },
            { k: "SKU", v: first?.sku || "UC-1M-BK" },
            { k: "Qty", v: first?.committedQty != null ? `${first.committedQty} pcs` : "1000 pcs" },
          ],
          markers: [
            { kind: "pin", x: 18, y: 26, text: "Customer delivery date" },
            { kind: "note", x: 66, y: 72, text: "Split shipment decision" },
          ],
        },
      ],
    },
    {
      id: "sales-commitment",
      label: "売約表",
      type: "Sales Commitment",
      title: "Sales Commitment",
      mockPages: [
        {
          title: "売約表（Mock）",
          subtitle: "Sales commitment sheet",
          rows: [
            { k: "Customer", v: first?.customerName || "Example Customer" },
            { k: "SKU", v: first?.sku || "UC-1M-BK" },
            { k: "Committed Qty", v: first?.committedQty != null ? String(first.committedQty) : "1000" },
            { k: "Delivery date", v: first?.requestedDeliveryDate || si?.requestedDeliveryDate || "2026-05-20" },
          ],
          markers: [{ kind: "warn", x: 70, y: 38, text: "⚠ Delivery risk?" }],
        },
      ],
    },
    {
      id: "sales-response",
      label: "営業回答",
      type: "Sales Response",
      title: "Sales Response",
      mockPages: [
        {
          title: "営業回答（Mock）",
          subtitle: "Short notes only",
          rows: [
            { k: "Answer", v: "分納でも可。AIR希望の可能性あり。" },
            { k: "Customer impact", v: "納期遅延は要事前連絡。" },
          ],
        },
      ],
    },
  ];
}

function renderShipmentWorkspace(tradeCase) {
  const sh = tradeCase && tradeCase.shipmentEntity ? tradeCase.shipmentEntity : null;
  const si = tradeCase && tradeCase.siEntity ? tradeCase.siEntity : null;
  const incidents = detectIncidents(tradeCase).filter((i) => i && i.status !== "resolved");

  const invs = uniqStrings([...(sh?.supplierInvoices || []), ...(sh?.switchInvoices || [])]);
  const invHtml = invs.length ? invs.map((x) => `<span class="pill pill--mini">${escapeHtml(x)}</span>`).join("") : `<span class="muted">-</span>`;

  const docStatus = Array.isArray(tradeCase?.decisionContext?.documentStatus) ? tradeCase.decisionContext.documentStatus : [];
  const docSummaryHtml = docStatus.length
    ? `<div class="doc-summary">${docStatus
        .map((d) => {
          const dt = d && d.docType ? String(d.docType) : "Doc";
          const st = d && d.status ? String(d.status) : "-";
          const isMissing = st.toLowerCase().includes("missing") || st.toLowerCase().includes("not");
          return `<span class="pill pill--mini ${isMissing ? "pill--warn" : "pill--muted"}">${escapeHtml(dt)}: ${escapeHtml(st)}</span>`;
        })
        .join("")}</div>`
    : `<div class="muted">-</div>`;

  const riskHtml = incidents.length
    ? `<ul class="list">${incidents.map((i) => `<li>${escapeHtml(incidentTitleJa(i))} <span class="muted">(${escapeHtml(i.severity || "low")})</span></li>`).join("")}</ul>`
    : `<div class="muted">(no active risks)</div>`;

  const documents = buildShipmentWorkspaceDocuments(tradeCase);
  const viewerHtml = renderDocumentViewer(documents, { modalId: "shipment-workspace-modal", viewerKey: "shipment" });

  const aiNotes = [
    incidents.some((i) => i.type === "invoiceQuantityMismatch") ? "INV数量がSIと一致していません" : null,
    docStatus.some((d) => String(d.docType || "").toLowerCase().includes("packing") && String(d.status || "").toLowerCase().includes("missing"))
      ? "PLが未着です"
      : "PLが未着です（mock）",
    sh?.blNo ? "BLはBooking情報と紐づいています" : null,
  ].filter(Boolean);

  return `
    <div class="workspace-desk">
      <div class="workspace-layout">
        <aside class="workspace-pane workspace-pane--left" aria-label="Shipment context">
          <div class="workspace-section">
            <div class="workspace-section__title">貨物 / 基本情報</div>
            <div class="workspace-kv">
              <div><span class="muted">Shipment</span> <span class="mono">${escapeHtml(sh?.id || "-")}</span></div>
              <div><span class="muted">Booking</span> <span class="mono">${escapeHtml(sh?.bookingNo || "-")}</span></div>
              <div><span class="muted">BL</span> <span class="mono">${escapeHtml(sh?.blNo || "-")}</span></div>
              <div><span class="muted">Container</span> <span class="mono">${escapeHtml(sh?.containerNo || "-")}</span></div>
              <div><span class="muted">ETD</span> <span class="mono">${escapeHtml(sh?.etd || "-")}</span></div>
              <div><span class="muted">ETA</span> <span class="mono">${escapeHtml(sh?.eta || "-")}</span></div>
            </div>
          </div>

          <div class="workspace-section">
            <div class="workspace-section__title">書類 / 関連INV</div>
            <div class="case-cover__meta">${invHtml}</div>
            ${docSummaryHtml}
          </div>

          <div class="workspace-section">
            <div class="workspace-section__title">Related</div>
            <div class="workspace-kv">
              <div><span class="muted">Case</span> <span class="mono">${escapeHtml(tradeCase?.id || "-")}</span></div>
              <div><span class="muted">Related SI</span> <span class="mono">${escapeHtml(si?.siNo || "-")}</span></div>
            </div>
          </div>
        </aside>

        <main class="workspace-pane workspace-pane--center" aria-label="Document viewer">
          ${viewerHtml}
        </main>

        <aside class="workspace-pane workspace-pane--right" aria-label="Decision helper">
          <div class="workspace-section">
            <div class="workspace-section__title">AI Notes</div>
            ${aiNotes.length ? `<ul class="list">${aiNotes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<div class="muted">-</div>`}
          </div>
          <div class="workspace-section">
            <div class="workspace-section__title">Delivery risk</div>
            ${riskHtml}
          </div>
          <div class="workspace-section">
            <div class="workspace-section__title">Human memo</div>
            <div class="muted">（mock）短文メモだけ。長文は Case detail に集約。</div>
          </div>
        </aside>
      </div>
      <div class="workspace-role-note">
        <span class="muted">UI note:</span> Shipment Workspace は「貨物と船積書類を見る」。問題と判断は Case detail に集約する。
      </div>
    </div>
  `;
}

function renderSiWorkspace(tradeCase) {
  const si = tradeCase && tradeCase.siEntity ? tradeCase.siEntity : null;
  const salesCommitments = Array.isArray(tradeCase?.decisionContext?.salesCommitments) ? tradeCase.decisionContext.salesCommitments : [];
  const commitmentsHtml = salesCommitments.length
    ? `<ul class="list">${salesCommitments
        .map(
          (x) =>
            `<li><span class="pill pill--mini pill--muted">${escapeHtml(x.customerName)}</span> <span class="mono">${escapeHtml(
              x.sku,
            )}</span> qty ${escapeHtml(String(x.committedQty))} / delivery <span class="mono">${escapeHtml(x.requestedDeliveryDate)}</span></li>`,
        )
        .join("")}</ul>`
    : `<div class="muted">(none)</div>`;

  const owners = uniqStrings(si?.salesOwners || []);
  const ownersHtml = owners.length ? owners.map((x) => `<span class="pill pill--mini">${escapeHtml(x)}</span>`).join("") : `<span class="muted">-</span>`;

  const relatedShipments = uniqStrings(si?.relatedShipmentIds || []);
  const relatedInvoices = uniqStrings(si?.relatedInvoiceNos || []);

  const documents = buildSiWorkspaceDocuments(tradeCase);
  const viewerHtml = renderDocumentViewer(documents, { modalId: "si-workspace-modal", viewerKey: "si" });

  const incidents = detectIncidents(tradeCase).filter((i) => i && i.status !== "resolved");

  const aiNotes = [
    si?.requestedDeliveryDate ? `顧客納期: ${si.requestedDeliveryDate}` : null,
    relatedShipments.length ? "関連Shipmentを確認してください" : null,
    relatedInvoices.length ? "関連INVを照合してください" : null,
  ].filter(Boolean);

  const riskNotes = [
    incidents.some((i) => i.type === "invoiceQuantityMismatch") ? "⚠ 数量差異あり（INV/SI）" : null,
    "⚠ 顧客納期回答が未確定（mock）",
  ].filter(Boolean);

  return `
    <div class="workspace-desk">
      <div class="workspace-layout">
        <aside class="workspace-pane workspace-pane--left" aria-label="SI summary">
          <div class="workspace-section">
            <div class="workspace-section__title">SI summary</div>
            <div class="workspace-kv">
              <div><span class="muted">SI No</span> <span class="mono">${escapeHtml(si?.siNo || "-")}</span></div>
              <div><span class="muted">顧客納期</span> <span class="mono">${escapeHtml(si?.requestedDeliveryDate || "-")}</span></div>
              <div><span class="muted">営業担当</span> <span class="case-cover__meta">${ownersHtml}</span></div>
            </div>
          </div>

          <div class="workspace-section">
            <div class="workspace-section__title">売約 / 営業回答</div>
            <details class="accordion">
              <summary class="accordion__summary">売約</summary>
              <div class="accordion__body">${commitmentsHtml}</div>
            </details>
          </div>

          <div class="workspace-section">
            <div class="workspace-section__title">分納状況</div>
            <div class="muted">（mock）INV 分納や次便紐付けの判断履歴をここに集約する</div>
          </div>

          <div class="workspace-section">
            <div class="workspace-section__title">Related</div>
            <details class="accordion">
              <summary class="accordion__summary">Related shipments / invoices</summary>
              <div class="accordion__body">
                <div class="muted" style="margin-bottom:6px;">Shipments</div>
                ${relatedShipments.length ? `<div class="case-cover__meta">${relatedShipments.map((x) => `<span class="pill pill--mini">${escapeHtml(x)}</span>`).join("")}</div>` : `<div class="muted">-</div>`}
                <div class="muted" style="margin:10px 0 6px;">Invoices</div>
                ${relatedInvoices.length ? `<div class="case-cover__meta">${relatedInvoices.map((x) => `<span class="pill pill--mini">${escapeHtml(x)}</span>`).join("")}</div>` : `<div class="muted">-</div>`}
              </div>
            </details>
          </div>
        </aside>

        <main class="workspace-pane workspace-pane--center" aria-label="SI documents">
          ${viewerHtml}
        </main>

        <aside class="workspace-pane workspace-pane--right" aria-label="Decision helper">
          <div class="workspace-section">
            <div class="workspace-section__title">AI Notes</div>
            ${aiNotes.length ? `<ul class="list">${aiNotes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<div class="muted">-</div>`}
          </div>
          <div class="workspace-section">
            <div class="workspace-section__title">Delivery risk</div>
            ${riskNotes.length ? `<ul class="list">${riskNotes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<div class="muted">-</div>`}
          </div>
          <div class="workspace-section">
            <div class="workspace-section__title">Human memo</div>
            <div class="muted">（mock）営業コメントは短く。長文は Case detail に集約。</div>
          </div>
        </aside>
      </div>
      <div class="workspace-role-note">
        <span class="muted">UI note:</span> SI Workspace は「販売約束と顧客納期を見る」。問題と判断は Case detail に集約する。
      </div>
    </div>
  `;
}

function renderTradeCaseDetail(tradeCase) {
  const documents = Array.isArray(tradeCase.documents) ? tradeCase.documents : [];
  const timeline = Array.isArray(tradeCase.timeline) ? tradeCase.timeline : [];
  const incidents = detectIncidents(tradeCase);
  const nextActions = proposeActions(tradeCase, incidents).map((p) => {
    const approvalStatus = state.proposalApprovalStatusById[p.id] || p.approvalStatus || "pendingApproval";
    const status = approvalStatus === "approved" ? "approved" : p.status;
    return { ...p, approvalStatus, status };
  });

  const supplierName = tradeCase.supplier && tradeCase.supplier.name ? tradeCase.supplier.name : "-";
  const updated = tradeCase.updatedAt ? formatLocalTime(tradeCase.updatedAt) : "-";
  const tradeTypeJa = tradeTypeLabelJa(tradeCase.tradeType);
  const shipmentStateJa = shipmentStateLabelJa(tradeCase.shipmentState);

  const products = Array.isArray(tradeCase.products) ? tradeCase.products : [];
  const primaryProduct = products[0] || null;
  const mismatchIncident = incidents.find((i) => i && i.type === "invoiceQuantityMismatch") || null;
  const mismatchDetails = mismatchIncident && mismatchIncident.details && typeof mismatchIncident.details === "object" ? mismatchIncident.details : null;
  const siQuantity =
    typeof mismatchDetails?.siQuantity === "number"
      ? mismatchDetails.siQuantity
      : typeof primaryProduct?.quantityInstructed === "number"
        ? primaryProduct.quantityInstructed
        : null;
  const invoiceQuantity =
    typeof mismatchDetails?.invoiceQuantity === "number"
      ? mismatchDetails.invoiceQuantity
      : typeof primaryProduct?.quantityInvoiced === "number"
        ? primaryProduct.quantityInvoiced
        : null;
  const shortageQuantity =
    typeof siQuantity === "number" && typeof invoiceQuantity === "number" ? Math.max(0, siQuantity - invoiceQuantity) : null;

  const titleText =
    typeof siQuantity === "number" && typeof invoiceQuantity === "number"
      ? `数量差異: SI ${siQuantity}pcs / INV ${invoiceQuantity}pcs`
      : tradeCase.title || `Case ${tradeCase.id}`;
  const subtitleText = `${supplierName} ・ ${tradeTypeJa} ・ ${shipmentStateJa}`;
  const chips = [
    `Case ${tradeCase.id}`,
    typeof siQuantity === "number" ? `SI ${siQuantity}pcs` : null,
    typeof invoiceQuantity === "number" ? `INV ${invoiceQuantity}pcs` : null,
    typeof shortageQuantity === "number" ? `Shortage ${shortageQuantity}pcs` : null,
    updated !== "-" ? `Updated ${updated}` : null,
  ].filter(Boolean);

  const docsHtml = documents.length
    ? documents
        .map(
          (d) =>
            `<li><span class="pill pill--muted">${escapeHtml(d.type)}</span> ${escapeHtml(d.title)} <span class="muted">(${escapeHtml(
              d.source,
            )})</span> ${d.receivedAt ? `<span class="muted">received:${escapeHtml(d.receivedAt)}</span>` : ""}</li>`,
        )
        .join("")
    : "<li class=\"muted\">(none)</li>";

  function renderOperationalEntities(tc) {
    const shipment = tc && tc.shipmentEntity ? tc.shipmentEntity : null;
    const si = tc && tc.siEntity ? tc.siEntity : null;

    const shipRows = shipment
      ? [
          shipment.blNo ? `<div><span class="muted">BL</span> <span class="mono">${escapeHtml(shipment.blNo)}</span></div>` : null,
          shipment.bookingNo ? `<div><span class="muted">Booking</span> <span class="mono">${escapeHtml(shipment.bookingNo)}</span></div>` : null,
          shipment.eta ? `<div><span class="muted">ETA</span> <span class="mono">${escapeHtml(shipment.eta)}</span></div>` : null,
        ].filter(Boolean)
      : [];

    const siRows = si
      ? [
          si.siNo ? `<div><span class="muted">SI</span> <span class="mono">${escapeHtml(si.siNo)}</span></div>` : null,
          si.requestedDeliveryDate
            ? `<div><span class="muted">Delivery</span> <span class="mono">${escapeHtml(si.requestedDeliveryDate)}</span></div>`
            : null,
        ].filter(Boolean)
      : [];

    if (!shipment && !si) return "";

    return `<section class="detail-section">
      <h3 class="detail-section__title">Operational Entities / 関連主体</h3>
      <div class="detail-block">
        <div class="detail-subhead">Shipment</div>
        ${shipment ? `<div class="detail__meta">${shipRows.join("") || `<div class="muted">-</div>`}</div>` : `<div class="muted">(none)</div>`}
        ${
          shipment
            ? `<div class="action-row"><button class="btn btn--primary" type="button" data-open-shipment-workspace="1">Shipment Workspace を開く</button></div>`
            : ""
        }
      </div>
      <div class="detail-block">
        <div class="detail-subhead">SI</div>
        ${si ? `<div class="detail__meta">${siRows.join("") || `<div class="muted">-</div>`}</div>` : `<div class="muted">(none)</div>`}
        ${si ? `<div class="action-row"><button class="btn btn--primary" type="button" data-open-si-workspace="1">SI Workspace を開く</button></div>` : ""}
      </div>
    </section>`;
  }

  function incidentTypeLabel(type) {
    const t = String(type || "");
    const map = {
      invoiceQuantityMismatch: "数量差異（INVとSI）",
      missingDocument: "書類不足",
      confirmQuantity: "数量確認が必要",
      shippingPending: "出荷手配待ち",
      supplierNoResponse: "サプライヤー未返信",
    };
    return map[t] || t;
  }

  function riskFromIncidents(list) {
    const severities = (Array.isArray(list) ? list : []).map((i) => String(i && i.severity ? i.severity : "").toLowerCase());
    if (severities.includes("critical")) return "CRITICAL";
    if (severities.includes("high")) return "HIGH";
    if (severities.includes("medium")) return "MEDIUM";
    if (severities.includes("low")) return "LOW";
    return "LOW";
  }

  function severityClass(risk) {
    const r = String(risk || "").toUpperCase();
    if (r === "CRITICAL") return "pill--critical";
    if (r === "HIGH") return "pill--high";
    if (r === "MEDIUM") return "pill--medium";
    return "pill--low";
  }

  function renderDecisionContext(decisionContext) {
    if (!decisionContext) return `<div class="muted">(no decision context)</div>`;

    const inventory = Array.isArray(decisionContext.inventory) ? decisionContext.inventory : [];
    const salesCommitments = Array.isArray(decisionContext.salesCommitments) ? decisionContext.salesCommitments : [];
    const inboundPlans = Array.isArray(decisionContext.inboundPlans) ? decisionContext.inboundPlans : [];
    const similarPastCases = Array.isArray(decisionContext.similarPastCases) ? decisionContext.similarPastCases : [];
    const supplierReliability = decisionContext.supplierReliability || null;
    const agentRecommendation = decisionContext.agentRecommendation || null;

    const availableBySku = Object.create(null);
    for (const inv of inventory) {
      const sku = String(inv && inv.sku ? inv.sku : "");
      if (!sku) continue;
      const available = typeof inv.availableQty === "number" ? inv.availableQty : 0;
      availableBySku[sku] = (availableBySku[sku] || 0) + available;
    }

    const committedBySku = Object.create(null);
    for (const sc of salesCommitments) {
      const sku = String(sc && sc.sku ? sc.sku : "");
      if (!sku) continue;
      const qty = typeof sc.committedQty === "number" ? sc.committedQty : 0;
      committedBySku[sku] = (committedBySku[sku] || 0) + qty;
    }

    const skuInsights = uniqStrings([...Object.keys(availableBySku), ...Object.keys(committedBySku)]).map((sku) => {
      const available = availableBySku[sku] || 0;
      const committed = committedBySku[sku] || 0;
      const shortage = Math.max(0, committed - available);
      return { sku, available, committed, shortage };
    });

    const skuInsightHtml = skuInsights.length
      ? `<div class="decision-context__insights">
          ${skuInsights
            .map((x) => {
              const ok = x.shortage <= 0;
              const badge = ok
                ? `<span class="pill pill--mini pill--ok">OK</span>`
                : `<span class="pill pill--mini pill--warn">不足</span>`;
              const msg = ok
                ? `available ${x.available} / committed ${x.committed}`
                : `available ${x.available} / committed ${x.committed} / shortage ${x.shortage}`;
              return `<div class="decision-context__insight">${badge}<span class="mono">${escapeHtml(x.sku)}</span><span class="muted">${escapeHtml(
                msg,
              )}</span></div>`;
            })
            .join("")}
        </div>`
      : "";

    const inventoryHtml = inventory.length
      ? `<div class="evidence-table">
          ${inventory
            .map((x) => {
              const updatedAt = x.updatedAt ? formatLocalTime(x.updatedAt) : "-";
              return `<div class="evidence-row">
                <div class="evidence-row__main"><span class="mono">${escapeHtml(x.sku)}</span> <span class="muted">${escapeHtml(
                x.productName || "",
              )}</span></div>
                <div class="evidence-row__meta muted">onHand ${escapeHtml(String(x.onHandQty))} / allocated ${escapeHtml(
                String(x.allocatedQty),
              )} / available <strong>${escapeHtml(String(x.availableQty))}</strong></div>
                <div class="evidence-row__meta muted">${escapeHtml(x.warehouse || "-")} ・ ${escapeHtml(updatedAt)}</div>
              </div>`;
            })
            .join("")}
        </div>`
      : `<div class="muted">(none)</div>`;

    const salesHtml = salesCommitments.length
      ? `<div class="evidence-table">
          ${salesCommitments
            .map((x) => {
              const pr = String(x.priority || "medium");
              const prBadge =
                pr === "high"
                  ? `<span class="pill pill--mini pill--critical">HIGH</span>`
                  : pr === "low"
                    ? `<span class="pill pill--mini pill--muted">LOW</span>`
                    : `<span class="pill pill--mini pill--medium">MED</span>`;
              return `<div class="evidence-row">
                <div class="evidence-row__main">${prBadge} <span class="mono">${escapeHtml(x.sku)}</span> <strong>${escapeHtml(
                String(x.committedQty),
              )}</strong> pcs</div>
                <div class="evidence-row__meta muted">${escapeHtml(x.customerName)} ・ requested ${escapeHtml(
                x.requestedDeliveryDate,
              )}</div>
              </div>`;
            })
            .join("")}
        </div>`
      : `<div class="muted">(none)</div>`;

    const inboundHtml = inboundPlans.length
      ? `<div class="evidence-table">
          ${inboundPlans
            .slice()
            .sort((a, b) => String(a.eta || "").localeCompare(String(b.eta || "")))
            .map((x) => {
              const status = String(x.status || "");
              const statusBadge = status
                ? `<span class="pill pill--mini pill--muted">${escapeHtml(status)}</span>`
                : "";
              const refs = [x.relatedSiNo, x.relatedInvoiceNo, x.relatedBlNo].filter(Boolean).join(" / ");
              return `<div class="evidence-row">
                <div class="evidence-row__main">${statusBadge} <span class="mono">${escapeHtml(x.sku)}</span> <strong>${escapeHtml(
                String(x.qty),
              )}</strong> pcs</div>
                <div class="evidence-row__meta muted">ETA ${escapeHtml(x.eta)}${refs ? ` ・ ${escapeHtml(refs)}` : ""}</div>
              </div>`;
            })
            .join("")}
        </div>`
      : `<div class="muted">(none)</div>`;

    const pastCasesHtml = similarPastCases.length
      ? `<ul class="mini-list">
          ${similarPastCases
            .slice()
            .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            .map((x) => {
              const sim = typeof x.similarity === "number" ? `${Math.round(x.similarity * 100)}%` : "-";
              return `<li><span class="pill pill--mini">${escapeHtml(sim)}</span> ${escapeHtml(x.title)}<div class="muted">${escapeHtml(
                x.issue,
              )}</div><div class="muted">Decision: ${escapeHtml(x.decisionTaken)} / Outcome: ${escapeHtml(x.outcome)}</div></li>`;
            })
            .join("")}
        </ul>`
      : `<div class="muted">(none)</div>`;

    const supplierHtml = supplierReliability
      ? `<div class="detail-block decision-context__supplier">
          <div class="kv">
            <div><span class="muted">supplier</span> ${escapeHtml(supplierReliability.supplierName)}</div>
            <div><span class="muted">onTimeRate</span> ${escapeHtml(String(Math.round(supplierReliability.onTimeRate * 100)))}%</div>
            <div><span class="muted">documentDelayRate</span> ${escapeHtml(
              String(Math.round(supplierReliability.documentDelayRate * 100)),
            )}%</div>
          </div>
          <div class="muted" style="margin-top:8px;">common issues: ${escapeHtml(
            (supplierReliability.commonIssues || []).join(" / ") || "-",
          )}</div>
        </div>`
      : `<div class="muted">(none)</div>`;

    const agentHtml = agentRecommendation
      ? `<div class="detail-block decision-context__agent">
          <div class="decision-context__agent-top">
            <div class="decision-context__agent-summary">${escapeHtml(agentRecommendation.summary || "-")}</div>
            <div class="kv muted" style="margin-top:6px;">
              <div><span class="muted">action</span> ${escapeHtml(agentRecommendation.suggestedActionType || "-")}</div>
              <div><span class="muted">confidence</span> ${escapeHtml(
                String(Math.round((agentRecommendation.confidence || 0) * 100)),
              )}%</div>
            </div>
          </div>
          ${
            Array.isArray(agentRecommendation.reasoning) && agentRecommendation.reasoning.length
              ? `<div class="detail-subhead" style="margin-top:10px;">Reasoning</div><ul class="mini-list">${agentRecommendation.reasoning
                  .map((r) => `<li>${escapeHtml(r)}</li>`)
                  .join("")}</ul>`
              : ""
          }
        </div>`
      : `<div class="muted">(none)</div>`;

    return `
      ${skuInsightHtml}
      <div class="decision-context__grid">
        <div class="decision-context__cell">
          <div class="detail-subhead">Inventory / 在庫</div>
          ${inventoryHtml}
        </div>
        <div class="decision-context__cell">
          <div class="detail-subhead">Sales Commitments / 売約</div>
          ${salesHtml}
        </div>
        <div class="decision-context__cell">
          <div class="detail-subhead">Next Inbound / 次便予定</div>
          ${inboundHtml}
        </div>
        <div class="decision-context__cell">
          <div class="detail-subhead">Similar Past Cases / 類似過去案件</div>
          ${pastCasesHtml}
        </div>
        <div class="decision-context__cell">
          <div class="detail-subhead">Supplier Reliability / 仕入先傾向</div>
          ${supplierHtml}
        </div>
        <div class="decision-context__cell">
          <div class="detail-subhead">Agent Recommendation / AI判断案</div>
          ${agentHtml}
        </div>
      </div>
    `;
  }

  const timelineHtml = timeline.length
    ? timeline
        .map((e) => {
          const at = e && e.at ? formatLocalTime(e.at) : "-";
          const actionLabel = e && e.label ? e.label : e && e.actionType ? e.actionType : "";
          const badge = actionLabel ? ` <span class="pill pill--mini">${escapeHtml(actionLabel)}</span>` : "";
          return `<li><span class="muted">${escapeHtml(at)}</span> ${escapeHtml(e.message || "-")}${badge}</li>`;
        })
        .join("")
    : "<li class=\"muted\">(none)</li>";

  const productsHtml = products.length
    ? products
        .map((p) => {
          const label = [p.sku, p.name, p.id].filter(Boolean).join(" / ");
          const qty = [
            typeof p.quantityOrdered === "number" ? `ordered:${p.quantityOrdered}` : null,
            typeof p.quantityInstructed === "number" ? `SI:${p.quantityInstructed}` : null,
            typeof p.quantityInvoiced === "number" ? `INV:${p.quantityInvoiced}` : null,
          ]
            .filter(Boolean)
            .join(" / ");
          return `<li>${escapeHtml(label)} <span class="muted">(${escapeHtml(qty || "-")})</span></li>`;
        })
        .join("")
    : "<li class=\"muted\">(none)</li>";

  const impactsByIncidentId = new Map();
  for (const incident of incidents) {
    const impact = analyzeImpact(tradeCase, incident);
    if (impact) impactsByIncidentId.set(incident.id, impact);
  }

  const riskLevel = riskFromIncidents(incidents);
  const topIncident =
    incidents
      .slice()
      .sort((a, b) => {
        const order = { critical: 4, high: 3, medium: 2, low: 1 };
        const sa = order[String(a && a.severity ? a.severity : "").toLowerCase()] || 0;
        const sb = order[String(b && b.severity ? b.severity : "").toLowerCase()] || 0;
        if (sb !== sa) return sb - sa;
        const ca = typeof a.confidence === "number" ? a.confidence : -1;
        const cb = typeof b.confidence === "number" ? b.confidence : -1;
        return cb - ca;
      })[0] || null;

  const topImpact = topIncident ? impactsByIncidentId.get(topIncident.id) : null;
  const etaCandidates = Array.from(impactsByIncidentId.values())
    .map((i) => (i && i.nextShipmentEta ? String(i.nextShipmentEta) : ""))
    .filter(Boolean)
    .slice()
    .sort((a, b) => a.localeCompare(b));
  const earliestEta = etaCandidates[0] || "";
  const decisionSummary = {
    riskLevel,
    mainIssue: topIncident ? topIncident.summary : "問題なし（検知なし）",
    recommendedAction: topImpact && topImpact.recommendedDecision ? String(topImpact.recommendedDecision) : "—",
    requiredDecision:
      topImpact && Array.isArray(topImpact.decisionOptions) && topImpact.decisionOptions.length ? "対応方針の選択" : "—",
    eta: topImpact && topImpact.nextShipmentEta ? String(topImpact.nextShipmentEta) : earliestEta || "—",
    confidence: topIncident && typeof topIncident.confidence === "number" ? `${Math.round(topIncident.confidence * 100)}%` : "—",
  };

  function statusClass(approvalStatus, status) {
    const s = approvalStatus || status || "";
    if (s === "approved") return "status-approved";
    if (s === "rejected") return "status-rejected";
    if (s === "executed" || s === "done") return "status-executed";
    if (s === "pendingApproval") return "status-pending";
    return "status-pending";
  }

  function statusLabel(approvalStatus, status) {
    const s = approvalStatus || status || "-";
    if (s === "pendingApproval") return "pending";
    if (s === "approved") return "approved";
    if (s === "rejected") return "rejected";
    if (s === "executed") return "executed";
    if (s === "done") return "done";
    return String(s);
  }

  function scoreDecisionOption(recommendedDecision, option) {
    const rec = String(recommendedDecision || "").toLowerCase();
    const title = String(option && option.title ? option.title : "").toLowerCase();
    const summary = String(option && option.summary ? option.summary : "").toLowerCase();
    let score = 0;
    if (title && rec.includes(title)) score += 3;
    if (summary && rec.includes(summary.slice(0, 16))) score += 1;
    if (title && /(推奨|recommended|link|紐付)/i.test(title) && /(推奨|recommended|link|紐付)/i.test(rec)) score += 1;
    return score;
  }

  function renderDecisionOptions(impact) {
    const options = Array.isArray(impact && impact.decisionOptions) ? impact.decisionOptions : [];
    if (!options.length) return `<div class="muted">(none)</div>`;

    const rec = impact && impact.recommendedDecision ? String(impact.recommendedDecision) : "";
    const sorted = options
      .map((o, idx) => ({ o, idx, score: scoreDecisionOption(rec, o) }))
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx))
      .map((x) => x.o);

    return `<div class="decision-options decision-options--compact">
      ${sorted
        .map((o) => {
          const pros = Array.isArray(o.pros) ? o.pros : [];
          const cons = Array.isArray(o.cons) ? o.cons : [];
          const checks = Array.isArray(o.requiredActions) ? o.requiredActions : [];
          const topPros = pros.slice(0, 2);
          const topCons = cons.slice(0, 2);
          const topChecks = checks.slice(0, 2);
          const badge = scoreDecisionOption(rec, o) > 0 ? `<span class="pill pill--recommended">推奨</span>` : "";
          return `<div class="decision-option">
            <div class="decision-option-title">${badge}${escapeHtml(o.title)}</div>
            <div class="decision-option-meta muted">${escapeHtml(o.summary)}</div>
            <div class="decision-option-badges">
              <span class="badge"><span class="muted">pros</span> ${pros.length}</span>
              <span class="badge"><span class="muted">cons</span> ${cons.length}</span>
              <span class="badge"><span class="muted">checks</span> ${checks.length}</span>
            </div>
            <div class="decision-option-mini">
              ${topPros.length ? `<div><span class="muted">+ </span>${topPros.map((x) => escapeHtml(x)).join(" / ")}</div>` : ""}
              ${topCons.length ? `<div><span class="muted">- </span>${topCons.map((x) => escapeHtml(x)).join(" / ")}</div>` : ""}
              ${topChecks.length ? `<div><span class="muted">✓ </span>${topChecks.map((x) => escapeHtml(x)).join(" / ")}</div>` : ""}
            </div>
          </div>`;
        })
        .join("")}
    </div>`;
  }

  function renderImpactBlock(impact) {
    if (!impact) return `<div class="muted">(none)</div>`;

    const affected = Array.isArray(impact.affectedProducts) ? impact.affectedProducts : [];
    const affectedHtml = affected.length
      ? affected
          .map((p) => {
            const label = [p.sku, p.name, p.productId].filter(Boolean).join(" / ");
            return `<li>${escapeHtml(label)} <span class="muted">(SI:${escapeHtml(
              String(p.siQty ?? "-"),
            )} / INV:${escapeHtml(String(p.invoiceQty ?? "-"))} / shortage:${escapeHtml(String(p.shortageQty ?? "-"))})</span></li>`;
          })
          .join("")
      : "<li class=\"muted\">(none)</li>";

    const summary = impact.summary || impact.customerImpact || "-";
    const rec = impact.recommendedDecision ? String(impact.recommendedDecision) : "-";
    const qty = impact.nextShipmentQty ?? "-";
    const eta = impact.nextShipmentEta ?? "-";
    const risk = impact.deliveryRisk ? String(impact.deliveryRisk) : "-";

    return `<div class="impact">
      <div class="impact__head">
        <span class="pill pill--mini">影響</span>
        <span class="impact__summary">${escapeHtml(summary)}</span>
      </div>
      <div class="impact__rec">
        <div class="kv">
          <span class="muted">Risk</span> ${escapeHtml(risk)}
          <span class="muted">推奨</span> ${escapeHtml(rec)}
          <span class="muted">次便</span> qty:${escapeHtml(String(qty))} / eta:${escapeHtml(String(eta))}
        </div>
      </div>
      <div class="accordion impact__details" data-accordion-root>
        <div class="accordion__item">
          <button class="accordion__trigger" type="button" data-accordion-trigger aria-expanded="false">
            <span class="pill pill--mini">詳細</span>
            <span class="accordion__summary">Affected products / Decision options</span>
          </button>
          <div class="accordion__panel" hidden>
            <div class="detail-subhead">Affected Products</div>
            <ul class="mini-list">${affectedHtml}</ul>
            <div class="detail-subhead">Decision Options（比較）</div>
            ${renderDecisionOptions(impact)}
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderProposals(proposals) {
    if (!Array.isArray(proposals) || proposals.length === 0) return `<div class="muted">(none)</div>`;

    return `<ul class="list proposals">
      ${proposals
        .map((a) => {
          const cls = statusClass(a.approvalStatus, a.status);
          const label = statusLabel(a.approvalStatus, a.status);
          const approveBtn =
            a.approvalStatus === "pendingApproval"
              ? `<button class="btn btn--small" type="button" data-approve-proposal="${escapeHtml(a.id)}">承認</button>`
              : `<span class="muted">承認済み</span>`;
          return `<li class="proposal">
            <div class="proposal__row">
              <div class="proposal__title">${escapeHtml(a.title)}</div>
              <div class="proposal__meta">
                <span class="pill">${escapeHtml(a.type)}</span>
                <span class="pill">${escapeHtml(a.priority)}</span>
                <span class="status-badge ${cls}">${escapeHtml(label)}</span>
                ${approveBtn}
              </div>
            </div>
            <div class="muted">${escapeHtml(a.description)}</div>
          </li>`;
        })
        .join("")}
    </ul>`;
  }

  const incidentAccordionHtml = incidents.length
    ? `<div class="accordion" data-accordion-root>
        ${incidents
          .map((incident) => {
            const impact = impactsByIncidentId.get(incident.id) || null;
            const relatedProposals = proposeActions(tradeCase, [incident]).map((p) => {
              const approvalStatus = state.proposalApprovalStatusById[p.id] || p.approvalStatus || "pendingApproval";
              const status = approvalStatus === "approved" ? "approved" : p.status;
              return { ...p, approvalStatus, status };
            });
            const isOpen = incident.severity === "high" || incident.severity === "critical";
            const confidence = typeof incident.confidence === "number" ? incident.confidence.toFixed(2) : "-";
            const detailsHtml =
              incident.details && typeof incident.details === "object"
                ? `<ul class="mini-list">${Object.entries(incident.details)
                    .map(([k, v]) => `<li><span class="muted">${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</li>`)
                    .join("")}</ul>`
                : `<div class="muted">(none)</div>`;

            return `<div class="accordion__item ${isOpen ? "is-open" : ""}">
              <button class="accordion__trigger" type="button" data-accordion-trigger aria-expanded="${isOpen ? "true" : "false"}">
                <span class="pill pill--incident ${severityClass(incident.severity)}">${escapeHtml(
                  String(incident.severity || "-").toUpperCase(),
                )}</span>
                <span class="pill pill--type">${escapeHtml(incidentTypeLabel(incident.type))}</span>
                <span class="accordion__meta muted">conf:${escapeHtml(confidence)}</span>
                <span class="accordion__summary">${escapeHtml(incident.summary)}</span>
              </button>
              <div class="accordion__panel" ${isOpen ? "" : "hidden"}>
                <div class="detail-subhead">Incident Details</div>
                <div class="detail-block">${detailsHtml}</div>
                <div class="detail-subhead">Impact Analysis</div>
                <div class="detail-block">${renderImpactBlock(impact)}</div>
                <div class="detail-subhead">Action Proposals</div>
                <div class="detail-block">${renderProposals(relatedProposals)}</div>
              </div>
            </div>`;
          })
          .join("")}
      </div>`
    : `<div class="muted">(none)</div>`;

  const affectedProductsAggregate = [];
  for (const impact of impactsByIncidentId.values()) {
    const list = Array.isArray(impact.affectedProducts) ? impact.affectedProducts : [];
    for (const p of list) affectedProductsAggregate.push(p);
  }
  const affectedProductsHtml = affectedProductsAggregate.length
    ? affectedProductsAggregate
        .map((p) => {
          const label = [p.sku, p.name, p.productId].filter(Boolean).join(" / ");
          return `<li>${escapeHtml(label)} <span class="muted">(shortage:${escapeHtml(String(p.shortageQty ?? "-"))})</span></li>`;
        })
        .join("")
    : "<li class=\"muted\">(none)</li>";

  const nextShipmentCandidates = Array.from(impactsByIncidentId.values())
    .map((impact) => ({
      qty: typeof impact.nextShipmentQty === "number" ? impact.nextShipmentQty : 0,
      eta: impact.nextShipmentEta || "",
    }))
    .filter((x) => x.qty > 0 && x.eta);
  const nextShipment = nextShipmentCandidates.length
    ? nextShipmentCandidates.slice().sort((a, b) => String(a.eta).localeCompare(String(b.eta)))[0]
    : null;
  const nextShipmentHtml = nextShipment
    ? `<div class="kv"><span class="muted">qty</span> ${escapeHtml(String(nextShipment.qty))} <span class="muted">eta</span> ${escapeHtml(
        String(nextShipment.eta),
      )}</div>`
    : `<div class="muted">(none)</div>`;

  // Context Drawer should represent a filtered slice from broader operational sources
  // such as inventory table, sales commitments, inbound schedule, and document archive,
  // not only a case-local summary.
  const contextDefs = [
    { key: "inventory", label: "在庫を見る" },
    { key: "salesCommitments", label: "売約を見る" },
    { key: "inboundPlans", label: "次便を見る" },
    { key: "similarPastCases", label: "類似案件を見る" },
    { key: "supplierReliability", label: "仕入先傾向を見る" },
    { key: "stakeholderResponses", label: "営業回答を見る" },
    { key: "documentStatus", label: "書類状況を見る" },
    { key: "freightCost", label: "Freight cost" },
  ];

  function renderContextLauncher(activeKey) {
    return `<div class="context-launcher">
      ${contextDefs
        .map((d) => {
          const isActive = String(activeKey || "") === d.key;
          return `<button class="btn btn--small ${isActive ? "btn--primary" : ""}" type="button" data-context-open="${escapeHtml(
            d.key,
          )}">${escapeHtml(d.label)}</button>`;
        })
        .join("")}
    </div>`;
  }

  function renderDrawerPanel(title, bodyHtml) {
    return renderDrawerPanelV2({ title, headerSummary: "", summaryStripHtml: "", bodyHtml });
  }

  function renderContextSummaryStrip({ key, tradeCase }) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const inventory = Array.isArray(dc && dc.inventory) ? dc.inventory : [];
    const sales = Array.isArray(dc && dc.salesCommitments) ? dc.salesCommitments : [];
    const inbound = Array.isArray(dc && dc.inboundPlans) ? dc.inboundPlans : [];
    const docs = Array.isArray(dc && dc.documentStatus) ? dc.documentStatus : [];
    const stakeholders = Array.isArray(dc && dc.stakeholderResponses) ? dc.stakeholderResponses : [];

    const primarySku = (() => {
      const fromProducts =
        tradeCase && Array.isArray(tradeCase.products) && tradeCase.products[0] && tradeCase.products[0].sku
          ? tradeCase.products[0].sku
          : "";
      const fromInventory = inventory[0] && inventory[0].sku ? inventory[0].sku : "";
      const fromSales = sales[0] && sales[0].sku ? sales[0].sku : "";
      return String(fromProducts || fromInventory || fromSales || "");
    })();

    const fmtQty = (n) => (typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "-");

    if (key === "inventory") {
      const invSku = inventory.filter((x) => x && String(x.sku || "") === primarySku);
      const available = invSku.reduce((sum, x) => sum + (typeof x.availableQty === "number" ? x.availableQty : 0), 0);
      const allocated = invSku.reduce((sum, x) => sum + (typeof x.allocatedQty === "number" ? x.allocatedQty : 0), 0);
      const committed = sales
        .filter((x) => x && String(x.sku || "") === primarySku)
        .reduce((sum, x) => sum + (typeof x.committedQty === "number" ? x.committedQty : 0), 0);
      const shortage = Math.max(0, committed - available);
      return `<div class="context-summary-strip__grid mono">
        <div class="context-summary-strip__k">${escapeHtml(primarySku || "-")}</div>
        <div><span class="muted">available</span> ${escapeHtml(fmtQty(available))}</div>
        <div><span class="muted">allocated</span> ${escapeHtml(fmtQty(allocated))}</div>
        <div><span class="muted">shortage</span> ${escapeHtml(fmtQty(shortage))}</div>
      </div>`;
    }

    if (key === "salesCommitments") {
      const list = sales.filter((x) => x && (!primarySku || String(x.sku || "") === primarySku));
      const committed = list.reduce((sum, x) => sum + (typeof x.committedQty === "number" ? x.committedQty : 0), 0);
      const requested = list
        .map((x) => (x && x.requestedDeliveryDate ? String(x.requestedDeliveryDate) : ""))
        .filter(Boolean)
        .slice()
        .sort()[0];
      return `<div class="context-summary-strip__grid mono">
        <div class="context-summary-strip__k">${escapeHtml(primarySku || "-")}</div>
        <div><span class="muted">requested</span> ${escapeHtml(requested || "-")}</div>
        <div><span class="muted">commit</span> ${escapeHtml(fmtQty(committed))}</div>
        <div><span class="muted">lines</span> ${escapeHtml(String(list.length))}</div>
      </div>`;
    }

    if (key === "inboundPlans") {
      const list = inbound.filter((x) => x && (!primarySku || String(x.sku || "") === primarySku));
      const bookedQty = list
        .filter((x) => String(x.status || "") === "booked")
        .reduce((sum, x) => sum + (typeof x.qty === "number" ? x.qty : 0), 0);
      const eta = list
        .map((x) => (x && x.eta ? String(x.eta) : ""))
        .filter(Boolean)
        .slice()
        .sort()[0];
      return `<div class="context-summary-strip__grid mono">
        <div class="context-summary-strip__k">${escapeHtml(primarySku || "-")}</div>
        <div><span class="muted">ETA</span> ${escapeHtml(eta || "-")}</div>
        <div><span class="muted">booked</span> ${escapeHtml(fmtQty(bookedQty))}</div>
        <div><span class="muted">plans</span> ${escapeHtml(String(list.length))}</div>
      </div>`;
    }

    if (key === "documentStatus") {
      const missing = docs.filter((x) => x && String(x.status || "") === "missing");
      const lastReceived = (() => {
        const tl = Array.isArray(tradeCase && tradeCase.timeline) ? tradeCase.timeline : [];
        const received = tl.filter((e) => e && String(e.type || "") === "documentReceived" && e.at);
        const sorted = received.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return sorted[0] && sorted[0].at ? formatLocalTime(sorted[0].at) : "";
      })();
      return `<div class="context-summary-strip__grid mono">
        <div class="context-summary-strip__k">DOCS</div>
        <div><span class="muted">missing</span> ${escapeHtml(String(missing.length))}</div>
        <div><span class="muted">last received</span> ${escapeHtml(lastReceived || "-")}</div>
        <div><span class="muted">tracked</span> ${escapeHtml(String(docs.length))}</div>
      </div>`;
    }

    if (key === "stakeholderResponses") {
      const total = stakeholders.length;
      const answered = stakeholders.filter((x) => {
        const s = String(x && x.responseStatus ? x.responseStatus : "");
        return s && s !== "確認中" && s !== "未返信";
      }).length;
      const pending = Math.max(0, total - answered);
      return `<div class="context-summary-strip__grid mono">
        <div class="context-summary-strip__k">SALES</div>
        <div><span class="muted">answered</span> ${escapeHtml(String(answered))}</div>
        <div><span class="muted">pending</span> ${escapeHtml(String(pending))}</div>
        <div><span class="muted">total</span> ${escapeHtml(String(total))}</div>
      </div>`;
    }

    return `<div class="context-summary-strip__grid mono">
      <div class="context-summary-strip__k">${escapeHtml(String(key || "Context"))}</div>
      <div class="muted">—</div>
      <div class="muted">—</div>
      <div class="muted">—</div>
    </div>`;
  }

  function renderDrawerPanelV2({ title, headerSummary, summaryStripHtml, bodyHtml }) {
    const summaryHtml = headerSummary ? `<div class="context-drawer__header-summary muted">${escapeHtml(headerSummary)}</div>` : "";
    const stripHtml = summaryStripHtml ? `<div class="context-summary-strip">${summaryStripHtml}</div>` : "";
    return `
      <div class="context-drawer__scroll">
        <div class="context-drawer__header context-drawer-header-sticky">
          <div class="context-drawer__header-top">
            <div class="context-drawer__title">${escapeHtml(title)}</div>
            <button class="btn btn--small btn--ghost" type="button" data-context-close>閉じる</button>
          </div>
          ${summaryHtml}
          ${stripHtml}
        </div>
        <div class="context-drawer__content">
          ${bodyHtml}
        </div>
      </div>
    `;
  }

  function renderDrawerContent(tradeCase, activeKey) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const inventory = Array.isArray(dc && dc.inventory) ? dc.inventory : [];
    const salesCommitments = Array.isArray(dc && dc.salesCommitments) ? dc.salesCommitments : [];
    const inboundPlans = Array.isArray(dc && dc.inboundPlans) ? dc.inboundPlans : [];
    const similarPastCases = Array.isArray(dc && dc.similarPastCases) ? dc.similarPastCases : [];
    const supplierReliability = dc && dc.supplierReliability ? dc.supplierReliability : null;
    const stakeholderResponses = Array.isArray(dc && dc.stakeholderResponses) ? dc.stakeholderResponses : [];
    const documentStatus = Array.isArray(dc && dc.documentStatus) ? dc.documentStatus : [];

    const key = String(activeKey || "");
    if (!key) return "";
    const contextTitleFromKey = (() => {
      const hit = contextDefs.find((d) => d && d.key === key);
      return hit && hit.label ? String(hit.label) : "";
    })();
    const caseSummary = `${tradeCase && tradeCase.id ? tradeCase.id : "Case"}${tradeCase && tradeCase.title ? ` • ${tradeCase.title}` : ""}`;
    const summaryStripHtml = renderContextSummaryStrip({ key, tradeCase });

    if (key === "inventory") {
      const rows = inventory.length
        ? inventory
            .map((inv) => {
              const shortage =
                typeof inv.availableQty === "number" && inv.availableQty < 0 ? Math.abs(inv.availableQty) : null;
              const shortageBadge =
                typeof shortage === "number" && shortage > 0
                  ? `<span class="pill pill--mini pill--high">shortage ${escapeHtml(String(shortage))}</span>`
                  : `<span class="pill pill--mini pill--muted">shortage -</span>`;
              return `<div class="evidence-row">
                <div class="evidence-row__main"><span class="mono">${escapeHtml(inv.sku)}</span> ${escapeHtml(inv.productName)}</div>
                <div class="evidence-row__meta">
                  <div class="kv">
                    <span class="muted">onHandQty</span> ${escapeHtml(String(inv.onHandQty))}
                    <span class="muted">allocatedQty</span> ${escapeHtml(String(inv.allocatedQty))}
                    <span class="muted">availableQty</span> ${escapeHtml(String(inv.availableQty))}
                    ${shortageBadge}
                  </div>
                  <div class="kv">
                    <span class="muted">warehouse</span> ${escapeHtml(inv.warehouse || "-")}
                    <span class="muted">updatedAt</span> ${escapeHtml(inv.updatedAt ? formatLocalTime(inv.updatedAt) : "-")}
                  </div>
                </div>
              </div>`;
            })
            .join("")
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "在庫を見る",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: `<div class="evidence-table">${rows}</div>`,
      });
    }

    if (key === "salesCommitments") {
      const rows = salesCommitments.length
        ? salesCommitments
            .map(
              (x) => `<div class="evidence-row">
                <div class="evidence-row__main">${escapeHtml(x.customerName)} / <span class="mono">${escapeHtml(x.sku)}</span></div>
                <div class="evidence-row__meta">
                  <div class="kv">
                    <span class="muted">committedQty</span> ${escapeHtml(String(x.committedQty))}
                    <span class="muted">requestedDeliveryDate</span> ${escapeHtml(String(x.requestedDeliveryDate || "-"))}
                    <span class="muted">priority</span> <span class="pill pill--mini">${escapeHtml(String(x.priority || "-"))}</span>
                  </div>
                  <div class="muted">${escapeHtml(x.impactNote || "impact note: -")}</div>
                </div>
              </div>`,
            )
            .join("")
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "売約を見る",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: `<div class="evidence-table">${rows}</div>`,
      });
    }

    if (key === "inboundPlans") {
      const rows = inboundPlans.length
        ? inboundPlans
            .map(
              (x) => `<div class="evidence-row">
                <div class="evidence-row__main"><span class="mono">${escapeHtml(x.sku)}</span> qty:${escapeHtml(String(x.qty))}</div>
                <div class="evidence-row__meta">
                  <div class="kv">
                    <span class="muted">eta</span> ${escapeHtml(String(x.eta || "-"))}
                    <span class="muted">status</span> ${escapeHtml(String(x.status || "-"))}
                  </div>
                  <div class="kv">
                    <span class="muted">relatedSiNo</span> ${escapeHtml(String(x.relatedSiNo || "-"))}
                    <span class="muted">relatedInvoiceNo</span> ${escapeHtml(String(x.relatedInvoiceNo || "-"))}
                    <span class="muted">relatedBlNo</span> ${escapeHtml(String(x.relatedBlNo || "-"))}
                  </div>
                </div>
              </div>`,
            )
            .join("")
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "次便を見る",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: `<div class="evidence-table">${rows}</div>`,
      });
    }

    if (key === "similarPastCases") {
      const rows = similarPastCases.length
        ? similarPastCases
            .map(
              (x) => `<div class="evidence-row">
                <div class="evidence-row__main">${escapeHtml(x.title || x.id)}</div>
                <div class="evidence-row__meta">
                  <div class="kv"><span class="muted">similarity</span> ${escapeHtml(String(Math.round((x.similarity || 0) * 100)))}%</div>
                  <div><span class="muted">issue</span> ${escapeHtml(x.issue || "-")}</div>
                  <div><span class="muted">decisionTaken</span> ${escapeHtml(x.decisionTaken || "-")}</div>
                  <div><span class="muted">outcome</span> ${escapeHtml(x.outcome || "-")}</div>
                </div>
              </div>`,
            )
            .join("")
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "類似案件を見る",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: `<div class="evidence-table">${rows}</div>`,
      });
    }

    if (key === "supplierReliability") {
      const html = supplierReliability
        ? `<div class="detail-block">
            <div class="kv">
              <span class="muted">supplierName</span> ${escapeHtml(supplierReliability.supplierName || "-")}
              <span class="muted">onTimeRate</span> ${escapeHtml(String(Math.round((supplierReliability.onTimeRate || 0) * 100)))}%
              <span class="muted">documentDelayRate</span> ${escapeHtml(String(Math.round((supplierReliability.documentDelayRate || 0) * 100)))}%
            </div>
            <div class="detail-subhead">commonIssues</div>
            <ul class="mini-list">${(Array.isArray(supplierReliability.commonIssues) ? supplierReliability.commonIssues : [])
              .map((x) => `<li>${escapeHtml(x)}</li>`)
              .join("")}</ul>
          </div>`
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "仕入先傾向を見る",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: html,
      });
    }

    if (key === "stakeholderResponses") {
      const rows = stakeholderResponses.length
        ? stakeholderResponses
            .map(
              (x) => `<div class="evidence-row">
                <div class="evidence-row__main">${escapeHtml(x.salesRep)} <span class="muted">/</span> ${escapeHtml(x.customer)}</div>
                <div class="evidence-row__meta">
                  <div class="kv">
                    <span class="muted">response status</span> <span class="pill pill--mini">${escapeHtml(x.responseStatus || "-")}</span>
                    <span class="muted">requested action</span> ${escapeHtml(x.requestedAction || "-")}
                    <span class="muted">deadline</span> ${escapeHtml(x.deadline || "-")}
                  </div>
                  <div><span class="muted">escalation rule</span> ${escapeHtml(x.escalationRule || "-")}</div>
                  ${x.aiComment ? `<div><span class="muted">ai comment</span> ${escapeHtml(x.aiComment)}</div>` : ""}
                  ${x.note ? `<div class="muted">${escapeHtml(x.note)}</div>` : ""}
                </div>
              </div>`,
            )
            .join("")
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "営業回答を見る",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: `<div class="evidence-table">${rows}</div>`,
      });
    }

    if (key === "documentStatus") {
      const rows = documentStatus.length
        ? documentStatus
            .map((x) => {
              const pillCls = x.status === "received" ? "pill--low" : "pill--high";
              return `<div class="evidence-row">
                <div class="evidence-row__main"><span class="pill pill--mini">${escapeHtml(x.docType)}</span> <span class="pill pill--mini ${pillCls}">${escapeHtml(
                x.status,
              )}</span></div>
                <div class="evidence-row__meta">${x.riskNote ? `<span class="muted">risk note</span> ${escapeHtml(x.riskNote)}` : `<span class="muted">risk note</span> -`}</div>
              </div>`;
            })
            .join("")
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "書類状況を見る",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: `<div class="evidence-table">${rows}</div>`,
      });
    }

    if (key === "freightCost") {
      return renderDrawerPanelV2({
        title: contextTitleFromKey || "Freight cost",
        headerSummary: caseSummary,
        summaryStripHtml,
        bodyHtml: `<div class="muted">（mock）このケースの見積運賃・AIR切替コスト比較は今後追加予定です。</div>`,
      });
    }

    return renderDrawerPanelV2({
      title: contextTitleFromKey || "Context",
      headerSummary: caseSummary,
      summaryStripHtml,
      bodyHtml: `<div class="muted">(unknown context)</div>`,
    });
  }

  function renderStakeholderCoordinationPreview(tradeCase) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const list = Array.isArray(dc && dc.stakeholderResponses) ? dc.stakeholderResponses : [];
    const affectedSalesCount = list.length;
    const confirmedCount = list.filter((x) => {
      const s = String(x && x.responseStatus ? x.responseStatus : "");
      return s && s !== "確認中" && s !== "未返信";
    }).length;
    const waitingCount = Math.max(0, affectedSalesCount - confirmedCount);

    const deadline = "2026-05-12 15:00";
    const rec = dc && dc.agentRecommendation && dc.agentRecommendation.summary ? dc.agentRecommendation.summary : "—";

    const responseRows = list.length
      ? `<ul class="mini-list">${list
          .map((x) => {
            const status = x && x.responseStatus ? x.responseStatus : "-";
            const action = x && x.requestedAction ? x.requestedAction : "-";
            const ai = x && x.aiComment ? x.aiComment : "";
            return `<li>${escapeHtml(x.salesRep || "-")} <span class="muted">(${escapeHtml(status)} / ${escapeHtml(
              action,
            )})</span>${ai ? ` <span class="muted">—</span> <span class="muted">${escapeHtml(ai)}</span>` : ""}</li>`;
          })
          .join("")}</ul>`
      : `<div class="muted">(no stakeholder responses)</div>`;

    return `<div class="detail-section detail-section--coordination">
      <h3 class="detail-section__title">Stakeholder Coordination / 関係者確認</h3>
      <div class="detail-block">
        <div class="kv">
          <span class="muted">影響営業</span> ${escapeHtml(String(affectedSalesCount))}
          <span class="muted">回答済み</span> ${escapeHtml(String(confirmedCount))}
          <span class="muted">確認中/未返信</span> ${escapeHtml(String(waitingCount))}
          <span class="muted">判断期限</span> ${escapeHtml(deadline)}
        </div>
        <div class="detail-subhead">responses (with AI comment)</div>
        ${responseRows}
        <div class="detail-subhead">current recommendation</div>
        <div class="muted">${escapeHtml(rec)}</div>
      </div>
    </div>`;
  }

  function renderTeamsMessagePreview(tradeCase) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const rec = dc && dc.agentRecommendation && dc.agentRecommendation.summary ? dc.agentRecommendation.summary : "—";
    const title = tradeCase && tradeCase.title ? tradeCase.title : tradeCase && tradeCase.id ? tradeCase.id : "case";
    const msg = `【判断依頼】${title}\n推奨: ${rec}\n判断期限: 2026-05-12 15:00\n必要資料: 在庫 / 売約 / 次便 / 書類状況`;
    return `<div class="detail-section detail-section--message">
      <h3 class="detail-section__title">Teams message preview</h3>
      <div class="detail-block"><pre class="pre">${escapeHtml(msg)}</pre></div>
    </div>`;
  }

  function renderAgentRecommendation(tradeCase) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const ar = dc && dc.agentRecommendation ? dc.agentRecommendation : null;
    if (!ar) return `<div class="muted">(no agent recommendation)</div>`;
    const reasoning = Array.isArray(ar.reasoning) ? ar.reasoning : [];
    return `<div class="detail-section">
      <h3 class="detail-section__title">Agent Recommendation / AI提案</h3>
      <div class="detail-block">
        <div class="kv">
          <span class="muted">suggestedActionType</span> ${escapeHtml(ar.suggestedActionType || "-")}
          <span class="muted">confidence</span> ${escapeHtml(String(Math.round((ar.confidence || 0) * 100)))}%
        </div>
        <div class="detail-subhead">summary</div>
        <div>${escapeHtml(ar.summary || "-")}</div>
        <div class="detail-subhead">reasoning</div>
        <ul class="mini-list">${reasoning.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
      </div>
    </div>`;
  }

  function renderCaseProgress(tradeCase) {
    const cp = tradeCase && tradeCase.caseProgress ? tradeCase.caseProgress : null;
    if (!cp) return "";

    const percentRaw = Number(cp.overallPercent);
    const percent = Number.isFinite(percentRaw) ? Math.max(0, Math.min(100, Math.round(percentRaw))) : 0;
    const wfCurrentLabel = (() => {
      const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
      const wf = dc && dc.resolutionWorkflow ? dc.resolutionWorkflow : null;
      const steps = wf && Array.isArray(wf.steps) ? wf.steps : [];
      const current = wf && wf.currentStepId ? steps.find((s) => s && s.id === wf.currentStepId) : null;
      const label = current && current.label ? current.label : "";
      return label ? String(label) : "";
    })();

    const iconFor = (st) => {
      const s = String(st || "");
      if (s === "done") return "✅";
      if (s === "waiting") return "⏳";
      if (s === "missing") return "❌";
      if (s === "blocked") return "⛔";
      if (s === "inProgress") return "🔄";
      if (s === "notStarted") return "○";
      if (s === "needsFix") return "⚠️";
      return "•";
    };

    const renderItems = (items) => {
      const list = Array.isArray(items) ? items : [];
      if (list.length === 0) return `<div class="muted">(no items)</div>`;
      return `<ul class="progress-list">${list
        .map((it) => {
          if (!it) return "";
          const label = it.label || it.id || "-";
          const note = it.note ? `<div class="progress-item__note">${escapeHtml(String(it.note))}</div>` : "";
          const blockingBadge = it.blocking ? `<span class="pill pill--mini pill--high">blocking</span>` : "";
          return `<li class="progress-item ${it.blocking ? "is-blocking" : ""}">
            <div class="progress-item__main">
              <span class="progress-item__icon">${escapeHtml(iconFor(it.status))}</span>
              <span class="progress-item__label">${escapeHtml(String(label))}</span>
              ${blockingBadge}
            </div>
            ${note}
          </li>`;
        })
        .join("")}</ul>`;
    };

    const blocking = Array.isArray(cp.blockingSummary) ? cp.blockingSummary : [];
    const blockingHtml = blocking.length
      ? `<div class="detail-subhead">Blocking Summary</div><ul class="mini-list">${blocking.map((x) => `<li>${escapeHtml(String(x))}</li>`).join("")}</ul>`
      : "";

    return `<section class="detail-section detail-section--progress">
      <h3 class="detail-section__title">Case Progress / 進捗</h3>
      <div class="progress-top">
        <div class="progress-bar" role="progressbar" aria-valuenow="${escapeHtml(String(percent))}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar__fill" style="width:${escapeHtml(String(percent))}%"></div>
        </div>
        <div class="progress-top__meta">
          <div class="progress-top__percent">${escapeHtml(String(percent))}% <span class="muted">complete</span></div>
          <div class="progress-top__status"><span class="muted">現在:</span> ${escapeHtml(cp.currentStatusLabel || "-")}</div>
          ${wfCurrentLabel ? `<div class="progress-top__workflow"><span class="muted">workflow:</span> ${escapeHtml(wfCurrentLabel)}</div>` : ""}
        </div>
      </div>

      ${blockingHtml}

      <div class="progress-help muted">AIが書類・船積予定・確認手順を照合し、対応進捗を更新します。</div>

      <div class="detail-subhead">Documents / 書類</div>
      ${renderItems(cp.documents)}

      <div class="detail-subhead">Booking &amp; Schedule / Booking・船積予定</div>
      ${renderItems(cp.bookingSchedule)}

      <div class="detail-subhead">Resolution / 対応進捗</div>
      ${renderItems(cp.resolution)}
    </section>`;
  }

  function renderResolutionDecisionTree(tradeCase) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const tree = dc && dc.resolutionDecisionTree ? dc.resolutionDecisionTree : null;
    if (!tree || !Array.isArray(tree.nodes) || tree.nodes.length === 0) {
      return `<div class="detail-section decision-tree"><h3 class="detail-section__title">Resolution Decision Tree / 分岐ルート（裏側）</h3><div class="muted">(no decision tree)</div></div>`;
    }

    const nodes = tree.nodes;
    const current =
      nodes.find((n) => n && n.id === tree.currentNodeId) || nodes.find((n) => n && n.status === "current") || nodes[0];

    const statusLabel = (s) => {
      const st = String(s || "");
      if (st === "current") return "現在";
      if (st === "available") return "確認可能";
      if (st === "completed") return "完了";
      if (st === "blocked") return "停滞";
      if (st === "notReached") return "未到達";
      if (st === "skipped") return "スキップ";
      return st || "-";
    };

    const ownerLabel = (t) => {
      const ot = String(t || "");
      if (ot === "supplier") return "仕入先";
      if (ot === "forwarder") return "フォワーダー";
      if (ot === "sales") return "営業";
      if (ot === "warehouse") return "倉庫";
      if (ot === "internal") return "社内";
      return ot || "-";
    };

    const contextMeta = (key) => {
      const k = String(key || "");
      if (k === "documents") return { label: "書類", drawerKey: "documentStatus" };
      if (k === "inventory") return { label: "在庫", drawerKey: "inventory" };
      if (k === "salesCommitments") return { label: "売約", drawerKey: "salesCommitments" };
      if (k === "inboundPlans") return { label: "次便", drawerKey: "inboundPlans" };
      if (k === "stakeholderResponses") return { label: "営業回答", drawerKey: "stakeholderResponses" };
      if (k === "supplierReliability") return { label: "仕入先傾向", drawerKey: "supplierReliability" };
      if (k === "freightCost") return { label: "運賃", drawerKey: "freightCost" };
      return { label: k || "-", drawerKey: "" };
    };

    const blockingBadge = current.blockingDecision
      ? `<span class="pill pill--mini pill--high">blocking</span>`
      : `<span class="pill pill--mini pill--muted">non-blocking</span>`;

    const ownerText = [ownerLabel(current.ownerType), current.ownerName].filter(Boolean).join(" / ");
    const received = current.receivedAnswer
      ? `<div class="current-question-card__received"><span class="muted">received</span> ${escapeHtml(String(current.receivedAnswer))}</div>`
      : "";

    const fallback = tree.fallbackRoute
      ? `<div class="fallback-route-card">
          <div class="fallback-route-card__title">No Reply Route / 未回答時の暫定ルート</div>
          <div class="muted">${escapeHtml(tree.fallbackRoute.triggerCondition || "-")}</div>
          <div>${escapeHtml(tree.fallbackRoute.suggestedAction || "-")}</div>
          ${tree.fallbackRoute.escalationTarget ? `<div class="muted">escalation: ${escapeHtml(tree.fallbackRoute.escalationTarget)}</div>` : ""}
        </div>`
      : "";

    const branches = Array.isArray(current.branches) ? current.branches : [];
    const isNoReplyBranch = (b) => {
      const v = b && b.value ? String(b.value) : "";
      const l = b && b.label ? String(b.label) : "";
      return v === "noReply" || l.toUpperCase() === "NO REPLY";
    };

    const pickDefaultBranchValue = () => {
      if (!branches.length) return null;
      const nonNoReply = branches.find((b) => b && !isNoReplyBranch(b));
      const first = branches.find((b) => b);
      const picked = nonNoReply || first;
      return picked && picked.value ? String(picked.value) : null;
    };

    const selectedBranchValue = (() => {
      const candidate = state.selectedDecisionBranch ? String(state.selectedDecisionBranch) : "";
      const ok = candidate && branches.some((b) => b && String(b.value || "") === candidate);
      if (ok) return candidate;
      const next = pickDefaultBranchValue();
      state.selectedDecisionBranch = next;
      return next;
    })();

    const getBranchByValue = (val) => branches.find((b) => b && String(b.value || "") === String(val || "")) || null;
    const selectedBranch = selectedBranchValue ? getBranchByValue(selectedBranchValue) : null;

    const missingContextKeySet = (() => {
      const dc0 = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
      const missing = new Set();
      const hasAny = (arr) => Array.isArray(arr) && arr.length > 0;
      if (!hasAny(dc0 && dc0.inventory)) missing.add("inventory");
      if (!hasAny(dc0 && dc0.salesCommitments)) missing.add("salesCommitments");
      if (!hasAny(dc0 && dc0.inboundPlans)) missing.add("inboundPlans");
      if (!hasAny(dc0 && dc0.documentStatus)) missing.add("documents");
      if (!hasAny(dc0 && dc0.stakeholderResponses)) missing.add("stakeholderResponses");
      if (!(dc0 && dc0.supplierReliability)) missing.add("supplierReliability");
      return missing;
    })();

    const branchUiStatus = (b) => {
      if (!b) return { kind: "unavailable", label: "unavailable", dot: "×" };
      const val = String(b.value || "");
      const isSelected = selectedBranchValue && val === selectedBranchValue;
      if (isSelected) return { kind: "active", label: "active", dot: "●" };

      const required = Array.isArray(b.requiredContext) ? b.requiredContext : [];
      const isBlocked = required.some((k) => missingContextKeySet.has(String(k || "")));
      if (isBlocked) return { kind: "blocked", label: "blocked", dot: "!" };

      if (isNoReplyBranch(b)) return { kind: "waiting", label: "waiting", dot: "○" };
      return { kind: "waiting", label: "waiting", dot: "○" };
    };

    const requiredChipsHtml = (required) => {
      const req = Array.isArray(required) ? required : [];
      if (!req.length) return `<div class="muted">(none)</div>`;
      return `<div class="required-context-chips">
        ${req
          .map((k) => {
            const meta = contextMeta(k);
            if (!meta.drawerKey) return `<span class="context-chip context-chip--disabled">${escapeHtml(meta.label)}</span>`;
            return `<button class="context-chip" type="button" data-context-open="${escapeHtml(meta.drawerKey)}">${escapeHtml(meta.label)}</button>`;
          })
          .join("")}
      </div>`;
    };

    const branchRowHtml = branches.length
      ? branches
          .map((b) => {
            if (!b) return "";
            const nextNode = b.nextNodeId ? nodes.find((n) => n && n.id === b.nextNodeId) : null;
            const nextTitle = nextNode && nextNode.title ? String(nextNode.title) : String(b.nextNodeId || "");
            const required = Array.isArray(b.requiredContext) ? b.requiredContext : [];
            const isWarning = isNoReplyBranch(b);
            const isSelected = selectedBranchValue && String(b.value || "") === selectedBranchValue;
            const st = branchUiStatus(b);

            return `<div class="flow-branch-node ${isSelected ? "is-selected" : ""} ${isWarning ? "is-warning" : ""} is-${escapeHtml(
              st.kind,
            )}" role="button" tabindex="0"
              data-decision-branch-select="1"
              data-branch-node-id="${escapeHtml(String(current.id || ""))}"
              data-branch-label="${escapeHtml(String(b.label || ""))}"
              data-branch-value="${escapeHtml(String(b.value || ""))}"
              data-branch-next="${escapeHtml(String(b.nextNodeId || ""))}">
              <div class="flow-branch-node__top">
                <div class="flow-branch-node__label-row">
                  <div class="flow-branch-node__label">${escapeHtml(String(b.label || "-"))}</div>
                  <div class="flow-branch-node__status"><span class="flow-branch-node__dot" aria-hidden="true">${escapeHtml(
                    st.dot,
                  )}</span> ${escapeHtml(st.label)}</div>
                  ${isWarning ? `<span class="pill pill--mini flow-branch-node__badge">fallback</span>` : ""}
                </div>
              </div>
              <div class="flow-branch-node__next"><span class="flow-branch-node__arrow" aria-hidden="true">↓</span> ${escapeHtml(
                nextTitle || "-",
              )}</div>
              <div class="flow-branch-node__chips">${requiredChipsHtml(required)}</div>
            </div>`;
          })
          .join("")
      : `<div class="muted">(no branches)</div>`;

    const selectedDetailHtml = (() => {
      if (!selectedBranch) return `<div class="selected-branch-detail"><div class="muted">(no selected branch)</div></div>`;
      const nextNode = selectedBranch.nextNodeId ? nodes.find((n) => n && n.id === selectedBranch.nextNodeId) : null;
      const nextTitle = nextNode && nextNode.title ? String(nextNode.title) : String(selectedBranch.nextNodeId || "-");
      const required = Array.isArray(selectedBranch.requiredContext) ? selectedBranch.requiredContext : [];
      const warningNote = isNoReplyBranch(selectedBranch)
        ? `<div class="selected-branch-detail__warning muted">未回答・期限切れの場合の暫定ルート</div>`
        : "";
      const routeNote = isNoReplyBranch(selectedBranch) ? "fallback route / 未回答時ルート" : "primary route";

      return `<div class="selected-branch-detail decision-flow-detail-panel">
        <div class="selected-branch-detail__top">
          <div class="selected-branch-detail__label">${escapeHtml(String(selectedBranch.label || "-"))}</div>
          <button class="btn btn--primary btn--small" type="button"
            data-decision-branch-commit="1"
            data-branch-node-id="${escapeHtml(String(current.id || ""))}"
            data-branch-label="${escapeHtml(String(selectedBranch.label || ""))}"
            data-branch-value="${escapeHtml(String(selectedBranch.value || ""))}"
            data-branch-next="${escapeHtml(String(selectedBranch.nextNodeId || ""))}">手動で分岐を確定（例外）</button>
        </div>
        ${warningNote}
        <div class="selected-branch-detail__row"><span class="muted">route</span> ${escapeHtml(routeNote)}</div>
        <div class="selected-branch-detail__row"><span class="muted">action</span> ${escapeHtml(String(selectedBranch.actionLabel || "-"))}</div>
        ${selectedBranch.explanation ? `<div class="selected-branch-detail__row"><span class="muted">explanation</span> ${escapeHtml(String(selectedBranch.explanation))}</div>` : ""}
        <div class="selected-branch-detail__row"><span class="muted">next node</span> ${escapeHtml(nextTitle || "-")}</div>
        <div class="selected-branch-detail__row"><span class="muted">required context</span></div>
        ${requiredChipsHtml(required)}
      </div>`;
    })();

    const overviewList = nodes
      .map((n) => {
        if (!n) return "";
        const isCurrent = n.id === (current && current.id ? current.id : "");
        const pill = `<span class="pill pill--mini ${isCurrent ? "pill--recommended" : ""}">${escapeHtml(statusLabel(n.status))}</span>`;
        return `<li>${pill} ${escapeHtml(n.title || n.id || "-")}</li>`;
      })
      .join("");

    const overviewAccordion = `<div class="accordion tree-overview-accordion" data-accordion-root>
      <div class="accordion__item">
        <button class="accordion__trigger" type="button" data-accordion-trigger aria-expanded="false">
          <span class="pill pill--mini">全体フローを見る</span>
          <span class="accordion__summary">Decision Tree overview</span>
        </button>
        <div class="accordion__panel" hidden>
          <ul class="mini-list">${overviewList}</ul>
        </div>
      </div>
    </div>`;

    return `<section class="detail-section decision-tree">
      <h3 class="detail-section__title">Resolution Decision Tree / 分岐ルート（裏側）</h3>
      <div class="decision-flow">
        <div class="decision-flow-minimap">
          <div class="flow-current-node current-question-card">
            <div class="current-question-card__top">
              <div class="flow-current-node__title">[${escapeHtml(current.title || current.id || "-")}]</div>
              <div class="current-question-card__badges">
                <span class="pill pill--mini">${escapeHtml(ownerText || "-")}</span>
                <span class="pill pill--mini">${escapeHtml(statusLabel(current.status))}</span>
                ${current.dueAt ? `<span class="pill pill--mini">due ${escapeHtml(String(current.dueAt))}</span>` : `<span class="pill pill--mini pill--muted">due -</span>`}
                ${blockingBadge}
              </div>
            </div>
            <div class="current-question-card__question"><span class="muted">Q:</span> ${escapeHtml(current.question || "-")}</div>
            ${received}
          </div>

          <div class="flow-connector" aria-hidden="true"></div>

          <div class="flow-branch-row decision-flow-minimap-branches">
            ${branchRowHtml}
          </div>
        </div>

        <div class="decision-flow-detail">
          ${selectedDetailHtml}
        </div>
      </div>

      ${fallback}

      ${overviewAccordion}
    </section>`;
  }

  function agentRunStatusLabel(status) {
    const s = String(status || "");
    if (s === "waitingHumanApproval") return "人間承認待ち";
    if (s === "waitingExternalReply") return "外部回答待ち";
    if (s === "completed") return "完了";
    if (s === "blocked") return "ブロック";
    if (s === "running") return "進行中";
    return s || "-";
  }

  function agentRunStepStatusLabel(status) {
    const s = String(status || "");
    if (s === "proposed") return "提案済み";
    if (s === "approved") return "承認済み";
    if (s === "sent") return "送信済み";
    if (s === "waitingReply") return "返信待ち";
    if (s === "replyReceived") return "返信受領";
    if (s === "classified") return "分類済み";
    if (s === "completed") return "完了";
    if (s === "detected") return "検知";
    if (s === "held") return "保留";
    if (s === "blocked") return "ブロック";
    return s || "-";
  }

  function agentRunStepIcon(status) {
    const s = String(status || "");
    if (s === "completed" || s === "sent" || s === "classified") return "✅";
    if (s === "proposed" || s === "approved") return "🟡";
    if (s === "waitingReply") return "○";
    if (s === "held") return "⏸";
    if (s === "blocked") return "⛔";
    return "○";
  }

  function agentActorLabel(actor) {
    const a = String(actor || "");
    if (a === "agent") return "AI";
    if (a === "human") return "Human";
    if (a === "supplier") return "Supplier";
    if (a === "sales") return "Sales";
    if (a === "forwarder") return "Forwarder";
    if (a === "system") return "System";
    return a || "-";
  }

  function renderResolutionAgentRun(tradeCase) {
    const run = tradeCase && tradeCase.resolutionAgentRun ? tradeCase.resolutionAgentRun : null;
    if (!run) {
      return `<section class="detail-section agent-run-card">
        <h3 class="detail-section__title">Resolution Agent Run / 対応エージェント進行</h3>
        <div class="muted">(no agent run)</div>
      </section>`;
    }

    const steps = Array.isArray(run.steps) ? run.steps : [];
    const current = steps.find((s) => s && s.id === run.currentStepId) || null;
    const next = run.nextHumanAction || null;

    const progress = typeof run.progressPercent === "number" ? clamp(run.progressPercent, 0, 100) : 0;
    const status = agentRunStatusLabel(run.status);
    const currentTitle = current && current.title ? String(current.title) : run.currentStepId || "-";
    const nextLabel = next && next.label ? String(next.label) : "-";

    return `<section class="detail-section agent-run-card">
      <h3 class="detail-section__title">Resolution Agent Run / 対応エージェント進行</h3>
      <div class="agent-run-status">
        <div class="agent-progress-bar" role="progressbar" aria-valuenow="${escapeHtml(String(progress))}" aria-valuemin="0" aria-valuemax="100">
          <div class="agent-progress-bar__fill" style="width:${escapeHtml(String(progress))}%"></div>
        </div>
        <div class="kv" style="margin-top:10px;">
          <span class="muted">Progress</span> ${escapeHtml(String(progress))}%
          <span class="muted">Status</span> ${escapeHtml(status)}
        </div>
        <div class="kv" style="margin-top:6px;">
          <span class="muted">Current</span> ${escapeHtml(currentTitle)}
          <span class="muted">Next</span> ${escapeHtml(nextLabel)}
        </div>
      </div>
    </section>`;
  }

  function renderNextHumanApproval(tradeCase) {
    const run = tradeCase && tradeCase.resolutionAgentRun ? tradeCase.resolutionAgentRun : null;
    if (!run) return "";
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const current = steps.find((s) => s && s.id === run.currentStepId) || null;
    if (!current || !current.requiresHumanApproval) return "";

    const msg = current.proposedMessage || null;
    if (!msg) {
      return `<section class="detail-section next-human-approval-card">
        <h3 class="detail-section__title">Next Human Approval / 次の承認</h3>
        <div class="muted">（pending）承認が必要なステップです。</div>
      </section>`;
    }

    const evidence = Array.isArray(current.evidence) ? current.evidence : [];
    const evidenceHtml = evidence.length ? `<ul class="mini-list">${evidence.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "";
    const statusText = agentRunStepStatusLabel(current.status);

    const canApprove = current.status === "proposed" || current.status === "approved";

    const desc =
      run && run.nextHumanAction && run.nextHumanAction.description
        ? String(run.nextHumanAction.description)
        : "AIが外部送信文面を作成しました。送信してよいですか？";

    return `<section class="detail-section next-human-approval-card">
      <h3 class="detail-section__title">Next Human Approval / 次の承認</h3>
      <div class="next-human-approval-card__lead">
        <div>${escapeHtml(desc)}</div>
        <div class="muted" style="margin-top:6px;">通常はAIが判定予定です。外部送信前に人間承認が必要です。</div>
      </div>
      <div class="proposed-message-preview">
        <div class="kv">
          <span class="muted">channel</span> ${escapeHtml(String(msg.channel || "-"))}
          <span class="muted">status</span> <span class="pill pill--mini">${escapeHtml(statusText)}</span>
        </div>
        <div class="kv" style="margin-top:6px;"><span class="muted">to</span> ${escapeHtml((Array.isArray(msg.to) ? msg.to : []).join(", ") || "-")}</div>
        ${msg.subject ? `<div class="kv" style="margin-top:6px;"><span class="muted">subject</span> ${escapeHtml(String(msg.subject))}</div>` : ""}
        <div class="detail-subhead" style="margin-top:10px;">body</div>
        <pre class="pre proposed-message-preview__body">${escapeHtml(String(msg.body || ""))}</pre>
        ${evidenceHtml ? `<div class="detail-subhead" style="margin-top:10px;">evidence</div>${evidenceHtml}` : ""}
      </div>
      <div class="approval-actions">
        <button class="btn btn--primary" type="button" data-agent-run-approve="1" ${canApprove ? "" : "disabled"}>Approve / 承認して送信</button>
        <button class="btn" type="button" data-agent-run-edit="1">Edit / 修正</button>
        <button class="btn" type="button" data-agent-run-hold="1">Hold / 保留</button>
      </div>
    </section>`;
  }

  function renderAgentRunTimeline(tradeCase) {
    const run = tradeCase && tradeCase.resolutionAgentRun ? tradeCase.resolutionAgentRun : null;
    if (!run) return "";
    const steps = Array.isArray(run.steps) ? run.steps : [];
    if (!steps.length) return "";

    const items = steps
      .map((s) => {
        if (!s) return "";
        const icon = agentRunStepIcon(s.status);
        const actor = agentActorLabel(s.actor);
        const status = agentRunStepStatusLabel(s.status);
        const approvalBadge = s.requiresHumanApproval ? `<span class="pill pill--mini pill--warn">requires approval</span>` : "";
        return `<div class="agent-run-step">
          <div class="agent-run-step__head">
            <span class="agent-run-step__icon" aria-hidden="true">${escapeHtml(icon)}</span>
            <div class="agent-run-step__title">${escapeHtml(String(s.title || s.id || "-"))}</div>
            <div class="agent-run-step__meta">
              <span class="pill pill--mini">${escapeHtml(actor)}</span>
              ${approvalBadge}
              <span class="pill pill--mini agent-run-step__status">${escapeHtml(status)}</span>
            </div>
          </div>
          <div class="agent-run-step__summary muted">${escapeHtml(String(s.summary || ""))}</div>
        </div>`;
      })
      .join("");

    return `<section class="detail-section agent-run-timeline">
      <h3 class="detail-section__title">Agent Run Timeline</h3>
      <div class="agent-run-timeline__list">${items}</div>
    </section>`;
  }

  function renderDecisionTreeOverviewAccordion(tradeCase) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const tree = dc && dc.resolutionDecisionTree ? dc.resolutionDecisionTree : null;
    const hasTree = tree && Array.isArray(tree.nodes) && tree.nodes.length > 0;

    return `<section class="detail-section">
      <div class="accordion" data-accordion-root>
        <div class="accordion__item">
          <button class="accordion__trigger" type="button" data-accordion-trigger aria-expanded="false">
            <span class="pill pill--mini">分岐ルートを見る</span>
            <span class="accordion__summary">AIはこの分岐ルートをもとに、仕入先回答や営業回答を分類し次アクションを提案します。</span>
          </button>
          <div class="accordion__panel" hidden>
            ${hasTree ? renderResolutionDecisionTree(tradeCase) : `<div class="muted">(no decision tree)</div>`}
          </div>
        </div>
      </div>
    </section>`;
  }

  function renderResolutionWorkflow(tradeCase) {
    const dc = tradeCase && tradeCase.decisionContext ? tradeCase.decisionContext : null;
    const wf = dc && dc.resolutionWorkflow ? dc.resolutionWorkflow : null;
    if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) {
      return `<div class="detail-section"><h3 class="detail-section__title">Resolution Workflow / 確認手順</h3><div class="muted">(no workflow)</div></div>`;
    }

    const steps = wf.steps;
    const current = steps.find((s) => s && s.id === wf.currentStepId) || steps[0];

    const statusLabel = (s) => {
      const st = String(s || "");
      if (st === "waiting") return "回答待ち";
      if (st === "notStarted") return "未開始";
      if (st === "confirmed") return "確認済み";
      if (st === "blocked") return "停滞";
      if (st === "escalated") return "エスカレーション済み";
      if (st === "skipped") return "スキップ";
      return st || "-";
    };

    const ownerLabel = (t) => {
      const ot = String(t || "");
      if (ot === "supplier") return "仕入先";
      if (ot === "forwarder") return "フォワーダー";
      if (ot === "sales") return "営業";
      if (ot === "warehouse") return "倉庫";
      if (ot === "internal") return "社内";
      return ot || "-";
    };

    const nextActionText = (() => {
      const owner = current ? ownerLabel(current.ownerType) : "担当";
      const label = current && current.label ? current.label : "確認中";
      const due = current && current.dueAt ? `期限: ${current.dueAt}` : "";
      const fallback = current && current.nextIfNoReply ? current.nextIfNoReply : wf.fallbackRoute ? wf.fallbackRoute.suggestedAction : "";
      const second = fallback ? `期限までに回答がない場合、${fallback}` : "";
      return `${owner}へ「${label}」を対応中。${due}${second ? `\n${second}` : ""}`;
    })();

    const fallbackHtml = wf.fallbackRoute
      ? `<div class="detail-subhead">fallback route</div>
         <div class="muted">${escapeHtml(wf.fallbackRoute.triggerCondition || "-")}</div>
         <div>${escapeHtml(wf.fallbackRoute.suggestedAction || "-")}</div>
         ${wf.fallbackRoute.escalationTarget ? `<div class="muted">escalation: ${escapeHtml(wf.fallbackRoute.escalationTarget)}</div>` : ""}`
      : "";

    const items = steps
      .map((s) => {
        if (!s) return "";
        const isCurrent = s.id === wf.currentStepId;
        const dueAt = s.dueAt ? `<div class="workflow-step__meta"><span class="muted">dueAt</span> ${escapeHtml(String(s.dueAt))}</div>` : "";
        const nextIfNoReply = s.nextIfNoReply
          ? `<div class="workflow-step__meta"><span class="muted">nextIfNoReply</span> ${escapeHtml(String(s.nextIfNoReply))}</div>`
          : "";
        const blocking = s.blockingDecision ? `<span class="pill pill--mini pill--high">blocking</span>` : `<span class="pill pill--mini pill--muted">non-blocking</span>`;
        return `<li class="workflow-step ${isCurrent ? "is-current" : ""}">
          <div class="workflow-step__top">
            <div class="workflow-step__title">${escapeHtml(s.label || s.id)}</div>
            <div class="workflow-step__badges">
              <span class="pill pill--mini">${escapeHtml(ownerLabel(s.ownerType))}</span>
              <span class="pill pill--mini">${escapeHtml(statusLabel(s.status))}</span>
              ${blocking}
            </div>
          </div>
          <div class="workflow-step__question">${escapeHtml(s.question || "-")}</div>
          ${dueAt}
          ${nextIfNoReply}
        </li>`;
      })
      .join("");

    return `<div class="detail-section">
      <h3 class="detail-section__title">Resolution Workflow / 確認手順</h3>
      <div class="next-required-action">
        <div class="next-required-action__title">Next Required Action</div>
        <pre class="pre pre--compact">${escapeHtml(nextActionText)}</pre>
      </div>
      <ul class="workflow-timeline">${items}</ul>
      ${fallbackHtml}
    </div>`;
  }

  const activeDrawerKey = state.activeContextDrawer;
  const drawerIsOpen = Boolean(activeDrawerKey);
  const operationalEntitiesHtml = renderOperationalEntities(tradeCase);

  openModal({
    title: `案件詳細`,
    bodyHtml: `
      <div class="decision-workspace ${drawerIsOpen ? "is-drawer-open" : ""}">
        <aside class="workspace-left">
          <div class="case-cover">
            <div class="case-cover__left">
              <div class="case-cover__block">
                <div class="case-cover__label muted">Title</div>
                <div class="case-cover__title">${escapeHtml(titleText)}</div>
              </div>
              <div class="case-cover__block">
                <div class="case-cover__label muted">Subtitle</div>
                <div class="case-cover__subtitle">${escapeHtml(subtitleText)}</div>
              </div>
              <div class="case-cover__block">
                <div class="case-cover__label muted">Metadata chips</div>
                <div class="case-cover__meta">
                  ${chips.map((c) => `<span class="pill pill--mini">${escapeHtml(c)}</span>`).join("")}
                </div>
              </div>
            </div>
          </div>

          <section class="detail-section detail-section--summary">
            <h3 class="detail-section__title">Main Incident / 現在の問題</h3>
            <div class="detail-block">
              <div class="kv">
                <span class="pill ${severityClass(decisionSummary.riskLevel)}">${escapeHtml(decisionSummary.riskLevel)}</span>
                <span class="muted">movement</span> ${escapeHtml(shipmentStateJa)}
              </div>
              <div class="detail-subhead">main issue</div>
              <div>${escapeHtml(decisionSummary.mainIssue)}</div>
            </div>
          </section>

          ${operationalEntitiesHtml}

          ${renderCaseProgress(tradeCase)}

          <section class="detail-section">
            <h3 class="detail-section__title">Decision History / Timeline</h3>
            <ul class="list">${timelineHtml}</ul>
          </section>

          <section class="detail-section">
            <h3 class="detail-section__title">Source Data / 元データ</h3>
            <div class="accordion" data-accordion-root>
              <div class="accordion__item">
                <button class="accordion__trigger" type="button" data-accordion-trigger aria-expanded="false">
                  <span class="pill pill--mini">元データを見る</span>
                  <span class="accordion__summary">case:${escapeHtml(tradeCase.id)} / supplier:${escapeHtml(supplierName)} / updated:${escapeHtml(
                    updated,
                  )}</span>
                </button>
                <div class="accordion__panel" hidden>
                  <div class="detail__meta">
                    <div><span class="muted">case id:</span> ${escapeHtml(tradeCase.id)}</div>
                    <div><span class="muted">title:</span> ${escapeHtml(tradeCase.title)}</div>
                    <div><span class="muted">supplier:</span> ${escapeHtml(supplierName)}</div>
                    <div><span class="muted">tradeType:</span> ${escapeHtml(tradeCase.tradeType)}</div>
                    <div><span class="muted">shipmentState:</span> ${escapeHtml(tradeCase.shipmentState)}</div>
                    <div><span class="muted">updatedAt:</span> ${escapeHtml(updated)}</div>
                  </div>

                  <div class="detail-subhead">Products</div>
                  <ul class="list">${productsHtml}</ul>

                  <div class="detail-subhead">Documents</div>
                  <ul class="list">${docsHtml}</ul>

                  <div class="detail-subhead">Affected Products (if any)</div>
                  <ul class="list">${affectedProductsHtml}</ul>

                  <div class="detail-subhead">Next Shipment (if any)</div>
                  ${nextShipmentHtml}
                </div>
              </div>
            </div>
          </section>
        </aside>

        <main class="workspace-main">
          ${renderResolutionAgentRun(tradeCase)}
          ${renderAgentRunTimeline(tradeCase)}
          ${renderDecisionTreeOverviewAccordion(tradeCase)}

          <section class="detail-section">
            <h3 class="detail-section__title">Context Launcher / 必要資料</h3>
            ${renderContextLauncher(activeDrawerKey)}
          </section>

          ${renderStakeholderCoordinationPreview(tradeCase)}
          <section class="detail-section">
            <h3 class="detail-section__title">Actions / 承認と実行</h3>
            <div class="muted">承認・下書き編集・保留などの実務アクションは、Issues（AI承認センター）で行ってください。</div>
            <div style="margin-top:10px;">
              <button class="btn btn--primary" type="button" data-open-approval-center="1">Open Issues（AI承認センター）</button>
            </div>
          </section>
        </main>

        <aside class="context-drawer" aria-hidden="${drawerIsOpen ? "false" : "true"}">
          ${drawerIsOpen ? renderDrawerContent(tradeCase, activeDrawerKey) : ""}
        </aside>
      </div>
    `,
  });
}

function openTradeCaseDetail(tradeCase) {
  state.modalTradeCaseId = tradeCase.id;
  renderTradeCaseDetail(tradeCase);
}

function setupDropzone() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const btnPick = document.getElementById("btn-pick");

  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ["dragenter", "dragover"].forEach((name) => {
    dropzone.addEventListener(name, (e) => {
      prevent(e);
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    dropzone.addEventListener(name, (e) => {
      prevent(e);
      dropzone.classList.remove("is-dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;

    if (dt.files && dt.files.length > 0) {
      for (const f of dt.files) {
        addItem({ kind: "file", name: f.name, type: f.type || "file", size: f.size });
      }
      return;
    }

    const text = dt.getData("text/plain");
    if (text && text.trim()) addItem({ kind: "text", text });
  });

  btnPick.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (!fileInput.files) return;
    for (const f of fileInput.files) {
      addItem({ kind: "file", name: f.name, type: f.type || "file", size: f.size });
    }
    fileInput.value = "";
  });
}

function setupTextAdd() {
  const textarea = document.getElementById("text-input");
  const btnAdd = document.getElementById("btn-add-text");
  btnAdd.addEventListener("click", () => {
    const text = textarea.value;
    if (!text || !text.trim()) return;
    addItem({ kind: "text", text });
    textarea.value = "";
  });
}

function setupModal() {
  const modal = document.getElementById("modal");
  let lastDecisionBranchHover = null;

  modal.addEventListener("mouseover", (e) => {
    const target = e.target;
    if (!target) return;
    const decisionBranchEl = target.closest && target.closest("[data-decision-branch-select]");
    if (!decisionBranchEl) return;
    const branchValue = decisionBranchEl.getAttribute("data-branch-value") || "";
    if (!branchValue || branchValue === lastDecisionBranchHover) return;
    lastDecisionBranchHover = branchValue;
    state.selectedDecisionBranch = branchValue;
    const tc = state.modalTradeCaseId ? getTradeCaseById(state.modalTradeCaseId) : null;
    if (tc) renderTradeCaseDetail(tc);
  });

  modal.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    if (target.matches("[data-close]")) closeModal();

    const openApprovalCenterEl = target.closest && target.closest("[data-open-approval-center]");
    if (openApprovalCenterEl) {
      state.topActiveTab = "issues";
      closeModal();
      renderApp();
      return;
    }

    const openShipmentWorkspaceEl = target.closest && target.closest("[data-open-shipment-workspace]");
    if (openShipmentWorkspaceEl) {
      const tc = state.modalTradeCaseId ? getTradeCaseById(state.modalTradeCaseId) : null;
      if (tc) openWorkspaceModal("shipment-workspace-modal", { title: "Shipment Workspace", bodyHtml: renderShipmentWorkspace(tc) });
      return;
    }

    const openSiWorkspaceEl = target.closest && target.closest("[data-open-si-workspace]");
    if (openSiWorkspaceEl) {
      const tc = state.modalTradeCaseId ? getTradeCaseById(state.modalTradeCaseId) : null;
      if (tc) openWorkspaceModal("si-workspace-modal", { title: "SI Workspace", bodyHtml: renderSiWorkspace(tc) });
      return;
    }

    const contextCloseEl = target.closest && target.closest("[data-context-close]");
    if (contextCloseEl) {
      state.activeContextDrawer = null;
      const tc = state.modalTradeCaseId ? getTradeCaseById(state.modalTradeCaseId) : null;
      if (tc) renderTradeCaseDetail(tc);
      return;
    }

    const contextOpenEl = target.closest && target.closest("[data-context-open]");
    if (contextOpenEl) {
      const key = contextOpenEl.getAttribute("data-context-open");
      state.activeContextDrawer = key || null;
      const tc = state.modalTradeCaseId ? getTradeCaseById(state.modalTradeCaseId) : null;
      if (tc) renderTradeCaseDetail(tc);
      return;
    }

    const accordionTrigger = target.closest && target.closest("[data-accordion-trigger]");
    if (accordionTrigger) {
      const item = accordionTrigger.closest(".accordion__item");
      if (!item) return;
      const panel = item.querySelector(".accordion__panel");
      const isOpen = item.classList.toggle("is-open");
      accordionTrigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (panel) panel.hidden = !isOpen;
      return;
    }

    const agentRunApproveEl = target.closest && target.closest("[data-agent-run-approve]");
    if (agentRunApproveEl) {
      if (!state.modalTradeCaseId) return;
      const ok = agentRunApproveSend(state.modalTradeCaseId);
      const tc = getTradeCaseById(state.modalTradeCaseId);
      if (ok && tc) renderTradeCaseDetail(tc);
      return;
    }

    const agentRunHoldEl = target.closest && target.closest("[data-agent-run-hold]");
    if (agentRunHoldEl) {
      if (!state.modalTradeCaseId) return;
      const ok = agentRunHold(state.modalTradeCaseId);
      const tc = getTradeCaseById(state.modalTradeCaseId);
      if (ok && tc) renderTradeCaseDetail(tc);
      return;
    }

    const agentRunEditEl = target.closest && target.closest("[data-agent-run-edit]");
    if (agentRunEditEl) {
      if (!state.modalTradeCaseId) return;
      const ok = agentRunEdit(state.modalTradeCaseId);
      const tc = getTradeCaseById(state.modalTradeCaseId);
      if (ok && tc) renderTradeCaseDetail(tc);
      return;
    }

    const decisionBranchCommitEl = target.closest && target.closest("[data-decision-branch-commit]");
    if (decisionBranchCommitEl) {
      const nodeId = decisionBranchCommitEl.getAttribute("data-branch-node-id") || "";
      const branchLabel = decisionBranchCommitEl.getAttribute("data-branch-label") || "";
      const branchValue = decisionBranchCommitEl.getAttribute("data-branch-value") || "";
      const nextNodeId = decisionBranchCommitEl.getAttribute("data-branch-next") || "";

      if (!state.modalTradeCaseId) return;
      const tc = getTradeCaseById(state.modalTradeCaseId);
      const tree = tc && tc.decisionContext && tc.decisionContext.resolutionDecisionTree ? tc.decisionContext.resolutionDecisionTree : null;

      if (tree && Array.isArray(tree.nodes)) {
        const current = tree.currentNodeId ? tree.nodes.find((n) => n && n.id === tree.currentNodeId) : null;
        const clickedNode = nodeId ? tree.nodes.find((n) => n && n.id === nodeId) : null;
        const activeNode = clickedNode || current;
        if (activeNode) {
          activeNode.receivedAnswer = branchLabel || branchValue || "";
          if (nodeId && branchValue) state.committedDecisionBranchByNodeId[String(nodeId)] = String(branchValue);
          if (nextNodeId) {
            activeNode.status = "completed";
            const next = tree.nodes.find((n) => n && n.id === nextNodeId) || null;
            if (next) {
              next.status = "current";
              tree.currentNodeId = next.id;
            }
          }
        }
      }

      if (tc && state.modalTradeCaseId) {
        const nodes = tree && Array.isArray(tree.nodes) ? tree.nodes : [];
        const nextTitle = nextNodeId ? nodes.find((n) => n && n.id === nextNodeId)?.title || nextNodeId : nextNodeId;
        recordDecisionTreeActivity(state.modalTradeCaseId, {
          label: branchLabel || branchValue || "branch",
          nextTitle: String(nextTitle || "-"),
          note: `commit node:${nodeId} value:${branchValue} next:${nextNodeId}`,
        });
      }

      recordHumanIntervention(state.modalTradeCaseId, {
        actionType: "decisionTreeBranch",
        label: `Decision Tree: ${branchLabel || branchValue || "branch"}`,
        note: `node:${nodeId} value:${branchValue} next:${nextNodeId}`,
      });

      if (tc) renderTradeCaseDetail(tc);
      return;
    }

    const decisionBranchSelectEl = target.closest && target.closest("[data-decision-branch-select]");
    if (decisionBranchSelectEl) {
      const branchValue = decisionBranchSelectEl.getAttribute("data-branch-value") || "";
      if (!branchValue) return;
      state.selectedDecisionBranch = branchValue;
      const tc = state.modalTradeCaseId ? getTradeCaseById(state.modalTradeCaseId) : null;
      if (tc && state.modalTradeCaseId && tc.decisionContext && tc.decisionContext.resolutionDecisionTree) {
        const tree = tc.decisionContext.resolutionDecisionTree;
        const nodeId = decisionBranchSelectEl.getAttribute("data-branch-node-id") || "";
        const branchLabel = decisionBranchSelectEl.getAttribute("data-branch-label") || "";
        const nextNodeId = decisionBranchSelectEl.getAttribute("data-branch-next") || "";
        const nextTitle = nextNodeId ? tree.nodes.find((n) => n && n.id === nextNodeId)?.title || nextNodeId : nextNodeId;
        recordDecisionTreeActivity(state.modalTradeCaseId, {
          label: branchLabel || branchValue || "branch",
          nextTitle: String(nextTitle || "-"),
          note: `select node:${nodeId} value:${branchValue} next:${nextNodeId}`,
        });
      }
      if (tc) renderTradeCaseDetail(tc);
      return;
    }

    const humanActionEl = target.closest && target.closest("[data-human-action]");
    if (humanActionEl) {
      const actionType = humanActionEl.getAttribute("data-human-action");
      const label = humanActionEl.getAttribute("data-human-label") || actionType;
      if (!actionType || !state.modalTradeCaseId) return;
      recordHumanIntervention(state.modalTradeCaseId, { actionType, label, note: "" });

      const tc = getTradeCaseById(state.modalTradeCaseId);
      if (tc) renderTradeCaseDetail(tc);
      log(`記録: ${actionType}`);
      return;
    }

    const approveEl = target.closest && target.closest("[data-approve-proposal]");
    if (approveEl) {
      const proposalId = approveEl.getAttribute("data-approve-proposal");
      if (!proposalId) return;
      state.proposalApprovalStatusById[proposalId] = "approved";

      if (state.modalTradeCaseId) {
        recordHumanIntervention(state.modalTradeCaseId, { actionType: "approveProposal", label: "承認", note: `proposal:${proposalId}` });
      }

      const tc = getTradeCaseById(state.modalTradeCaseId);
      if (tc) renderTradeCaseDetail(tc);
      log(`承認: proposal ${proposalId}`);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.isOperationalThreadModalOpen) {
      closeOperationalThreadModal();
      renderApp();
      return;
    }
    if (isAnyWorkspaceModalOpen()) {
      closeWorkspaceModal("shipment-workspace-modal");
      closeWorkspaceModal("si-workspace-modal");
      return;
    }
    closeModal();
  });
}

function setupWorkspaceModals() {
  const shipment = document.getElementById("shipment-workspace-modal");
  const si = document.getElementById("si-workspace-modal");

  const attach = (modalEl, modalId) => {
    if (!modalEl) return;
    modalEl.addEventListener("click", (e) => {
      const target = e.target;
      if (!target) return;
      const closeEl = target.closest && target.closest("[data-close-workspace]");
      if (closeEl) closeWorkspaceModal(modalId);

      const markerToggleEl = target.closest && target.closest("[data-doc-marker-toggle]");
      if (markerToggleEl) {
        const ui = getWorkspaceUi(modalId);
        ui.showMarkers = ui.showMarkers === false;
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        if (tc) {
          const body = modalEl.querySelector(".modal__body");
          if (body) body.innerHTML = modalId === "shipment-workspace-modal" ? renderShipmentWorkspace(tc) : renderSiWorkspace(tc);
        }
        return;
      }

      const zoomEl = target.closest && target.closest("[data-doc-zoom]");
      if (zoomEl) {
        const ui = getWorkspaceUi(modalId);
        if (!ui.activeDocId) return;
        const deltaRaw = zoomEl.getAttribute("data-doc-zoom");
        const delta = Number(deltaRaw);
        if (!Number.isFinite(delta)) return;
        const current = typeof ui.zoomByDocId[ui.activeDocId] === "number" ? ui.zoomByDocId[ui.activeDocId] : 100;
        ui.zoomByDocId[ui.activeDocId] = clamp(current + delta, 80, 160);
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        if (tc) {
          const body = modalEl.querySelector(".modal__body");
          if (body) body.innerHTML = modalId === "shipment-workspace-modal" ? renderShipmentWorkspace(tc) : renderSiWorkspace(tc);
        }
        return;
      }

      const thumbEl = target.closest && target.closest("[data-doc-thumb]");
      if (thumbEl) {
        const ui = getWorkspaceUi(modalId);
        if (!ui.activeDocId) return;
        const idxRaw = thumbEl.getAttribute("data-doc-thumb");
        const idx = Number(idxRaw);
        if (!Number.isFinite(idx)) return;
        ui.activePageByDocId[ui.activeDocId] = Math.max(0, idx);
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        if (tc) {
          const body = modalEl.querySelector(".modal__body");
          if (body) body.innerHTML = modalId === "shipment-workspace-modal" ? renderShipmentWorkspace(tc) : renderSiWorkspace(tc);
        }
        return;
      }

      const tabEl = target.closest && target.closest("[data-doc-tab]");
      if (tabEl) {
        const docId = tabEl.getAttribute("data-doc-tab");
        const viewerKey = tabEl.getAttribute("data-workspace-viewer") || "";
        const ui = getWorkspaceUi(modalId);
        if (docId) {
          ui.activeDocId = docId;
          ui.activePageByDocId[docId] = 0;
        }
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        if (tc) {
          const body = modalEl.querySelector(".modal__body");
          if (body) body.innerHTML = modalId === "shipment-workspace-modal" ? renderShipmentWorkspace(tc) : renderSiWorkspace(tc);
        }
        return;
      }

      const prevEl = target.closest && target.closest("[data-doc-prev]");
      const nextEl = target.closest && target.closest("[data-doc-next]");
      if (prevEl || nextEl) {
        const ui = getWorkspaceUi(modalId);
        if (!ui.activeDocId) return;
        const documents = modalId === "shipment-workspace-modal" ? buildShipmentWorkspaceDocuments(getTradeCaseById(modalEl.getAttribute("data-tradecase-id") || "")) : buildSiWorkspaceDocuments(getTradeCaseById(modalEl.getAttribute("data-tradecase-id") || ""));
        const activeDoc = Array.isArray(documents) ? documents.find((d) => d && d.id === ui.activeDocId) : null;
        const pageCount = activeDoc && Array.isArray(activeDoc.mockPages) ? activeDoc.mockPages.length : 1;
        const current = typeof ui.activePageByDocId[ui.activeDocId] === "number" ? ui.activePageByDocId[ui.activeDocId] : 0;
        const nextPage = clamp(current + (nextEl ? 1 : -1), 0, Math.max(0, pageCount - 1));
        ui.activePageByDocId[ui.activeDocId] = nextPage;
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        if (tc) {
          const body = modalEl.querySelector(".modal__body");
          if (body) body.innerHTML = modalId === "shipment-workspace-modal" ? renderShipmentWorkspace(tc) : renderSiWorkspace(tc);
        }
        return;
      }
    });
  };

  attach(shipment, "shipment-workspace-modal");
  attach(si, "si-workspace-modal");
}

function setupOperationalThreadModal() {
  const modal = document.getElementById("operational-thread-modal");
  if (!modal) return;
  modal.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    const closeEl = target.closest && target.closest("[data-close-op-thread]");
    if (closeEl) {
      closeOperationalThreadModal();
      renderApp();
      return;
    }

    const opThreadActionEl = target.closest && target.closest("[data-op-thread-action]");
    if (opThreadActionEl) {
      if (opThreadActionEl.classList && opThreadActionEl.classList.contains("is-disabled")) return;
      const action = opThreadActionEl.getAttribute("data-op-thread-action") || "";
      const threadId = opThreadActionEl.getAttribute("data-op-thread-id") || "";
      const messageId = opThreadActionEl.getAttribute("data-op-message-id") || "";
      handleOperationalThreadAction({ action, threadId, messageId });
      return;
    }

    const reqActionEl = target.closest && target.closest("[data-req-action]");
    if (reqActionEl) {
      if (reqActionEl.classList && reqActionEl.classList.contains("is-disabled")) return;
      const action = reqActionEl.getAttribute("data-req-action") || "";
      const threadId = reqActionEl.getAttribute("data-req-thread") || "";
      handleRequestsAction({ action, threadId });
      return;
    }
  });
}

// Manual upload modal (separate from trade case detail modal)
function setupManualModal() {
  const manual = document.getElementById("manual-modal");
  if (!manual) return;

  const btn = document.getElementById("btn-manual-add");
  if (btn) btn.addEventListener("click", () => {
    manual.classList.add("is-open");
    manual.setAttribute("aria-hidden", "false");
    // render inbox items inside the modal
    renderInbox();
  });

  manual.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    if (target.matches("[data-close]")) {
      manual.classList.remove("is-open");
      manual.setAttribute("aria-hidden", "true");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (manual.classList.contains("is-open")) {
        manual.classList.remove("is-open");
        manual.setAttribute("aria-hidden", "true");
      }
    }
  });
}

function seed() {
  state.tradeCases = mockTradeCases.map((c) => {
    const incidents = detectIncidents(c);
    const proposals = proposeActions(c, incidents);
    return { ...c, incidents, nextActions: proposals };
  });
  const sortedIds = state.tradeCases
    .map((c) => (c && c.id ? c.id : ""))
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(a).localeCompare(String(b)));
  state.issueSeqByTradeCaseId = {};
  for (let i = 0; i < sortedIds.length; i++) state.issueSeqByTradeCaseId[sortedIds[i]] = i + 1;
  seedRequestsMock();
  seedActivityFeedMock();
  renderApp();
}

function seedRequestsMock() {
  const raw1Id = `raw-${shortId()}`;
  const raw2Id = `raw-${shortId()}`;
  const t11 = `thr-${shortId()}`;
  const t12 = `thr-${shortId()}`;
  const t21 = `thr-${shortId()}`;

  state.rawRequests = [
    {
      id: raw1Id,
      source: "teams",
      from: "営業A",
      text: "PLまだ？あとSI-224も確認して",
      receivedAt: "2026-05-12 13:40",
      aiThreads: [
        {
          id: t11,
          title: "PL未着確認",
          linkedShipmentId: "SHP-2026-009",
          linkedIssueId: "ISS-0002",
          status: "existing issue updated",
          action: "Add comment to existing Issue",
          messages: [
            {
              id: `msg-${shortId()}`,
              role: "requester",
              sender: "営業A",
              text: "PLまだ？",
              createdAt: "2026-05-12T04:40:00.000Z",
            },
            {
              id: `msg-${shortId()}`,
              role: "agent",
              sender: "trade-shelf-agent",
              text: "まだ未着です。5/11 14:02 に ACME Components へ催促済みです。",
              createdAt: "2026-05-12T04:41:10.000Z",
              evidence: [
                { label: "Email: Re: PL pending for SHP-2026-009", type: "email", refId: "mail-pl-pending" },
                { label: "Document status: PL missing", type: "document", refId: "PL" },
                { label: "Shipment: SHP-2026-009", type: "shipment", refId: "SHP-2026-009" },
                { label: "Issue: ISS-0002", type: "issue", refId: "ISS-0002" },
              ],
            },
            {
              id: `msg-${shortId()}`,
              role: "requester",
              sender: "営業A",
              text: "じゃあもう一回PUSHして",
              createdAt: "2026-05-12T04:42:00.000Z",
            },
            {
              id: `msg-${shortId()}`,
              role: "agent",
              sender: "trade-shelf-agent",
              text: "仕入先への再確認メール案を作成しました。送信してよいですか？",
              createdAt: "2026-05-12T04:42:40.000Z",
              evidence: [
                { label: "Shipment: SHP-2026-009", type: "shipment", refId: "SHP-2026-009" },
                { label: "Issue: ISS-0002", type: "issue", refId: "ISS-0002" },
                { label: "Document status: PL missing", type: "document", refId: "PL" },
              ],
              proposedAction: {
                label: "Draft supplier push email",
                type: "sendSupplierPush",
                draftBody:
                  "Subject: PL pending for SHP-2026-009\n\nHello ACME Components,\n\nWe still haven't received the Packing List for SHP-2026-009.\nCould you please share it at your earliest convenience?\n\nBest regards,\nTrade Shelf Ops",
              },
            },
          ],
        },
        {
          id: t12,
          title: "SI-224確認",
          linkedSiNo: "SI-2026-224",
          status: "new issue candidate",
          action: "Create new Issue",
        },
      ],
    },
    {
      id: raw2Id,
      source: "teams",
      from: "営業B",
      text: "Customer C、AIR必要か見て",
      receivedAt: "2026-05-12 13:45",
      aiThreads: [
        {
          id: t21,
          title: "AIR必要性確認",
          linkedSiNo: "SI-2026-001",
          linkedShipmentId: "SHP-2026-009",
          linkedCustomer: "Customer C",
          status: "needs sales confirmation",
          action: "Draft Teams confirmation",
        },
      ],
    },
  ];
  state.activeRawRequestId = raw1Id;
  state.activeOperationalThreadId = t11;
}

function seedActivityFeedMock() {
  const findTcByShipmentId = (shipmentId) =>
    (Array.isArray(state.tradeCases) ? state.tradeCases : []).find((c) => c && c.shipmentEntity && String(c.shipmentEntity.id) === String(shipmentId)) || null;

  const findTcBySiNo = (siNo) =>
    (Array.isArray(state.tradeCases) ? state.tradeCases : []).find((c) => c && c.siEntity && String(c.siEntity.siNo) === String(siNo)) || null;

  const issueNoForCase = (tcId) => {
    const n = state.issueSeqByTradeCaseId && typeof state.issueSeqByTradeCaseId[tcId] === "number" ? state.issueSeqByTradeCaseId[tcId] : null;
    const nn = typeof n === "number" && Number.isFinite(n) ? n : 0;
    return `ISS-${String(Math.max(0, nn)).padStart(4, "0")}`;
  };

  const tcShipment = findTcByShipmentId("SHP-2026-009");
  const tcId = tcShipment?.id || findTcBySiNo("SI-2026-001")?.id || "";
  const issueNo = tcId ? issueNoForCase(tcId) : "ISS-0002";

  state.activityFeedItems = [
    {
      id: `act-${shortId()}`,
      type: "teamsReceived",
      source: "teams",
      title: "Teams received",
      actor: "営業A",
      at: "2026-05-12 13:40",
      summary: "「PLまだ？あとSI-224も確認して」",
      details: ["AI classified: PL未着確認 / SI-224確認", `Linked: Issue ${issueNo} / Shipment SHP-2026-009`, "Status: waiting approval"],
      statusKey: "awaitingApproval",
      linked: [
        { kind: "issue", label: issueNo },
        { kind: "shipment", label: "SHP-2026-009" },
      ],
      links: [
        { label: "Open Issue", href: `/#issues/${encodeURIComponent(issueNo)}` },
        { label: "Open Shipment", href: `/#shipments/SHP-2026-009` },
        { label: "Open SI Workspace", href: `/#si/SI-2026-001` },
        { label: "Retry classify", href: `/#retry/classify/${encodeURIComponent(issueNo)}` },
      ],
    },
    {
      id: `act-${shortId()}`,
      type: "emailReceived",
      source: "email",
      title: "Email received",
      actor: "supplier@acme.com",
      at: "2026-05-12 14:12",
      summary: "Attached: PL.pdf",
      details: ["AI processed: Packing List recognized", "Updated: Shipment SHP-2026-009", `Issue ${issueNo} resolved candidate`],
      statusKey: "processing",
      linked: [
        { kind: "shipment", label: "SHP-2026-009" },
        { kind: "issue", label: issueNo },
      ],
      links: [
        { label: "Open Shipment", href: `/#shipments/SHP-2026-009` },
        { label: "Open Issue", href: `/#issues/${encodeURIComponent(issueNo)}` },
      ],
    },
    {
      id: `act-${shortId()}`,
      type: "aiProcessed",
      source: "ai",
      title: "AI processed",
      actor: "trade-shelf-agent",
      at: "2026-05-12 14:13",
      summary: "PL.pdf parsed → document status updated",
      details: ["Confidence: 0.94", "Extraction: cartons / gross weight / HS codes (mock)"],
      statusKey: "success",
      linked: [{ kind: "shipment", label: "SHP-2026-009" }],
      links: [{ label: "Open Shipment", href: `/#shipments/SHP-2026-009` }],
    },
    {
      id: `act-${shortId()}`,
      type: "issueUpdated",
      source: "ai",
      title: "Issue updated",
      actor: "trade-shelf-agent",
      at: "2026-05-12 14:14",
      summary: `${issueNo} status: blocked → review`,
      details: ["Proposed: mark resolved if PL matches SI/INV (mock)"],
      statusKey: "warning",
      linked: [{ kind: "issue", label: issueNo }],
      links: [{ label: "Open Issue", href: `/#issues/${encodeURIComponent(issueNo)}` }],
    },
    {
      id: `act-${shortId()}`,
      type: "escalation",
      source: "system",
      title: "Escalation detected",
      actor: "system",
      at: "2026-05-12 15:02",
      summary: "ETA changed on SHP-2026-009",
      details: ["Old ETA: 2026-05-20 → New ETA: 2026-05-23 (mock)"],
      statusKey: "warning",
      linked: [{ kind: "shipment", label: "SHP-2026-009" }],
      links: [{ label: "Open Shipment", href: `/#shipments/SHP-2026-009` }],
    },
    {
      id: `act-${shortId()}`,
      type: "supplierReply",
      source: "email",
      title: "Supplier reply",
      actor: "sales@acme-components.example",
      at: "2026-05-12 16:18",
      summary: "Re: INV mismatch — will reissue invoice today",
      details: ["Attachment: INV-1122-rev.pdf (mock)"],
      statusKey: "success",
      linked: [{ kind: "issue", label: issueNo }],
      links: [{ label: "Open Issue", href: `/#issues/${encodeURIComponent(issueNo)}` }],
    },
    {
      id: `act-${shortId()}`,
      type: "failedProcessing",
      source: "ai",
      title: "Failed processing",
      actor: "trade-shelf-agent",
      at: "2026-05-12 17:05",
      summary: "Attachment unreadable (mock)",
      details: ["Reason: PDF corrupted", "Action: retry OCR / request resend"],
      statusKey: "failed",
      linked: [],
      links: [{ label: "Retry classify", href: `/#retry/ocr/${shortId()}` }],
    },
  ];
}

function decomposeRawRequestMock(text) {
  const t = String(text || "").trim();
  const out = [];
  const hasPL = /\bPL\b|Packing\s*List|パッキングリスト|梱包明細/i.test(t);
  const hasAIR = /\bAIR\b|航空|air\s*freight/i.test(t);
  const siMatch = t.match(/\bSI[- ]?\d{3,}\b/i);

  if (hasPL) {
    out.push({
      id: `thr-${shortId()}`,
      title: "PL未着確認",
      linkedShipmentId: "SHP-2026-009",
      status: "new issue candidate",
      action: "Create new Issue",
    });
  }
  if (siMatch) {
    out.push({
      id: `thr-${shortId()}`,
      title: `${siMatch[0].toUpperCase().replace(" ", "-")}確認`,
      linkedSiNo: "SI-2026-224",
      status: "new issue candidate",
      action: "Create new Issue",
    });
  }
  if (hasAIR) {
    out.push({
      id: `thr-${shortId()}`,
      title: "AIR必要性確認",
      linkedCustomer: "Customer",
      linkedShipmentId: "SHP-2026-009",
      status: "needs sales confirmation",
      action: "Draft Teams confirmation",
    });
  }
  if (!out.length) {
    out.push({
      id: `thr-${shortId()}`,
      title: "依頼内容の確認",
      status: "needs clarification",
      action: "Draft Teams reply",
    });
  }
  return out;
}

function setupNewTop() {
  const root = document.getElementById("app");
  if (!root) return;

  root.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;

    const tabEl = target.closest && target.closest("[data-nt-tab]");
    if (tabEl) {
      const key = tabEl.getAttribute("data-nt-tab") || "";
      if (newTopTabs.some((t) => t.key === key)) {
        state.topActiveTab = key;
        if (key !== "issues") state.activeIssueId = null;
        if (key !== "requests") state.isOperationalThreadModalOpen = false;
        renderApp();
      }
      return;
    }

    const actFilterEl = target.closest && target.closest("[data-activity-filter]");
    if (actFilterEl) {
      const key = actFilterEl.getAttribute("data-activity-filter") || "all";
      state.activityFilterKey = key || "all";
      renderApp();
      return;
    }

    const actAttachEl = target.closest && target.closest("[data-activity-attach-manual]");
    if (actAttachEl) {
      window.alert("(mock) Open manual attach flow.");
      return;
    }

    const rawOpenEl = target.closest && target.closest("[data-raw-request-open]");
    if (rawOpenEl) {
      const id = rawOpenEl.getAttribute("data-raw-request-open") || "";
      if (id) {
        state.activeRawRequestId = id;
        state.activeOperationalThreadId = null;
        state.isOperationalThreadModalOpen = false;
        renderApp();
      }
      return;
    }

    const thrOpenEl = target.closest && target.closest("[data-operational-thread-open]");
    if (thrOpenEl) {
      const id = thrOpenEl.getAttribute("data-operational-thread-open") || "";
      if (id) {
        state.activeOperationalThreadId = id;
        state.isOperationalThreadModalOpen = true;
        renderApp();
      }
      return;
    }

    const opThreadActionEl = target.closest && target.closest("[data-op-thread-action]");
    if (opThreadActionEl) {
      const action = opThreadActionEl.getAttribute("data-op-thread-action") || "";
      const threadId = opThreadActionEl.getAttribute("data-op-thread-id") || "";
      const messageId = opThreadActionEl.getAttribute("data-op-message-id") || "";
      handleOperationalThreadAction({ action, threadId, messageId });
      return;
    }

    const ingestSampleEl = target.closest && target.closest("[data-ingest-sample]");
    if (ingestSampleEl) {
      state.ingestInputText = "PLまだ？あとSI-224も確認して";
      state.ingestError = "";
      renderApp();
      return;
    }

    const ingestSubmitEl = target.closest && target.closest("[data-ingest-submit]");
    if (ingestSubmitEl) {
      const rawText = String(state.ingestInputText || "").trim();
      if (!rawText) return;
      if (state.ingestLoading) return;

      state.ingestLoading = true;
      state.ingestError = "";
      renderApp();

      (async () => {
        try {
          const payload = await submitMockIngest(rawText);
          if (payload && payload.ok === false) {
            throw new Error(payload.error || "Mock ingest failed");
          }
          const result = payload && payload.result ? payload.result : payload;
          state.latestIngestResult = result || null;

          const events = Array.isArray(result?.activityEvents) ? result.activityEvents.filter(Boolean) : [];
          const feedItems = events.map(activityEventToFeedItem);
          state.activityFeedItems = prependUniqueById(state.activityFeedItems, feedItems);

          const mutationsRaw = Array.isArray(result?.issueMutations) ? result.issueMutations.filter(Boolean) : [];
          const mutations = mutationsRaw.map((m) => ({
            id: `mut:${String(m?.issueId || "")}:${String(m?.action || "")}:${String(m?.title || "")}`,
            issueId: m?.issueId,
            action: m?.action,
            title: m?.title,
            body: m?.body,
          }));
          state.issueMutationItems = prependUniqueById(state.issueMutationItems, mutations);
        } catch (e) {
          state.ingestError = e && e.message ? String(e.message) : "Mock ingest failed";
        } finally {
          state.ingestLoading = false;
          renderApp();
        }
      })();
      return;
    }

    const reqAddEl = target.closest && target.closest("[data-requests-add]");
    if (reqAddEl) {
      const rootPage = reqAddEl.closest && reqAddEl.closest(".req-page");
      const box = rootPage && rootPage.querySelector ? rootPage.querySelector("[data-requests-input]") : null;
      const text = box && typeof box.value === "string" ? box.value.trim() : "";
      if (box) box.value = "";
      if (text) {
        const id = `raw-${shortId()}`;
        const at = formatLocalTime(nowIso());
        const item = {
          id,
          source: "web",
          from: "Web UI",
          text,
          receivedAt: at,
          aiThreads: decomposeRawRequestMock(text),
        };
        state.rawRequests = [item, ...(Array.isArray(state.rawRequests) ? state.rawRequests : [])];
        state.activeRawRequestId = id;
        state.activeOperationalThreadId = (item.aiThreads[0] && item.aiThreads[0].id) || null;
        renderApp();
      }
      return;
    }

    const reqActionEl = target.closest && target.closest("[data-req-action]");
    if (reqActionEl) {
      const action = reqActionEl.getAttribute("data-req-action") || "";
      const threadId = reqActionEl.getAttribute("data-req-thread") || "";
      if (reqActionEl.classList && reqActionEl.classList.contains("is-disabled")) return;
      handleRequestsAction({ action, threadId });
      return;
    }

    const shelfViewEl = target.closest && target.closest("[data-shelf-view]");
    if (shelfViewEl) {
      const nextMode = shelfViewEl.getAttribute("data-shelf-view") || "si";
      state.shelfViewMode = nextMode === "shipments" ? "shipments" : "si";
      renderApp();
      return;
    }

    const openShipmentEl = target.closest && target.closest("[data-open-shipment]");
    if (openShipmentEl) {
      openShipmentWorkspace(openShipmentEl.getAttribute("data-open-shipment") || "");
      return;
    }

    const openSiEl = target.closest && target.closest("[data-open-si]");
    if (openSiEl) {
      openSiWorkspace(openSiEl.getAttribute("data-open-si") || "");
      return;
    }

    const openIssueEl = target.closest && target.closest("[data-open-issue]");
    if (openIssueEl) {
      // (legacy) keep backward compatibility
      openShipmentWorkspace(openIssueEl.getAttribute("data-open-issue") || "");
      return;
    }

    const issueOpenEl = target.closest && target.closest("[data-issue-open]");
    if (issueOpenEl) {
      const id = issueOpenEl.getAttribute("data-issue-open") || "";
      state.activeIssueId = id || null;
      renderApp();
      return;
    }

    const issueBackEl = target.closest && target.closest("[data-issue-back]");
    if (issueBackEl) {
      state.activeIssueId = null;
      renderApp();
      return;
    }

    const issueAddCommentEl = target.closest && target.closest("[data-issue-add-comment]");
    if (issueAddCommentEl) {
      const id = issueAddCommentEl.getAttribute("data-issue-add-comment") || "";
      const rootEl = issueAddCommentEl.closest && issueAddCommentEl.closest(".issue-detail");
      const box = rootEl && rootEl.querySelector ? rootEl.querySelector("[data-issue-comment-box]") : null;
      const text = box && typeof box.value === "string" ? box.value.trim() : "";
      if (id && text) {
        recordTimelineEvent(id, {
          id: shortId(),
          at: nowIso(),
          type: "humanComment",
          label: "Human comment",
          actor: "ops-user",
          message: text,
        });
        if (box) box.value = "";
      }
      renderApp();
      return;
    }

    const openShipmentFromIssueEl = target.closest && target.closest("[data-issue-open-shipment]");
    if (openShipmentFromIssueEl) {
      openShipmentWorkspace(openShipmentFromIssueEl.getAttribute("data-issue-open-shipment") || "");
      return;
    }

    const openSiFromIssueEl = target.closest && target.closest("[data-issue-open-si]");
    if (openSiFromIssueEl) {
      openSiWorkspace(openSiFromIssueEl.getAttribute("data-issue-open-si") || "");
      return;
    }

    const openCaseFromIssueEl = target.closest && target.closest("[data-issue-open-case]");
    if (openCaseFromIssueEl) {
      const id = openCaseFromIssueEl.getAttribute("data-issue-open-case") || "";
      const tc = id ? getTradeCaseById(id) : null;
      if (tc) {
        openTradeCaseDetail(tc);
      }
      return;
    }

    const openNewFromIssueEl = target.closest && target.closest("[data-issue-open-new]");
    if (openNewFromIssueEl) {
      openNewWindow(openNewFromIssueEl.getAttribute("data-issue-open-new") || "");
      return;
    }

    const issueApproveEl = target.closest && target.closest("[data-issue-approve]");
    if (issueApproveEl) {
      const id = issueApproveEl.getAttribute("data-issue-approve") || "";
      agentRunApproveSend(id);
      renderApp();
      return;
    }

    const issueHoldEl = target.closest && target.closest("[data-issue-hold]");
    if (issueHoldEl) {
      const id = issueHoldEl.getAttribute("data-issue-hold") || "";
      agentRunHold(id);
      renderApp();
      return;
    }

    const issueEditEl = target.closest && target.closest("[data-issue-edit]");
    if (issueEditEl) {
      const id = issueEditEl.getAttribute("data-issue-edit") || "";
      agentRunEdit(id);
      renderApp();
      return;
    }

    const issueEscalateEl = target.closest && target.closest("[data-issue-escalate]");
    if (issueEscalateEl) {
      const id = issueEscalateEl.getAttribute("data-issue-escalate") || "";
      recordHumanIntervention(id, { actionType: "issueEscalate", label: "Escalate", note: "manual escalation" });
      log(`エスカレーション（mock）: ${id}`);
      renderApp();
      return;
    }

    const evidenceFilterEl = target.closest && target.closest("[data-evidence-filter]");
    if (evidenceFilterEl) {
      const key = evidenceFilterEl.getAttribute("data-evidence-filter") || "all";
      const allowed = ["all", "documents", "emails", "teams", "issues", "sentLogs", "decisions", "aiLogs", "archived"];
      state.evidenceFilterKey = allowed.includes(key) ? key : "all";
      renderApp();
      return;
    }

    const evidenceOpenIssueEl = target.closest && target.closest("[data-evidence-open-issue]");
    if (evidenceOpenIssueEl) {
      const tradeCaseId = evidenceOpenIssueEl.getAttribute("data-evidence-open-issue") || "";
      if (tradeCaseId) {
        state.topActiveTab = "issues";
        state.activeIssueId = tradeCaseId;
        renderApp();
      }
      return;
    }

    const evidenceOpenEl = target.closest && target.closest("[data-evidence-open]");
    if (evidenceOpenEl) {
      const id = evidenceOpenEl.getAttribute("data-evidence-open") || "";
      const item = (getMockEvidenceArchiveItems() || []).find((x) => x && String(x.id) === String(id)) || null;
      if (!item) {
        window.alert("(mock) Evidence not found.");
        return;
      }
      if (String(item.type) === "Issue") {
        if (item.tradeCaseId) {
          state.topActiveTab = "issues";
          state.activeIssueId = String(item.tradeCaseId);
          renderApp();
        } else {
          window.alert("(mock) Issue link is missing.");
        }
        return;
      }

      const preview = item.preview || null;
      const title = String(item.title || "Evidence preview");
      if (preview && preview.kind === "document") {
        const body = String(preview.body || "");
        openModal({ title: title || "Document", bodyHtml: `<div class="evidence-preview-modal">
          <div class="evidence-preview-modal__kind">Document viewer（mock）</div>
          <pre class="evidence-preview-modal__pre">${escapeHtml(body)}</pre>
        </div>` });
        return;
      }

      if (preview && preview.kind === "message") {
        const from = String(preview.from || "—");
        const to = String(preview.to || "");
        const subject = String(preview.subject || "");
        const body = String(preview.body || "");
        openModal({
          title: title || "Message",
          bodyHtml: `<div class="evidence-preview-modal">
            <div class="evidence-preview-modal__kind">Message preview（mock）</div>
            <div class="evidence-preview-meta">
              <div class="evidence-preview-meta__row"><div class="evidence-preview-meta__k">From</div><div class="evidence-preview-meta__v">${escapeHtml(from)}</div></div>
              ${to ? `<div class="evidence-preview-meta__row"><div class="evidence-preview-meta__k">To</div><div class="evidence-preview-meta__v">${escapeHtml(to)}</div></div>` : ""}
              ${subject ? `<div class="evidence-preview-meta__row"><div class="evidence-preview-meta__k">Subject</div><div class="evidence-preview-meta__v">${escapeHtml(subject)}</div></div>` : ""}
            </div>
            <pre class="evidence-preview-modal__pre">${escapeHtml(body)}</pre>
          </div>`,
        });
        return;
      }

      openModal({ title, bodyText: "(mock) Preview is not available." });
      return;
    }

    const ingestionEl = target.closest && target.closest("[data-open-ingestion]");
    if (ingestionEl) {
      openIngestionModal();
      return;
    }
  });

  root.addEventListener("input", (e) => {
    const target = e.target;
    if (!target) return;
    const ingestEl = target.closest && target.closest("[data-ingest-input]");
    if (ingestEl) {
      state.ingestInputText = typeof ingestEl.value === "string" ? ingestEl.value : "";
      return;
    }
    const searchEl = target.closest && target.closest("[data-evidence-search]");
    if (searchEl) {
      state.evidenceSearchQuery = typeof searchEl.value === "string" ? searchEl.value : "";
      renderApp();
    }
  });

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const target = e.target;
    if (!target) return;
    const openShipmentEl = target.closest && target.closest("[data-open-shipment]");
    if (openShipmentEl) {
      openShipmentWorkspace(openShipmentEl.getAttribute("data-open-shipment") || "");
      return;
    }
    const openSiEl = target.closest && target.closest("[data-open-si]");
    if (openSiEl) {
      openSiWorkspace(openSiEl.getAttribute("data-open-si") || "");
      return;
    }
    const openIssueEl = target.closest && target.closest("[data-open-issue]");
    if (openIssueEl) {
      openShipmentWorkspace(openIssueEl.getAttribute("data-open-issue") || "");
      return;
    }

    const issueOpenEl = target.closest && target.closest("[data-issue-open]");
    if (issueOpenEl) {
      const id = issueOpenEl.getAttribute("data-issue-open") || "";
      state.activeIssueId = id || null;
      renderApp();
      return;
    }
  });

  const modal = document.getElementById("ingestion-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;
      const closeEl = t.closest && t.closest("[data-close]");
      if (closeEl) closeIngestionModal();
    });
  }
}

function main() {
  setupModal();
  setupWorkspaceModals();
  setupOperationalThreadModal();
  seed();
  setupNewTop();
  renderApp();
}

main();

import {
  analyzeImpact,
  detectIncidents,
  mockTradeCases,
  proposeActions,
  resolveCanonicalConversation,
  resolveCanonicalIssueLink,
} from "@trade-shelf/shared";
import { createShelfRenderer, renderShelfPreviewHtml } from "./components/shelf.js";
import { createDocumentWorkspaceRenderer } from "./components/documentWorkspace.js";
import { createApprovalCenterRenderer } from "./components/approvalCenter.js";

const API_BASE_URL = (() => {
  const raw = window.TRADE_SHELF_API_BASE_URL;
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return "";
  return v.endsWith("/") ? v.slice(0, -1) : v;
})();

let serverActivityPollTimer = null;
let slackStatusPollTimer = null;
let demoApprovalsPollTimer = null;

const DEBUG_UI_LOGS = Boolean(window && window.TRADE_SHELF_DEBUG_UI_LOGS);

const TOP_TAB_PATHS = {
  shelf: "/shelf",
  issues: "/approvals",
  activity: "/activity",
  settings: "/settings",
};

function topTabFromPath(pathname) {
  const p = String(pathname || "");
  if (p.startsWith("/approvals")) return "issues";
  if (p.startsWith("/activity")) return "activity";
  if (p.startsWith("/settings")) return "settings";
  return "shelf";
}

function syncUrlForTopTab(nextTab, { replace = false } = {}) {
  const tab = String(nextTab || "");
  const nextPath = TOP_TAB_PATHS[tab] || TOP_TAB_PATHS.shelf;
  if (!nextPath || typeof history === "undefined") return;
  if (window.location && window.location.pathname === nextPath) return;
  if (replace) history.replaceState({ tab }, "", nextPath);
  else history.pushState({ tab }, "", nextPath);
}

function setTopActiveTab(nextTab, { push = false, replace = false } = {}) {
  const tab = TOP_TAB_PATHS[String(nextTab || "")] ? String(nextTab || "") : "shelf";
  state.topActiveTab = tab;
  if (tab !== "issues") {
    state.activeIssueId = null;
    state.activeMutationId = null;
    state.isOperationalThreadModalOpen = false;
  }
  if (push) syncUrlForTopTab(tab, { replace: false });
  if (replace) syncUrlForTopTab(tab, { replace: true });
  renderApp();
  scheduleServerActivityPoll();
  scheduleSlackStatusPoll();
  scheduleDemoApprovalsPoll();
}

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

const DEMO_DOCUMENTS = {
  "SI-2026-001": "/demo-docs/SI-2026-001.png",
};

const state = {
  inboxItems: [],
  tradeCases: [],
  shelfItems: [],
  /**
   * Document Workspace の「人間メモ」（mock; 永続化なし）
   * @type {Array<{ id: string, body: string, linkedEntities: Array<{ type: string, id: string }>, aiShared: boolean, createdAt: string, updatedAt: string }>}
   */
  humanMemos: [],
  /**
   * Human memo add/edit modal state (Document Workspace)
   * @type {{ mode: "create" | "edit", memoId?: string, focusType: string, focusId: string, tradeCaseId: string, bodyDraft: string, selectedEntities: Array<{ type: string, id: string }> } | null}
   */
  activeHumanMemoEdit: null,
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
   * Classification mode toggle (Requests page)
   * @type {"mock" | "llm"}
   */
  classifyMode: "llm",
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
   * Mock ingest notice text (Requests page)
   * @type {string}
   */
  ingestNotice: "",
  /**
   * Latest mock ingest result payload (Requests page)
   * @type {any}
   */
  latestIngestResult: null,
  /**
   * StateTransitionCandidate の手動反映済みID（manual apply）
   * @type {string[]}
   */
  appliedStateTransitionCandidateIds: [],
  /**
   * Latest ingest result mode ("mock" | "llm")
   * @type {"mock" | "llm" | null}
   */
  latestIngestResultMode: null,
  /**
   * Mock approval states (actionPlanId -> { status, updatedAt })
   * @type {Record<string, { status: string, updatedAt: string }>}
   */
  approvalsByActionPlanId: {},
  /**
   * Pending clarification queue (mock)
   * @type {Array<any>}
   */
  pendingClarifications: [],
  /**
   * Active raw request id in Requests page
   * @type {string | null}
   */
  activeRawRequestId: null,
  /**
   * Selected conversation id in Requests page (Inbox / Conversation Hub)
   * @type {string | null}
   */
  selectedConversationId: null,
  /**
   * Active conversation thread id in Requests page
   * @type {string | null}
   */
  activeConversationThreadId: null,
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
   * Issues（承認センター）で開いている Issue detail の tradeCaseId
   * @type {string | null}
   */
  activeIssueId: null,
  /**
   * 承認センターで開いている LLM mutation detail の id
   * @type {string | null}
   */
  activeMutationId: null,
  /**
   * 承認センターで開いている「確認返信候補」の actionPlanId
   * @type {string | null}
   */
  activeReplyCandidateId: null,
  /**
   * 承認センターで開いている draft edit modal の actionPlanId
   * @type {string | null}
   */
  activeDraftEditActionPlanId: null,
  /**
   * 承認センター（Issues）右カラム折りたたみ状態（変更・確認依頼）
   * @type {boolean}
   */
  approvalCenterRightPanelCollapsed: false,
  /**
   * tradeCaseId -> sequential issue number (1-based)
   * @type {Record<string, number>}
   */
  issueSeqByTradeCaseId: {},
  /**
   * New TOP (GitHub-like) active tab
   * @type {"shelf" | "issues" | "activity" | "settings"}
   */
  topActiveTab: "shelf",
  /**
   * Activity Feed items (mock)
   * @type {Array<any>}
   */
  activityFeedItems: [],
  /**
   * Activity Feed expanded state (id -> boolean)
   * @type {Record<string, boolean>}
   */
  activityExpandedById: {},
  /**
   * Latest Issue mutations (mock ingest)
   * @type {Array<any>}
   */
  issueMutationItems: [],
  /**
   * Execution Timeline Agent 由来の internal issue candidates（mock）
   * @type {Array<any>}
   */
  timelineIssueCandidates: [],
  /**
   * Activity Feed filter key
   * @type {"all" | "teams" | "email" | "slack" | "aiProcessed" | "awaitingApproval" | "failed" | "supplierReply"}
   */
  activityFilterKey: "all",
  /**
   * Slack integration status (mock-ish; fetched from API)
   * @type {{ status: "connected" | "unknown", lastReceivedAt: string | null } | null}
   */
  slackIntegrationStatus: null,
  /**
   * Hackathon demo approvals pushed from server (unknown SI -> add to Shelf)
   * @type {Array<any>}
   */
  demoApprovals: [],
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
  /**
   * Shelf search query (Shelf page)
   * @type {string}
   */
  shelfSearchQuery: "",
  /**
   * Shelf hover preview state
   * @type {null | { itemId: string, left: number, top: number }}
   */
  activeShelfPreview: null,
  /**
   * Shelf preview payload lookup (itemId -> payload)
   * @type {Record<string, any>}
   */
  shelfPreviewPayloadById: {},
  /**
   * Execution Timeline Scenario modal (Document Workspace)
   * @type {null | { tradeCaseId: string, focusType: string, focusId: string }}
   */
  activeTimelineScenarioModal: null,
};

const documentWorkspaceRenderer = createDocumentWorkspaceRenderer({
  state,
  escapeHtml,
  uniqStrings,
  normalizeFocusType,
  normalizeInvoiceNo,
  detectIncidents,
  buildDocumentWorkspaceDocuments,
  resolveInitialDocId,
  resolveFocusDocId,
  getWorkspaceUi,
  ensureWorkspaceUiDefaults,
  renderDocumentTabs,
  renderDocumentViewer,
  formatFocusLabel,
  prependUniqueById,
  nowIso,
  matchesMutationId,
  activityEventToFeedItem,
});

const newTopTabs = [
  { key: "shelf", label: "棚", subLabel: "Shelf" },
  /**
   * 承認センター（Approval Center）
   *
   * ここは「すべての Issue / Incident を表示する場所」ではない想定。
   * 主に以下を扱う:
   * - external action（メール送信 / 外部取引先への確認依頼 / 外部システム反映 など）の pending approval
   * - high-risk な human decision が必要なもの
   *
   * Incident（検知結果）や通常の State Transition（内部状態遷移）は、
   * すべてをここへ流すのではなく、後段で評価・選別される。
   */
  { key: "issues", label: "承認センター", subLabel: "Approvals" },
  { key: "activity", label: "活動ログ", subLabel: "Activity" },
  { key: "settings", label: "Settings", subLabel: "" },
];

function openShipmentWorkspace(tradeCaseId) {
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  if (!tc) return;
  const shipmentId = String(tc?.shipmentEntity?.id || "").trim();
  openDocumentWorkspace(tc.id, "shipment", shipmentId || "-", "shipment");
}

function openSiWorkspace(tradeCaseId) {
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  if (!tc) return;
  const siNo = String(tc?.siEntity?.siNo || "").trim();
  openDocumentWorkspace(tc.id, "si", siNo || "-", "si");
}

function normalizeInvoiceNo(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^inv[-\s_]*\d+/i.test(s)) return `INV-${s.replace(/^inv[-\s_]*/i, "").trim()}`;
  return s;
}

function normalizeFocusType(input) {
  const t = String(input || "").trim().toLowerCase();
  if (t === "si") return "si";
  if (t === "invoice" || t === "inv") return "invoice";
  if (t === "packing_list" || t === "packinglist" || t === "pl") return "packing_list";
  if (t === "bl") return "bl";
  if (t === "shipment") return "shipment";
  if (t === "document" || t === "doc") return "document";
  if (t === "case" || t === "tradecase" || t === "trade_case") return "case";
  return "case";
}

function formatFocusLabel(focusType, focusId) {
  const type = normalizeFocusType(focusType);
  const id = String(focusId || "").trim();
  if (!id || id === "-") {
    if (type === "si") return "SI -";
    if (type === "invoice") return "INV -";
    if (type === "packing_list") return "PL -";
    if (type === "bl") return "BL -";
    if (type === "shipment") return "Shipment -";
    if (type === "document") return "Document -";
    return "Case -";
  }
  if (type === "si") return id;
  if (type === "invoice") return normalizeInvoiceNo(id);
  if (type === "packing_list") return id;
  if (type === "bl") return id;
  if (type === "shipment") return id;
  if (type === "document") return id;
  return `Case ${id}`;
}

function resolveFocusDocId({ focusType, focusId, documents }) {
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  if (!docs.length) return null;
  const type = normalizeFocusType(focusType);
  const id = String(focusId || "").trim();
  if (!id) return null;

  if (type === "si") {
    return (
      docs.find((d) => String(d?.id || "").startsWith("si-"))?.id ||
      docs.find((d) => String(d?.label || "") === id)?.id ||
      null
    );
  }
  if (type === "invoice") {
    const target = invoiceDocId(id);
    return (
      docs.find((d) => String(d?.id || "") === target)?.id ||
      docs.find((d) => String(d?.label || "") === normalizeInvoiceNo(id))?.id ||
      null
    );
  }
  if (type === "shipment") {
    return docs.find((d) => String(d?.id || "") === "shipment")?.id || docs.find((d) => String(d?.label || "") === id)?.id || null;
  }
  if (type === "document") {
    return docs.find((d) => String(d?.id || "") === id)?.id || docs.find((d) => String(d?.label || "") === id)?.id || null;
  }
  if (type === "case") return null;

  return null;
}

function focusFromDoc({ docId, docLabel, tradeCase }) {
  const tc = tradeCase || null;
  const id = String(docId || "").trim();
  const label = String(docLabel || "").trim();
  if (!id) return { focusType: "case", focusId: tc?.id ? String(tc.id) : "-" };

  if (id.startsWith("si-")) return { focusType: "si", focusId: String(tc?.siEntity?.siNo || label || "-") };
  if (id === "shipment") return { focusType: "shipment", focusId: String(tc?.shipmentEntity?.id || "-") };
  if (id.startsWith("inv-")) return { focusType: "invoice", focusId: label || "-" };

  return { focusType: "document", focusId: label || id };
}

function invoiceDocId(invoiceNo) {
  const inv = normalizeInvoiceNo(invoiceNo);
  if (!inv) return "";
  return inv.toLowerCase().replace(/^inv-/, "inv-");
}

function resolveInitialDocId(initialDocId, documents) {
  const raw = String(initialDocId || "").trim();
  if (!raw) return null;
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  if (!docs.length) return null;

  const byId = new Map(docs.map((d) => [String(d.id || ""), d]));
  if (byId.has(raw)) return raw;

  const lower = raw.toLowerCase();
  if (lower === "si") {
    const siDoc = docs.find((d) => String(d.id || "").startsWith("si-")) || docs.find((d) => String(d.type || "").toLowerCase().includes("shipping"));
    return siDoc ? siDoc.id : null;
  }
  if (lower === "inv") {
    const invDoc = docs.find((d) => String(d.id || "").startsWith("inv-")) || docs.find((d) => String(d.type || "").toLowerCase().includes("invoice"));
    return invDoc ? invDoc.id : null;
  }
  if (lower === "pl") {
    const plDoc = docs.find((d) => String(d.id || "").includes("pl")) || docs.find((d) => String(d.type || "").toLowerCase().includes("packing"));
    return plDoc ? plDoc.id : null;
  }
  if (lower === "bl") {
    const blDoc = docs.find((d) => String(d.id || "").startsWith("bl-")) || docs.find((d) => String(d.type || "").toLowerCase().includes("b/l"));
    return blDoc ? blDoc.id : null;
  }
  if (/^inv[-\s_]*\d+/i.test(raw) || /^inv-\d+/i.test(lower)) {
    const id = invoiceDocId(raw);
    return byId.has(id) ? id : null;
  }
  return null;
}

function openDocumentWorkspace(tradeCaseId, focusType, focusId, initialDocId) {
  console.log("[openDocumentWorkspace entered]", {
    tradeCaseId,
    focusType,
    focusId,
    initialDocId,
  });

  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  if (!tc) return;
  state.modalTradeCaseId = tc.id;
  const type = normalizeFocusType(focusType);
  const id = String(focusId || "").trim();
  const documents = buildDocumentWorkspaceDocuments(tc, type, id);

  const ui = getWorkspaceUi("document-workspace-modal");
  ui.focusType = type;
  ui.focusId = id || "-";

  const resolvedInitial = resolveInitialDocId(initialDocId, documents);
  const resolvedFocus = resolveFocusDocId({ focusType: type, focusId: id, documents });
  const resolved = resolvedFocus || resolvedInitial;
  if (resolved) {
    ui.activeDocId = resolved;
    ui.activePageByDocId[resolved] = 0;
  }

  const headerLabels = documentWorkspaceRenderer.buildWorkspaceHeaderLabels({ tradeCase: tc, focusType: type, focusId: id });
  openWorkspaceModal("document-workspace-modal", {
    title: "Document Workspace",
    titleHtml: renderWorkspaceTitleHtml(headerLabels),
    bodyHtml: documentWorkspaceRenderer.renderDocumentWorkspace(tc, {
      focusType: type,
      focusId: id,
      initialDocId,
      stateTransitionCandidates: state.latestIngestResult?.stateTransitionCandidates ?? [],
    }),
    tradeCaseId: tc.id,
  });

  console.log("[openDocumentWorkspace state]", {
    modalOpen: document.getElementById("document-workspace-modal")?.classList.contains("is-open"),
  });
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

function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const opts = { ...(options || {}), signal: controller.signal };
  return fetch(url, opts).finally(() => window.clearTimeout(timer));
}

function normalizeServerActivityFeedItem(item) {
  const it = item && typeof item === "object" ? item : {};
  const id = String(it.id || "").trim();
  if (!id) return null;
  const occurredAt = String(it.occurredAt || "").trim();
  const resolvedOccurredAt = occurredAt && !Number.isNaN(Date.parse(occurredAt)) ? occurredAt : nowIso();
  const at = it.at ? String(it.at) : formatLocalTime(resolvedOccurredAt);
  return {
    ...it,
    id,
    occurredAt: resolvedOccurredAt,
    at,
    source: String(it.source || "").trim() || "unknown",
    title: String(it.title || "").trim(),
    actor: String(it.actor || "").trim(),
    statusKey: String(it.statusKey || "").trim() || "success",
    details: Array.isArray(it.details) ? it.details.filter(Boolean).map((d) => String(d)) : [],
  };
}

async function fetchServerActivityFeed() {
  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/activity`, { method: "GET" }, 12000);
    if (!response.ok) return;
    const json = await response.json();
    const itemsRaw = Array.isArray(json?.items) ? json.items : [];
    const normalized = itemsRaw.map(normalizeServerActivityFeedItem).filter(Boolean);
    if (!normalized.length) return;
    state.activityFeedItems = prependUniqueById(state.activityFeedItems, normalized);
    renderApp();
  } catch {
    // ignore (demo)
  }
}

async function fetchSlackIntegrationStatus() {
  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/slack/status`, { method: "GET" }, 12000);
    if (!response.ok) return;
    const json = await response.json();
    const status = json && json.status === "connected" ? "connected" : "unknown";
    const lastReceivedAt = json && typeof json.lastReceivedAt === "string" ? json.lastReceivedAt : null;
    state.slackIntegrationStatus = { status, lastReceivedAt };
    renderApp();
  } catch {
    // ignore (demo)
  }
}

function normalizeServerDemoApprovalItem(item) {
  const it = item && typeof item === "object" ? item : {};
  const id = String(it.id || "").trim();
  if (!id) return null;
  const status = String(it.status || "").trim() || "pending";
  const title = String(it.title || "").trim();
  const description = String(it.description || "").trim();
  const metadata = it.metadata && typeof it.metadata === "object" ? it.metadata : {};
  return {
    ...it,
    id,
    status,
    title,
    description,
    metadata: {
      siNumber: String(metadata.siNumber || "").trim(),
      source: String(metadata.source || "").trim(),
      suggestedStatus: String(metadata.suggestedStatus || "").trim(),
      eta: String(metadata.eta || "").trim(),
      reason: String(metadata.reason || "").trim(),
      originalMessage: String(metadata.originalMessage || "").trim(),
    },
  };
}

async function fetchServerDemoApprovals() {
  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/demo/approvals`, { method: "GET" }, 12000);
    if (!response.ok) return;
    const json = await response.json();
    const itemsRaw = Array.isArray(json?.items) ? json.items : [];
    const normalized = itemsRaw.map(normalizeServerDemoApprovalItem).filter(Boolean);
    state.demoApprovals = normalized;
    renderApp();
  } catch {
    // ignore (demo)
  }
}

function normalizeServerDemoTradeCase(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return { ...item, id };
}

async function fetchServerDemoTradeCases() {
  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/demo/tradecases`, { method: "GET" }, 12000);
    if (!response.ok) return [];
    const json = await response.json();
    const itemsRaw = Array.isArray(json?.items) ? json.items : [];
    return itemsRaw.map(normalizeServerDemoTradeCase).filter(Boolean);
  } catch {
    return [];
  }
}

function scheduleDemoApprovalsPoll() {
  if (demoApprovalsPollTimer) {
    window.clearTimeout(demoApprovalsPollTimer);
    demoApprovalsPollTimer = null;
  }
  if (state.topActiveTab !== "issues") return;
  const tick = async () => {
    await fetchServerDemoApprovals();
    if (state.topActiveTab !== "issues") return;
    demoApprovalsPollTimer = window.setTimeout(tick, 5000);
  };
  demoApprovalsPollTimer = window.setTimeout(tick, 150);
}

function recomputeIssueSeqByTradeCaseId() {
  const sortedIds = (Array.isArray(state.tradeCases) ? state.tradeCases : [])
    .map((c) => (c && c.id ? c.id : ""))
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(a).localeCompare(String(b)));
  state.issueSeqByTradeCaseId = {};
  for (let i = 0; i < sortedIds.length; i++) state.issueSeqByTradeCaseId[sortedIds[i]] = i + 1;
}

function mergeTradeCaseIntoState(tradeCase) {
  if (!tradeCase || typeof tradeCase !== "object") return;
  const id = String(tradeCase.id || "").trim();
  if (!id) return;
  const incidents = detectIncidents(tradeCase);
  const proposals = proposeActions(tradeCase, incidents);
  const normalized = { ...tradeCase, incidents, nextActions: proposals };

  const list = Array.isArray(state.tradeCases) ? state.tradeCases.filter(Boolean) : [];
  const idx = list.findIndex((x) => String(x?.id || "") === id);
  if (idx === -1) state.tradeCases = [normalized, ...list];
  else {
    const next = list.slice();
    next[idx] = { ...next[idx], ...normalized };
    state.tradeCases = next;
  }
  recomputeIssueSeqByTradeCaseId();
}

async function approveDemoApprovalItem(approvalId) {
  const id = String(approvalId || "").trim();
  if (!id) return;
  try {
    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/demo/approvals/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      },
      15000,
    );
    if (!response.ok) {
      const text = await response.text();
      window.alert(text || "(demo) approve failed");
      return;
    }
    const json = await response.json();
    const approval = normalizeServerDemoApprovalItem(json?.approval);
    if (approval) {
      const list = Array.isArray(state.demoApprovals) ? state.demoApprovals.filter(Boolean) : [];
      const next = list.map((x) => (String(x?.id || "") === approval.id ? approval : x));
      state.demoApprovals = next;
    }
    if (json?.tradeCase) mergeTradeCaseIntoState(json.tradeCase);
    renderApp();
  } catch {
    window.alert("(demo) approve failed");
  }
}

function scheduleServerActivityPoll() {
  if (serverActivityPollTimer) {
    window.clearTimeout(serverActivityPollTimer);
    serverActivityPollTimer = null;
  }
  if (state.topActiveTab !== "activity") return;
  const tick = async () => {
    await fetchServerActivityFeed();
    if (state.topActiveTab !== "activity") return;
    serverActivityPollTimer = window.setTimeout(tick, 5000);
  };
  serverActivityPollTimer = window.setTimeout(tick, 200);
}

function scheduleSlackStatusPoll() {
  if (slackStatusPollTimer) {
    window.clearTimeout(slackStatusPollTimer);
    slackStatusPollTimer = null;
  }
  if (state.topActiveTab !== "settings") return;
  const tick = async () => {
    await fetchSlackIntegrationStatus();
    if (state.topActiveTab !== "settings") return;
    slackStatusPollTimer = window.setTimeout(tick, 8000);
  };
  slackStatusPollTimer = window.setTimeout(tick, 200);
}

async function submitMockIngest(rawText) {
  const response = await fetchWithTimeout(`${API_BASE_URL}/ingest/mock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "teams",
      senderName: "営業A",
      channel: "Teams",
      rawText,
      pendingClarifications: Array.isArray(state.pendingClarifications) ? state.pendingClarifications : [],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Mock ingest failed: ${response.status}`);
  }

  return response.json();
}

async function submitLlmIngest(rawText) {
  const response = await fetchWithTimeout(`${API_BASE_URL}/ingest/llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "teams",
      senderName: "営業A",
      channel: "Teams",
      rawText,
      pendingClarifications: Array.isArray(state.pendingClarifications) ? state.pendingClarifications : [],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `LLM ingest failed: ${response.status}`);
  }

  return response.json();
}

function formatEntityType(type) {
  const t = String(type || "");
  const map = {
    si: "SI",
    SI: "SI",
    document: "Document",
    Document: "Document",
    shipment: "Shipment",
    Shipment: "Shipment",
    supplier: "Supplier",
    Supplier: "Supplier",
    Issue: "Issue",
    issue: "Issue",
  };
  return map[t] || map[t.toLowerCase()] || t;
}

function parseIssueMutationBody(body) {
  const text = String(body || "");
  const lines = text.split(/\r?\n/);
  const out = {
    summary: "",
    intent: "",
    confidence: null,
    rawText: "",
    entities: [],
  };

  for (const line of lines) {
    const s = String(line || "");
    if (s.startsWith("Summary:")) out.summary = s.replace(/^Summary:\s*/, "").trim();
    if (s.startsWith("Intent:")) out.intent = s.replace(/^Intent:\s*/, "").trim();
    if (s.startsWith("Confidence:")) {
      const v = s.replace(/^Confidence:\s*/, "").trim();
      const n = Number(v);
      out.confidence = Number.isFinite(n) ? n : null;
    }
    if (s.startsWith("Raw:")) out.rawText = s.replace(/^Raw:\s*/, "").trim();
    const m = s.match(/^Entities\((.+?)\):\s*(.+)\s*$/);
    if (m) {
      const entityType = String(m[1] || "").trim();
      const ids = String(m[2] || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      for (const entityId of ids) out.entities.push({ entityType, entityId });
    }
  }

  return out;
}

function classifyLabelJaFromIntent(intent) {
  const v = String(intent || "").trim();
  const norm = v.toLowerCase();
  if (!norm) return "-";
  if (norm.includes("missing_document") || norm.includes("missing-document") || norm.includes("document_missing")) return "書類未着確認";
  if (norm.includes("invoice") && norm.includes("mismatch")) return "インボイス不一致確認";
  if (norm.includes("eta") || norm.includes("schedule")) return "スケジュール確認";
  if (norm.includes("delivery")) return "納期リスク確認";
  return v;
}

function confidenceLabelJa(confidence) {
  const c = typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null;
  if (c === null) return "-";
  if (c >= 0.9) return `高（${c.toFixed(2)}）`;
  if (c >= 0.75) return `中（${c.toFixed(2)}）`;
  return `低（${c.toFixed(2)}）`;
}

function summarizeEntitiesJa(entities) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  if (!list.length) return "-";
  const byType = new Map();
  for (const e of list) {
    const t = String(e?.entityType || "").trim();
    const id = String(e?.entityId || "").trim();
    if (!t || !id) continue;
    const arr = byType.get(t) || [];
    arr.push(id);
    byType.set(t, arr);
  }
  const parts = [];
  for (const [t, ids] of byType.entries()) {
    const uniq = [...new Set(ids)].filter(Boolean);
    if (!uniq.length) continue;
    const label = formatEntityType(t);
    parts.push(`${label} ${uniq.join(", ")}`.trim());
  }
  return parts.length ? parts.join(" / ") : "-";
}

function normalizeAiApprovalText(text) {
  const s = String(text || "");
  if (!s) return "";
  return s;
}

function normalizeMutationTitle(title) {
  let s = String(title || "").trim();
  if (!s) return "";
  s = normalizeAiApprovalText(s);
  // Demo data sometimes has legacy prefixes like "【輸入】" / "【三国間】".
  s = s.replace(/^【[^】]+】\s*/u, "");
  s = s.replace(/\s*:\s*shipment unknown\s*$/i, "");
  // Avoid showing "SI番号だけ" in Approval Center list.
  if (/^SI-\d{4}-\d+$/i.test(s)) {
    const si = s.toUpperCase();
    if (si === "SI-2026-016") return `ETA変更・納期影響確認（${si}）`;
    return `要確認（${si}）`;
  }
  return s.trim();
}

function extractMutationParsed(mutation) {
  const m = mutation || {};
  const parsed = parseIssueMutationBody(String(m?.body || ""));
  const linkedEntities = Array.isArray(m?.linkedEntities) ? m.linkedEntities.filter(Boolean) : [];
  const entities =
    linkedEntities.length
      ? linkedEntities
          .map((l) => ({ entityType: String(l?.entityType || ""), entityId: String(l?.entityId || "") }))
          .filter((e) => e.entityType && e.entityId)
      : parsed.entities;

  const confidence =
    typeof m?.confidence === "number" && Number.isFinite(m.confidence)
      ? m.confidence
      : typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : null;

  return {
    summary: parsed.summary,
    intent: parsed.intent,
    confidence,
    rawText: parsed.rawText,
    entities,
  };
}

function isGenericMutationTitle(title) {
  const s = normalizeMutationTitle(String(title || "")).trim();
  if (!s) return true;
  if (s === "AIが対応候補を整理しました。確認してください。") return true;
  if (/^承認待ち\s*:/i.test(s)) return true;
  return false;
}

function chooseRepresentativeMutation(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;

  const actionScore = (a) => {
    const v = String(a || "");
    if (v === "create_issue_candidate") return 30;
    if (v === "append_comment") return 20;
    if (v === "mark_approval_required") return 10;
    return 0;
  };

  const score = (m) => {
    const base = actionScore(m?.action);
    const title = String(m?.title || "");
    const titlePenalty = isGenericMutationTitle(title) ? 8 : 0;
    return base - titlePenalty;
  };

  return list
    .slice()
    .sort((a, b) => score(b) - score(a))[0] || null;
}

function issueMutationGroupKey(mutation) {
  const threadId = String(mutation?.threadId || "").trim();
  if (threadId) return `thread:${threadId}`;
  const issueId = String(mutation?.issueId || "").trim() || "LLM";
  return `issue:${issueId}`;
}

function groupIssueMutationsForApproval(mutations) {
  const list = Array.isArray(mutations) ? mutations.filter(Boolean) : [];
  const groups = new Map();
  const order = [];

  for (const mut of list) {
    const key = issueMutationGroupKey(mut);
    if (!groups.has(key)) {
      groups.set(key, { key, items: [] });
      order.push(key);
    }
    groups.get(key).items.push(mut);
  }

  return order
    .map((key) => {
      const g = groups.get(key);
      if (!g) return null;
      const items = Array.isArray(g.items) ? g.items.filter(Boolean) : [];
      const representative = chooseRepresentativeMutation(items);
      const others = representative ? items.filter((x) => String(x?.id || "") !== String(representative?.id || "")) : items;
      const issueId = String(representative?.issueId || "").trim() || (key.startsWith("issue:") ? key.slice("issue:".length) : "LLM");
      const threadId = String(representative?.threadId || "").trim() || (key.startsWith("thread:") ? key.slice("thread:".length) : "");
      return { key, issueId, threadId, representative, others };
    })
    .filter(Boolean);
}

function findCanonicalConversationIdBySourceRawInputId(sourceRawInputId) {
  const id = String(sourceRawInputId || "").trim();
  if (!id) return "";
  const raw = (Array.isArray(state.rawRequests) ? state.rawRequests : []).find((r) => {
    if (!r) return false;
    const key = String(r.sourceRawInputId || r.originalRawInputId || r.id || "").trim();
    return key === id;
  });
  return String(raw?.conversationThreadId || "").trim();
}

function findCanonicalConversationIdByOperationalThreadId(operationalThreadId) {
  const id = String(operationalThreadId || "").trim();
  if (!id) return "";
  const threads = computeConversationThreadsFromRawRequests(state.rawRequests);
  const hit = threads.find((t) => String(t?.representativeThreadId || "").trim() === id) || null;
  return String(hit?.id || "").trim();
}

function findSourceConversationThread(candidate, conversationThreads) {
  if (!candidate) return null;

  const baseThreads = Array.isArray(conversationThreads) ? conversationThreads.filter(Boolean) : [];
  const ingestThreads = [
    ...(Array.isArray(state.latestIngestResult?.conversationThreads) ? state.latestIngestResult.conversationThreads : []),
    ...(Array.isArray(state.latestIngestResult?.threads) ? state.latestIngestResult.threads : []),
  ].filter(Boolean);
  const allThreads = [...baseThreads, ...ingestThreads];
  const DEBUG_SOURCE_THREAD = false;

  if (DEBUG_SOURCE_THREAD) {
    console.table(
      allThreads.map((thread) => ({
        id: thread?.id,
        channel: thread?.channel || thread?.sourceChannel,
        requester: thread?.requester || thread?.requesterName || thread?.sender,
        messages: Array.isArray(thread?.messages) ? thread.messages.filter(Boolean).length : Number(thread?.messageCount ?? 0) || 0,
        sourceRawInputId: thread?.sourceRawInputId,
        rawInputId: thread?.rawInputId,
      })),
    );
  }

  const matchesThreadId = (thread, idLike) => {
    if (!thread) return false;
    const id = String(idLike || "").trim();
    if (!id) return false;
    return [
      thread.id,
      thread.threadId,
      thread.sourceThreadId,
      thread.conversationThreadId,
      thread.canonicalConversationId,
      thread.canonicalId,
      thread.sourceRawInputId,
      thread.rawInputId,
      thread.representativeThreadId,
      thread.relatedConversationId,
    ]
      .filter(Boolean)
      .map((x) => String(x).trim())
      .includes(id);
  };

  const extractRawInputId = (value) => {
    const match = String(value || "").match(/raw-\d+/);
    return match?.[0] || "";
  };

  const extractRawThreadId = (value) => {
    const match = String(value || "").match(/raw-\d+-t\d+/);
    return match?.[0] || "";
  };

  const getThreadMessageCount = (thread) => {
    if (!thread) return 0;
    const list = Array.isArray(thread.messages) ? thread.messages.filter(Boolean) : [];
    if (list.length) return list.length;
    const raw = thread.messageCount ?? thread.messagesCount ?? thread.count;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  const scoreThreadCandidate = (thread) => {
    if (!thread) return -999;
    let score = 0;

    const msgCount = getThreadMessageCount(thread);
    if (msgCount > 0) score += 100;

    const ch = String(thread.channel || thread.sourceChannel || "").toLowerCase();
    if (ch === "teams" || ch === "email") score += 20;
    else if (ch) score += 10;

    const who = String(thread.requester || thread.requesterName || thread.sender || thread.from || "").trim();
    if (who) score += 20;

    const title = String(thread.title || "").trim();
    const last = String(thread.lastMessage || thread.lastMessageText || "").trim();
    if (title || last) score += 10;

    return score;
  };

  const pickBestThreadCandidate = (candidates) => {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!list.length) return null;
    return (
      list
        .slice()
        .sort((a, b) => {
          const s = scoreThreadCandidate(b) - scoreThreadCandidate(a);
          if (s) return s;
          return getThreadMessageCount(b) - getThreadMessageCount(a);
        })[0] || null
    );
  };

  const findByAnyId = (ids) => {
    const list = Array.isArray(ids) ? ids.filter(Boolean).map((x) => String(x).trim()).filter(Boolean) : [];
    const matched = [];
    const seen = new Set();
    for (const id of list) {
      const threads = allThreads.filter((t) => matchesThreadId(t, id));
      for (const t of threads) {
        const key = String(t?.id || t?.threadId || t?.conversationThreadId || t?.sourceThreadId || "") || JSON.stringify(t);
        if (seen.has(key)) continue;
        seen.add(key);
        matched.push(t);
      }
    }

    if (DEBUG_SOURCE_THREAD) {
      console.table(
        matched.map((thread) => ({
          id: thread?.id,
          channel: thread?.channel || thread?.sourceChannel,
          requester: thread?.requester || thread?.requesterName || thread?.sender,
          messages: getThreadMessageCount(thread),
          score: scoreThreadCandidate(thread),
          sourceRawInputId: thread?.sourceRawInputId,
          rawInputId: thread?.rawInputId,
        })),
      );
    }

    return pickBestThreadCandidate(matched);
  };

  const canonicalConversationId = String(candidate.canonicalConversationId || candidate.canonicalId || "").trim();
  if (canonicalConversationId) {
    const byConv = baseThreads.find((t) => t && String(t.id || "").trim() === canonicalConversationId) || null;
    if (byConv) return byConv;
  }

  const candidateConversationThreadId = String(candidate.conversationThreadId || "").trim();
  const conversationIdLike = candidateConversationThreadId.startsWith("CONV:") ? candidateConversationThreadId : "";
  const explicitIds = [
    canonicalConversationId,
    conversationIdLike,
    candidate.operationalThreadId,
    candidate.sourceThreadId,
    candidate.threadId,
    candidate.relatedConversationId,
    extractRawThreadId(candidate.id),
  ];

  const byExplicit = findByAnyId(explicitIds);
  if (byExplicit) return byExplicit;

  // Fallback: infer threadId from ingest artifacts (ActionPlans / IntakeResolutions).
  const issueId = String(candidate.issueId || "").trim();
  const sourceRawInputId = String(candidate.sourceRawInputId || "").trim();
  const actionPlanId = String(candidate.actionPlanId || candidate.relatedActionPlanId || "").trim();

  const ingestActionPlans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
  const ingestIntakeResolutions = Array.isArray(state.latestIngestResult?.intakeResolutions)
    ? state.latestIngestResult.intakeResolutions.filter(Boolean)
    : [];

  const inferredThreadIds = (() => {
    const plan =
      ingestActionPlans.find((ap) => ap && actionPlanId && String(ap.id || "") === actionPlanId) ||
      ingestActionPlans.find((ap) => ap && issueId && String(ap.issueId || "") === issueId) ||
      ingestActionPlans.find((ap) => ap && sourceRawInputId && String(ap.sourceRawInputId || "") === sourceRawInputId) ||
      null;
    if (plan) {
      return [
        plan.sourceThreadId,
        plan.conversationThreadId,
        plan.threadId,
        plan.relatedConversationId,
        extractRawThreadId(plan.id),
      ];
    }

    const res =
      ingestIntakeResolutions.find((r) => r && issueId && String(r.issueId || "") === issueId) ||
      ingestIntakeResolutions.find((r) => r && sourceRawInputId && String(r.sourceRawInputId || "") === sourceRawInputId) ||
      null;
    if (res) {
      return [
        res.sourceThreadId,
        res.conversationThreadId,
        res.threadId,
        res.relatedConversationId,
        extractRawThreadId(res.id),
      ];
    }

    return [];
  })();

  const byInferred = findByAnyId(inferredThreadIds);
  if (byInferred) return byInferred;

  // Fallback: locate by raw input id embedded in candidate id (mut:raw-...:raw-...-t1:...).
  const rawInputId =
    String(candidate.sourceRawInputId || "").trim() ||
    String(candidate.rawInputId || "").trim() ||
    extractRawInputId(candidate.id);
  if (rawInputId) {
    const rawMatches = allThreads.filter((thread) =>
      [
        thread.sourceRawInputId,
        thread.rawInputId,
        thread.id,
        thread.representativeThreadId,
        thread.threadId,
        thread.conversationThreadId,
        thread.sourceThreadId,
      ]
        .filter(Boolean)
        .some((value) => String(value).includes(rawInputId)),
    );
    const byRaw = pickBestThreadCandidate(rawMatches);
    if (byRaw) return byRaw;
  }

  return null;
}

function resolveThreadForPreIssueItem(item, conversationThreads) {
  return findSourceConversationThread(item, conversationThreads);
}

function resolveThreadForApprovalCandidate(candidate, conversationThreads) {
  return findSourceConversationThread(candidate, conversationThreads);
}

function normalizePreviewText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function scorePreIssueItem(item) {
  if (!item) return 0;
  const followUp = Boolean(String(item.followUpAt || "").trim());
  const missingCount = Array.isArray(item.missingFields) ? item.missingFields.filter(Boolean).length : 0;
  const messageCount = typeof item.messageCount === "number" ? item.messageCount : 0;
  const hasLastMessage = Boolean(String(item.lastMessageText || item.lastMessage || "").trim());
  const hasSourceThreadId = Boolean(
    String(item.sourceThreadId || item.conversationThreadId || item.relatedConversationId || item.threadId || "").trim(),
  );

  return (followUp ? 40 : 0) + Math.min(missingCount, 5) * 6 + Math.min(messageCount, 99) + (hasLastMessage ? 10 : 0) + (hasSourceThreadId ? 8 : 0);
}

function getPreIssueItemKey(item) {
  if (!item) return "";

  const threadId = String(
    item.sourceThreadId ||
      item.conversationThreadId ||
      item.relatedConversationId ||
      item.threadId ||
      item.representativeThreadId ||
      "",
  ).trim();
  if (threadId) return `thread:${threadId}`;

  const canonicalConversationId = String(item.canonicalConversationId || item.canonicalId || "").trim();
  if (canonicalConversationId) return `conv:${canonicalConversationId}`;

  const requestId = String(item.requestId || item.rawRequestId || "").trim();
  if (requestId) return `req:${requestId}`;

  const channel = String(item.channel || item.sourceChannel || "").trim();
  const requester = String(item.requester || item.requesterName || item.sender || "").trim();
  const text = normalizePreviewText(
    item.lastMessageText ||
      item.lastMessage ||
      item.message ||
      item.body ||
      item.draftBody ||
      item.bodyText ||
      item.text ||
      "",
  );
  const fallback = [channel, requester, text].filter(Boolean).join("|");
  return fallback ? `fallback:${fallback}` : "";
}

function dedupePreIssueItems(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const byKey = new Map();
  const order = [];

  for (const item of list) {
    const key = getPreIssueItemKey(item);
    if (!key) continue;

    const existing = byKey.get(key) || null;
    if (!existing) {
      byKey.set(key, item);
      order.push(key);
      continue;
    }

    if (scorePreIssueItem(item) > scorePreIssueItem(existing)) {
      byKey.set(key, item);
    }
  }

  return order.map((k) => byKey.get(k)).filter(Boolean);
}

const DEBUG_PRE_ISSUE = false;
// Debug-only: allow switching between mock/LLM classification from the UI.
// In demo mode, we keep LLM (Kimi) fixed and hide the toggle.
const DEBUG_CLASSIFY_MODE_SWITCH = Boolean(window.TRADE_SHELF_DEBUG_CLASSIFY_MODE_SWITCH);

const getEffectiveClassifyMode = (classifyModeLike) => {
  if (DEBUG_CLASSIFY_MODE_SWITCH) return classifyModeLike === "mock" ? "mock" : "llm";
  return "llm";
};

function transitionApprovalState(currentState, action) {
  const s = String(currentState || "planned");
  const a = String(action || "");

  // Todo.md transitions (runtime candidate only)
  // pending_approval + approve -> approved
  // pending_approval + edit -> edited
  // pending_approval + hold -> held
  //
  // edited + approve -> approved
  // edited + edit -> edited
  // edited + hold -> held
  //
  // held + resume -> pending_approval
  //
  // approved + mock_send -> mock_sent
  // mock_sent is terminal.
  switch (a) {
    case "approve": {
      if (s === "pending_approval" || s === "edited") return "approved";
      return null;
    }
    case "edit": {
      if (s === "pending_approval" || s === "edited") return "edited";
      return null;
    }
    case "hold": {
      if (s === "pending_approval" || s === "edited") return "held";
      return null;
    }
    case "resume": {
      if (s === "held") return "pending_approval";
      return null;
    }
    case "mock_send": {
      if (s === "approved") return "mock_sent";
      return null;
    }
    default:
      return null;
  }
}

function getAvailableApprovalActions(status) {
  const s = String(status || "planned");
  return {
    approve: transitionApprovalState(s, "approve") !== null,
    edit: transitionApprovalState(s, "edit") !== null,
    hold: transitionApprovalState(s, "hold") !== null,
    resume: transitionApprovalState(s, "resume") !== null,
    mock_send: transitionApprovalState(s, "mock_send") !== null,
  };
}

function shouldShowApprovalActionButtons(status) {
  // Todo.md requirement:
  // - pending_approval / edited / held / approved: show action buttons area
  // - mock_sent: read-only
  const s = String(status || "");
  if (!s) return false;
  if (s === "pending_approval") return true;
  if (s === "edited") return true;
  if (s === "held") return true;
  if (s === "approved") return true;
  return false;
}

function approvalStatusLabelJa(status) {
  const s = String(status || "");
  if (s === "pending_approval") return "承認待ち";
  if (s === "approved") return "承認済み";
  if (s === "held") return "保留中";
  if (s === "edited") return "編集済み";
  if (s === "mock_sent") return "mock送信済み";
  if (s === "planned") return "planned";
  return s || "-";
}

function ensureApprovalsInitializedFromIngestResult(result) {
  const plans = Array.isArray(result?.actionPlans) ? result.actionPlans.filter(Boolean) : [];
  if (!plans.length) return;
  if (!state.approvalsByActionPlanId || typeof state.approvalsByActionPlanId !== "object") state.approvalsByActionPlanId = {};

  for (const p of plans) {
    const id = String(p?.id || "").trim();
    if (!id) continue;
    if (state.approvalsByActionPlanId[id]) continue;
    const status = String(p?.status || "planned");
    state.approvalsByActionPlanId[id] = { status, updatedAt: nowIso() };
  }
}

function findActionPlanIdFromAnyId(idLike) {
  const id = String(idLike || "").trim();
  if (!id) return "";
  if (state.approvalsByActionPlanId && typeof state.approvalsByActionPlanId === "object" && state.approvalsByActionPlanId[id]) return id;
  const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
  const byId = plans.find((p) => String(p?.id || "") === id);
  if (byId) return id;
  const byIssue = plans.find((p) => String(p?.issueId || "") === id);
  if (byIssue && byIssue.id) return String(byIssue.id);
  const byThread = plans.find((p) => String(p?.threadId || "") === id);
  if (byThread && byThread.id) return String(byThread.id);
  return "";
}

function matchesMutationId(item, idLike) {
  if (!item) return false;
  const id = String(idLike || "").trim();
  if (!id) return false;

  const candidates = [
    item.id,
    item.actionPlanId,
    item.issueCandidateId,
    item.mutationId,
    item.approvalCandidateId,
    item.issueId,
    item.threadId,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return candidates.includes(id);
}

function getMutationOpenId(item) {
  if (!item) return "";
  return (
    String(item.id || "").trim() ||
    String(item.actionPlanId || "").trim() ||
    String(item.issueCandidateId || "").trim() ||
    String(item.mutationId || "").trim() ||
    String(item.approvalCandidateId || "").trim()
  );
}

function updateIngestResultStatusesForActionPlan(actionPlanId, nextStatus) {
  const apId = String(actionPlanId || "").trim();
  const status = String(nextStatus || "").trim();
  if (!apId || !status) return;

  if (state.latestIngestResult && Array.isArray(state.latestIngestResult.actionPlans)) {
    state.latestIngestResult.actionPlans = state.latestIngestResult.actionPlans.map((p) => {
      if (!p || String(p.id || "") !== apId) return p;
      return { ...p, status };
    });
  }

  if (state.latestIngestResult && Array.isArray(state.latestIngestResult.drafts)) {
    state.latestIngestResult.drafts = state.latestIngestResult.drafts.map((d) => {
      if (!d) return d;
      if (String(d?.actionPlanId || "") !== apId) return d;
      return { ...d, status };
    });
  }
}

function findDraftByActionPlanId(actionPlanId, { preferredChannel } = {}) {
  const apId = String(actionPlanId || "").trim();
  if (!apId) return null;
  const drafts = Array.isArray(state.latestIngestResult?.drafts) ? state.latestIngestResult.drafts.filter(Boolean) : [];
  const related = drafts.filter((d) => String(d?.actionPlanId || "") === apId);
  if (!related.length) return null;
  const pc = String(preferredChannel || "").trim();
  if (pc) return related.find((d) => String(d?.channel || "") === pc) || related[0] || null;
  return related[0] || null;
}

function updateDraftBodyForActionPlan(actionPlanId, nextBody, { preferredChannel } = {}) {
  const apId = String(actionPlanId || "").trim();
  if (!apId) return { ok: false, error: "missing_action_plan" };
  if (typeof nextBody !== "string") return { ok: false, error: "invalid_body" };
  if (!state.latestIngestResult || !Array.isArray(state.latestIngestResult.drafts)) return { ok: false, error: "drafts_not_found" };

  const drafts = state.latestIngestResult.drafts.filter(Boolean);
  const pc = String(preferredChannel || "").trim();
  let idx = drafts.findIndex(
    (d) =>
      d &&
      String(d.actionPlanId || "") === apId &&
      (pc ? String(d.channel || "") === pc : true),
  );
  if (idx < 0 && pc) {
    idx = drafts.findIndex((d) => d && String(d.actionPlanId || "") === apId);
  }
  if (idx < 0) return { ok: false, error: "draft_not_found" };

  const current = String(drafts[idx]?.body || "");
  if (nextBody === current) return { ok: false, error: "no_change" };

  const updated = { ...drafts[idx], body: nextBody };
  const nextDrafts = drafts.slice();
  nextDrafts[idx] = updated;
  state.latestIngestResult.drafts = nextDrafts;
  return { ok: true };
}

function recordApprovalActivityEvent(actionPlanId, nextStatus) {
  const apId = String(actionPlanId || "").trim();
  const status = String(nextStatus || "").trim();
  if (!apId || !status) return;

  recordApprovalActivityEventDetailed(apId, { nextStatus: status });
}

function recordApprovalActivityEventDetailed(actionPlanId, { action, nextStatus, description } = {}) {
  const apId = String(actionPlanId || "").trim();
  const status = String(nextStatus || "").trim();
  if (!apId || !status) return;

  const type = (() => {
    if (action === "resume") return "resumed";
    if (status === "approved") return "approved";
    if (status === "held") return "held";
    if (status === "edited") return "edited";
    if (status === "mock_sent") return "mock_sent";
    return "";
  })();
  if (!type) return;

  const seq = (() => {
    if (type === "approved") return 70;
    if (type === "edited") return 71;
    if (type === "held") return 72;
    if (type === "resumed") return 73;
    if (type === "mock_sent") return 80;
    return null;
  })();

  const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
  const plan = plans.find((p) => String(p?.id || "") === apId) || null;

  const ev = {
    id: `act:${shortId()}`,
    type,
    title: (() => {
      if (type === "edited") return "下書きを編集";
      if (type === "mock_sent") return "送信（モック）";
      return type;
    })(),
    occurredAt: nowIso(),
    actor: "human",
    description: description ? String(description) : undefined,
    status,
    sequence: typeof seq === "number" ? seq : undefined,
    threadId: plan?.threadId ? String(plan.threadId) : undefined,
    issueId: plan?.issueId ? String(plan.issueId) : undefined,
  };

  if (!state.latestIngestResult) state.latestIngestResult = {};
  state.latestIngestResult.activityEvents = prependUniqueById(state.latestIngestResult.activityEvents, [ev]);

  // Also reflect to Activity page immediately.
  const reflectable = new Set(["edited", "approved", "held", "resumed", "mock_sent"]);
  if (reflectable.has(type)) {
    const feedItem = activityEventToFeedItem(ev);
    state.activityFeedItems = prependUniqueById(state.activityFeedItems, [feedItem]);
  }
}

function applyStateTransitionCandidate(candidateId, { tradeCaseId } = {}) {
  const candId = String(candidateId || "").trim();
  if (!candId) return { ok: false, error: "missing_candidate_id" };

  const candidates = Array.isArray(state.latestIngestResult?.stateTransitionCandidates)
    ? state.latestIngestResult.stateTransitionCandidates.filter(Boolean)
    : [];
  const candidate = candidates.find((c) => String(c?.id || "").trim() === candId) || null;
  if (!candidate) return { ok: false, error: "candidate_not_found" };

  if (!Array.isArray(state.appliedStateTransitionCandidateIds)) state.appliedStateTransitionCandidateIds = [];
  const appliedIds = state.appliedStateTransitionCandidateIds.map(String);
  if (appliedIds.includes(candId)) return { ok: false, error: "already_applied" };

  const entityType = String(candidate?.entityType || "").trim();
  const entityId = String(candidate?.entityId || "").trim();
  const fromState = String(candidate?.fromState || "").trim();
  const toState = String(candidate?.toState || "").trim();

  const now = nowIso();
  const isRecentDuplicateActivity = ({ statusKey, needleId } = {}) => {
    const items = Array.isArray(state.activityFeedItems) ? state.activityFeedItems.filter(Boolean) : [];
    if (!items.length) return false;
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return false;

    for (let i = 0; i < Math.min(items.length, 30); i += 1) {
      const it = items[i];
      if (!it || String(it.type || "") !== "manualStateTransition") continue;
      if (statusKey && String(it.statusKey || "") !== String(statusKey)) continue;
      const occurredAt = String(it.occurredAt || "").trim();
      const atMs = Date.parse(occurredAt);
      if (!Number.isFinite(atMs)) continue;
      if (Math.abs(nowMs - atMs) > 3000) continue;
      const details = Array.isArray(it.details) ? it.details.filter(Boolean).map(String) : [];
      if (needleId && !details.includes(String(needleId))) continue;
      return true;
    }
    return false;
  };

  const pushActivity = ({ statusKey, title, summary, details }) => {
    if (isRecentDuplicateActivity({ statusKey, needleId: candId })) return;
    const detailLines = (() => {
      const base = Array.isArray(details) ? details.filter(Boolean).map(String) : [];
      const withId = candId ? [...base, candId] : base;
      const uniq = [];
      for (const line of withId) {
        if (!line) continue;
        if (uniq.includes(line)) continue;
        uniq.push(line);
      }
      return uniq;
    })();
    const item = {
      id: `act:${shortId()}`,
      type: "manualStateTransition",
      source: "human",
      title: String(title || "Manual state transition").trim() || "Manual state transition",
      actor: "human",
      occurredAt: now,
      at: formatLocalTime(now),
      summary: String(summary || "").trim(),
      details: detailLines,
      statusKey: String(statusKey || "processing"),
      linked: entityId ? [{ kind: entityType.toLowerCase(), label: entityId }] : [],
      links: [],
    };
    state.activityFeedItems = prependUniqueById(state.activityFeedItems, [item]);
  };

  if (entityType !== "Shipment") {
    pushActivity({
      statusKey: "warning",
      title: "状態遷移候補: 未対応",
      summary: `Unsupported entityType: ${entityType || "-"}`,
      details: [candId],
    });
    log(`State transition candidate not applied: unsupported entityType ${entityType || "-"}.`);
    return { ok: false, error: "unsupported_entity_type" };
  }

  const tc = (() => {
    if (tradeCaseId) return getTradeCaseById(tradeCaseId);
    const list = Array.isArray(state.tradeCases) ? state.tradeCases.filter(Boolean) : [];
    const byShipment = list.find((c) => String(c?.shipmentEntity?.id || "").trim() === entityId) || null;
    if (byShipment) return byShipment;
    const bySi = list.find((c) => String(c?.siEntity?.id || "").trim() === entityId) || null;
    return bySi || null;
  })();

  if (!tc) {
    pushActivity({
      statusKey: "failed",
      title: "状態遷移候補: 反映失敗",
      summary: `TradeCase not found for Shipment ${entityId || "-"}`,
      details: [candId],
    });
    log("State transition candidate not applied: TradeCase not found.");
    return { ok: false, error: "trade_case_not_found" };
  }

  const currentState = String(tc?.shipmentEntity?.shipmentState || tc?.shipmentState || "").trim();
  if (toState && currentState && currentState === toState) {
    // Already applied (by state), do not treat as conflict and do not duplicate activity logs.
    return { ok: false, error: "already_applied" };
  }
  if (fromState && currentState && currentState !== fromState) {
    pushActivity({
      statusKey: "warning",
      title: "状態遷移候補: 反映せず（conflict）",
      summary: `State transition candidate not applied: current state no longer matches fromState.`,
      details: [
        `Shipment ${entityId || "-"}`,
        `candidate: ${fromState || "-"} → ${toState || "-"}`,
        `current: ${currentState || "-"}`,
        candId,
      ],
    });
    log("State transition candidate not applied: current state no longer matches candidate fromState.");
    return { ok: false, error: "conflict" };
  }

  if (tc.shipmentEntity) tc.shipmentEntity.shipmentState = toState;
  tc.shipmentState = toState;

  recordTimelineEvent(tc.id, {
    id: shortId(),
    at: now,
    type: "statusChanged",
    message: `状態遷移を反映: Shipment ${entityId || "-"} ${fromState || "-"} → ${toState || "-"}`,
    shipmentState: toState || undefined,
    actor: "human",
  });

  pushActivity({
    statusKey: "success",
    title: "状態遷移を手動反映",
    summary: `Manual state transition applied: Shipment ${entityId || "-"} ${fromState || "-"} → ${toState || "-"} from ${candId}.`,
    details: [String(candidate?.reason || "").trim()].filter(Boolean),
  });
  log(`Manual state transition applied: Shipment ${entityId || "-"} ${fromState || "-"} → ${toState || "-"} from ${candId}.`);

  state.appliedStateTransitionCandidateIds = [...state.appliedStateTransitionCandidateIds, candId];
  return { ok: true };
}

function applyApprovalAction(idLike, action, { description } = {}) {
  const actionPlanId = findActionPlanIdFromAnyId(idLike);
  if (!actionPlanId) return { ok: false, error: "ActionPlan が見つかりませんでした。" };

  const entry = state.approvalsByActionPlanId?.[actionPlanId] || null;
  const current = String((entry && entry.status) || "planned");
  const next = transitionApprovalState(current, action);
  if (!next) return { ok: false, error: `不正な遷移です: ${current} -> ${action}` };

  state.approvalsByActionPlanId[actionPlanId] = { status: next, updatedAt: nowIso() };
  updateIngestResultStatusesForActionPlan(actionPlanId, next);
  recordApprovalActivityEventDetailed(actionPlanId, { action, nextStatus: next, description });

  return { ok: true, actionPlanId, next };
}

function buildDraftBodyFromMutation(mutation) {
  const title = String(mutation?.title || "").trim();
  const parsed = parseIssueMutationBody(String(mutation?.body || ""));
  const classification = classifyLabelJaFromIntent(parsed.intent) || "確認";
  const entitiesText = summarizeEntitiesJa(parsed.entities);

  const lines = [];
  if (entitiesText && entitiesText !== "-") lines.push(`${entitiesText} について、${classification}のため状況をご確認ください。`);
  else lines.push(`${classification}のため、状況をご確認ください。`);
  if (title) lines.push(`件名: ${title}`);
  lines.push("");
  lines.push("可能であれば、以下をご連絡ください。");
  lines.push("- 現状（未着 / 発行済 / 再発行中 など）");
  lines.push("- 予定日（未発行の場合）");
  lines.push("- 関連書類や参照番号（あれば）");
  return lines.join("\n");
}

function buildIssueLikeFromMutation(mutation) {
  const parsed = extractMutationParsed(mutation);
  const classification = classifyLabelJaFromIntent(parsed.intent);
  const entitiesText = summarizeEntitiesJa(parsed.entities);
  const confidenceText = confidenceLabelJa(parsed.confidence);
  const rawText = parsed.rawText || "-";

  const title = normalizeMutationTitle(String(mutation?.title || "")) || "Untitled";
  const issueNo = String(mutation?.issueId || "LLM");
  const now = nowIso();

  const source = String(mutation?.source || "").trim() || "Kimi AI分類";

  const threadId = String(mutation?.threadId || "").trim();
  const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
  const actionPlan =
    plans.find((p) => (threadId && String(p?.threadId || "") === threadId) || (issueNo && String(p?.issueId || "") === issueNo)) || null;

  const actionPlanId = actionPlan && actionPlan.id ? String(actionPlan.id) : "";
  const approvalEntry = actionPlanId ? state.approvalsByActionPlanId?.[actionPlanId] : null;
  const approvalStatus = String((approvalEntry && approvalEntry.status) || (actionPlan && actionPlan.status) || "pending_approval");

  const drafts = Array.isArray(state.latestIngestResult?.drafts) ? state.latestIngestResult.drafts.filter(Boolean) : [];
  const relatedDrafts = actionPlanId
    ? drafts.filter((d) => String(d?.actionPlanId || "") === actionPlanId)
    : threadId
      ? drafts.filter((d) => String(d?.threadId || "") === threadId)
      : [];

  const preferredDraft = relatedDrafts.find((d) => String(d?.channel || "") === "email") || relatedDrafts[0] || null;
  const draft = preferredDraft
    ? {
        channel: String(preferredDraft.channel || "-"),
        to: preferredDraft.to ? [String(preferredDraft.to)] : [],
        subject: preferredDraft.subject || "",
        body: String(preferredDraft.body || ""),
      }
    : {
        channel: "email",
        to: ["supplier@example.invalid"],
        subject: `Confirmation required: ${title}`,
        body: buildDraftBodyFromMutation(mutation),
      };

  const statusText = approvalStatus === "pending_approval" ? "pending approval" : approvalStatus || "requires approval";
  return {
    id: String(mutation?.id || issueNo),
    issueNo,
    title,
    severity: "medium",
    statusKey: "requiresApproval",
    statusText,
    currentStatus: {
      status: approvalStatusLabelJa(approvalStatus),
      pendingApproval: approvalStatus === "pending_approval",
      nextAction: "AI提案内容の確認",
      aiProposal: parsed.summary || title,
      classification,
      entitiesText,
      confidenceText,
      source,
    },
    timeline: [
      {
        id: `raw:${issueNo}`,
        at: now,
        type: "rawInputReceived",
        label: "依頼を受信",
        actor: "requester",
        message: `元の依頼: ${rawText}`,
      },
      {
        id: `ai:${issueNo}`,
        at: now,
        type: "aiClassified",
        label: "AIが業務スレッドへ分類",
        actor: "trade-shelf-agent",
        message: `分類: ${classification}\n信頼度: ${confidenceText}\nsource: ${source}`,
      },
      {
        id: `ent:${issueNo}`,
        at: now,
        type: "entityLinked",
        label: "関連エンティティへ紐付け",
        actor: "trade-shelf-agent",
        message: `関連エンティティ: ${entitiesText}`,
      },
      {
        id: `draft:${issueNo}`,
        at: now,
        type: "draftProposal",
        label: "Draft proposal",
        actor: "trade-shelf-agent",
        message: "AIが次に必要な確認アクションを作成しました。承認してください。",
      },
    ],
    draft,
  };
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
  const description = String(ev?.description || "");
  const status = String(ev?.status || "");
  const sequence = typeof ev?.sequence === "number" ? ev.sequence : null;
  const linkedEntities = Array.isArray(ev?.linkedEntities) ? ev.linkedEntities.filter(Boolean) : [];

  const linkedDeduped = (() => {
    const seen = new Set();
    const out = [];
    for (const l of linkedEntities) {
      const et = String(l?.entityType || "").trim();
      const eid = String(l?.entityId || "").trim();
      if (!et || !eid) continue;
      const key = `${et}::${eid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ entityType: et, entityId: eid, confidence: l?.confidence });
    }
    return out;
  })();

  const linked = linkedDeduped.map((l) => ({
    kind: String(l?.entityType || "").toLowerCase(),
    label: String(l?.entityId || "").trim(),
  }));

  const activityTitleJa = (() => {
    switch (rawType) {
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
      case "resumed":
        return "再開";
      case "mock_sent":
        return "mock送信";
      case "failed_processing":
        return "処理失敗";
      default:
        return String(ev?.title || "活動");
    }
  })();

  const title = description ? `${activityTitleJa}：${description}` : activityTitleJa;

  const details = [
    rawType ? `type: ${activityTitleJa}${rawType ? ` (${rawType})` : ""}` : "",
    status ? `状態: ${statusKeyFromIngestStatus(status)} (${status})` : "",
    typeof sequence === "number" ? `順序: ${String(sequence)}` : "",
    linkedDeduped.length
      ? `紐付け: ${linkedDeduped.map((l) => `${formatEntityType(l.entityType)} ${l.entityId}`).join(", ")}`
      : "",
    description && rawType !== "raw_input_received" ? `raw detail: ${description}` : "",
  ].filter(Boolean);

  return {
    id: String(ev?.id || `act-${shortId()}`),
    type,
    source: "ai",
    title,
    actor: String(ev?.actor || "") || "mock ingest",
    at,
    occurredAt,
    sequence,
    details,
    statusKey: statusKeyFromIngestStatus(status),
    linked,
    links: [],
  };
}

function mergePendingClarificationsFromIngestResult(result) {
  const incoming = Array.isArray(result?.pendingClarifications) ? result.pendingClarifications.filter(Boolean) : [];
  const matched = result?.matchedPendingClarification || null;
  if (!incoming.length && !(matched && matched.id)) return;

  if (!Array.isArray(state.pendingClarifications)) state.pendingClarifications = [];
  const byId = new Map(state.pendingClarifications.filter(Boolean).map((p) => [String(p.id || ""), p]));

  for (const p of incoming) {
    const id = String(p?.id || "").trim();
    if (!id) continue;
    byId.set(id, p);
  }
  if (matched && matched.id) {
    byId.set(String(matched.id), matched);
  }

  state.pendingClarifications = Array.from(byId.values()).filter(Boolean);
}

function buildActivityProcessingSummary(appState) {
  const activityItems = Array.isArray(appState?.activityFeedItems) ? appState.activityFeedItems.filter(Boolean) : [];
  const approvals = Object.values(appState?.approvalsByActionPlanId ?? {}).filter(Boolean);
  const pendingClarifications = Array.isArray(appState?.pendingClarifications) ? appState.pendingClarifications.filter(Boolean) : [];

  const awaitingClassification = pendingClarifications.filter((p) => String(p?.status || "") === "awaiting_clarification_reply").length;
  const awaitingApproval = approvals.filter((a) => String(a?.status || "") === "pending_approval").length;

  let failedProcessing = 0;
  for (const it of activityItems) {
    const status = String(it?.statusKey || "").toLowerCase();
    const type = String(it?.type || "").toLowerCase();
    if (status === "failed" || type === "failedprocessing") failedProcessing++;
  }

  return { awaitingClassification, awaitingApproval, failedProcessing };
}

function normalizeConversationStatusKey(status) {
  const s = String(status || "").toLowerCase();
  if (s === "awaiting_clarification") return "awaiting_clarification";
  if (s === "missing_context") return "awaiting_clarification";
  if (s === "pending_clarification") return "awaiting_clarification";
  if (s === "clarification_draft") return "awaiting_clarification";
  if (s === "context_resolving") return "awaiting_clarification";
  if (s === "matched") return "matched";
  if (s === "reflected_to_approvals") return "reflected_to_approvals";
  if (s === "issue_linked") return "issue_linked";
  if (s === "resolved") return "resolved";
  if (s === "closed") return "closed";
  return "reflected_to_approvals";
}

function displayConversationStatusLabel(status) {
  switch (normalizeConversationStatusKey(status)) {
    case "awaiting_clarification":
      return "確認中";
    case "matched":
      return "整理済";
    case "reflected_to_approvals":
      return "承認待ちへ反映済";
    case "issue_linked":
      return "既存案件へ関連付け済";
    case "resolved":
    case "closed":
      return "完了";
    default:
      return "—";
  }
}

function canonicalRawInputFromRequest(r) {
  const source = String(r?.source || "teams").trim();
  const normalizedSource = source === "email" ? "email" : "teams";
  const id = String(r?.originalRawInputId || r?.sourceRawInputId || r?.id || "").trim() || `raw-${shortId()}`;
  return {
    id,
    source: normalizedSource,
    receivedAt: String(r?.receivedAt || ""),
    senderName: String(r?.from || ""),
    channel: String(source || ""),
    rawText: String(r?.text || ""),
    status: "received",
  };
}

function resolveConversationThreadIdForRawRequest(rawRequest) {
  const pendingClarifications = Array.isArray(state.pendingClarifications) ? state.pendingClarifications.filter(Boolean) : [];
  const canonical = resolveCanonicalConversation(canonicalRawInputFromRequest(rawRequest), { pendingClarifications, bucketMinutes: 15 });
  return String(canonical?.conversationThreadId || "").trim() || "";
}

function nextConversationMessageSequence(conversationThreadId) {
  const convId = String(conversationThreadId || "").trim();
  if (!convId) return 1;

  const list = Array.isArray(state.rawRequests) ? state.rawRequests.filter(Boolean) : [];
  let max = 0;
  for (const raw of list) {
    const rawConv = String(raw?.conversationThreadId || "").trim() || resolveConversationThreadIdForRawRequest(raw);
    if (!rawConv || rawConv !== convId) continue;
    const msgs = Array.isArray(raw?.messages) ? raw.messages : [];
    for (const m of msgs) {
      const seq = Number(m?.sequence);
      if (Number.isFinite(seq)) max = Math.max(max, seq);
    }
  }
  return max + 1;
}

function appendConversationMessagesWithSequence(rawRequest, newMessages) {
  if (!rawRequest) return;
  if (!Array.isArray(rawRequest.messages)) rawRequest.messages = [];

  const list = Array.isArray(newMessages) ? newMessages.filter(Boolean) : [];
  if (!list.length) return;

  const convId = String(rawRequest?.conversationThreadId || "").trim();
  let nextSeq = convId ? nextConversationMessageSequence(convId) : 1;

  for (const m of list) {
    rawRequest.messages.push({ ...m, sequence: nextSeq });
    nextSeq += 1;
  }
}

function computeConversationThreadsFromRawRequests(rawRequests) {
  const list = Array.isArray(rawRequests) ? rawRequests.filter(Boolean) : [];
  const rawInputFromRequest = (r) => canonicalRawInputFromRequest(r);

  const pendingClarifications = Array.isArray(state.pendingClarifications) ? state.pendingClarifications.filter(Boolean) : [];
  const ingestLinks = Array.isArray(state.latestIngestResult?.links) ? state.latestIngestResult.links.filter(Boolean) : [];
  const ingestActionPlans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
  const ingestIssueMutations = Array.isArray(state.latestIngestResult?.issueMutations) ? state.latestIngestResult.issueMutations.filter(Boolean) : [];

  const groups = new Map();
  for (const r of list) {
    const canonical = resolveCanonicalConversation(rawInputFromRequest(r), { pendingClarifications, bucketMinutes: 15 });
    const key = String(canonical?.conversationThreadId || "").trim() || `CONV:${shortId()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const uniq = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || "").trim()).filter(Boolean)));

  const threads = Array.from(groups.entries()).map(([key, items]) => {
    // Keep "発生順" as stored in `state.rawRequests` (append order).
    // `receivedAt` can collide at minute resolution, so timestamp sort is unreliable.
    const inOrder = items.slice();

    const last = inOrder[inOrder.length - 1] || null;
    const first = inOrder[0] || null;
    const requesterName = String(last?.from || first?.from || "—");
    const sourceChannel = String(last?.source || first?.source || "");
    const updatedAt = String(last?.receivedAt || first?.receivedAt || "");
    const lastMessageText = String(last?.text || "");

    const messages = [];
    for (const it of inOrder) {
      const itMsgs = Array.isArray(it?.messages) ? it.messages.filter(Boolean) : [];
      if (itMsgs.length) {
        for (const m of itMsgs) {
          messages.push({
            role: String(m?.role || "human") === "ai" ? "ai" : "human",
            text: String(m?.text || ""),
            createdAt: String(m?.createdAt || it?.receivedAt || ""),
            sequence: m?.sequence ?? m?.seq ?? m?.order ?? m?.index,
          });
        }
        continue;
      }
      messages.push({ role: "human", text: String(it?.text || ""), createdAt: String(it?.receivedAt || ""), sequence: null });
    }

    const messagesWithSequence = withStableMessageSequence(messages);

    const relatedSiIds = uniq(
      inOrder.flatMap((x) => (Array.isArray(x?.aiThreads) ? x.aiThreads : []).map((t) => (t && t.linkedSiNo ? String(t.linkedSiNo) : ""))),
    );
    const relatedIssueIds = uniq(
      inOrder.flatMap((x) => (Array.isArray(x?.aiThreads) ? x.aiThreads : []).map((t) => (t && t.linkedIssueId ? String(t.linkedIssueId) : ""))),
    );

    const pendingId =
      inOrder.map((x) => String(x?.pendingClarification?.id || x?.pendingClarificationId || "").trim()).find(Boolean) || "";
    const matchedId =
      inOrder.map((x) => String(x?.matchedPendingClarification?.id || x?.matchedPendingClarificationId || "").trim()).find(Boolean) || "";

    const representativeThreadId = (() => {
      for (const x of inOrder) {
        const threads = Array.isArray(x?.aiThreads) ? x.aiThreads.filter(Boolean) : [];
        for (const t of threads) {
          const id = String(t?.id || "").trim();
          if (id) return id;
        }
      }
      return "";
    })();

    const canonicalIssue = representativeThreadId
      ? resolveCanonicalIssueLink({ id: representativeThreadId }, ingestLinks.filter((l) => String(l?.threadId || "") === representativeThreadId))
      : null;

    const hasResolvedIssueLink = Boolean(canonicalIssue && canonicalIssue.reason === "linked_issue" && canonicalIssue.issueId);
    const hasResolvedSi =
      relatedSiIds.length > 0 ||
      (representativeThreadId &&
        ingestLinks.some((l) => String(l?.threadId || "") === representativeThreadId && String(l?.entityType || "") === "SI" && l?.entityId));

    const reflectedToApprovals = Boolean(
      inOrder.some((x) => x && x.reflectedToApprovals) ||
        (representativeThreadId && ingestActionPlans.some((ap) => String(ap?.threadId || "") === representativeThreadId)) ||
        (canonicalIssue &&
          canonicalIssue.issueId &&
          (ingestActionPlans.some((ap) => String(ap?.issueId || "") === canonicalIssue.issueId) ||
            ingestIssueMutations.some((m) => String(m?.issueId || "") === canonicalIssue.issueId))),
    );

    const shouldClearAwaitingClarification = Boolean(pendingId && hasResolvedSi && hasResolvedIssueLink && reflectedToApprovals);

    // When a pending clarification gets matched by a follow-up reply, the "確認待ち" loop is effectively resolved.
    // We intentionally treat it as resolved so it disappears from the pre-issue inbox.
    const status = normalizeConversationStatusKey(
      matchedId ? "resolved" : pendingId && !shouldClearAwaitingClarification ? "awaiting_clarification" : "reflected_to_approvals",
    );

    const threadTitles = uniq(
      inOrder.flatMap((x) => (Array.isArray(x?.aiThreads) ? x.aiThreads : []).map((t) => (t && t.title ? String(t.title) : ""))),
    );
    const titleParts = [];
    if (threadTitles.length) titleParts.push(threadTitles[0]);
    if (relatedSiIds.length) titleParts.push(relatedSiIds[0]);
    const title = titleParts.length ? titleParts.join(" / ") : "会話";

    return {
      id: String(first?.conversationThreadId || key),
      representativeThreadId,
      canonicalIssueLink: canonicalIssue,
      reflectedToApprovals,
      requesterName,
      sourceChannel,
      title,
      status,
      updatedAt,
      messageCount: messagesWithSequence.length,
      lastMessageText,
      relatedSiIds,
      relatedIssueIds,
      messages: messagesWithSequence,
    };
  });

  return threads.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || String(b.id || "").localeCompare(String(a.id || "")));
}

function isPreIssueConversationThread(thread) {
  if (!thread) return false;

  const status = normalizeConversationStatusKey(thread.status || thread.resolutionStatus);
  if (status === "reflected_to_approvals") return false;
  if (status === "issue_linked") return false;
  if (status === "resolved") return false;
  if (status === "closed") return false;

  if (status === "awaiting_clarification") return true;

  // `matched` can still be "pre-issue", but only if it hasn't moved into the approval pipeline yet.
  if (Boolean(thread.reflectedToApprovals)) return false;
  if (thread?.canonicalIssueLink?.issueId) return false;

  return true;
}

function isPreIssueItem(item) {
  const status = String(item?.status || item?.resolutionStatus || item?.kind || "").trim();

  if (
    status === "awaiting_clarification" ||
    status === "missing_context" ||
    status === "pending_clarification" ||
    status === "clarification_draft" ||
    status === "context_resolving" ||
    status === "awaiting_clarification_reply" ||
    status === "awaiting_human_selection" ||
    status === "needs_clarification" ||
    status === "status_query"
  ) {
    return true;
  }

  if (item?.issueCandidateId) return false;
  if (item?.approvalCandidateId) return false;
  if (item?.linkedApprovalId) return false;
  if (status === "reflected_to_approvals") return false;

  return false;
}

function normalizeActionStatusLike(statusLike) {
  const raw = String(statusLike || "").trim();
  if (!raw) return "";
  const s = raw.toLowerCase();

  // normalize common aliases / legacy keys
  if (s === "requiresapproval" || s === "requires_approval") return "pending_approval";
  if (s === "on_hold") return "held";
  if (s === "draft_created") return "drafted";

  return s;
}

function isPendingActionItem(item) {
  const status = normalizeActionStatusLike(item?.status || item?.approvalStatus || item?.state || item?.statusKey || "");
  return [
    "planned",
    "pending_approval",
    "edited",
    "held",
    "drafted",
  ].includes(status);
}

function isCompletedActionItem(item) {
  const status = normalizeActionStatusLike(item?.status || item?.approvalStatus || item?.state || item?.statusKey || "");
  return [
    "approved",
    "sent",
    "mock_sent",
    "completed",
    "resolved",
    "done",
  ].includes(status);
}

function isApprovalCandidateItem(item) {
  const status = String(item?.status || item?.resolutionStatus || item?.kind || "").trim();

  if (
    status === "awaiting_clarification" ||
    status === "missing_context" ||
    status === "pending_clarification" ||
    status === "clarification_draft" ||
    status === "context_resolving" ||
    status === "awaiting_clarification_reply" ||
    status === "awaiting_human_selection" ||
    status === "needs_clarification" ||
    status === "status_query"
  ) {
    return false;
  }

  return Boolean(
    item?.issueCandidateId ||
      item?.approvalCandidateId ||
      item?.linkedApprovalId ||
      status === "reflected_to_approvals" ||
      status === "pending_approval",
  );
}

function hasApprovalCandidateForThread(thread, { actionPlans, issueMutations } = {}) {
  if (!thread) return false;

  const plans = Array.isArray(actionPlans) ? actionPlans.filter(Boolean) : [];
  const muts = Array.isArray(issueMutations) ? issueMutations.filter(Boolean) : [];

  const representativeThreadId = String(thread.representativeThreadId || "").trim();
  const relatedIssueIds = Array.isArray(thread.relatedIssueIds) ? thread.relatedIssueIds.filter(Boolean).map(String) : [];

  const hasPlan =
    (representativeThreadId && plans.some((ap) => String(ap?.threadId || "") === representativeThreadId)) ||
    (relatedIssueIds.length && plans.some((ap) => relatedIssueIds.includes(String(ap?.issueId || ""))));

  if (hasPlan) return true;

  const hasMutation =
    (representativeThreadId && muts.some((m) => String(m?.threadId || "") === representativeThreadId)) ||
    (relatedIssueIds.length && muts.some((m) => relatedIssueIds.includes(String(m?.issueId || ""))));

  return hasMutation;
}

function formatRequestSourceLabel(source) {
  const v = String(source || "").toLowerCase();
  if (v === "teams") return "Teams";
  if (v === "web") return "Web";
  if (v === "email") return "Email";
  if (v === "manualmemo") return "Manual memo";
  return v || "-";
}

function getConversationThreadMessageCount(thread) {
  if (!thread) return 0;
  const list = Array.isArray(thread.messages) ? thread.messages.filter(Boolean) : [];
  if (list.length) return list.length;
  const raw = thread.messageCount ?? thread.messagesCount ?? thread.count;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function withStableMessageSequence(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const maxExisting = list.reduce((max, m) => {
    const raw = m?.sequence ?? m?.seq ?? m?.order ?? m?.index;
    const v = Number(raw);
    if (!Number.isFinite(v)) return max;
    return Math.max(max, v);
  }, 0);

  let next = maxExisting + 1;
  return list.map((m, idx) => {
    const raw = m?.sequence ?? m?.seq ?? m?.order ?? m?.index;
    const existing = Number(raw);
    if (Number.isFinite(existing)) return { ...m, sequence: existing, __index: idx };
    const assigned = maxExisting > 0 ? next++ : idx + 1;
    return { ...m, sequence: assigned, __index: idx };
  });
}

function sortConversationMessagesOldestFirst(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const messagesWithIndex = list.map((message, index) => ({ ...message, __index: index }));

  messagesWithIndex.sort((a, b) => {
    const aSeq = a.sequence ?? a.seq ?? a.order ?? a.index ?? a.__index;
    const bSeq = b.sequence ?? b.seq ?? b.order ?? b.index ?? b.__index;
    if (aSeq !== bSeq) return Number(aSeq) - Number(bSeq);

    const aTime = new Date(String(a.createdAt || a.timestamp || 0)).getTime();
    const bTime = new Date(String(b.createdAt || b.timestamp || 0)).getTime();
    if (aTime !== bTime) return aTime - bTime;

    return a.__index - b.__index;
  });

  return messagesWithIndex;
}

function openConversationThreadModal(thr) {
  if (!thr) return;
  const title = String(thr.title || "会話");
  const who = String(thr.requesterName || "—");
  const src = formatRequestSourceLabel(thr.sourceChannel);
  const updated = String(thr.updatedAt || "");
  const statusKey = normalizeConversationStatusKey(thr.status);
  const siIds = Array.isArray(thr.relatedSiIds) ? thr.relatedSiIds.filter(Boolean) : [];
  const issueIds = Array.isArray(thr.relatedIssueIds) ? thr.relatedIssueIds.filter(Boolean) : [];
  const metaChips = [
    `<span class="mini-chip">${escapeHtml(who)}</span>`,
    `<span class="mini-chip">${escapeHtml(src)}</span>`,
    `<span class="mini-chip">状態: ${escapeHtml(displayConversationStatusLabel(statusKey))}</span>`,
    updated ? `<span class="mini-chip nt-mono">${escapeHtml(updated)}</span>` : "",
    ...siIds.map((x) => `<span class="mini-chip">${escapeHtml(x)}</span>`),
    ...issueIds.map((x) => `<span class="mini-chip">${escapeHtml(x)}</span>`),
  ]
    .filter(Boolean)
    .join("");

  const normalizedMessages = withStableMessageSequence(Array.isArray(thr.messages) ? thr.messages : []);
  const logHtml = normalizedMessages
    .map((m) => {
      const role = String(m?.role || "") === "ai" ? "ai" : "human";
      const sender = role === "ai" ? "AI" : who;
      const at = String(m?.createdAt || "");
      const text = String(m?.text || "");
      const meta = `${escapeHtml(sender)}${at ? ` <span class="muted nt-mono">${escapeHtml(at)}</span>` : ""}`;
      return `<div class="conversation-message ${role}">
        <div class="conversation-message__meta">${meta}</div>
        <div class="conversation-message__body">${escapeHtml(text)}</div>
      </div>`;
    })
    .join("");

  openModal({
    title,
    variant: "conversation_thread",
    bodyHtml: `<div class="conversation-thread-modal">
      <div class="conversation-thread-modal__meta">${metaChips}</div>
      <div class="conversation-thread-modal__log">${logHtml || `<div class="nt-muted">No messages</div>`}</div>
    </div>`,
  });
}

function openConversationThreadModalById(threadId) {
  const id = String(threadId || "").trim();
  if (!id) return;

  const threads = computeConversationThreadsFromRawRequests(state.rawRequests);
  const direct = threads.find((t) => t && String(t.id || "").trim() === id) || null;
  const thr = direct || findSourceConversationThread({ canonicalConversationId: id, operationalThreadId: id, sourceThreadId: id, threadId: id, id }, threads) || null;
  if (!thr) {
    window.alert("Conversation thread not found.");
    return;
  }
  openConversationThreadModal(thr);
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
        <div class="proposed-action-card__title">${escapeHtml(String(pa.label || "対応案"))}</div>
        <div class="proposed-action-card__meta muted">${escapeHtml(String(pa.type || ""))}</div>
      </div>
      ${draftHtml}
      <div class="proposed-action-card__actions">
        <button class="btn btn--primary btn--small" type="button" data-op-thread-action="approve" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String(m.id || ""))}" ${isDone ? "disabled" : ""}>送信を承認</button>
        <button class="btn btn--ghost btn--small" type="button" data-op-thread-action="edit" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String(m.id || ""))}">下書きを編集</button>
        <button class="btn btn--ghost btn--small" type="button" data-op-thread-action="hold" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String(m.id || ""))}">保留</button>
      </div>
      ${footHtml}
    </div>`;
  };

  if (!messages.length) return `<div class="nt-muted">会話がまだありません。</div>`;
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
        )}">関連案件を見る</button>
      </aside>
    </div>

    <div class="op-thread-modal__actions" aria-label="Thread actions">
      <div class="op-thread-modal__actions-left">
        <button class="btn btn--primary btn--small ${hasProposed ? "" : "is-disabled"}" type="button" data-op-thread-action="approve" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String((msg && msg.id) || ""))}" ${hasProposed ? "" : "aria-disabled=\"true\""}>送信を承認</button>
        <button class="btn btn--ghost btn--small ${hasProposed ? "" : "is-disabled"}" type="button" data-op-thread-action="edit" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String((msg && msg.id) || ""))}" ${hasProposed ? "" : "aria-disabled=\"true\""}>下書きを編集</button>
        <button class="btn btn--ghost btn--small ${hasProposed ? "" : "is-disabled"}" type="button" data-op-thread-action="hold" data-op-thread-id="${escapeHtml(
          String(thr.id || ""),
        )}" data-op-message-id="${escapeHtml(String((msg && msg.id) || ""))}" ${hasProposed ? "" : "aria-disabled=\"true\""}>保留</button>
      </div>
      <div class="op-thread-modal__actions-right">
        <button class="btn btn--primary btn--small" type="button" data-req-action="addComment" data-req-thread="${escapeHtml(
          String(thr.id || ""),
        )}">案件に追加</button>
        <button class="btn btn--ghost btn--small" type="button" data-req-action="openIssue" data-req-thread="${escapeHtml(
          String(thr.id || ""),
        )}">関連案件を見る</button>
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
    label: "ステータス変更",
    message: "ステータス: 要承認 → 取引先回答待ち",
  });

  recordHumanIntervention(tradeCaseId, {
    actionType: "agentRunApproveSend",
    label: "送信を承認",
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
    label: "ステータス変更",
    message: "ステータス: 要承認 → 保留",
  });
  run.nextHumanAction = {
    label: "保留を解除して承認",
    description: "保留中です。内容を確認し、送信する場合は承認してください。",
    actionType: current.actionType || "humanApproval",
  };
  recordHumanIntervention(tradeCaseId, { actionType: "agentRunHold", label: "保留", note: `step:${current.id}` });
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
  const nextBody = window.prompt("本文を編集（mock）", String(msg.body || ""));
  if (typeof nextBody === "string") msg.body = nextBody;
  recordTimelineEvent(tradeCaseId, {
    id: shortId(),
    at: nowIso(),
    type: "draftEdit",
    label: "下書き更新",
    message: "下書きを編集しました（mock）。",
  });
  recordHumanIntervention(tradeCaseId, { actionType: "agentRunEdit", label: "下書きを編集", note: `step:${current.id}` });
  log(`修正（mock）: ${current.id}`);
  return true;
}

function renderNewTop() {
  const rawTab = state.topActiveTab || "shelf";
  const tab = newTopTabs.some((t) => t && String(t.key) === String(rawTab)) ? rawTab : "issues";

  const renderDraftEditModal = () => {
    const apId = String(state.activeDraftEditActionPlanId || "").trim();
    if (!apId) return "";
    const drafts = Array.isArray(state.latestIngestResult?.drafts) ? state.latestIngestResult.drafts.filter(Boolean) : [];
    const draft = drafts.find((d) => String(d?.actionPlanId || "") === apId) || null;
    if (!draft) return "";

    const toText = (() => {
      const raw = draft?.to;
      if (Array.isArray(raw)) return raw.map((x) => String(x || "")).filter(Boolean).join(", ");
      if (typeof raw === "string") return raw;
      return "";
    })();
    const ccText = (() => {
      const raw = draft?.cc;
      if (Array.isArray(raw)) return raw.map((x) => String(x || "")).filter(Boolean).join(", ");
      if (typeof raw === "string") return raw;
      return "";
    })();

    const subjectText = draft?.subject ? String(draft.subject) : "";
    const bodyText = draft?.body ? String(draft.body) : "";

    return `
      <div class="draft-edit-overlay" data-draft-edit-overlay="1" role="dialog" aria-modal="true" aria-label="Edit supplier email">
        <div class="draft-edit-modal" data-draft-edit-modal="1">
          <div class="draft-edit-modal__top">
            <div class="draft-edit-modal__title">Edit supplier email</div>
          </div>
          <div class="draft-edit-modal__form" aria-label="Draft fields">
            <label class="draft-edit-modal__field">
              <div class="draft-edit-modal__label">To</div>
              <input class="draft-edit-modal__input" data-draft-edit-to value="${escapeHtml(toText)}" />
            </label>
            <label class="draft-edit-modal__field">
              <div class="draft-edit-modal__label">CC</div>
              <input class="draft-edit-modal__input" data-draft-edit-cc value="${escapeHtml(ccText)}" />
            </label>
            <label class="draft-edit-modal__field">
              <div class="draft-edit-modal__label">Subject</div>
              <input class="draft-edit-modal__input" data-draft-edit-subject value="${escapeHtml(subjectText)}" />
            </label>
            <label class="draft-edit-modal__field">
              <div class="draft-edit-modal__label">Body</div>
              <textarea class="draft-edit-modal__textarea" data-draft-edit-body>${escapeHtml(bodyText)}</textarea>
            </label>
          </div>
          <div class="draft-edit-modal__actions" aria-label="Draft edit actions">
            <button class="btn btn--ghost" type="button" data-draft-edit-cancel="1">Cancel</button>
            <button class="btn btn--primary" type="button" data-draft-edit-save="1">Save draft</button>
          </div>
        </div>
      </div>
    `;
  };

  const renderHumanMemoModal = () => {
    const ctx = state.activeHumanMemoEdit || null;
    if (!ctx) return "";
    const mode = ctx.mode === "edit" ? "edit" : "create";
    const title = mode === "edit" ? "人間メモを編集" : "人間メモを追加";
    const focusType = normalizeFocusType(ctx.focusType);
    const focusIdRaw = String(ctx.focusId || "").trim();
    const focusId = focusType === "invoice" ? normalizeInvoiceNo(focusIdRaw) : focusIdRaw;
    const tradeCaseId = String(ctx.tradeCaseId || "").trim();
    if (!focusType || !focusId || !tradeCaseId) return "";

    const tc = getTradeCaseById(tradeCaseId);
    if (!tc) return "";

    const focusEntity = { type: focusType, id: focusId };
    const candidates = buildHumanMemoCandidateEntities(tc, focusEntity);
    const selected = uniqLinkedEntities(Array.isArray(ctx.selectedEntities) ? ctx.selectedEntities : [focusEntity]);
    const selectedKeys = new Set(selected.map((e) => `${e.type}::${e.id}`));
    const draft = String(ctx.bodyDraft || "");

    const renderPickChip = (e) => {
      const key = `${e.type}::${e.id}`;
      const label = formatFocusLabel(e.type, e.id) || String(e.id || "");
      const isOn = selectedKeys.has(key);
      const cls = isOn ? "memo-chip memo-chip--pick is-selected" : "memo-chip memo-chip--pick";
      return `<button class="${cls}" type="button" data-human-memo-entity-toggle="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
    };

    const focusLabel = formatFocusLabel(focusEntity.type, focusEntity.id) || String(focusEntity.id || "");
    const relatedCandidates = candidates.filter((e) => `${e.type}::${e.id}` !== `${focusEntity.type}::${focusEntity.id}`);

    return `
      <div class="human-memo-overlay" data-human-memo-overlay="1" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="human-memo-modal" data-human-memo-modal="1">
          <div class="human-memo-modal__top">
            <div class="human-memo-modal__title">${escapeHtml(title)}</div>
          </div>
          <div class="human-memo-modal__form">
            <label class="human-memo-modal__field">
              <div class="human-memo-modal__label">本文</div>
              <textarea class="human-memo-modal__textarea" data-human-memo-body placeholder="この書類・案件についての補足を入力">${escapeHtml(draft)}</textarea>
            </label>
            <div class="human-memo-modal__field">
              <div class="human-memo-modal__label">紐付き</div>
              <div class="memo-chip-row"><span class="memo-chip memo-chip--fixed">${escapeHtml(focusLabel)}</span></div>
            </div>
            ${
              relatedCandidates.length
                ? `<div class="human-memo-modal__field">
                    <div class="human-memo-modal__label">関連にも付ける</div>
                    <div class="memo-chip-row">${relatedCandidates.map((e) => renderPickChip(e)).join("")}</div>
                  </div>`
                : ""
            }
          </div>
          <div class="human-memo-modal__actions">
            <button class="btn btn--ghost btn--tiny" type="button" data-human-memo-cancel="1">Cancel</button>
            <button class="btn btn--primary btn--tiny" type="button" data-human-memo-save="1">Save</button>
          </div>
        </div>
      </div>
    `;
  };

  const navIconByKey = {
    shelf: "🗂️",
    issues: "⚠️",
    activity: "📡",
    settings: "⚙️",
  };

  const navHtml = `<nav class="top-nav" aria-label="Primary">
    ${newTopTabs
      .filter((t) => !(t && t.hiddenInNav))
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

  const resolveIssueLabelForTradeCase = (tc) => {
    const id = String(tc?.id || "");
    if (!id) return "";
    if (id === "TC-2026-0001") return "ISS-CAND-TIMELINE-001";
    return "";
  };

  const { renderShelf } = createShelfRenderer({
    state,
    shipments,
    escapeHtml,
    isOverdueYmd,
    resolveIssueLabelForTradeCase,
    getMockEvidenceArchiveItems,
  });


  const approvalCenterRenderer = createApprovalCenterRenderer({
    DEBUG_PRE_ISSUE,
    approvalStatusLabelJa,
    buildIssueLikeFromMutation,
    classifyLabelJaFromIntent,
    computeConversationThreadsFromRawRequests,
    confidenceLabelJa,
    dedupePreIssueItems,
    detectIncidents,
    displayConversationStatusLabel,
    escapeHtml,
    extractMutationParsed,
    findActionPlanIdFromAnyId,
    findCanonicalConversationIdByOperationalThreadId,
    findCanonicalConversationIdBySourceRawInputId,
    formatLocalTime,
    formatRequestSourceLabel,
    getAvailableApprovalActions,
    getConversationThreadMessageCount,
    getMutationOpenId,
    getPreIssueItemKey,
    getTradeCaseById,
    groupIssueMutationsForApproval,
    hasApprovalCandidateForThread,
    incidentTitleJa,
    isPendingActionItem,
    isPreIssueConversationThread,
    isPreIssueItem,
    matchesMutationId,
    normalizeConversationStatusKey,
    normalizeMutationTitle,
    nowIso,
    resolveThreadForApprovalCandidate,
    resolveThreadForPreIssueItem,
    shortId,
    shouldShowApprovalActionButtons,
    summarizeEntitiesJa,
  });

  const renderIssues = () => approvalCenterRenderer.renderApprovalCenter({ state });

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
    // Activity page is an audit surface.
    // Operational work should happen in Shelf / Workspace / Approval Center.
    // This side summary only shows processing status derived from current state.
    const filterKey = state.activityFilterKey || "all";
    const itemsRaw = Array.isArray(state.activityFeedItems) ? state.activityFeedItems.filter(Boolean) : [];
    const items = itemsRaw
      .slice()
      .sort((a, b) => {
        const atA = String(a?.occurredAt || "");
        const atB = String(b?.occurredAt || "");
        if (atA !== atB) return atB.localeCompare(atA);
        // Same occurredAt: show the later step first within the same pipeline (sequence DESC).
        // Keep null/undefined sequence at the bottom.
        return (b?.sequence ?? -999) - (a?.sequence ?? -999) || String(a?.id || "").localeCompare(String(b?.id || ""));
      });

    const filterDefs = [
      { key: "all", label: "全て" },
      { key: "teams", label: "Teams" },
      { key: "email", label: "Email" },
      { key: "slack", label: "Slack" },
      { key: "aiProcessed", label: "AI処理" },
      { key: "awaitingApproval", label: "承認待ち" },
      { key: "failed", label: "失敗" },
      { key: "supplierReply", label: "仕入先返信" },
    ];

      const matchesFilter = (it) => {
        const src = String(it?.source || "").toLowerCase();
        const t = String(it?.type || "").toLowerCase();
        const status = String(it?.statusKey || "").toLowerCase();
        if (filterKey === "teams") return src === "teams";
        if (filterKey === "email") return src === "email";
        if (filterKey === "slack") return src === "slack";
        if (filterKey === "aiProcessed") return src === "ai" || t === "aiprocessed" || t === "issueupdated" || t === "issueresolved";
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
      const summary = String(it?.summary || "").trim();
      const details = Array.isArray(it?.details) ? it.details.filter(Boolean) : [];
      const id = String(it?.id || "");
      const expanded = !!(state.activityExpandedById && state.activityExpandedById[id]);
      const toggleIcon = expanded ? "▼" : "▶";
      const metaInline = [actor, at].filter(Boolean).join(" · ");
      const summaryHtml = summary ? `<div class="activity-summary">${escapeHtml(summary)}</div>` : "";
      const detailsHtml =
        expanded && details.length
          ? `<div class="activity-detail">
              <ul class="activity-details">${details.map((d) => `<li>${escapeHtml(String(d))}</li>`).join("")}</ul>
            </div>`
          : "";

      return `<article class="activity-item" aria-label="Activity item">
        <div class="activity-tl" aria-hidden="true">
          <div class="activity-line"></div>
          <div class="activity-dot ${escapeHtml(statusDotClass(it))}"></div>
        </div>
        <div class="activity-card">
          <div class="activity-headline">
            <button class="activity-toggle" type="button" data-activity-toggle="${escapeHtml(id)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="toggle details">
              ${escapeHtml(toggleIcon)}
            </button>
            <div class="activity-title" title="${escapeHtml(title || "-")}">${escapeHtml(title || "-")}</div>
            <div class="activity-meta-inline">${escapeHtml(metaInline || "")}</div>
          </div>
          ${summaryHtml}
          ${expanded ? renderLinked(it) : ""}
          ${detailsHtml}
          ${expanded ? renderLinks(it) : ""}
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
      : `<div class="activity-empty nt-muted">活動ログがありません。</div>`;

    const headerHtml = `<header class="activity-head" aria-label="Feed header">
      <div class="activity-head__title">活動ログ</div>
      <div class="activity-head__sub nt-muted">AI・Teams・Email・Slack の更新を時系列で表示します。</div>
    </header>`;

    const queueCounts = buildActivityProcessingSummary(state);

    const railHtml = `<aside class="activity-rail" aria-label="System rail">
      <section class="activity-rail__section" aria-label="AI処理状況">
        <div class="activity-rail__h">AI処理状況</div>
        <div class="activity-rail__kv"><span class="k">未整理連絡</span><span class="v nt-mono">${escapeHtml(
          String(queueCounts.awaitingClassification),
        )}</span></div>
        <div class="activity-rail__kv"><span class="k">確認待ち</span><span class="v nt-mono">${escapeHtml(
          String(queueCounts.awaitingApproval),
        )}</span></div>
        <div class="activity-rail__kv"><span class="k">要確認</span><span class="v nt-mono">${escapeHtml(
          String(queueCounts.failedProcessing),
        )}</span></div>
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

  const renderSettingsPage = () => {
    const endpointPath = "/slack/events";
    const endpointFull = `${API_BASE_URL}${endpointPath}`;
    const status = state.slackIntegrationStatus?.status || "unknown";
    const lastReceivedAt = state.slackIntegrationStatus?.lastReceivedAt || null;
    const lastText = lastReceivedAt ? formatLocalTime(lastReceivedAt) : "—";
    const statusText = status === "connected" ? "Connected" : "Unknown";

    return `<section class="settings-page" aria-label="Settings page">
      <header class="settings-head">
        <div class="settings-head__title">Settings</div>
        <div class="settings-head__sub nt-muted">Integrations（hackathon demo）</div>
      </header>

      <div class="settings-grid" aria-label="Settings grid">
        <section class="settings-card" aria-label="Slack integration">
          <div class="settings-card__h">Slack Integration</div>
          <div class="settings-kv">
            <div class="k">Endpoint</div>
            <div class="v nt-mono">${escapeHtml(endpointFull)}</div>
          </div>
          <div class="settings-kv">
            <div class="k">Status</div>
            <div class="v">${escapeHtml(statusText)}</div>
          </div>
          <div class="settings-kv">
            <div class="k">Last Event</div>
            <div class="v nt-mono">${escapeHtml(lastText)}</div>
          </div>
          <div class="settings-actions">
            <button class="btn btn--ghost btn--small" type="button" data-slack-refresh="1">Refresh</button>
          </div>
          <div class="nt-muted settings-note">※ Signing secret verification は TODO（hackathon demo）</div>
        </section>
      </div>
    </section>`;
  };

  const renderRequests = ({ embedded, rightPanelToggle } = {}) => {
    const effectiveClassifyMode = getEffectiveClassifyMode(state.classifyMode);
    const list = Array.isArray(state.rawRequests) ? state.rawRequests.filter(Boolean) : [];
    const conversationThreads = computeConversationThreadsFromRawRequests(list);
    const approvalSide = {
      actionPlans: Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans : [],
      issueMutations: Array.isArray(state.issueMutationItems) ? state.issueMutationItems : [],
    };

    const preIssueThreads = conversationThreads.filter((t) => {
      return isPreIssueConversationThread(t) && !hasApprovalCandidateForThread(t, approvalSide);
    });
    const intakeCandidates = preIssueThreads;
    const activeConversationThreadId =
      state.activeConversationThreadId || (intakeCandidates[0] && intakeCandidates[0].id) || null;

    const sourceLabel = (s) => {
      const v = String(s || "").toLowerCase();
      if (v === "teams") return "Teams";
      if (v === "web") return "Web";
      if (v === "email") return "Email";
      if (v === "manualmemo") return "Manual memo";
      return v || "-";
    };

    const statusBadgeHtml = (status) => {
      const s = normalizeConversationStatusKey(status);
      const label = displayConversationStatusLabel(s);
      const cls = s === "awaiting_clarification" ? "is-pending" : s === "matched" ? "is-matched" : "";
      return `<span class="request-inbox-badge ${cls}">${escapeHtml(label)}</span>`;
    };

    const cardsHtml = intakeCandidates
      .map((t) => {
        const isActive = Boolean(activeConversationThreadId && String(t.id) === String(activeConversationThreadId));
        const src = sourceLabel(t.sourceChannel);
        const updated = String(t.updatedAt || "");
        const title = String(t.title || "会話");
        const last = String(t.lastMessageText || "");
        const count = typeof t.messageCount === "number" ? t.messageCount : 0;
        const si = Array.isArray(t.relatedSiIds) ? t.relatedSiIds.filter(Boolean) : [];
        const siChips = si.length ? si.map((x) => `<span class="mini-chip">${escapeHtml(x)}</span>`).join("") : "";

        return `<div class="conversation-thread-card ${isActive ? "selected" : ""}" role="button" tabindex="0" data-conversation-thread-open="${escapeHtml(
          String(t.id || ""),
        )}">
          <div class="conversation-thread-meta">
            <div class="conversation-thread-meta__left">
              <div class="conversation-thread-card__sender">${escapeHtml(String(t.requesterName || "—"))}</div>
              <span class="request-channel-badge">${escapeHtml(src)}</span>
              <span class="conversation-thread-card__time nt-mono">${escapeHtml(updated)}</span>
            </div>
            <div class="conversation-thread-meta__right">${statusBadgeHtml(t.status)}</div>
          </div>
          <div class="conversation-thread-card__title">${escapeHtml(title)}</div>
          <div class="conversation-thread-card__preview">${escapeHtml(`最終メッセージ: ${last}`)}</div>
          <div class="conversation-thread-card__foot">
            <span class="nt-mono">${escapeHtml(String(count))} messages</span>
            <span class="conversation-thread-card__foot-right">
              ${siChips ? `<span class="conversation-thread-card__chips">${siChips}</span>` : ""}
              <button class="btn btn--ghost btn--small" type="button" data-conversation-thread-open="${escapeHtml(
                String(t.id || ""),
              )}">会話を見る</button>
            </span>
          </div>
        </div>`;
      })
      .join("");

    const ingestResult = state.latestIngestResult;
    const ingestThreads = Array.isArray(ingestResult?.threads) ? ingestResult.threads.filter(Boolean) : [];
    const rawIngestLinks = Array.isArray(ingestResult?.links) ? ingestResult.links.filter(Boolean) : [];
    const ingestResolutions = Array.isArray(ingestResult?.intakeResolutions) ? ingestResult.intakeResolutions.filter(Boolean) : [];
    const ingestEvents = Array.isArray(ingestResult?.activityEvents) ? ingestResult.activityEvents.filter(Boolean) : [];
    const ingestMutations = Array.isArray(ingestResult?.issueMutations) ? ingestResult.issueMutations.filter(Boolean) : [];
    const ingestActionPlans = Array.isArray(ingestResult?.actionPlans) ? ingestResult.actionPlans.filter(Boolean) : [];
    const ingestDrafts = Array.isArray(ingestResult?.drafts) ? ingestResult.drafts.filter(Boolean) : [];
    const ctxResolution = ingestResult?.contextResolution || null;

    const isLlmResult = state.latestIngestResultMode === "llm";
    const llmThreads = isLlmResult ? ingestThreads : [];
    const ingestLinks = rawIngestLinks;

    const intentLabel = (intent) => {
      const v = String(intent || "");
      const map = {
        missing_document_check: "書類未着確認",
        shipment_status_check: "出荷状況確認",
        quantity_mismatch: "数量・金額差異",
        eta_change: "ETA変更",
        air_change_check: "AIR変更確認",
        unknown: "要確認",
      };
      return map[v] || v || "-";
    };

    const llmResultHtml = isLlmResult
      ? `<div class="ingest-result__llm" aria-label="LLM result">
          <div class="ingest-result__llm-head">
            <div class="ingest-result__h">AI分類結果</div>
            <span class="req-pill req-pill--llm">KimiによるAI分類</span>
          </div>
          <div class="ingest-result__llm-sub muted">${escapeHtml(String(llmThreads.length))}件の業務スレッドを検出</div>
          <div class="ingest-result__llm-list">
            ${llmThreads
              .map((t) => {
                const intent = String(t?.intent || "unknown");
                const title = String(t?.title || "Untitled");
                const confidence = typeof t?.confidence === "number" ? t.confidence : null;
                const cfText = typeof confidence === "number" && Number.isFinite(confidence) ? confidence.toFixed(2) : "-";
                const extracted = t?.extractedEntities && typeof t.extractedEntities === "object" ? t.extractedEntities : {};
                const entities = [];
                const push = (label, values) => {
                  const arr = Array.isArray(values) ? values.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
                  if (!arr.length) return;
                  entities.push(`<div class="ingest-entity"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(arr.join(", "))}</span></div>`);
                };
                push("SI", extracted.siIds);
                push("Shipment", extracted.shipmentIds);
                push("Invoice", extracted.invoiceIds);
                push("Supplier", extracted.supplierNames);
                push("Doc", extracted.documentTypes);
                return `<div class="ingest-llm-thread">
                  <div class="ingest-llm-thread__top">
                    <span class="ingest-llm-thread__intent nt-mono">[${escapeHtml(intentLabel(intent))}]</span>
                    <span class="ingest-llm-thread__title">${escapeHtml(title)}</span>
                    <span class="ingest-llm-thread__cf nt-mono">${escapeHtml(cfText)}</span>
                  </div>
                  ${entities.length ? `<div class="ingest-llm-thread__entities">${entities.join("")}</div>` : `<div class="nt-muted">紐付け先: （なし）</div>`}
                </div>`;
              })
              .join("")}
          </div>
        </div>`
      : "";

    const ingestSummaryHtml = ingestResult
      ? `<div class="ingest-result" aria-label="Latest ingest result">
          <div class="ingest-result__stats" aria-label="Ingest summary stats">
            <div><span class="k">業務スレッド</span><span class="v nt-mono">${escapeHtml(String(ingestThreads.length))}</span></div>
            <div><span class="k">紐付け先</span><span class="v nt-mono">${escapeHtml(String(ingestLinks.length))}</span></div>
            <div><span class="k">Intake</span><span class="v nt-mono">${escapeHtml(String(ingestResolutions.length))}</span></div>
            <div><span class="k">活動ログ</span><span class="v nt-mono">${escapeHtml(String(ingestEvents.length))}</span></div>
            <div><span class="k">Issue更新候補</span><span class="v nt-mono">${escapeHtml(String(ingestMutations.length))}</span></div>
            <div><span class="k">ActionPlans</span><span class="v nt-mono">${escapeHtml(String(ingestActionPlans.length))}</span></div>
            <div><span class="k">Drafts</span><span class="v nt-mono">${escapeHtml(String(ingestDrafts.length))}</span></div>
          </div>
          ${
            ctxResolution && String(ctxResolution.status || "") !== "resolved_enough"
              ? `<div class="ingest-result__note">
                  <div class="muted">${escapeHtml(String(ctxResolution.reason || ""))}</div>
                  ${
                    ctxResolution.clarificationQuestion
                      ? `<pre class="pre pre--compact" style="margin-top:8px;">${escapeHtml(String(ctxResolution.clarificationQuestion || ""))}</pre>`
                      : ""
                  }
                </div>`
              : ""
          }
          <div class="ingest-result__note muted">詳細は Issues（承認センター）で確認してください。</div>
          <div class="ingest-result__actions">
            <button class="btn btn--primary btn--small" type="button" data-open-approval-center="1">Open Issues（承認センター）</button>
          </div>
          <div class="accordion" data-accordion-root>
            <div class="accordion__item">
              <button class="accordion__trigger" type="button" data-accordion-trigger aria-expanded="false">
                <span class="pill pill--mini">詳細（debug）</span>
                <span class="accordion__summary">threads / actionPlans / drafts / LLM result</span>
              </button>
              <div class="accordion__panel" hidden>
                ${llmResultHtml}
                ${
                  ingestActionPlans.length
                    ? `<div class="ingest-result__threads">
                        <div class="ingest-result__h">Action Plans</div>
                        <ul class="ingest-result__list">${ingestActionPlans
                          .map((p) => {
                            const title = String(p?.title || "ActionPlan");
                            const types = Array.isArray(p?.actionTypes) ? p.actionTypes.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
                            const meta = types.length ? `(${types.join(", ")})` : "";
                            return `<li>${escapeHtml(title)} <span class="muted nt-mono">${escapeHtml(meta)}</span></li>`;
                          })
                          .join("")}</ul>
                      </div>`
                    : ""
                }
                ${
                  ingestDrafts.length
                    ? `<div class="ingest-result__threads">
                        <div class="ingest-result__h">Drafts</div>
                        <ul class="ingest-result__list">${ingestDrafts
                          .map((d) => {
                            const ch = String(d?.channel || "-");
                            const to = d?.to ? String(d.to) : "";
                            const subj = d?.subject ? String(d.subject) : "";
                            const label = ch === "email" ? `email${to ? ` → ${to}` : ""}` : "teams";
                            const meta = subj ? `(${subj})` : "";
                            return `<li>${escapeHtml(label)} <span class="muted nt-mono">${escapeHtml(meta)}</span></li>`;
                          })
                          .join("")}</ul>
                      </div>`
                    : ""
                }
                ${
                  ingestThreads.length
                    ? `<div class="ingest-result__threads">
                        <div class="ingest-result__h">スレッド</div>
                        <ul class="ingest-result__list">${ingestThreads
                          .map((t) => `<li>${escapeHtml(String(t?.title || t?.id || "Thread"))}</li>`)
                          .join("")}</ul>
                      </div>`
                    : ""
                }
              </div>
            </div>
          </div>
        </div>`
      : "";

    return `<section class="req-page requests-hub ${embedded ? "req-page--embedded" : ""}" aria-label="Change & Check Requests">
      ${
        embedded
          ? ""
          : `<div class="req-title">
              <div class="req-title__h">変更・確認依頼</div>
              <div class="req-title__sub">Teams/Email由来の連絡をAIが整理し、人間の判断が必要なものを集約します（mock）。</div>
            </div>`
      }

      <div class="requests-intake" aria-label="Intake">
        <div class="requests-intake__head">
          <div>
            <div class="requests-intake__title">変更・確認依頼を取り込む</div>
            <div class="requests-intake__sub muted">貼り付けた依頼をAIが整理し、受信ボックスへ反映します。</div>
          </div>
          ${
            embedded && rightPanelToggle
              ? `<div class="requests-intake__head-right">
                  <button class="right-panel-toggle right-panel-toggle--inside" type="button" data-toggle-approval-right-panel="1" aria-label="${escapeHtml(
                    rightPanelToggle.label,
                  )}">${escapeHtml(rightPanelToggle.icon)}</button>
                </div>`
              : ""
          }
        </div>

        <div class="requests-intake__form" aria-label="Mock ingest form">
          <textarea class="ingest-textarea requests-intake__textarea" rows="2" placeholder="例: PLまだ？あとSI-224も確認して" data-ingest-input="1">${escapeHtml(
            String(state.ingestInputText || ""),
          )}</textarea>
          <div class="requests-intake__actions">
            <button class="btn btn--primary btn--small" type="button" data-ingest-submit="1" ${
              state.ingestLoading ? "disabled" : ""
            }>${effectiveClassifyMode === "mock" ? "モックを実行" : "AI分類を実行"}</button>
            <button class="btn btn--ghost btn--small" type="button" data-ingest-sample="1" ${state.ingestLoading ? "disabled" : ""}>サンプル</button>
            ${
              state.ingestLoading
                ? effectiveClassifyMode === "llm"
                  ? `<span class="ingest-loading nt-muted"><span class="spinner" aria-hidden="true"></span>Kimiが分類中...</span>`
                  : `<span class="ingest-loading nt-muted">loading...</span>`
                : ""
            }
          </div>
          ${state.ingestNotice ? `<div class="ingest-notice">${escapeHtml(String(state.ingestNotice))}</div>` : ""}
          ${state.ingestError ? `<div class="ingest-error">${escapeHtml(String(state.ingestError))}</div>` : ""}
          <details class="debug-collapsible" aria-label="Debug details">
            <summary>詳細（debug）</summary>
            ${ingestSummaryHtml || `<div class="nt-muted">No ingest result</div>`}
          </details>
        </div>
      </div>

      ${
        embedded
          ? ""
          : `<div class="requests-inbox-layout" aria-label="Inbox / Conversation hub">
        <div class="request-inbox-panel" aria-label="Issue intake candidates">
          <div class="request-inbox-panel__head">
            <div class="request-inbox-panel__title">確認待ち</div>
            <div class="request-inbox-panel__count nt-mono">${escapeHtml(String(intakeCandidates.length))}</div>
          </div>
          <div class="request-inbox-panel__sub muted">AIが確認が必要と判断した連絡・更新を表示します。</div>
          <div class="requests-manual-add" aria-label="Manual add">
            <textarea class="requests-manual-add__input" rows="1" placeholder="＋ 手入力で追加（例: PLまだ？）" data-requests-input="1"></textarea>
            <button class="btn btn--ghost btn--small" type="button" data-requests-add="1">追加</button>
          </div>
          <div class="conversation-thread-list">${
            cardsHtml ||
            `<div class="requests-empty">
              <div class="requests-empty__title">現在、確認待ちの案件はありません。</div>
              <div class="requests-empty__sub">Slack・Email・Teams などの連絡から、人間の判断が必要なものだけ自動でここに表示されます。</div>
            </div>`
          }</div>
        </div>
      </div>`
      }
    </section>`;
  };

  const mainHtml =
    tab === "shelf"
      ? renderShelf()
      : tab === "issues"
        ? (() => {
            const rightCollapsed = Boolean(state.approvalCenterRightPanelCollapsed);
            const toggleLabel = rightCollapsed ? "変更・確認依頼パネルを開く" : "変更・確認依頼パネルを閉じる";
            // UI only: keep approval/ingest logic and state names unchanged.
            const toggleIcon = rightCollapsed ? "‹ 入力" : "›";
            return `<section class="operations-page" aria-label="Operations">
              <div class="operations-layout ${rightCollapsed ? "is-right-collapsed" : ""}" aria-label="Approvals + Requests layout">
                <div class="operations-left" aria-label="Approvals">${renderIssues()}</div>
                <div class="operations-right ${rightCollapsed ? "is-collapsed" : ""}" aria-label="Requests">
                  ${
                    rightCollapsed
                      ? `<div class="operations-right__handle" aria-label="Right panel handle">
                          <button class="right-panel-toggle right-panel-toggle--collapsed" type="button" data-toggle-approval-right-panel="1" aria-label="${escapeHtml(
                            toggleLabel,
                          )}">${escapeHtml(toggleIcon)}</button>
                        </div>`
                      : ""
                  }
                  <div class="operations-right__body" ${rightCollapsed ? 'aria-hidden="true"' : ""}>${
                    rightCollapsed
                      ? ""
                      : renderRequests({
                          embedded: true,
                          rightPanelToggle: { label: toggleLabel, icon: toggleIcon },
                        })
                  }</div>
                </div>
              </div>
            </section>`;
          })()
        : tab === "activity"
          ? renderActivityFeedPage()
        : renderSettingsPage();

	  return `
	    <div class="new-top">
	      <header class="top-header">
	        <div class="top-header__brand">Trade Shelf Agent</div>
	      </header>
		      ${navHtml}
		      <main class="nt-main" aria-label="Main">${mainHtml}</main>
	        ${renderDraftEditModal()}
          ${renderHumanMemoModal()}
		    </div>
		  `;
}

function renderApp() {
  window.__renderAppCount = (window.__renderAppCount || 0) + 1;
  if (DEBUG_UI_LOGS) {
    console.log("[renderApp]", {
      count: window.__renderAppCount,
      newTopCountBefore: document.querySelectorAll("#app > .new-top").length,
      workspaceModalExists: !!document.getElementById("document-workspace-modal"),
    });
  }

  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = renderNewTop();
  syncOperationalThreadModal();

  if (DEBUG_UI_LOGS) {
    console.log("[renderApp done]", {
      count: window.__renderAppCount,
      newTopCountAfter: document.querySelectorAll("#app > .new-top").length,
      workspaceModalExists: !!document.getElementById("document-workspace-modal"),
    });
  }
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
    window.alert("(mock) 対応案が見つかりません。");
    return;
  }

  if (action === "edit") {
    const current = String(msg.proposedAction.draftBody || "");
    const next = window.prompt("下書きを編集（mock）", current);
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
      state.activeMutationId = null;
      state.isOperationalThreadModalOpen = false;
      renderApp();
    } else {
      const issueId = thr && thr.linkedIssueId ? String(thr.linkedIssueId).trim() : "";
      const mutation = issueId
        ? (Array.isArray(state.issueMutationItems) ? state.issueMutationItems : []).find((m) => m && String(m.issueId || "") === issueId) || null
        : null;
      if (mutation && mutation.id) {
        state.topActiveTab = "issues";
        state.activeIssueId = null;
        state.activeMutationId = String(mutation.id);
        state.isOperationalThreadModalOpen = false;
        renderApp();
      } else {
        window.alert("No related Issue found in mock data.");
      }
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
  if (!logItems) {
    console.log(String(text || ""));
    return;
  }
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

function openModal({ title, bodyText, bodyHtml, variant }) {
  const modal = document.getElementById("modal");
  const v = String(variant || "").trim();
  modal.classList.remove("modal--conversation-thread");
  if (v === "conversation_thread") {
    modal.classList.add("modal--conversation-thread");
    modal.classList.remove("modal--tradecase");
  } else {
    modal.classList.add("modal--tradecase");
  }

  const backBtn = document.getElementById("btn-back");
  if (backBtn) backBtn.style.display = v === "conversation_thread" ? "none" : "";

  const closeBtn = document.getElementById("btn-close");
  if (closeBtn) {
    closeBtn.classList.toggle("modal-close-btn", v === "conversation_thread");
    closeBtn.textContent = v === "conversation_thread" ? "×" : "閉じる";
  }

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
  if (!modal) return;
  if (modal && modal.contains(document.activeElement)) {
    try {
      document.activeElement.blur();
    } catch {
      // ignore
    }
  }
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  modal.classList.remove("modal--conversation-thread");
  modal.classList.add("modal--tradecase");
  const backBtn = document.getElementById("btn-back");
  if (backBtn) backBtn.style.display = "";
  const closeBtn = document.getElementById("btn-close");
  if (closeBtn) {
    closeBtn.classList.remove("modal-close-btn");
    closeBtn.textContent = "閉じる";
  }
  state.modalTradeCaseId = null;
  state.activeContextDrawer = null;
}

function openWorkspaceModal(modalId, { title, titleHtml, bodyHtml, tradeCaseId }) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  const modalTitle = modal.querySelector(".modal__title");
  const body = modal.querySelector(".modal__body");
  if (modalTitle) {
    if (typeof titleHtml === "string" && titleHtml) {
      modalTitle.innerHTML = titleHtml;
    } else {
      modalTitle.textContent = title || "";
    }
  }
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
  if (modal.contains(document.activeElement)) {
    try {
      document.activeElement.blur();
    } catch {
      // ignore
    }
  }
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  modal.removeAttribute("data-tradecase-id");
}

function rerenderOpenDocumentWorkspaceBody() {
  const modalId = "document-workspace-modal";
  const modalEl = document.getElementById(modalId);
  if (!modalEl) return;
  if (!modalEl.classList.contains("is-open")) return;
  const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
  const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
  if (!tc) return;
  const ui = getWorkspaceUi(modalId);
  const titleEl = modalEl.querySelector(".modal__title");
  if (titleEl) {
    const headerLabels = documentWorkspaceRenderer.buildWorkspaceHeaderLabels({ tradeCase: tc, focusType: ui.focusType, focusId: ui.focusId });
    titleEl.innerHTML = renderWorkspaceTitleHtml(headerLabels);
  }
  const body = modalEl.querySelector(".modal__body");
  if (body) {
    body.innerHTML = documentWorkspaceRenderer.renderDocumentWorkspace(tc, {
      focusType: ui.focusType,
      focusId: ui.focusId,
      stateTransitionCandidates: state.latestIngestResult?.stateTransitionCandidates ?? [],
    });
  }
}

function renderWorkspaceTitleHtml(labels) {
  const l = labels && typeof labels === "object" ? labels : {};
  const title = String(l.title || "").trim();
  const subtitle = String(l.subtitle || "").trim();
  const subtitleHtml = subtitle ? `<div class="workspace-title__sub muted">${escapeHtml(subtitle)}</div>` : "";
  return `<div class="workspace-title"><div class="workspace-title__main"><div class="workspace-title__text">${escapeHtml(
    title || "-",
  )}</div>${subtitleHtml}</div></div>`;
}

function uniqLinkedEntities(entities) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const type = normalizeFocusType(e?.type);
    const id = String(e?.id || "").trim();
    if (!type || !id || id === "-") continue;
    const key = `${type}::${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
  }
  return out;
}

function buildHumanMemoCandidateEntities(tradeCase, focusEntity) {
  const tc = tradeCase || null;
  const focus = focusEntity || null;
  const candidates = [];
  if (focus) candidates.push(focus);

  const siNo = tc?.siEntity?.siNo ? String(tc.siEntity.siNo).trim() : "";
  if (siNo) candidates.push({ type: "si", id: siNo });

  const shipmentId = tc?.shipmentEntity?.id ? String(tc.shipmentEntity.id).trim() : "";
  if (shipmentId) candidates.push({ type: "shipment", id: shipmentId });

  const invoiceNo = (() => {
    const inv = Array.isArray(tc?.invoiceNumbers) ? tc.invoiceNumbers.filter(Boolean)[0] : null;
    const raw = inv?.invoiceNo ? String(inv.invoiceNo).trim() : "";
    return raw ? normalizeInvoiceNo(raw) : "";
  })();
  if (invoiceNo) candidates.push({ type: "invoice", id: invoiceNo });

  return uniqLinkedEntities(candidates).slice(0, 6);
}

function isAnyWorkspaceModalOpen() {
  const shipment = document.getElementById("shipment-workspace-modal");
  const si = document.getElementById("si-workspace-modal");
  const doc = document.getElementById("document-workspace-modal");
  return Boolean(
    (shipment && shipment.classList.contains("is-open")) ||
      (si && si.classList.contains("is-open")) ||
      (doc && doc.classList.contains("is-open")),
  );
}

function getWorkspaceUi(modalId) {
  if (!state.workspaceUiByModalId[modalId]) {
    state.workspaceUiByModalId[modalId] = { activeDocId: null, activePageByDocId: {}, zoomByDocId: {}, showMarkers: true, focusType: "case", focusId: "-" };
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

function isShippingInstructionDocument(activeDocument, viewerKey) {
  const doc = activeDocument && typeof activeDocument === "object" ? activeDocument : null;
  const viewerKeyNorm = String(viewerKey || "").trim().toLowerCase();
  const docViewerKeyNorm = String(doc?.viewerKey || "").trim().toLowerCase();
  const docTypeNorm = String(doc?.type || "").trim().toLowerCase();
  const docIdNorm = String(doc?.id || "").trim().toLowerCase();
  const docTitle = String(doc?.title || doc?.label || "");

  if (!doc) return false;
  if (viewerKeyNorm === "si") return true;
  if (docViewerKeyNorm === "si") return true;
  if (docTypeNorm === "si") return true;
  if (docTypeNorm === "shipping instruction") return true;
  if (docIdNorm.startsWith("si-")) return true;
  if (/Shipping Instruction/i.test(docTitle)) return true;
  return false;
}

function renderDocumentViewer(documents, { modalId, viewerKey }) {
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const ui = ensureWorkspaceUiDefaults(modalId, docs);
  const activeDoc = docs.find((d) => d && d.id === ui.activeDocId) || docs[0] || null;
  const activeDocId = activeDoc ? activeDoc.id : null;
  const isActiveDocMissing = Boolean(activeDoc && activeDoc.status === "missing");
  const isBaselineShippingInstruction = isShippingInstructionDocument(activeDoc, viewerKey);

  if (isBaselineShippingInstruction) ui.showMarkers = false;

  if (!docs.length) {
    return `
      <div class="document-viewer" data-doc-viewer="${escapeHtml(String(viewerKey || ""))}">
        <div class="document-stage" role="region" aria-label="Document stage">
          <div class="paper-viewport">
            <div class="paper-document paper-document--empty" role="document" aria-label="Document placeholder">
              <div class="paper-page paper-page--placeholder">
                <div class="paper-page__title">書類待ち</div>
                <div class="paper-page__sub">この案件には、まだ関連書類が登録されていません。</div>
                <div class="paper-page__block">
                  <div class="muted">Slack / Email / Upload から書類が追加されると、ここに表示されます。</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  const pageCount = activeDoc && Array.isArray(activeDoc.mockPages) ? activeDoc.mockPages.length : 1;
  const activePageIdxRaw = activeDocId ? ui.activePageByDocId[activeDocId] : 0;
  const activePageIdx = clamp(typeof activePageIdxRaw === "number" ? activePageIdxRaw : 0, 0, Math.max(0, pageCount - 1));
  if (activeDocId) ui.activePageByDocId[activeDocId] = activePageIdx;

  const zoomRaw = activeDocId ? ui.zoomByDocId[activeDocId] : 100;
  const zoom = clamp(typeof zoomRaw === "number" ? zoomRaw : 100, 80, 160);
  if (activeDocId) ui.zoomByDocId[activeDocId] = zoom;

  const showMarkers = ui.showMarkers !== false && !isBaselineShippingInstruction;
  const canRenderMarkers = showMarkers && !isActiveDocMissing;

  const renderMarkersHtml = (markers) => {
    const list = Array.isArray(markers) ? markers.filter(Boolean) : [];
    if (!canRenderMarkers || !list.length) return "";
    return list
      .map((m) => {
        const kind = m && m.kind ? String(m.kind) : "note";
        const x = typeof m?.x === "number" ? m.x : 12;
        const y = typeof m?.y === "number" ? m.y : 12;
        const text = m && m.text ? String(m.text) : "";
        if (!text) return "";
        return `<div class="paper-marker paper-marker--${escapeHtml(kind)}" style="left:${escapeHtml(String(x))}%;top:${escapeHtml(String(y))}%">${escapeHtml(text)}</div>`;
      })
      .filter(Boolean)
      .join("");
  };

  let pagesHtml = `<div class="paper-page"><div class="muted">No document</div></div>`;
  if (activeDoc) {
    const previewImageSrc = String(activeDoc?.previewImageSrc || "").trim();
    if (previewImageSrc) {
      const title = String(activeDoc?.title || activeDoc?.type || activeDoc?.label || activeDoc?.id || "Document");
      const demoMarkers = [
        { kind: "pin", x: 23, y: 22, text: "SI番号を検出（OK）" },
        { kind: "note", x: 68, y: 45, text: "B/L Type: Surrender（要確認）" },
      ];
      const overlay = renderMarkersHtml(
        isBaselineShippingInstruction ? [] : Array.isArray(activeDoc?.previewMarkers) ? activeDoc.previewMarkers : demoMarkers,
      );
      pagesHtml = `
        <div class="paper-page paper-page--image">
          <div class="paper-page__page-no">1 / 1</div>
          <img class="paper-doc-image" src="${escapeHtml(previewImageSrc)}" alt="${escapeHtml(title)}" loading="lazy" />
          ${overlay ? `<div class="paper-overlay" aria-hidden="true">${overlay}</div>` : ""}
        </div>
      `;
    } else if (activeDoc.status === "missing") {
      const docLabel = String(activeDoc?.label || activeDoc?.type || activeDoc?.id || "書類").trim() || "書類";
      pagesHtml = `
        <div class="paper-page paper-page--placeholder">
          <div class="paper-page__page-no">1 / 1</div>
          <div class="paper-page__title">${escapeHtml(docLabel)}</div>
          <div class="paper-page__sub">状態：書類待ち</div>
          <div class="paper-page__block">
            <div class="paper-annotation">
              <div class="paper-annotation__title">AIメモ</div>
              <div class="paper-annotation__body">${escapeHtml(
                `${docLabel} 未着のため、通関準備に影響する可能性があります。`,
              )}</div>
            </div>
            <div class="muted" style="margin-top:10px">${escapeHtml(
              `${docLabel} はまだ登録されていません。Slack / Email / Upload から書類が追加されると、ここに表示されます。`,
            )}</div>
          </div>
        </div>
      `;
    } else {
      const pages = Array.isArray(activeDoc.mockPages) && activeDoc.mockPages.length ? activeDoc.mockPages : [{ title: activeDoc.title || activeDoc.type, rows: [] }];
      pagesHtml = pages
        .map((p, idx) => {
          const rows = Array.isArray(p?.rows) ? p.rows : [];
          const overlay = renderMarkersHtml(isBaselineShippingInstruction ? [] : p?.markers);
          const pageNo = `${idx + 1} / ${pages.length}`;
          return `
            <div class="paper-page">
              <div class="paper-page__page-no">${escapeHtml(pageNo)}</div>
              <div class="paper-page__title">${escapeHtml(p?.title || activeDoc.title || activeDoc.type || activeDoc.label || activeDoc.id)}</div>
              ${p?.subtitle ? `<div class="paper-page__sub">${escapeHtml(p.subtitle)}</div>` : ""}
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
                !isBaselineShippingInstruction && p?.annotation
                  ? `<div class="paper-annotation">
                      <div class="paper-annotation__title">Annotation</div>
                      <div class="paper-annotation__body">${escapeHtml(String(p.annotation))}</div>
                    </div>`
                  : ""
              }
              ${overlay ? `<div class="paper-overlay" aria-hidden="true">${overlay}</div>` : ""}
            </div>
          `;
        })
        .join("");
    }
  }

  const toolsHtml = `
    <div class="document-tools" aria-label="Viewer tools">
      <button class="btn btn--ghost btn--tiny" type="button" data-doc-zoom="-10" data-workspace-viewer="${escapeHtml(viewerKey)}" aria-label="Zoom out">−</button>
      <div class="document-tools__zoom">${zoom}%</div>
      <button class="btn btn--ghost btn--tiny" type="button" data-doc-zoom="10" data-workspace-viewer="${escapeHtml(viewerKey)}" aria-label="Zoom in">＋</button>
      ${
        isActiveDocMissing || isBaselineShippingInstruction
          ? ""
          : `<button class="btn btn--ghost btn--tiny" type="button" data-doc-marker-toggle="1" data-workspace-viewer="${escapeHtml(viewerKey)}" aria-label="Toggle annotations">Annotations</button>`
      }
    </div>
  `;

  return `
    <div class="document-viewer" data-doc-viewer="${escapeHtml(viewerKey)}">
      <div class="document-viewer__top">
        ${toolsHtml}
      </div>
      <div class="document-stage" role="region" aria-label="Document stage">
        <div class="paper-viewport">
          <div class="paper-document" role="document" aria-label="Document page" style="--paper-zoom:${escapeHtml(String(zoom / 100))}">
            ${pagesHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderDocumentTabs(documents, { activeDocId, viewerKey } = {}) {
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const activeId = activeDocId ? String(activeDocId) : "";
  const vKey = String(viewerKey || "").trim() || "document";
  return `
    <div class="document-tabs document-tabs--workspace" role="tablist" aria-label="Documents">
      ${docs
        .map((d) => {
          const docId = String(d?.id || "");
          if (!docId) return "";
          const isActive = Boolean(activeId && docId === activeId);
          const label = d?.label || docId;
          const isMissing = d?.status === "missing";
          const isMismatch = d?.status === "mismatch";
          return `<button class="document-tab ${isActive ? "is-active" : ""} ${isMissing ? "is-missing" : ""} ${isMismatch ? "is-danger" : ""}" type="button" role="tab"
            aria-selected="${isActive ? "true" : "false"}"
            data-doc-tab="${escapeHtml(docId)}"
            data-workspace-viewer="${escapeHtml(vKey)}"
          >${escapeHtml(label)}${isMissing ? ` <span class="pill pill--mini pill--warn">書類待ち</span>` : ""}${isMismatch ? ` <span class="pill pill--mini pill--danger">mismatch</span>` : ""}</button>`;
        })
        .filter(Boolean)
        .join("")}
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
  const siNo = String(si?.siNo || "").trim();
  const previewImageSrc = siNo ? DEMO_DOCUMENTS[siNo] : "";
  if (!previewImageSrc) return [];
  const normalizedSiId = String(siNo || "si").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return [
    {
      id: normalizedSiId.startsWith("si-") ? normalizedSiId : `si-${normalizedSiId}`,
      label: siNo || "SI",
      type: "Shipping Instruction",
      title: "Shipping Instruction",
      previewImageSrc,
      mockPages: [
        {
          title: "SHIPPING INSTRUCTION",
          subtitle: "Mock / paper view",
          rows: [
            { k: "SI No", v: siNo || "SI-" },
            { k: "Requested delivery", v: si?.requestedDeliveryDate || "2026-05-20" },
            { k: "Customer", v: first?.customerName || "Example Customer" },
            { k: "SKU", v: first?.sku || "UC-1M-BK" },
            { k: "Qty", v: first?.committedQty != null ? `${first.committedQty} pcs` : "1000 pcs" },
          ],
          markers: [],
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

function buildDocumentWorkspaceDocuments(tradeCase, focusType, focusId) {
  const tc = tradeCase || null;
  if (!tc) return [];

  const sh = tc.shipmentEntity || null;
  const si = tc.siEntity || null;
  const type = normalizeFocusType(focusType);
  const focusKey = String(focusId || "").trim();

  const base = buildSiWorkspaceDocuments(tc);
  if (type === "si" && !base.length) return [];
  const siDoc = base.find((d) => String(d?.id || "").startsWith("si-")) || null;
  const salesResponseDoc = base.find((d) => String(d?.id || "") === "sales-response") || null;
  const salesCommitmentDoc = base.find((d) => String(d?.id || "") === "sales-commitment") || null;
  const salesResponseDocForTabs = salesResponseDoc ? { ...salesResponseDoc, label: "Sales response" } : null;
  const salesCommitmentDocForTabs = salesCommitmentDoc ? { ...salesCommitmentDoc, label: "売約" } : null;

  const invoiceRefs = Array.isArray(tc.invoiceNumbers) ? tc.invoiceNumbers.filter(Boolean) : [];
  const invoiceNos = uniqStrings([
    ...invoiceRefs.map((x) => normalizeInvoiceNo(x?.invoiceNo)),
    ...(sh?.supplierInvoices || []).map(normalizeInvoiceNo),
    ...(si?.relatedInvoiceNos || []).map(normalizeInvoiceNo),
  ]).filter(Boolean);

  const invByNo = new Map();
  for (const inv of invoiceRefs) {
    const no = normalizeInvoiceNo(inv?.invoiceNo);
    if (!no) continue;
    invByNo.set(no, inv);
  }

  const incidents = detectIncidents(tc);
  const mismatch = incidents.find((i) => i && i.type === "invoiceQuantityMismatch") || null;
  const details = mismatch && mismatch.details && typeof mismatch.details === "object" ? mismatch.details : null;
  const siQty =
    typeof details?.siQuantity === "number"
      ? details.siQuantity
      : typeof tc?.products?.[0]?.quantityInstructed === "number"
        ? tc.products[0].quantityInstructed
        : null;

  const invDocs = invoiceNos.map((invNo) => {
    const ref = invByNo.get(invNo) || null;
    const id = invoiceDocId(invNo);
    const qty = typeof ref?.qty === "number" ? ref.qty : null;
    const supplierName = String(ref?.supplier || tc?.supplier?.name || "ACME Components (Shenzhen)");
    const blNo = String(sh?.blNo || "BL-SZX-7781");
    const isQtyMismatch = siQty != null && qty != null && siQty !== qty;
    return {
      id: id || `inv-${String(invNo || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label: invNo,
      type: "Invoice",
      title: "Commercial Invoice",
      status: isQtyMismatch ? "mismatch" : undefined,
      mockPages: [
        {
          title: "COMMERCIAL INVOICE",
          subtitle: "Mock / paper view",
          rows: [
            { k: "Invoice No", v: invNo },
            { k: "Supplier", v: supplierName },
            { k: "SI No", v: si?.siNo || "SI-2026-001" },
            { k: "BL", v: blNo },
            { k: "Item", v: tc?.products?.[0]?.sku || "UC-1M-BK" },
            {
              k: "Qty",
              v: qty != null ? `${qty} pcs` : "—",
              warn: isQtyMismatch ? `⚠ SI ${siQty}pcs` : "",
            },
            { k: "Amount", v: "USD 12,800.00" },
          ],
          annotation: isQtyMismatch ? "⚠ Quantity mismatch detected" : "",
          markers:
            isQtyMismatch
              ? [
                  { kind: "warn", x: 72, y: 34, text: "⚠ Qty mismatch" },
                  { kind: "note", x: 16, y: 72, text: "Confirm split shipment?" },
                ]
              : [{ kind: "note", x: 16, y: 72, text: "Check customer impact" }],
        },
      ],
    };
  });

  const hasAnyPlMissing = true;
  const plDoc = {
    id: "pl-missing",
    label: "PL missing",
    type: "Packing List",
    status: hasAnyPlMissing ? "missing" : undefined,
  };

  const blNo = String(sh?.blNo || tc?.blNumbers?.[0] || "BL-SZX-7781");
  const blId = blNo ? blNo.toLowerCase().replace(/^bl-/, "bl-") : "bl";
  const blDoc = {
    id: blId,
    label: blNo,
    type: "B/L",
    title: "Bill of Lading",
    mockPages: [
      {
        title: "BILL OF LADING",
        subtitle: "Mock / paper view",
        rows: [
          { k: "B/L No", v: blNo || "BL-SZX-7781" },
          { k: "Booking No", v: sh?.bookingNo || "BK-44521" },
          { k: "Container", v: sh?.containerNo || "TCLU1234567" },
          { k: "ETD", v: sh?.etd || "2026-05-03" },
          { k: "ETA", v: sh?.eta || "2026-05-10" },
          { k: "POL → POD", v: "Shenzhen → Tokyo" },
        ],
        markers: [{ kind: "pin", x: 18, y: 18, text: "Vessel schedule" }],
      },
    ],
  };

  const shipmentDoc = {
    id: "shipment",
    label: "Shipment",
    type: "Shipment",
    title: "Shipment Overview",
    mockPages: [
      {
        title: "SHIPMENT OVERVIEW",
        subtitle: "AI operational summary",
        rows: [
          { k: "Shipment", v: sh?.id || "SHP-2026-009" },
          { k: "Booking", v: sh?.bookingNo || "BK-88201" },
          { k: "Container", v: sh?.containerNo || "TCLU-998877" },
          { k: "ETA", v: sh?.eta || "2026-05-12" },
          { k: "Status", v: shipmentStateLabelJa(sh?.shipmentState || tc?.shipmentState || "") || "-" },
        ],
      },
    ],
  };

  const out = [];
  if (siDoc) out.push(siDoc);
  if (salesResponseDocForTabs) out.push(salesResponseDocForTabs);
  if (salesCommitmentDocForTabs) out.push(salesCommitmentDocForTabs);
  out.push(...invDocs);
  out.push(plDoc);
  out.push(blDoc);
  out.push(shipmentDoc);

  const docs = out.filter(Boolean);
  const focusDocId = resolveFocusDocId({ focusType: type, focusId: focusKey, documents: docs });

  const kindOf = (d) => {
    const id = String(d?.id || "");
    if (id.startsWith("si-")) return "si";
    if (id === "sales-response") return "salesResponse";
    if (id === "sales-commitment") return "salesCommitment";
    if (id.startsWith("inv-")) return "invoice";
    if (id === "pl-missing" || id.startsWith("pl-")) return "pl";
    if (id.startsWith("bl-")) return "bl";
    if (id === "shipment") return "shipment";
    return "other";
  };

  const orderByFocus = (() => {
    if (type === "si") return ["si", "salesResponse", "invoice", "pl", "bl", "shipment", "salesCommitment", "other"];
    if (type === "invoice") return ["invoice", "si", "shipment", "pl", "bl", "salesResponse", "salesCommitment", "other"];
    if (type === "shipment") return ["shipment", "invoice", "pl", "bl", "si", "salesResponse", "salesCommitment", "other"];
    if (type === "document") return ["other", "si", "invoice", "pl", "bl", "shipment", "salesResponse", "salesCommitment"];
    return ["si", "invoice", "pl", "bl", "shipment", "salesResponse", "salesCommitment", "other"];
  })();

  const rankKind = new Map(orderByFocus.map((k, i) => [k, i]));

  return docs
    .slice()
    .sort((a, b) => {
      const ak = kindOf(a);
      const bk = kindOf(b);
      const ar = rankKind.has(ak) ? rankKind.get(ak) : 999;
      const br = rankKind.has(bk) ? rankKind.get(bk) : 999;
      if (ar !== br) return ar - br;

      // Within the focused kind, bring the focus doc to the front.
      if (focusDocId) {
        if (String(a?.id || "") === focusDocId) return -1;
        if (String(b?.id || "") === focusDocId) return 1;
      }

      // Keep missing docs near the end of their kind (except when focused).
      const am = a?.status === "missing";
      const bm = b?.status === "missing";
      if (am !== bm) return am ? 1 : -1;

      return String(a?.label || a?.id || "").localeCompare(String(b?.label || b?.id || ""));
    });
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
          <div class="workspace-section__title">AIの気づき</div>
          ${aiNotes.length ? `<ul class="list">${aiNotes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<div class="muted">-</div>`}
        </div>
        <div class="workspace-section">
          <div class="workspace-section__title">人間メモ</div>
          <div class="muted">（mock）短文メモだけ。長文は Case detail に集約。</div>
        </div>
        <div class="workspace-section">
          <div class="workspace-section__title">納期・物流リスク</div>
          ${riskHtml}
        </div>
      </aside>
    </div>
    <div class="workspace-role-note">
      <span class="muted">UI note:</span> Shipment Workspace は「貨物と船積書類を見る」。問題と判断は Case detail に集約する。
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

  const baselineTitle = "基準書類：Shipping Instruction";
  const baselineBody = "このSIを基準に、後続の Invoice / Packing List / B/L の内容を照合します。";
  const confirmPoints = ["SI番号", "数量", "納期", "出荷条件"];
  const followUpExamples = ["INV数量がSIと違う", "PL未着", "BL type確認", "ETA変更"];

  return `
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
          <div class="workspace-section__title">AIの書類チェック</div>
          <div class="muted" style="margin-bottom:6px;">${escapeHtml(baselineTitle)}</div>
          <div style="margin-bottom:10px;">${escapeHtml(baselineBody)}</div>
          <div class="muted" style="margin-bottom:6px;">確認ポイント</div>
          <ul class="list">${confirmPoints.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
        </div>
        <div class="workspace-section">
          <div class="workspace-section__title">人間メモ</div>
          <div class="muted">（mock）営業コメントは短く。長文は Case detail に集約。</div>
        </div>
        <div class="workspace-section">
          <div class="workspace-section__title">後続書類での照合（例）</div>
          <ul class="list">${followUpExamples.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
        </div>
      </aside>
    </div>
    <div class="workspace-role-note">
      <span class="muted">UI note:</span> SI Workspace は「販売約束と顧客納期を見る」。問題と判断は Case detail に集約する。
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

    const formatAiInferenceLabel = (raw) => {
      const s = String(raw || "").trim();
      if (!s) return "";
      if (s.startsWith("AI推定")) return s;
      if (/^ETA[:\s]/i.test(s)) return `AI推定ETA: ${s.replace(/^ETA[:\s]*/i, "").trim() || "-"}`;
      if (/\bETA\b/i.test(s) || /入荷予定|到着予定|入港予定|納品予定/.test(s)) return `AI推定ETA: ${s}`;
      return `AI推定: ${s}`;
    };

    const looksLikeConfirmedEntity = (raw) => {
      const s = String(raw || "").trim();
      if (!s) return false;
      if (/^(SI|SHP|INV|BL|ISS|PLN)-\d{4}[-\d]*/.test(s)) return true;
      return false;
    };

    const shouldAiTagProgressItem = (it) => {
      if (!it) return false;
      const label = it.label || it.id || "";
      if (looksLikeConfirmedEntity(label)) return false;
      const st = String(it.status || "").trim();
      if (!st) return false;
      return st === "missing" || st === "needsFix" || st === "blocked";
    };

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
          const aiBadge = shouldAiTagProgressItem(it) ? `<span class="nt-badge is-ai">AI推定</span>` : "";
          const note = it.note ? `<div class="progress-item__note">${escapeHtml(String(it.note))}</div>` : "";
          const blockingBadge = it.blocking ? `<span class="pill pill--mini pill--high">blocking</span>` : "";
          return `<li class="progress-item ${it.blocking ? "is-blocking" : ""}">
            <div class="progress-item__main">
              <span class="progress-item__icon">${escapeHtml(iconFor(it.status))}</span>
              ${aiBadge}
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
      ? `<div class="detail-subhead">Blocking Summary</div><ul class="mini-list">${blocking
          .map((x) => `<li>${escapeHtml(formatAiInferenceLabel(x))}</li>`)
          .join("")}</ul>`
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
        <div class="kv" style="margin-top:6px;"><span class="muted">宛先</span> ${escapeHtml((Array.isArray(msg.to) ? msg.to : []).join(", ") || "-")}</div>
        ${msg.subject ? `<div class="kv" style="margin-top:6px;"><span class="muted">件名</span> ${escapeHtml(String(msg.subject))}</div>` : ""}
        <div class="detail-subhead" style="margin-top:10px;">本文</div>
        <pre class="pre proposed-message-preview__body">${escapeHtml(String(msg.body || ""))}</pre>
        ${evidenceHtml ? `<div class="detail-subhead" style="margin-top:10px;">根拠</div>${evidenceHtml}` : ""}
      </div>
      <div class="approval-actions">
        <button class="btn btn--primary" type="button" data-agent-run-approve="1" ${canApprove ? "" : "disabled"}>承認して送信</button>
        <button class="btn" type="button" data-agent-run-edit="1">修正</button>
        <button class="btn" type="button" data-agent-run-hold="1">保留</button>
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
            <div class="muted">承認・下書き編集・保留などの実務アクションは、Issues（承認センター）で行ってください。</div>
            <div style="margin-top:10px;">
              <button class="btn btn--primary" type="button" data-open-approval-center="1">Open Issues（承認センター）</button>
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
      if (tc) openShipmentWorkspace(tc.id);
      return;
    }

    const openSiWorkspaceEl = target.closest && target.closest("[data-open-si-workspace]");
    if (openSiWorkspaceEl) {
      const tc = state.modalTradeCaseId ? getTradeCaseById(state.modalTradeCaseId) : null;
      if (tc) openSiWorkspace(tc.id);
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
    if (state.activeTimelineScenarioModal) {
      state.activeTimelineScenarioModal = null;
      rerenderOpenDocumentWorkspaceBody();
      return;
    }
    if (isAnyWorkspaceModalOpen()) {
      console.log("[workspace modal close]", { reason: "escape" });
      closeWorkspaceModal("shipment-workspace-modal");
      closeWorkspaceModal("si-workspace-modal");
      closeWorkspaceModal("document-workspace-modal");
      return;
    }
    closeModal();
  });
}

function setupWorkspaceModals() {
  const shipment = document.getElementById("shipment-workspace-modal");
  const si = document.getElementById("si-workspace-modal");
  const doc = document.getElementById("document-workspace-modal");

  const renderWorkspaceBody = (modalId, tc) => {
    if (modalId === "document-workspace-modal") {
      const ui = getWorkspaceUi(modalId);
      return documentWorkspaceRenderer.renderDocumentWorkspace(tc, {
        focusType: ui.focusType,
        focusId: ui.focusId,
        stateTransitionCandidates: state.latestIngestResult?.stateTransitionCandidates ?? [],
      });
    }
    if (modalId === "shipment-workspace-modal") return renderShipmentWorkspace(tc);
    return renderSiWorkspace(tc);
  };

  const buildWorkspaceDocs = (modalId, tc) => {
    if (modalId === "document-workspace-modal") {
      const ui = getWorkspaceUi(modalId);
      return buildDocumentWorkspaceDocuments(tc, ui.focusType, ui.focusId);
    }
    if (modalId === "shipment-workspace-modal") return buildShipmentWorkspaceDocuments(tc);
    return buildSiWorkspaceDocuments(tc);
  };

  const attach = (modalEl, modalId) => {
    if (!modalEl) return;
    modalEl.addEventListener("click", (e) => {
      const target = e.target;
      if (!target) return;
      const closeBtnEl = target.closest && target.closest("[data-close-workspace]");
      if (closeBtnEl) {
        console.log("[workspace modal close]", { reason: "close_button", modalId });
        closeWorkspaceModal(modalId);
        return;
      }

      const backdropEl = target.closest && target.closest("[data-close-workspace-backdrop]");
      if (backdropEl && target === backdropEl) {
        console.log("[workspace modal close]", { reason: "backdrop_click", modalId });
        closeWorkspaceModal(modalId);
        return;
      }

      const rerenderWorkspaceBody = () => {
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        if (!tc) return;
        const body = modalEl.querySelector(".modal__body");
        if (body) body.innerHTML = renderWorkspaceBody(modalId, tc);
      };

      const openTimelineScenarioEl = target.closest && target.closest("[data-open-timeline-scenario]");
      if (openTimelineScenarioEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id") || "";
        if (!tradeCaseId) return;
        const ui = getWorkspaceUi(modalId);
        state.activeTimelineScenarioModal = {
          tradeCaseId,
          focusType: normalizeFocusType(ui.focusType),
          focusId: String(ui.focusId || "-"),
        };
        rerenderWorkspaceBody();
        return;
      }

      const openTimelineIssueEl = target.closest && target.closest("[data-open-timeline-issue],[data-open-timeline-issue-candidate]");
      if (openTimelineIssueEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        const issueId =
          (openTimelineIssueEl.getAttribute && openTimelineIssueEl.getAttribute("data-open-timeline-issue")) ||
          (openTimelineIssueEl.getAttribute && openTimelineIssueEl.getAttribute("data-open-timeline-issue-candidate")) ||
          "";
        if (!issueId) return;

        const mutation =
          (Array.isArray(state.issueMutationItems) ? state.issueMutationItems : []).find((m) => m && (String(m.issueId || "") === String(issueId) || matchesMutationId(m, issueId))) ||
          null;
        const openId = getMutationOpenId(mutation) || findActionPlanIdFromAnyId(issueId) || String(issueId);

        closeWorkspaceModal(modalId);
        state.topActiveTab = "issues";
        state.activeMutationId = openId;
        state.activeIssueId = null;
        try {
          location.hash = "#issues";
        } catch {
          // ignore
        }
        renderApp();
        return;
      }

      const closeTimelineScenarioEl = target.closest && target.closest("[data-close-timeline-scenario]");
      if (closeTimelineScenarioEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        state.activeTimelineScenarioModal = null;
        rerenderWorkspaceBody();
        return;
      }

      const applyStateTransitionEl = target.closest && target.closest("[data-apply-state-transition-candidate]");
      if (applyStateTransitionEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        const candidateId = applyStateTransitionEl.getAttribute("data-apply-state-transition-candidate") || "";
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id") || "";
        applyStateTransitionCandidate(candidateId, { tradeCaseId });
        renderApp();
        rerenderOpenDocumentWorkspaceBody();
        return;
      }

      const humanMemoAddEl = target.closest && target.closest("[data-human-memo-add]");
      if (humanMemoAddEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        const ui = getWorkspaceUi(modalId);
        const focusType = normalizeFocusType(ui.focusType);
        const focusIdRaw = String(ui.focusId || "").trim();
        const focusId = focusType === "invoice" ? normalizeInvoiceNo(focusIdRaw) : focusIdRaw;
        if (!focusId || focusId === "-") {
          window.alert("Focus が選択されていません。");
          return;
        }
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id") || "";
        if (!tradeCaseId) return;
        state.activeHumanMemoEdit = {
          mode: "create",
          focusType,
          focusId,
          tradeCaseId,
          bodyDraft: "",
          selectedEntities: [{ type: focusType, id: focusId }],
        };
        renderApp();
        return;
      }

      const humanMemoDeleteEl = target.closest && target.closest("[data-human-memo-delete]");
      if (humanMemoDeleteEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        const memoId = humanMemoDeleteEl.getAttribute("data-human-memo-delete") || "";
        if (!memoId) return;
        const ok = window.confirm("このメモを削除しますか？");
        if (!ok) return;
        const memos = Array.isArray(state.humanMemos) ? state.humanMemos.filter(Boolean) : [];
        state.humanMemos = memos.filter((m) => m && String(m.id || "") !== String(memoId));
        renderApp();
        rerenderOpenDocumentWorkspaceBody();
        return;
      }

      const humanMemoShareEl = target.closest && target.closest("[data-human-memo-share]");
      if (humanMemoShareEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        const memoId = humanMemoShareEl.getAttribute("data-human-memo-share") || "";
        if (!memoId) return;
        const memos = Array.isArray(state.humanMemos) ? state.humanMemos.filter(Boolean) : [];
        const idx = memos.findIndex((m) => m && String(m.id || "") === String(memoId));
        if (idx < 0) return;
        const now = nowIso();
        const updated = { ...memos[idx], aiShared: true, updatedAt: now };
        const next = memos.slice();
        next[idx] = updated;
        state.humanMemos = next;

        const linked = Array.isArray(updated.linkedEntities) ? updated.linkedEntities.filter(Boolean) : [];
        const feedItem = {
          id: `act:${shortId()}`,
          type: "humanMemoShared",
          title: "人間メモをAI contextへ共有",
          occurredAt: now,
          at: formatLocalTime(now),
          actor: "human",
          source: "human",
          statusKey: "success",
          details: [String(updated.body || "").slice(0, 160)],
          linked: linked.map((e) => ({
            kind: String(e?.type || "").toLowerCase(),
            label: formatFocusLabel(e?.type, e?.id) || String(e?.id || ""),
          })),
        };
        state.activityFeedItems = prependUniqueById(state.activityFeedItems, [feedItem]);

        rerenderWorkspaceBody();
        return;
      }

      const humanMemoCardEl = target.closest && target.closest("[data-human-memo-card]");
      if (humanMemoCardEl && modalId === "document-workspace-modal") {
        e.preventDefault();
        e.stopPropagation();
        const memoId = humanMemoCardEl.getAttribute("data-human-memo-card") || "";
        if (!memoId) return;
        const memos = Array.isArray(state.humanMemos) ? state.humanMemos.filter(Boolean) : [];
        const memo = memos.find((m) => m && String(m.id || "") === String(memoId)) || null;
        if (!memo) return;

        const ui = getWorkspaceUi(modalId);
        const focusType = normalizeFocusType(ui.focusType);
        const focusIdRaw = String(ui.focusId || "").trim();
        const focusId = focusType === "invoice" ? normalizeInvoiceNo(focusIdRaw) : focusIdRaw;
        if (!focusId || focusId === "-") return;

        const tradeCaseId = modalEl.getAttribute("data-tradecase-id") || "";
        if (!tradeCaseId) return;

        state.activeHumanMemoEdit = {
          mode: "edit",
          memoId,
          focusType,
          focusId,
          tradeCaseId,
          bodyDraft: String(memo.body || ""),
          selectedEntities: uniqLinkedEntities(Array.isArray(memo.linkedEntities) ? memo.linkedEntities : []),
        };
        renderApp();
        return;
      }

      const markerToggleEl = target.closest && target.closest("[data-doc-marker-toggle]");
      if (markerToggleEl) {
        const ui = getWorkspaceUi(modalId);
        ui.showMarkers = ui.showMarkers === false;
        rerenderWorkspaceBody();
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
        rerenderWorkspaceBody();
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
        rerenderWorkspaceBody();
        return;
      }

      const tabEl = target.closest && target.closest("[data-doc-tab]");
      if (tabEl) {
        const docId = tabEl.getAttribute("data-doc-tab");
        const ui = getWorkspaceUi(modalId);
        if (docId) {
          ui.activeDocId = docId;
          ui.activePageByDocId[docId] = 0;
        }
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id");
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        if (tc && modalId === "document-workspace-modal" && docId) {
          const documents = buildWorkspaceDocs(modalId, tc);
          const doc = Array.isArray(documents) ? documents.find((d) => d && String(d.id || "") === String(docId)) : null;
          const nextFocus = focusFromDoc({ docId, docLabel: doc?.label, tradeCase: tc });
          ui.focusType = normalizeFocusType(nextFocus.focusType);
          ui.focusId = String(nextFocus.focusId || "-");
        }
        if (tc) {
          if (modalId === "document-workspace-modal") {
            const titleEl = modalEl.querySelector(".modal__title");
            if (titleEl) {
              const headerLabels = documentWorkspaceRenderer.buildWorkspaceHeaderLabels({ tradeCase: tc, focusType: ui.focusType, focusId: ui.focusId });
              titleEl.innerHTML = renderWorkspaceTitleHtml(headerLabels);
            }
          }
          const body = modalEl.querySelector(".modal__body");
          if (body) body.innerHTML = renderWorkspaceBody(modalId, tc);
        }
        return;
      }

      const prevEl = target.closest && target.closest("[data-doc-prev]");
      const nextEl = target.closest && target.closest("[data-doc-next]");
      if (prevEl || nextEl) {
        const ui = getWorkspaceUi(modalId);
        if (!ui.activeDocId) return;
        const tradeCaseId = modalEl.getAttribute("data-tradecase-id") || "";
        const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
        const documents = tc ? buildWorkspaceDocs(modalId, tc) : [];
        const activeDoc = Array.isArray(documents) ? documents.find((d) => d && d.id === ui.activeDocId) : null;
        const pageCount = activeDoc && Array.isArray(activeDoc.mockPages) ? activeDoc.mockPages.length : 1;
        const current = typeof ui.activePageByDocId[ui.activeDocId] === "number" ? ui.activePageByDocId[ui.activeDocId] : 0;
        const nextPage = clamp(current + (nextEl ? 1 : -1), 0, Math.max(0, pageCount - 1));
        ui.activePageByDocId[ui.activeDocId] = nextPage;
        if (tc) {
          const body = modalEl.querySelector(".modal__body");
          if (body) body.innerHTML = renderWorkspaceBody(modalId, tc);
        }
        return;
      }
    });
  };

  attach(shipment, "shipment-workspace-modal");
  attach(si, "si-workspace-modal");
  attach(doc, "document-workspace-modal");
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
  seedHumanMemosMock();
  renderApp();

  // Hackathon demo: re-hydrate demo-created TradeCases from server-side JSON store.
  fetchServerDemoTradeCases().then((tradeCases) => {
    for (const tc of tradeCases) mergeTradeCaseIntoState(tc);
    renderApp();
  });
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

function seedHumanMemosMock() {
  // Keep deterministic-ish demo entries. No persistence.
  const now = nowIso();
  state.humanMemos = [
    {
      id: "memo-001",
      body: "営業Aかなり急ぎ。分納の可能性あり。仕入先回答待ち。",
      linkedEntities: [
        { type: "invoice", id: "INV-1122" },
        { type: "si", id: "SI-2026-001" },
      ],
      aiShared: false,
      createdAt: now,
      updatedAt: now,
    },
  ];
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
        title: "Teams受信",
        actor: "営業A",
        at: "2026-05-12 13:40",
        summary: "「PLまだ？あとSI-224も確認して」",
        details: ["AI整理: PL未着確認 / SI-224確認", `紐付け: 案件 ${issueNo} / 出荷 SHP-2026-009`, "状態: 確認待ち"],
        statusKey: "awaitingApproval",
        linked: [
          { kind: "issue", label: issueNo },
          { kind: "shipment", label: "SHP-2026-009" },
        ],
        links: [
          { label: "案件を開く", href: `/#issues/${encodeURIComponent(issueNo)}` },
          { label: "出荷を開く", href: `/#shipments/SHP-2026-009` },
          { label: "SIワークスペースを開く", href: `/#si/SI-2026-001` },
          { label: "再整理する", href: `/#retry/classify/${encodeURIComponent(issueNo)}` },
        ],
      },
      {
        id: `act-${shortId()}`,
        type: "emailReceived",
        source: "email",
        title: "Email受信",
        actor: "supplier@acme.com",
        at: "2026-05-12 14:12",
        summary: "Attached: PL.pdf",
        details: ["AI整理完了: Packing Listを認識", "更新: 出荷 SHP-2026-009", `案件 ${issueNo} 解決候補`],
        statusKey: "processing",
        linked: [
          { kind: "shipment", label: "SHP-2026-009" },
          { kind: "issue", label: issueNo },
        ],
        links: [
          { label: "出荷を開く", href: `/#shipments/SHP-2026-009` },
          { label: "案件を開く", href: `/#issues/${encodeURIComponent(issueNo)}` },
        ],
      },
      {
        id: `act-${shortId()}`,
        type: "aiProcessed",
        source: "ai",
        title: "AI整理完了",
        actor: "trade-shelf-agent",
        at: "2026-05-12 14:13",
        summary: "PL.pdf parsed → document status updated",
        details: ["信頼度: 0.94", "抽出: cartons / gross weight / HS codes（モック）"],
        statusKey: "success",
        linked: [{ kind: "shipment", label: "SHP-2026-009" }],
        links: [{ label: "出荷を開く", href: `/#shipments/SHP-2026-009` }],
      },
      {
        id: `act-${shortId()}`,
        type: "issueUpdated",
        source: "ai",
        title: "案件更新",
        actor: "trade-shelf-agent",
        at: "2026-05-12 14:14",
        summary: `${issueNo} status: blocked → review`,
        details: ["提案: PLがSI/INVと一致なら解決扱い（モック）"],
        statusKey: "warning",
        linked: [{ kind: "issue", label: issueNo }],
        links: [{ label: "案件を開く", href: `/#issues/${encodeURIComponent(issueNo)}` }],
      },
      {
        id: `act-${shortId()}`,
        type: "escalation",
        source: "system",
        title: "注意案件検出",
        actor: "system",
        at: "2026-05-12 15:02",
        summary: "ETA changed on SHP-2026-009",
        details: ["旧ETA: 2026-05-20 → 新ETA: 2026-05-23（モック）"],
        statusKey: "warning",
        linked: [{ kind: "shipment", label: "SHP-2026-009" }],
        links: [{ label: "出荷を開く", href: `/#shipments/SHP-2026-009` }],
      },
      {
        id: `act-${shortId()}`,
        type: "supplierReply",
        source: "email",
        title: "仕入先返信",
        actor: "sales@acme-components.example",
        at: "2026-05-12 16:18",
        summary: "Re: INV mismatch — will reissue invoice today",
        details: ["添付: INV-1122-rev.pdf（モック）"],
        statusKey: "success",
        linked: [{ kind: "issue", label: issueNo }],
        links: [{ label: "案件を開く", href: `/#issues/${encodeURIComponent(issueNo)}` }],
      },
      {
        id: `act-${shortId()}`,
        type: "failedProcessing",
        source: "ai",
        title: "処理失敗",
        actor: "trade-shelf-agent",
        at: "2026-05-12 17:05",
        summary: "Attachment unreadable (mock)",
        details: ["理由: PDF破損", "対応: OCR再試行 / 再送依頼"],
        statusKey: "failed",
        linked: [],
        links: [{ label: "再整理する", href: `/#retry/ocr/${shortId()}` }],
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
  window.__setupNewTopCount = (window.__setupNewTopCount || 0) + 1;
  if (DEBUG_UI_LOGS) {
    console.log("[setupNewTop]", {
      count: window.__setupNewTopCount,
    });
  }

  const root = document.getElementById("app");
  if (!root) return;

  function handleNewTopClick(e) {
    window.__newTopClickCount = (window.__newTopClickCount || 0) + 1;
    const target = e.target;
    if (DEBUG_UI_LOGS) {
      console.log("[handleNewTopClick]", {
        count: window.__newTopClickCount,
        target,
      });
    }
    if (!target) return;

    const approvalRightToggleEl = target.closest && target.closest("[data-toggle-approval-right-panel]");
    if (approvalRightToggleEl) {
      e.preventDefault();
      e.stopPropagation();
      state.approvalCenterRightPanelCollapsed = !state.approvalCenterRightPanelCollapsed;
      renderApp();
      return;
    }

    const guardApprovalClick = (idLike, action, { description } = {}) => {
      const apId = findActionPlanIdFromAnyId(idLike);
      if (!apId) return { ok: false, ignored: true, reason: "missing_action_plan" };
      const entry = state.approvalsByActionPlanId?.[apId] || null;
      const fallbackPlan =
        (Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans : []).find((p) => p && String(p.id || "") === apId) || null;
      const current = String((entry && entry.status) || (fallbackPlan && fallbackPlan.status) || "planned");
      const available = getAvailableApprovalActions(current);
      if (!available[String(action)]) return { ok: false, ignored: true, reason: `unavailable:${current}->${String(action)}` };
      const res = applyApprovalAction(apId, action, { description });
      return { ok: res.ok, ignored: false, res };
    };

    const draftEditCancelEl = target.closest && target.closest("[data-draft-edit-cancel]");
    if (draftEditCancelEl) {
      e.preventDefault();
      e.stopPropagation();
      state.activeDraftEditActionPlanId = null;
      renderApp();
      return;
    }

    const draftEditOverlayEl = target.closest && target.closest("[data-draft-edit-overlay]");
    if (draftEditOverlayEl && target === draftEditOverlayEl) {
      e.preventDefault();
      e.stopPropagation();
      state.activeDraftEditActionPlanId = null;
      renderApp();
      return;
    }

    const draftEditSaveEl = target.closest && target.closest("[data-draft-edit-save]");
    if (draftEditSaveEl) {
      e.preventDefault();
      e.stopPropagation();

      const apId = String(state.activeDraftEditActionPlanId || "").trim();
      if (!apId) return;

      const modal = draftEditSaveEl.closest && draftEditSaveEl.closest("[data-draft-edit-modal]");
      if (!modal || !modal.querySelector) {
        state.activeDraftEditActionPlanId = null;
        renderApp();
        return;
      }

      const readValue = (sel) => {
        const el = modal.querySelector(sel);
        if (!el) return "";
        if (typeof el.value === "string") return el.value;
        return "";
      };

      const nextToText = String(readValue("[data-draft-edit-to]") || "").trim();
      const nextCcText = String(readValue("[data-draft-edit-cc]") || "").trim();
      const nextSubject = String(readValue("[data-draft-edit-subject]") || "").trim();
      const nextBody = String(readValue("[data-draft-edit-body]") || "");

      const parseRecipients = (text) =>
        String(text || "")
          .split(/[;,]/g)
          .map((s) => String(s || "").trim())
          .filter(Boolean);

      if (!state.latestIngestResult || !Array.isArray(state.latestIngestResult.drafts)) {
        window.alert("(mock) drafts not found");
        state.activeDraftEditActionPlanId = null;
        renderApp();
        return;
      }

      const drafts = state.latestIngestResult.drafts.filter(Boolean);
      const idx = drafts.findIndex((d) => d && String(d.actionPlanId || "") === apId);
      if (idx < 0) {
        window.alert("(mock) draft not found");
        state.activeDraftEditActionPlanId = null;
        renderApp();
        return;
      }

      const current = drafts[idx] || {};
      const shouldStoreAsArrayTo = Array.isArray(current.to);
      const shouldStoreAsArrayCc = Array.isArray(current.cc);

      const updated = {
        ...current,
        to: shouldStoreAsArrayTo ? parseRecipients(nextToText) : nextToText,
        cc: shouldStoreAsArrayCc ? parseRecipients(nextCcText) : nextCcText,
        subject: nextSubject,
        body: nextBody,
      };

      const nextDrafts = drafts.slice();
      nextDrafts[idx] = updated;
      state.latestIngestResult.drafts = nextDrafts;

      const attempt = guardApprovalClick(apId, "edit");
      if (!attempt.ok) {
        if (!attempt.ignored) window.alert("(mock) edit failed");
      }

      state.activeDraftEditActionPlanId = null;
      renderApp();
      return;
    }

    const humanMemoCancelEl = target.closest && target.closest("[data-human-memo-cancel]");
    if (humanMemoCancelEl) {
      e.preventDefault();
      e.stopPropagation();
      state.activeHumanMemoEdit = null;
      renderApp();
      return;
    }

    const humanMemoOverlayEl = target.closest && target.closest("[data-human-memo-overlay]");
    if (humanMemoOverlayEl && target === humanMemoOverlayEl) {
      e.preventDefault();
      e.stopPropagation();
      state.activeHumanMemoEdit = null;
      renderApp();
      return;
    }

    const humanMemoToggleEl = target.closest && target.closest("[data-human-memo-entity-toggle]");
    if (humanMemoToggleEl) {
      e.preventDefault();
      e.stopPropagation();

      const ctx = state.activeHumanMemoEdit || null;
      if (!ctx) return;

      const modal = document.querySelector("[data-human-memo-modal]");
      if (modal && modal.querySelector) {
        const bodyEl = modal.querySelector("[data-human-memo-body]");
        if (bodyEl && typeof bodyEl.value === "string") ctx.bodyDraft = bodyEl.value;
      }

      const key = humanMemoToggleEl.getAttribute("data-human-memo-entity-toggle") || "";
      const [typeRaw, idRaw] = key.split("::");
      const type = normalizeFocusType(typeRaw);
      const id = String(idRaw || "").trim();
      if (!type || !id) return;

      const focusType = normalizeFocusType(ctx.focusType);
      const focusIdRaw = String(ctx.focusId || "").trim();
      const focusId = focusType === "invoice" ? normalizeInvoiceNo(focusIdRaw) : focusIdRaw;
      const focusKey = `${focusType}::${focusId}`;

      const current = uniqLinkedEntities(ctx.selectedEntities || []);
      const set = new Set(current.map((e) => `${e.type}::${e.id}`));
      if (set.has(key)) set.delete(key);
      else set.add(key);
      set.add(focusKey);

      ctx.selectedEntities = Array.from(set).map((k) => {
        const [t, i] = k.split("::");
        return { type: t, id: i };
      });
      state.activeHumanMemoEdit = ctx;
      renderApp();
      return;
    }

    const humanMemoSaveEl = target.closest && target.closest("[data-human-memo-save]");
    if (humanMemoSaveEl) {
      e.preventDefault();
      e.stopPropagation();

      const ctx = state.activeHumanMemoEdit || null;
      if (!ctx) return;
      const modal = humanMemoSaveEl.closest && humanMemoSaveEl.closest("[data-human-memo-modal]");
      if (!modal || !modal.querySelector) return;
      const bodyEl = modal.querySelector("[data-human-memo-body]");
      const text = bodyEl && typeof bodyEl.value === "string" ? String(bodyEl.value).trim() : "";
      if (!text) return;

      const mode = ctx.mode === "edit" ? "edit" : "create";
      const focusType = normalizeFocusType(ctx.focusType);
      const focusIdRaw = String(ctx.focusId || "").trim();
      const focusId = focusType === "invoice" ? normalizeInvoiceNo(focusIdRaw) : focusIdRaw;
      const focusEntity = focusType && focusId ? { type: focusType, id: focusId } : null;

      const linkedEntities = uniqLinkedEntities([...(ctx.selectedEntities || []), ...(focusEntity ? [focusEntity] : [])]);
      if (!linkedEntities.length) return;

      const now = nowIso();
      if (mode === "edit") {
        const memoId = String(ctx.memoId || "").trim();
        if (!memoId) return;
        const memos = Array.isArray(state.humanMemos) ? state.humanMemos.filter(Boolean) : [];
        const idx = memos.findIndex((m) => m && String(m.id || "") === String(memoId));
        if (idx < 0) return;
        const updated = { ...memos[idx], body: text, linkedEntities, updatedAt: now };
        const next = memos.slice();
        next[idx] = updated;
        state.humanMemos = next;
        state.activeHumanMemoEdit = null;
        renderApp();
        rerenderOpenDocumentWorkspaceBody();
        return;
      }
      const memo = {
        id: `memo-${shortId()}`,
        body: text,
        linkedEntities,
        aiShared: false,
        createdAt: now,
        updatedAt: now,
      };
      if (!Array.isArray(state.humanMemos)) state.humanMemos = [];
      state.humanMemos = [memo, ...state.humanMemos.filter(Boolean)];
      state.activeHumanMemoEdit = null;
      renderApp();
      rerenderOpenDocumentWorkspaceBody();
      return;
    }

    const classifyModeEl = target.closest && target.closest("[data-classify-mode]");
    if (classifyModeEl) {
      if (state.ingestLoading) return;
      e.preventDefault();
      e.stopPropagation();
      if (!DEBUG_CLASSIFY_MODE_SWITCH) {
        // Demo mode: keep LLM fixed. (UI is hidden, but we guard clicks just in case.)
        state.classifyMode = "llm";
        return;
      }
      const next = classifyModeEl.getAttribute("data-classify-mode") || "llm";
      state.classifyMode = next === "mock" ? "mock" : "llm";
      renderApp();
      return;
    }

    const tabEl = target.closest && target.closest("[data-nt-tab]");
    if (tabEl) {
      e.preventDefault();
      e.stopPropagation();
      const key = tabEl.getAttribute("data-nt-tab") || "";
      if (newTopTabs.some((t) => t.key === key)) {
        setTopActiveTab(key, { push: true });
      }
      return;
    }

    const shelfSearchOpenEl = target.closest && target.closest("[data-shelf-search-open]");
    if (shelfSearchOpenEl) {
      e.preventDefault();
      e.stopPropagation();
      const t = shelfSearchOpenEl.getAttribute("data-shelf-search-open-type") || "";
      const id = shelfSearchOpenEl.getAttribute("data-shelf-search-open-id") || "";
      if (t === "shipment") {
        openShipmentWorkspace(id);
        return;
      }
      if (t === "si") {
        openSiWorkspace(id);
        return;
      }
      if (t === "case") {
        const tc = id ? getTradeCaseById(id) : null;
        if (tc) openTradeCaseDetail(tc);
        return;
      }
      if (t === "evidence") {
        const item = (getMockEvidenceArchiveItems() || []).find((x) => x && String(x.id) === String(id)) || null;
        if (item) {
          // Reuse the same preview behavior as Evidence Archive.
          const preview = item.preview || null;
          const title = String(item.title || "Evidence preview");
          if (String(item.type) === "Issue" && item.tradeCaseId) {
            state.topActiveTab = "issues";
            state.activeIssueId = String(item.tradeCaseId);
            renderApp();
            return;
          }
          if (preview && preview.kind === "document") {
            const body = String(preview.body || "");
            openModal({
              title: title || "Document",
              bodyHtml: `<div class="evidence-preview-modal">
                <div class="evidence-preview-modal__kind">Document viewer（mock）</div>
                <pre class="evidence-preview-modal__pre">${escapeHtml(body)}</pre>
              </div>`,
            });
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
        }
        return;
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

    const actToggleEl = target.closest && target.closest("[data-activity-toggle]");
    if (actToggleEl) {
      const id = actToggleEl.getAttribute("data-activity-toggle") || "";
      if (id) {
        if (!state.activityExpandedById || typeof state.activityExpandedById !== "object") state.activityExpandedById = {};
        state.activityExpandedById[id] = !state.activityExpandedById[id];
        renderApp();
      }
      return;
    }

    const actAttachEl = target.closest && target.closest("[data-activity-attach-manual]");
    if (actAttachEl) {
      window.alert("(mock) Open manual attach flow.");
      return;
    }

    const slackRefreshEl = target.closest && target.closest("[data-slack-refresh]");
    if (slackRefreshEl) {
      e.preventDefault();
      e.stopPropagation();
      fetchSlackIntegrationStatus();
      return;
    }

    const convOpenEl = target.closest && target.closest("[data-conversation-thread-open]");
    if (convOpenEl) {
      const id = convOpenEl.getAttribute("data-conversation-thread-open") || "";
      if (id) {
        state.activeConversationThreadId = id;
        renderApp();
        const cached = state.conversationThreadCacheById && typeof state.conversationThreadCacheById === "object" ? state.conversationThreadCacheById[id] : null;
        if (cached) openConversationThreadModal(cached);
        else openConversationThreadModalById(id);
      }
      return;
    }

    const focusThreadEl = target.closest && target.closest("[data-focus-thread]");
    if (focusThreadEl) {
      const id = focusThreadEl.getAttribute("data-focus-thread") || "";
      if (id) {
        state.activeOperationalThreadId = id;
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
          let result = null;
          const mode = getEffectiveClassifyMode(state.classifyMode);

          if (mode === "mock") {
            const payload = await submitMockIngest(rawText);
            if (payload && payload.ok === false) {
              throw new Error(payload.error || "Mock ingest failed");
            }
            result = payload && payload.result ? payload.result : payload;
          } else {
            const payload = await submitLlmIngest(rawText);
            if (payload && payload.ok === false) {
              throw new Error(payload.error || "LLM ingest failed");
            }
            result = payload && payload.result ? payload.result : payload;
          }

          state.latestIngestResult = result || null;
          state.latestIngestResultMode = mode;
          ensureApprovalsInitializedFromIngestResult(result);
          mergePendingClarificationsFromIngestResult(result);
          state.ingestNotice = (() => {
            const ctx = result?.contextResolution || null;
            if (ctx && String(ctx.status || "") !== "resolved_enough") {
              const st = String(ctx.status || "");
              const q = String(ctx.clarificationQuestion || "").trim();
              const prefix = st === "ambiguous" ? "候補選択が必要です" : "追加情報が必要です";
              const tail = "承認センターの確認返信候補に追加しました。";
              return `${prefix}${q ? `: ${q}` : ""} ${tail}`;
            }
            const muts = Array.isArray(result?.issueMutations) ? result.issueMutations.filter(Boolean) : [];
            const plans = Array.isArray(result?.actionPlans) ? result.actionPlans.filter(Boolean) : [];
            const events = Array.isArray(result?.activityEvents) ? result.activityEvents.filter(Boolean) : [];
            const hasApprovalItems = Boolean(
              muts.length ||
                plans.length ||
                events.some((ev) => ev && String(ev.type || "") === "approval_required"),
            );
            const label = mode === "llm" ? "AI分類" : "モック";
            if (!hasApprovalItems) {
              if (result?.matchedPendingClarification?.id) return `(${label}) 補足情報を反映しました。`;
              if (Array.isArray(result?.stateTransitionCandidates) && result.stateTransitionCandidates.length)
                return `(${label}) 状態遷移候補を検出しました。`;
              return `(${label}) 解析結果を更新しました。`;
            }
            const count = muts.length || plans.length || 0;
            return `(${label}) 承認センターに反映しました${count ? `（${count}件）` : ""}。`;
          })();

          // Reflect ingest into the Requests inbox (mock Conversation Hub)
          {
            const at = formatLocalTime(nowIso());
            const threadsRaw = Array.isArray(result?.threads) ? result.threads.filter(Boolean) : [];
            const ingestLinks = Array.isArray(result?.links) ? result.links.filter(Boolean) : [];
            const threadsFromResult = threadsRaw.map((t) => {
              const extracted = t?.extractedEntities && typeof t.extractedEntities === "object" ? t.extractedEntities : {};
              const first = (arr) => (Array.isArray(arr) && arr.length ? String(arr[0] ?? "").trim() : "");
              const threadLinks = ingestLinks.filter((l) => l && String(l.threadId || "") === String(t?.id || ""));
              const issueLink = resolveCanonicalIssueLink(t, threadLinks, "existing_or_candidate");
              return {
                id: String(t?.id || `thr-${shortId()}`),
                title: String(t?.title || "Thread"),
                status: state.classifyMode === "llm" ? "ai classified" : "mock classified",
                action: "Create new Issue",
                linkedShipmentId: first(extracted.shipmentIds),
                linkedSiNo: first(extracted.siIds),
                linkedIssueId: issueLink && issueLink.issueId ? String(issueLink.issueId) : "",
                linkedCustomer: first(extracted.customerNames),
              };
            });

              const muts = Array.isArray(result?.issueMutations) ? result.issueMutations.filter(Boolean) : [];
              const plans = Array.isArray(result?.actionPlans) ? result.actionPlans.filter(Boolean) : [];
              const events = Array.isArray(result?.activityEvents) ? result.activityEvents.filter(Boolean) : [];
              const hasApprovalItems = Boolean(
                muts.length ||
                  plans.length ||
                  events.some((ev) => ev && String(ev.type || "") === "approval_required"),
              );
	            const item = {
	              id: `raw-${shortId()}`,
	              source: "teams",
	              from: "営業A",
	              text: rawText,
	              receivedAt: at,
	              aiThreads: threadsFromResult.length ? threadsFromResult : decomposeRawRequestMock(rawText),
	              originalRawInputId: String(result?.rawInput?.id || ""),
	              pendingClarificationId: (() => {
	                const pcs = Array.isArray(result?.pendingClarifications) ? result.pendingClarifications.filter(Boolean) : [];
	                return pcs[0] && pcs[0].id ? String(pcs[0].id) : "";
	              })(),
	              matchedPendingClarificationId: result?.matchedPendingClarification?.id ? String(result.matchedPendingClarification.id) : "",
	              reflectedToApprovals: hasApprovalItems,
	              messages: [],
	            };
	            item.conversationThreadId = resolveConversationThreadIdForRawRequest(item);
	            const ctx = result?.contextResolution || null;
	            const q = ctx && ctx.clarificationQuestion ? String(ctx.clarificationQuestion).trim() : "";
	            const aiText = (() => {
                if (ctx && String(ctx.status || "") !== "resolved_enough" && q) return q;
                if (!hasApprovalItems) {
                  if (result?.matchedPendingClarification?.id) return "補足情報を反映しました。";
                  if (Array.isArray(result?.stateTransitionCandidates) && result.stateTransitionCandidates.length) return "状態遷移候補を検出しました。";
                  return "解析結果を更新しました。";
                }
                return "承認センターに反映しました。";
              })();
	            appendConversationMessagesWithSequence(item, [
	              { role: "human", text: rawText, createdAt: at },
	              { role: "ai", text: aiText, createdAt: at },
	            ]);

	            const next = Array.isArray(state.rawRequests) ? state.rawRequests.slice() : [];
	            next.push(item);
	            state.rawRequests = next;

	            if (item.conversationThreadId) state.activeConversationThreadId = item.conversationThreadId;
	          }

          const events = Array.isArray(result?.activityEvents) ? result.activityEvents.filter(Boolean) : [];
          const feedItems = events.map(activityEventToFeedItem);
          state.activityFeedItems = prependUniqueById(state.activityFeedItems, feedItems);

          const mutationsRaw = Array.isArray(result?.issueMutations) ? result.issueMutations.filter(Boolean) : [];
          const actionPlans = Array.isArray(result?.actionPlans) ? result.actionPlans.filter(Boolean) : [];
          const intakeResolutions = Array.isArray(result?.intakeResolutions) ? result.intakeResolutions.filter(Boolean) : [];
          const matchedThreads = Array.isArray(result?.threads) ? result.threads.filter(Boolean) : [];

	          const resolveSourceThreadIdForCandidate = ({ actionPlanId, issueId, sourceRawInputId, threadId } = {}) => {
            const plan =
              (actionPlanId && actionPlans.find((ap) => ap && String(ap.id || "") === String(actionPlanId))) ||
              (issueId && actionPlans.find((ap) => ap && String(ap.issueId || "") === String(issueId))) ||
              (sourceRawInputId && actionPlans.find((ap) => ap && String(ap.sourceRawInputId || "") === String(sourceRawInputId))) ||
              null;

            const res =
              (issueId && intakeResolutions.find((r) => r && String(r.issueId || "") === String(issueId))) ||
              (sourceRawInputId && intakeResolutions.find((r) => r && String(r.sourceRawInputId || "") === String(sourceRawInputId))) ||
              null;

            const matchedThread =
              (threadId && matchedThreads.find((t) => t && String(t.id || "") === String(threadId))) ||
              (plan?.threadId && matchedThreads.find((t) => t && String(t.id || "") === String(plan.threadId))) ||
              (res?.threadId && matchedThreads.find((t) => t && String(t.id || "") === String(res.threadId))) ||
              null;

	            const sourceThreadId =
	              plan?.sourceThreadId ||
	              plan?.threadId ||
	              res?.sourceThreadId ||
	              res?.threadId ||
	              (matchedThread ? matchedThread.id : "") ||
	              "";

            return String(sourceThreadId || "").trim();
          };

	          const mutations = mutationsRaw.map((m) => {
	            const issueId = String(m?.issueId || "").trim();
	            const sourceRawInputId = String(m?.sourceRawInputId || "").trim();
	            const explicitThreadId = String(m?.sourceThreadId || m?.threadId || "").trim();
	            const operationalThreadId =
	              explicitThreadId ||
	              resolveSourceThreadIdForCandidate({
	                actionPlanId: m?.actionPlanId || m?.relatedActionPlanId,
	                issueId,
	                sourceRawInputId,
	                threadId: m?.threadId,
	              });
	            const canonicalConversationId =
	              findCanonicalConversationIdBySourceRawInputId(sourceRawInputId) ||
	              findCanonicalConversationIdByOperationalThreadId(operationalThreadId) ||
	              "";

	            return {
	              id: `mut:${String(sourceRawInputId || "raw")}:${String(operationalThreadId || "thread")}:${String(issueId || "")}:${String(m?.action || "")}`,
	              issueId: m?.issueId,
	              action: m?.action,
	              title: m?.title,
	              body: m?.body,
	              linkedEntities: Array.isArray(m?.linkedEntities) ? m.linkedEntities : undefined,
	              confidence: typeof m?.confidence === "number" ? m.confidence : undefined,
	              sourceRawInputId: m?.sourceRawInputId,
	              operationalThreadId: operationalThreadId || undefined,
	              canonicalConversationId: canonicalConversationId || undefined,
	              threadId: operationalThreadId || m?.threadId,
	              sourceThreadId: operationalThreadId || undefined,
	              conversationThreadId: canonicalConversationId || undefined,
	              source: m?.sourceLabel,
	            };
	          });
          state.issueMutationItems = prependUniqueById(state.issueMutationItems, mutations);
        } catch (e) {
          const mode = getEffectiveClassifyMode(state.classifyMode);
          state.ingestError = e && e.message ? String(e.message) : mode === "llm" ? "LLM classify failed" : "Mock ingest failed";
          state.ingestNotice = "";
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
	          originalRawInputId: id,
	          reflectedToApprovals: true,
	          messages: [],
	        };
	        item.conversationThreadId = resolveConversationThreadIdForRawRequest(item);
	        appendConversationMessagesWithSequence(item, [
	          { role: "human", text, createdAt: at },
	          { role: "ai", text: "（mock）承認センターに反映しました。", createdAt: at },
	        ]);

	        const next = Array.isArray(state.rawRequests) ? state.rawRequests.slice() : [];
	        next.push(item);
	        state.rawRequests = next;

	        if (item.conversationThreadId) state.activeConversationThreadId = item.conversationThreadId;
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

    const openDocumentWorkspaceEl = target.closest && target.closest("[data-open-document-workspace]");
    if (openDocumentWorkspaceEl) {
      const tradeCaseId = String(openDocumentWorkspaceEl.getAttribute("data-open-document-workspace") || "").trim();
      const focusType = String(openDocumentWorkspaceEl.getAttribute("data-focus-type") || "").trim();
      const focusId = String(openDocumentWorkspaceEl.getAttribute("data-focus-id") || "").trim();
      const initialDocId = String(openDocumentWorkspaceEl.getAttribute("data-initial-doc-id") || "").trim();

      const book = target.closest ? target.closest(".shelf-book") : null;
      console.log("[shelf-book click]", {
        exists: !!book,
        dataset: book?.dataset,
      });

      console.log("[OPEN DOCUMENT WORKSPACE call]", {
        tradeCaseId,
        focusType,
        focusId,
        initialDocId,
      });

      if (tradeCaseId) openDocumentWorkspace(tradeCaseId, focusType, focusId, initialDocId);
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

    const demoApprovalApproveEl = target.closest && target.closest("[data-demo-approval-approve]");
    if (demoApprovalApproveEl) {
      e.preventDefault();
      e.stopPropagation();
      const id = demoApprovalApproveEl.getAttribute("data-demo-approval-approve") || "";
      approveDemoApprovalItem(id);
      return;
    }

    const issueOpenEl = target.closest && target.closest("[data-issue-open]");
    if (issueOpenEl) {
      e.preventDefault();
      e.stopPropagation();
      const id = issueOpenEl.getAttribute("data-issue-open") || "";
      state.activeIssueId = id || null;
      state.activeMutationId = null;
      state.activeReplyCandidateId = null;
      renderApp();
      return;
    }

    const issueBackEl = target.closest && target.closest("[data-issue-back]");
    if (issueBackEl) {
      e.preventDefault();
      e.stopPropagation();
      state.activeIssueId = null;
      renderApp();
      return;
    }

    const mutationOpenEl = target.closest && target.closest("[data-mutation-open]");
    if (mutationOpenEl) {
      e.preventDefault();
      e.stopPropagation();
      const id = mutationOpenEl.getAttribute("data-mutation-open") || "";
      console.log("[CLICK mutation-open]", {
        target,
        row: mutationOpenEl,
        mutationId: id,
      });
      state.activeMutationId = id || null;
      state.activeIssueId = null;
      state.activeReplyCandidateId = null;
      console.log("[SET activeMutationId]", state.activeMutationId);
      renderApp();
      return;
    }

    const mutationBackEl = target.closest && target.closest("[data-mutation-back]");
    if (mutationBackEl) {
      e.preventDefault();
      e.stopPropagation();
      state.activeMutationId = null;
      renderApp();
      return;
    }

    const replyCandidateOpenEl = target.closest && target.closest("[data-reply-candidate-open]");
    if (replyCandidateOpenEl) {
      e.preventDefault();
      e.stopPropagation();
      const id = replyCandidateOpenEl.getAttribute("data-reply-candidate-open") || "";
      state.activeReplyCandidateId = id || null;
      state.activeIssueId = null;
      state.activeMutationId = null;
      renderApp();
      return;
    }

    const replyBackEl = target.closest && target.closest("[data-reply-back]");
    if (replyBackEl) {
      e.preventDefault();
      e.stopPropagation();
      state.activeReplyCandidateId = null;
      renderApp();
      return;
    }

    const replyApproveEl = target.closest && target.closest("[data-reply-approve]");
    if (replyApproveEl) {
      const id = replyApproveEl.getAttribute("data-reply-approve") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "approve");
      if (!attempt.ok) {
        if (!attempt.ignored) window.alert(`(mock) approve failed`);
        return;
      }
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) approved: ${String(res.actionPlanId)} -> ${String(res.next)}`);
      renderApp();
      return;
    }

    const replyHoldEl = target.closest && target.closest("[data-reply-hold]");
    if (replyHoldEl) {
      const id = replyHoldEl.getAttribute("data-reply-hold") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "hold");
      if (!attempt.ok) {
        if (!attempt.ignored) window.alert(`(mock) hold failed`);
        return;
      }
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) held: ${String(res.actionPlanId)} -> ${String(res.next)}`);
      renderApp();
      return;
    }

    const replyEditEl = target.closest && target.closest("[data-reply-edit]");
    if (replyEditEl) {
      const id = replyEditEl.getAttribute("data-reply-edit") || "";
      e.preventDefault();
      e.stopPropagation();
      const apId = findActionPlanIdFromAnyId(id);
      if (!apId) return;

      state.activeDraftEditActionPlanId = apId;
      renderApp();
      return;
    }

    const replyResumeEl = target.closest && target.closest("[data-reply-resume]");
    if (replyResumeEl) {
      const id = replyResumeEl.getAttribute("data-reply-resume") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "resume");
      if (!attempt.ok) return;
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) resumed: ${String(res.actionPlanId)} -> ${String(res.next)}`);
      renderApp();
      return;
    }

    const replyMockSendEl = target.closest && target.closest("[data-reply-mock-send]");
    if (replyMockSendEl) {
      const id = replyMockSendEl.getAttribute("data-reply-mock-send") || "";
      e.preventDefault();
      e.stopPropagation();
      const apId = findActionPlanIdFromAnyId(id);
      const draft = apId ? findDraftByActionPlanId(apId) : null;
      const toText = (() => {
        const raw = draft?.to;
        if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean).join(", ");
        if (typeof raw === "string") return raw;
        return "";
      })();
      const subject = draft?.subject ? String(draft.subject) : "";
      const desc = `mock送信：${toText || "-"} / ${subject || "-"}`;

      const attempt = guardApprovalClick(id, "mock_send", { description: desc });
      if (!attempt.ok) {
        if (!attempt.ignored) window.alert(`(mock) mock send failed`);
        return;
      }
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) mock sent: ${String(res.actionPlanId)} -> ${String(res.next)}`);
      renderApp();
      return;
    }

    const clarificationSendEl = target.closest && target.closest("[data-clarification-mock-send]");
    if (clarificationSendEl) {
      const id = String(clarificationSendEl.getAttribute("data-clarification-mock-send") || "").trim();
      if (!id) return;

      const lookup = (() => {
        if (id.startsWith("pc:")) {
          const rawId = id.slice(3);
          const pcs = Array.isArray(state.pendingClarifications) ? state.pendingClarifications.filter(Boolean) : [];
          const p = pcs.find((x) => x && String(x.id || "") === rawId) || null;
          if (!p) return null;
          return {
            threadId: String(p?.threadId || "").trim(),
            requester: String(p?.requesterName || "").trim(),
            bodyText: String(p?.clarificationQuestion || "").trim(),
          };
        }
        if (id.startsWith("ir:")) {
          const threadId = id.slice(3);
          const rs = Array.isArray(state.latestIngestResult?.intakeResolutions) ? state.latestIngestResult.intakeResolutions.filter(Boolean) : [];
          const r = rs.find((x) => x && String(x.threadId || "") === threadId) || null;
          if (!r) return null;
          return {
            threadId,
            requester: "",
            bodyText: String((r?.status === "status_query" ? r?.statusAnswer : r?.clarificationQuestion) || "").trim(),
          };
        }
        return null;
      })();

      const msg = lookup?.bodyText || "（mock）確認返信を送信しました。";
      window.alert(`(mock) 確認返信を送信: ${msg}`);
      return;
    }

    const clarificationHoldEl = target.closest && target.closest("[data-clarification-hold]");
    if (clarificationHoldEl) {
      const id = String(clarificationHoldEl.getAttribute("data-clarification-hold") || "").trim();
      if (!id) return;
      window.alert(`(mock) 保留しました: ${id}`);
      return;
    }

    const alphaApproveEl = target.closest && target.closest("[data-alpha-approve]");
    if (alphaApproveEl) {
      const id = alphaApproveEl.getAttribute("data-alpha-approve") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "approve");
      if (!attempt.ok) return;
      renderApp();
      return;
    }

    const alphaHoldEl = target.closest && target.closest("[data-alpha-hold]");
    if (alphaHoldEl) {
      const id = alphaHoldEl.getAttribute("data-alpha-hold") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "hold");
      if (!attempt.ok) return;
      renderApp();
      return;
    }

    const alphaEditEl = target.closest && target.closest("[data-alpha-edit]");
    if (alphaEditEl) {
      const id = alphaEditEl.getAttribute("data-alpha-edit") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "edit");
      if (!attempt.ok) return;
      renderApp();
      return;
    }

    const alphaMockSendEl = target.closest && target.closest("[data-alpha-mock-send]");
    if (alphaMockSendEl) {
      const id = alphaMockSendEl.getAttribute("data-alpha-mock-send") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "mock_send");
      if (!attempt.ok) return;
      renderApp();
      return;
    }

    const mutationApproveEl = target.closest && target.closest("[data-mutation-approve]");
    if (mutationApproveEl) {
      const id = mutationApproveEl.getAttribute("data-mutation-approve") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "approve");
      if (!attempt.ok) {
        if (!attempt.ignored) window.alert(`(mock) approve failed`);
        return;
      }
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) approved: ${String(res.actionPlanId)} -> ${String(res.next)}`);
      renderApp();
      return;
    }

    const mutationHoldEl = target.closest && target.closest("[data-mutation-hold]");
    if (mutationHoldEl) {
      const id = mutationHoldEl.getAttribute("data-mutation-hold") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "hold");
      if (!attempt.ok) {
        if (!attempt.ignored) window.alert(`(mock) hold failed`);
        return;
      }
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) held: ${String(res.actionPlanId)} -> ${String(res.next)}`);
      renderApp();
      return;
    }

    const mutationEditEl = target.closest && target.closest("[data-mutation-edit]");
    if (mutationEditEl) {
      const id = mutationEditEl.getAttribute("data-mutation-edit") || "";
      e.preventDefault();
      e.stopPropagation();
      const apId = findActionPlanIdFromAnyId(id);
      if (!apId) return;

      state.activeDraftEditActionPlanId = apId;
      renderApp();
      return;
    }

    const mutationResumeEl = target.closest && target.closest("[data-mutation-resume]");
    if (mutationResumeEl) {
      const id = mutationResumeEl.getAttribute("data-mutation-resume") || "";
      e.preventDefault();
      e.stopPropagation();
      const attempt = guardApprovalClick(id, "resume");
      if (!attempt.ok) return;
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) resumed: ${String(res.actionPlanId)} -> ${String(res.next)}`);
      renderApp();
      return;
    }

    const mutationMockSendEl = target.closest && target.closest("[data-mutation-mock-send]");
    if (mutationMockSendEl) {
      const id = mutationMockSendEl.getAttribute("data-mutation-mock-send") || "";
      e.preventDefault();
      e.stopPropagation();
      const apId = findActionPlanIdFromAnyId(id);
      const draft = apId ? findDraftByActionPlanId(apId, { preferredChannel: "email" }) : null;
      const toText = (() => {
        const raw = draft?.to;
        if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean).join(", ");
        if (typeof raw === "string") return raw;
        return "";
      })();
      const subject = draft?.subject ? String(draft.subject) : "";
      const desc = `mock送信：${toText || "-"} / ${subject || "-"}`;

      const attempt = guardApprovalClick(id, "mock_send", { description: desc });
      if (!attempt.ok) {
        if (!attempt.ignored) window.alert(`(mock) mock send failed`);
        return;
      }
      const res = attempt.res;
      if (res && res.actionPlanId) log(`(mock) mock sent: ${String(res.actionPlanId)} -> ${String(res.next)}`);
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

  }

  root.addEventListener("input", (e) => {
    const target = e.target;
    if (!target) return;
    const humanMemoBodyEl = target.closest && target.closest("[data-human-memo-body]");
    if (humanMemoBodyEl) {
      if (state.activeHumanMemoEdit) {
        state.activeHumanMemoEdit.bodyDraft = typeof humanMemoBodyEl.value === "string" ? humanMemoBodyEl.value : "";
      }
      return;
    }
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
    const shelfSearchEl = target.closest && target.closest("[data-shelf-search]");
    if (shelfSearchEl) {
      state.shelfSearchQuery = typeof shelfSearchEl.value === "string" ? shelfSearchEl.value : "";
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
      state.activeMutationId = null;
      renderApp();
      return;
    }

    const mutationOpenEl = target.closest && target.closest("[data-mutation-open]");
    if (mutationOpenEl) {
      const id = mutationOpenEl.getAttribute("data-mutation-open") || "";
      console.log("[KEY mutation-open]", { target, row: mutationOpenEl, mutationId: id });
      state.activeMutationId = id || null;
      state.activeIssueId = null;
      renderApp();
      return;
    }
  });

  root.addEventListener("click", handleNewTopClick);

  const ensureShelfFloatingPreviewEl = () => {
    const existing = document.getElementById("shelf-floating-preview");
    if (existing) return existing;

    const el = document.createElement("div");
    el.id = "shelf-floating-preview";
    el.className = "shelf-floating-preview";
    el.setAttribute("data-shelf-floating-preview", "");
    el.setAttribute("aria-hidden", "true");
    el.hidden = true;
    // NOTE: This element is appended to document.body (outside #app), so we
    // must ensure it behaves as a fixed, viewport-positioned tooltip even if
    // CSS scoping changes.
    el.style.position = "fixed";
    el.style.pointerEvents = "none";
    el.style.zIndex = "9999";
    el.style.maxWidth = "320px";
    document.body.appendChild(el);
    return el;
  };

  const positionShelfFloatingPreview = (previewEl, bookEl) => {
    if (!previewEl || !bookEl || typeof bookEl.getBoundingClientRect !== "function") return;
    const rect = bookEl.getBoundingClientRect();
    const margin = 12;

    previewEl.style.position = "fixed";
    previewEl.hidden = false;

    const previewRect = previewEl.getBoundingClientRect();

    let left = rect.right + margin;
    let top = rect.top;

    if (left + previewRect.width > window.innerWidth - margin) {
      left = rect.left - previewRect.width - margin;
    }

    if (top + previewRect.height > window.innerHeight - margin) {
      top = window.innerHeight - previewRect.height - margin;
    }
    if (top < margin) top = margin;

    if (left < margin) left = margin;
    if (left + previewRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - previewRect.width - margin);
    }

    previewEl.style.left = `${Math.round(left)}px`;
    previewEl.style.top = `${Math.round(top)}px`;
  };

  const showShelfPreviewForBook = (bookEl) => {
    if (!bookEl || !bookEl.getAttribute) return;
    const itemId = String(bookEl.getAttribute("data-shelf-preview-id") || "").trim();
    if (!itemId) return;

    const payload = state.shelfPreviewPayloadById?.[itemId] || null;
    if (!payload) return;

    const el = ensureShelfFloatingPreviewEl();
    if (!el) return;

    const html = renderShelfPreviewHtml(payload, escapeHtml);
    if (!html) return;

    if (el.dataset.itemId !== itemId) el.dataset.itemId = itemId;
    if (el.innerHTML !== html) el.innerHTML = html;

    el.hidden = false;
    positionShelfFloatingPreview(el, bookEl);

    requestAnimationFrame(() => {
      if (el.hidden) return;
      if (el.dataset.itemId !== itemId) return;
      positionShelfFloatingPreview(el, bookEl);
    });
  };

  const hideShelfPreview = () => {
    const el = document.getElementById("shelf-floating-preview");
    if (!el) return;
    if (el.hidden) return;
    el.hidden = true;
    el.dataset.itemId = "";
  };

  root.addEventListener(
    "mouseover",
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const book = t.closest(".shelf-book");
      if (!book) return;
      showShelfPreviewForBook(book);
    },
    { passive: true }
  );

  root.addEventListener(
    "mouseout",
    (e) => {
      const from = e.target;
      if (!from || !from.closest) return;
      const fromBook = from.closest(".shelf-book");
      if (!fromBook) return;
      const to = e.relatedTarget;
      const toBook = to && to.closest ? to.closest(".shelf-book") : null;
      if (toBook) return;
      hideShelfPreview();
    },
    { passive: true }
  );

  root.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const book = t.closest(".shelf-book");
    if (!book) return;
    showShelfPreviewForBook(book);
  });

  root.addEventListener("focusout", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const fromBook = t.closest(".shelf-book");
    if (!fromBook) return;
    const to = e.relatedTarget;
    const toBook = to && to.closest ? to.closest(".shelf-book") : null;
    if (toBook) return;
    hideShelfPreview();
  });

}

function main() {
  setupModal();
  setupWorkspaceModals();
  setupOperationalThreadModal();
  seed();
  const initialTab = topTabFromPath(window.location && window.location.pathname);
  state.topActiveTab = initialTab;
  if (window.location && window.location.pathname === "/") {
    syncUrlForTopTab(initialTab, { replace: true });
  }
  window.addEventListener("popstate", () => {
    setTopActiveTab(topTabFromPath(window.location && window.location.pathname), { push: false });
  });
  setupNewTop();
  renderApp();
  scheduleServerActivityPoll();
  scheduleSlackStatusPoll();
}

main();

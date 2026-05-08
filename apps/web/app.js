import { analyzeImpact, detectIncidents, mockTradeCases, proposeActions } from "@trade-shelf/shared";

const shelves = ["出荷待ち", "書類不足", "返信待ち", "通関中", "完了"];

const state = {
  inboxItems: [],
  tradeCases: [],
  proposalApprovalStatusById: {},
  modalTradeCaseId: null,
};

function getTradeCaseById(id) {
  return state.tradeCases.find((c) => c && c.id === id) || null;
}

function recordTimelineEvent(tradeCaseId, event) {
  const tc = getTradeCaseById(tradeCaseId);
  if (!tc) return;
  if (!Array.isArray(tc.timeline)) tc.timeline = [];
  tc.timeline.unshift(event);
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
  const incidents = Array.isArray(tradeCase.incidents) ? tradeCase.incidents : [];
  const hasMissingDoc = incidents.some((i) => i && i.type === "missingDocument" && i.status !== "resolved");
  if (hasMissingDoc) return "書類不足";

  const hasNoResponse = incidents.some((i) => i && i.type === "supplierNoResponse" && i.status !== "resolved");
  if (hasNoResponse) return "返信待ち";

  const s = tradeCase.shipmentState;
  if (s === "completed") return "完了";
  if (s === "customsCleared" || s === "delivered") return "完了";
  if (s === "inTransit" || s === "arrived" || s === "shipped") return "通関中";
  if (s === "bookingRequested" || s === "notArranged" || s === "shippingPending") return "出荷待ち";
  return "出荷待ち";
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

  for (const shelfName of shelves) {
    const el = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-count]`);
    if (!el) continue;
    const count = state.tradeCases.filter((c) => classifyTradeCaseToShelf(c) === shelfName).length;
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
  for (const shelfName of shelves) {
    const body = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-body]`);
    if (!body) continue;
    body.innerHTML = "";
    const items = state.tradeCases.filter((c) => classifyTradeCaseToShelf(c) === shelfName).slice().reverse();
    for (const tradeCase of items) {
      const card = document.createElement("div");
      card.className = "card";
      const incidentCount = Array.isArray(tradeCase.incidents) ? tradeCase.incidents.length : 0;
      if (incidentCount > 0) card.classList.add("card--incident");
      card.dataset.id = tradeCase.id;
      card.innerHTML = `<div class="card__title"></div><div class="card__body"></div>`;
      card.querySelector(".card__title").textContent = tradeCase.title;
      const supplierName = tradeCase.supplier && tradeCase.supplier.name ? tradeCase.supplier.name : "-";
      const updated = tradeCase.updatedAt ? formatLocalTime(tradeCase.updatedAt) : "-";
      card.querySelector(".card__body").textContent = [
        `supplier: ${supplierName}`,
        `tradeType: ${tradeCase.tradeType}`,
        `shipmentState: ${tradeCase.shipmentState}`,
        `updatedAt: ${updated}`,
        `incidents: ${incidentCount > 0 ? `あり(${incidentCount})` : "なし"}`,
      ].join(" / ");
      card.addEventListener("click", () => openTradeCaseDetail(tradeCase));
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

  const products = Array.isArray(tradeCase.products) ? tradeCase.products : [];
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

  openModal({
    title: `案件詳細: ${tradeCase.id}`,
    bodyHtml: `
      <div class="detail">
        <section class="detail-section detail-section--summary">
          <h3 class="detail-section__title">Decision Summary</h3>
          <div class="decision-summary">
            <div class="decision-summary__row">
              <span class="muted">Risk level</span>
              <span class="pill ${severityClass(decisionSummary.riskLevel)}">${escapeHtml(decisionSummary.riskLevel)}</span>
            </div>
            <div class="decision-summary__row"><span class="muted">Main issue</span><span class="decision-summary__value">${escapeHtml(decisionSummary.mainIssue)}</span></div>
            <div class="decision-summary__row"><span class="muted">Recommended action</span><span class="decision-summary__value">${escapeHtml(decisionSummary.recommendedAction)}</span></div>
            <div class="decision-summary__row"><span class="muted">Required decision</span><span class="decision-summary__value">${escapeHtml(decisionSummary.requiredDecision)}</span></div>
            <div class="decision-summary__row"><span class="muted">Deadline / ETA</span><span class="decision-summary__value">${escapeHtml(decisionSummary.eta)}</span></div>
            <div class="decision-summary__row"><span class="muted">Confidence</span><span class="decision-summary__value">${escapeHtml(decisionSummary.confidence)}</span></div>
          </div>
        </section>

        <section class="detail-section detail-section--decision">
          <h3 class="detail-section__title">Human Decision / 人間の判断</h3>
          <div class="detail-subhead">Human Intervention</div>
          <div class="action-groups">
            <div class="action-group">
              <div class="action-group__title muted">Primary actions</div>
              <div class="action-row">
                <button class="btn btn--primary" type="button" data-human-action="markAsPartialShipment" data-human-label="分納として処理">分納として処理</button>
                <button class="btn btn--primary" type="button" data-human-action="linkToNextShipment" data-human-label="次便に紐づけ">次便に紐づけ</button>
              </div>
            </div>
            <div class="action-group">
              <div class="action-group__title muted">Secondary actions</div>
              <div class="action-row">
                <button class="btn" type="button" data-human-action="requestConfirmation" data-human-label="確認依頼">確認依頼</button>
                <button class="btn" type="button" data-human-action="hold" data-human-label="保留">保留</button>
                <button class="btn" type="button" data-human-action="escalate" data-human-label="エスカレーション">エスカレーション</button>
              </div>
            </div>
            <div class="action-group">
              <div class="action-group__title muted">Exception actions</div>
              <div class="action-row">
                <button class="btn" type="button" data-human-action="markAsNoIssue" data-human-label="問題なしとして記録">問題なしとして記録</button>
                <button class="btn btn--danger" type="button" data-human-action="reject" data-human-label="却下">却下</button>
              </div>
            </div>
          </div>

          <div class="detail-subhead">Approval（提案の承認）</div>
          ${renderProposals(nextActions)}
        </section>

        <section class="detail-section">
          <h3 class="detail-section__title">Agent Analysis / AI分析</h3>
          <div class="detail-subhead">Detected Incidents</div>
          ${incidentAccordionHtml}
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

        <section class="detail-section">
          <h3 class="detail-section__title">Decision History</h3>
          <ul class="list">${timelineHtml}</ul>
        </section>
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

  modal.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    if (target.matches("[data-close]")) closeModal();

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
    if (e.key === "Escape") closeModal();
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
  updateCounts();
  renderShelves();
  log(`サンプル: mockTradeCases ${state.tradeCases.length} 件を棚に表示`);
}

function clearAll() {
  state.inboxItems = [];
  state.tradeCases = [];
  document.getElementById("inbox-items").innerHTML = "";
  for (const shelfName of shelves) {
    const body = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-body]`);
    if (body) body.innerHTML = "";
  }
  document.getElementById("log-items").innerHTML = "";
  updateCounts();
  log("クリア: 全ての棚/Inbox を空にしました");
}

function setupTopActions() {
  document.getElementById("btn-seed").addEventListener("click", seed);
  document.getElementById("btn-clear").addEventListener("click", clearAll);
  document.getElementById("btn-incident").addEventListener("click", () => {
    addItem({
      kind: "text",
      text: "INCIDENT: expected 1000 / invoiced 400 mismatch\n影響: 出荷・通関遅延の可能性。\n対応案を出して承認を取りたい。",
    });
  });
}

function main() {
  setupDropzone();
  setupTextAdd();
  setupModal();
  setupManualModal();
  setupTopActions();
  seed();
  updateCounts();
  log("起動: UI mock を開始");
}

main();

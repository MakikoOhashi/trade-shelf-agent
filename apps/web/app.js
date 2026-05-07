import { analyzeImpact, detectIncidents, mockTradeCases, proposeActions } from "@trade-shelf/shared";

const shelves = ["出荷待ち", "書類不足", "返信待ち", "通関中", "完了"];

const state = {
  inboxItems: [],
  tradeCases: [],
  proposalApprovalStatusById: {},
  modalTradeCaseId: null,
};

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
  inboxCount.textContent = `${state.inboxItems.length} items`;

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

  const timelineHtml = timeline.length
    ? timeline
        .map((e) => `<li><span class="muted">${escapeHtml(formatLocalTime(e.at))}</span> ${escapeHtml(e.type)}: ${escapeHtml(e.message)}</li>`)
        .join("")
    : "<li class=\"muted\">(none)</li>";

  const incidentsHtml = incidents.length
    ? incidents
        .map(
          (i) =>
            `<li><span class="pill pill--incident">${escapeHtml(i.severity)}</span> <span class="pill">${escapeHtml(
              i.type,
            )}</span> <span class="muted">conf:${typeof i.confidence === "number" ? i.confidence.toFixed(2) : "-"}</span><div class="muted">${escapeHtml(
              i.summary,
            )}</div></li>`,
        )
        .join("")
    : "<li class=\"muted\">(none)</li>";

  const impacts = incidents
    .map((i) => ({ incident: i, impact: analyzeImpact(tradeCase, i) }))
    .filter((x) => x && x.impact);

  const impactsHtml = impacts.length
    ? impacts
        .map(({ incident, impact }) => {
          const productsHtml = Array.isArray(impact.affectedProducts)
            ? impact.affectedProducts
                .map((p) => {
                  const label = [p.sku, p.name, p.productId].filter(Boolean).join(" / ");
                  return `<li>${escapeHtml(label)} <span class="muted">(SI:${escapeHtml(
                    String(p.siQty ?? "-"),
                  )} / INV:${escapeHtml(String(p.invoiceQty ?? "-"))} / shortage:${escapeHtml(String(p.shortageQty ?? "-"))})</span></li>`;
                })
                .join("")
            : "<li class=\"muted\">(none)</li>";

          const optionsHtml = Array.isArray(impact.decisionOptions)
            ? impact.decisionOptions
                .map((o) => {
                  const pros = Array.isArray(o.pros) && o.pros.length ? `<div class="muted">pros: ${escapeHtml(o.pros.join(" / "))}</div>` : "";
                  const cons = Array.isArray(o.cons) && o.cons.length ? `<div class="muted">cons: ${escapeHtml(o.cons.join(" / "))}</div>` : "";
                  const req =
                    Array.isArray(o.requiredActions) && o.requiredActions.length
                      ? `<div class="muted">required: ${escapeHtml(o.requiredActions.join(" / "))}</div>`
                      : "";
                  return `<li class="impact__option">
                    <div class="impact__option-title">${escapeHtml(o.title)}</div>
                    <div class="muted">${escapeHtml(o.summary)}</div>
                    ${pros}${cons}${req}
                  </li>`;
                })
                .join("")
            : "<li class=\"muted\">(none)</li>";

          return `<div class="impact">
            <div class="impact__head">
              <span class="pill pill--incident">${escapeHtml(incident.severity)}</span>
              <span class="pill">${escapeHtml(incident.type)}</span>
              <span class="pill">${escapeHtml(impact.deliveryRisk)}</span>
            </div>

            <div class="impact__kv">
              <div><span class="muted">shortageQty:</span> ${escapeHtml(String(impact.shortageQty))}</div>
              <div><span class="muted">currentStock:</span> ${escapeHtml(String(impact.currentStock))}</div>
              <div><span class="muted">allocatedQty:</span> ${escapeHtml(String(impact.allocatedQty))}</div>
              <div><span class="muted">availableQty:</span> ${escapeHtml(String(impact.availableQty))}</div>
              <div><span class="muted">nextShipment:</span> ${escapeHtml(String(impact.nextShipmentQty))} @ ${escapeHtml(
            impact.nextShipmentEta || "-",
          )}</div>
              <div><span class="muted">canCoverByNextShipment:</span> ${escapeHtml(String(impact.canCoverByNextShipment))}</div>
            </div>

            <div class="impact__block"><span class="muted">affectedProducts</span><ul class="list">${productsHtml}</ul></div>
            <div class="impact__block"><span class="muted">customerImpact</span><div>${escapeHtml(impact.customerImpact)}</div></div>
            <div class="impact__block"><span class="muted">recommendedDecision</span><div class="impact__recommend">${escapeHtml(
              impact.recommendedDecision,
            )}</div></div>

            <div class="impact__block"><span class="muted">decisionOptions</span><ul class="list impact__options">${optionsHtml}</ul></div>
          </div>`;
        })
        .join("")
    : "<div class=\"muted\">(none)</div>";

  const actionsHtml = nextActions.length
    ? nextActions
        .map((a) => {
          const approveBtn =
            a.approvalStatus !== "approved"
              ? `<button class="btn btn--small" type="button" data-approve-proposal="${escapeHtml(a.id)}">承認</button>`
              : `<span class="pill pill--ok">approved</span>`;
          return `<li class="proposal">
            <div class="proposal__row">
              <div class="proposal__title">${escapeHtml(a.title)}</div>
              <div class="proposal__meta">
                <span class="pill">${escapeHtml(a.type)}</span>
                <span class="pill">${escapeHtml(a.priority)}</span>
                <span class="pill">${escapeHtml(a.approvalStatus || "-")}</span>
                ${approveBtn}
              </div>
            </div>
            <div class="muted">${escapeHtml(a.description)}</div>
          </li>`;
        })
        .join("")
    : "<li class=\"muted\">(none)</li>";

  openModal({
    title: `案件詳細: ${tradeCase.id}`,
    bodyHtml: `
      <div class="detail">
        <div class="detail__meta">
          <div><span class="muted">title:</span> ${escapeHtml(tradeCase.title)}</div>
          <div><span class="muted">supplier:</span> ${escapeHtml(supplierName)}</div>
          <div><span class="muted">tradeType:</span> ${escapeHtml(tradeCase.tradeType)}</div>
          <div><span class="muted">shipmentState:</span> ${escapeHtml(tradeCase.shipmentState)}</div>
          <div><span class="muted">updatedAt:</span> ${escapeHtml(updated)}</div>
        </div>

        <h3 class="detail__head">Detected Incidents</h3>
        <ul class="list">${incidentsHtml}</ul>

        <h3 class="detail__head">Impact Analysis</h3>
        ${impactsHtml}

        <h3 class="detail__head">Action Proposals</h3>
        <ul class="list">${actionsHtml}</ul>

        <h3 class="detail__head">Documents</h3>
        <ul class="list">${docsHtml}</ul>

        <h3 class="detail__head">Timeline</h3>
        <ul class="list">${timelineHtml}</ul>
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

    if (target.matches("[data-approve-proposal]")) {
      const proposalId = target.getAttribute("data-approve-proposal");
      if (!proposalId) return;
      state.proposalApprovalStatusById[proposalId] = "approved";

      const tc = state.tradeCases.find((c) => c && c.id === state.modalTradeCaseId);
      if (tc) renderTradeCaseDetail(tc);
      log(`承認: proposal ${proposalId}`);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
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
  setupTopActions();
  seed();
  updateCounts();
  log("起動: UI mock を開始");
}

main();

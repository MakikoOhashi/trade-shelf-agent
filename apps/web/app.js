import { analyzeImpact, detectIncidents, mockTradeCases, proposeActions } from "@trade-shelf/shared";

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
  proposalApprovalStatusById: {},
  modalTradeCaseId: null,
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
};

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

  const contextDefs = [
    { key: "inventory", label: "在庫を見る" },
    { key: "salesCommitments", label: "売約を見る" },
    { key: "inboundPlans", label: "次便を見る" },
    { key: "similarPastCases", label: "類似案件を見る" },
    { key: "supplierReliability", label: "仕入先傾向を見る" },
    { key: "stakeholderResponses", label: "営業回答を見る" },
    { key: "documentStatus", label: "書類状況を見る" },
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
    return `
      <div class="context-drawer__top">
        <div class="context-drawer__title">${escapeHtml(title)}</div>
        <button class="btn btn--small btn--ghost" type="button" data-context-close>閉じる</button>
      </div>
      <div class="context-drawer__body">
        ${bodyHtml}
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
      return renderDrawerPanel("Inventory / 在庫", `<div class="evidence-table">${rows}</div>`);
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
      return renderDrawerPanel("Sales Commitments / 売約", `<div class="evidence-table">${rows}</div>`);
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
      return renderDrawerPanel("Inbound Plans / 次便", `<div class="evidence-table">${rows}</div>`);
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
      return renderDrawerPanel("Similar Past Cases / 類似案件", `<div class="evidence-table">${rows}</div>`);
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
      return renderDrawerPanel("Supplier Reliability / 仕入先傾向", html);
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
                  ${x.note ? `<div class="muted">${escapeHtml(x.note)}</div>` : ""}
                </div>
              </div>`,
            )
            .join("")
        : `<div class="muted">(no data)</div>`;
      return renderDrawerPanel("Stakeholder Responses / 関係者回答", `<div class="evidence-table">${rows}</div>`);
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
      return renderDrawerPanel("Document Status / 書類状況", `<div class="evidence-table">${rows}</div>`);
    }

    return renderDrawerPanel("Context", `<div class="muted">(unknown context)</div>`);
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

    return `<div class="detail-section detail-section--coordination">
      <h3 class="detail-section__title">Stakeholder Coordination / 関係者確認</h3>
      <div class="detail-block">
        <div class="kv">
          <span class="muted">影響営業</span> ${escapeHtml(String(affectedSalesCount))}
          <span class="muted">回答済み</span> ${escapeHtml(String(confirmedCount))}
          <span class="muted">確認中/未返信</span> ${escapeHtml(String(waitingCount))}
          <span class="muted">判断期限</span> ${escapeHtml(deadline)}
        </div>
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

  const activeDrawerKey = state.activeContextDrawer;
  const drawerIsOpen = Boolean(activeDrawerKey);

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
            <div class="detail-subhead">Context Launcher / 必要資料</div>
            ${renderContextLauncher(activeDrawerKey)}
          </section>

          ${renderAgentRecommendation(tradeCase)}

          <section class="detail-section detail-section--decision">
            <h3 class="detail-section__title">Human Decision Actions / 判断と承認</h3>
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

          ${renderStakeholderCoordinationPreview(tradeCase)}
          ${renderTeamsMessagePreview(tradeCase)}

          <section class="detail-section">
            <h3 class="detail-section__title">Agent Analysis / AI分析</h3>
            <div class="detail-subhead">Detected Incidents</div>
            ${incidentAccordionHtml}
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

  modal.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    if (target.matches("[data-close]")) closeModal();

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
  renderShelfHeader();
  renderShelves();
  log(`サンプル: mockTradeCases ${state.tradeCases.length} 件を棚に表示（${state.currentViewLens} view）`);
}

function clearAll() {
  state.inboxItems = [];
  state.tradeCases = [];
  document.getElementById("inbox-items").innerHTML = "";
  ensureShelvesDom();
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

function setupViewLens() {
  const root = document.getElementById("view-lens");
  if (!root) return;

  root.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    const btn = target.closest && target.closest("[data-view-lens]");
    if (!btn) return;
    const lens = btn.getAttribute("data-view-lens");
    if (!lens) return;
    state.currentViewLens = lens;
    renderShelfHeader();
    updateCounts();
    renderShelves();
    log(`View Lens: ${lens} に切替`);
  });

  renderShelfHeader();
}

function main() {
  setupDropzone();
  setupTextAdd();
  setupModal();
  setupManualModal();
  setupTopActions();
  setupViewLens();
  seed();
  updateCounts();
  log("起動: UI mock を開始");
}

main();

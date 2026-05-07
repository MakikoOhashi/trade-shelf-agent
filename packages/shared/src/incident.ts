import type { ActionProposal, Incident, TradeCase, TradeDocument } from "./domain";

function nowIso() {
  return new Date().toISOString();
}

function stableId(prefix: string, seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function hasDocType(documents: TradeDocument[], type: TradeDocument["type"]) {
  return documents.some((d) => d && d.type === type);
}

function pickQuantityFromDocs(documents: TradeDocument[], docType: TradeDocument["type"], key: "siQuantity" | "invoiceQuantity") {
  for (const d of documents) {
    if (!d || d.type !== docType) continue;
    const v = d.extracted && typeof d.extracted[key] === "number" ? d.extracted[key] : undefined;
    if (typeof v === "number") return v;
  }
  return undefined;
}

function detectEtaChangeSignal(tradeCase: TradeCase) {
  if (Array.isArray(tradeCase.incidents) && tradeCase.incidents.some((i) => i && i.type === "etaChanged")) return true;

  const docs = Array.isArray(tradeCase.documents) ? tradeCase.documents : [];
  for (const d of docs) {
    if (!d) continue;
    const t = `${d.title || ""}\n${d.summary || ""}`.toLowerCase();
    if (/(eta).*(revised|change|changed|変更|改定)/i.test(t)) return true;
    if (/(revised|変更|改定).*(eta)/i.test(t)) return true;
  }

  const timeline = Array.isArray(tradeCase.timeline) ? tradeCase.timeline : [];
  for (const e of timeline) {
    const t = String(e && e.message ? e.message : "");
    if (/ETA/.test(t) && /(変更|改定|revised|changed)/i.test(t)) return true;
    if (/ETA\s*.*→/.test(t)) return true;
  }
  return false;
}

export function detectIncidents(tradeCase: TradeCase): Incident[] {
  const documents = Array.isArray(tradeCase.documents) ? tradeCase.documents : [];

  const incidents: Incident[] = [];

  const siQuantity = pickQuantityFromDocs(documents, "SI", "siQuantity") ?? tradeCase.products?.[0]?.quantityInstructed;
  const invoiceQuantity =
    pickQuantityFromDocs(documents, "Invoice", "invoiceQuantity") ?? tradeCase.products?.[0]?.quantityInvoiced;

  if (typeof siQuantity === "number" && typeof invoiceQuantity === "number" && invoiceQuantity < siQuantity) {
    incidents.push({
      id: stableId("INC", `${tradeCase.id}:invoiceQuantityMismatch:${siQuantity}:${invoiceQuantity}`),
      type: "invoiceQuantityMismatch",
      severity: "high",
      confidence: 0.96,
      status: "open",
      summary: `SI(${siQuantity})に対してINV(${invoiceQuantity})が不足。残数量と出荷予定の確認が必要。`,
      detectedAt: nowIso(),
      relatedDocumentIds: documents.filter((d) => d.type === "SI" || d.type === "Invoice").map((d) => d.id),
      details: { siQuantity, invoiceQuantity },
    });
  }

  if (detectEtaChangeSignal(tradeCase)) {
    incidents.push({
      id: stableId("INC", `${tradeCase.id}:etaChanged`),
      type: "etaChanged",
      severity: "medium",
      confidence: 0.8,
      status: "open",
      summary: "ETA変更の兆候を検知。最新ETAと遅延理由の確認が必要。",
      detectedAt: nowIso(),
      relatedDocumentIds: documents.filter((d) => d.type === "ForwarderMail" || d.type === "ArrivalNotice").map((d) => d.id),
    });
  }

  const missingInvoice = !hasDocType(documents, "Invoice");
  const missingPackingList = !hasDocType(documents, "PackingList");
  if (missingInvoice || missingPackingList) {
    const missing = [missingInvoice ? "Invoice" : null, missingPackingList ? "PackingList" : null].filter(Boolean).join(", ");
    incidents.push({
      id: stableId("INC", `${tradeCase.id}:missingDocument:${missing}`),
      type: "missingDocument",
      severity: "medium",
      confidence: 0.85,
      status: "open",
      summary: `必要書類が不足（${missing}）。再送依頼が必要。`,
      detectedAt: nowIso(),
      details: { missingInvoice, missingPackingList },
    });
  }

  return incidents;
}

export function proposeActions(tradeCase: TradeCase, incidents: Incident[]): ActionProposal[] {
  const actions: ActionProposal[] = [];

  for (const incident of incidents) {
    if (!incident) continue;

    if (incident.type === "invoiceQuantityMismatch") {
      actions.push({
        id: stableId("ACT", `${tradeCase.id}:${incident.id}:confirmQuantity`),
        type: "confirmQuantity",
        priority: "high",
        status: "proposed",
        approvalStatus: "pendingApproval",
        title: "仕入先へ残数量と出荷予定を確認",
        description: "SI数量に対してINV数量が不足。分納か、追加INV/PLが必要か確認する。",
        target: "supplier",
        message: "SIは指図済みですが、INV数量が不足しています。残数量の出荷予定と追加INV/PLの発行可否をご確認ください。",
        rationale: "数量差異は出荷・通関・納期に直結するため、早期に事実確認が必要。",
        confidence: incident.confidence ?? 0.8,
      });
      continue;
    }

    if (incident.type === "etaChanged") {
      actions.push({
        id: stableId("ACT", `${tradeCase.id}:${incident.id}:followUpForwarder`),
        type: "followUpForwarder",
        priority: "medium",
        status: "proposed",
        approvalStatus: "pendingApproval",
        title: "Forwarder に最新ETAと遅延理由を確認",
        description: "ETA変更の影響を把握し、必要なら顧客連絡/納期調整を行う。",
        target: "forwarder",
        message: "最新ETAと遅延理由（港混雑/ロール等）をご共有ください。追加費用の見込みがあれば併せて教えてください。",
        rationale: "遅延原因と新ETAが分かると、顧客連絡や費用リスクの先回りができる。",
        confidence: incident.confidence ?? 0.7,
      });
      continue;
    }

    if (incident.type === "missingDocument") {
      actions.push({
        id: stableId("ACT", `${tradeCase.id}:${incident.id}:requestDocument`),
        type: "requestDocument",
        priority: "medium",
        status: "proposed",
        approvalStatus: "pendingApproval",
        title: "仕入先へ不足書類の再送を依頼",
        description: "Invoice / PackingList の不足により手続きが止まるため、再送依頼を行う。",
        target: "supplier",
        message: "Invoice / PackingList が未受領です。お手数ですが再送をお願いします。",
        rationale: "書類不足は出荷・通関のボトルネックになりやすい。",
        confidence: incident.confidence ?? 0.7,
      });
      continue;
    }
  }

  return actions;
}

export function approveProposal(proposalId: string): ActionProposal {
  return {
    id: proposalId,
    type: "other",
    priority: "medium",
    status: "approved",
    approvalStatus: "approved",
    title: "Approved",
    description: "Approved (mock)",
  };
}


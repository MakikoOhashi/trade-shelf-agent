import type { ActionProposal, ImpactAnalysis, Incident, TradeCase, TradeDocument } from "./domain";

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

export function analyzeImpact(tradeCase: TradeCase, incident: Incident): ImpactAnalysis | null {
  if (!tradeCase || !incident) return null;

  if (incident.type !== "invoiceQuantityMismatch") return null;

  const siQuantity = typeof incident.details?.siQuantity === "number" ? incident.details.siQuantity : tradeCase.products?.[0]?.quantityInstructed;
  const invoiceQuantity =
    typeof incident.details?.invoiceQuantity === "number" ? incident.details.invoiceQuantity : tradeCase.products?.[0]?.quantityInvoiced;

  const product = tradeCase.products?.[0];
  const affectedProducts = [
    {
      productId: product?.id || "unknown",
      sku: product?.sku,
      name: product?.name,
      siQty: typeof siQuantity === "number" ? siQuantity : undefined,
      invoiceQty: typeof invoiceQuantity === "number" ? invoiceQuantity : undefined,
      shortageQty:
        typeof siQuantity === "number" && typeof invoiceQuantity === "number" ? Math.max(0, siQuantity - invoiceQuantity) : undefined,
    },
  ];

  // Case1 (TC-2026-0001): mock impact analysis with fixed numbers for the demo.
  const isCase1 = tradeCase.id === "TC-2026-0001" || (siQuantity === 1000 && invoiceQuantity === 400);
  if (isCase1) {
    return {
      incidentId: incident.id,
      affectedProducts: [
        {
          ...affectedProducts[0],
          currentStock: 200,
          allocatedQty: 150,
          availableQty: 50,
          shortageQty: 600,
        },
      ],
      shortageQty: 600,
      currentStock: 200,
      allocatedQty: 150,
      availableQty: 50,
      nextShipmentQty: 600,
      nextShipmentEta: "2026-05-12",
      canCoverByNextShipment: true,
      customerImpact: "残数量(600pcs)が現状在庫では賄えない。次便(2026-05-12)でカバー可能だが、顧客納期の影響有無を確認する必要がある。",
      deliveryRisk: "medium",
      recommendedDecision: "分納として記録し、残600pcsを次便に紐付ける。顧客納期への影響を確認する。",
      decisionOptions: [
        {
          id: "recordPartialAndLinkNextShipment",
          title: "分納として記録し次便に紐付け",
          summary: "不足600pcsを次便(600pcs, ETA 2026-05-12)へ割当て、顧客納期への影響を確認する。",
          pros: ["見通しを即時に可視化できる", "次便で数量が揃う前提なら追加手配が不要"],
          cons: ["顧客納期に影響する可能性がある", "次便遅延時に影響が顕在化する"],
          requiredActions: ["仕入先へ分納/次便の確定を確認", "顧客納期影響の確認（必要なら連絡）"],
        },
        {
          id: "requestAdditionalInvoice",
          title: "追加INV/PLの発行を依頼",
          summary: "残600pcsの追加INV/PL発行と出荷スケジュールを仕入先に確認する。",
          pros: ["書類起点で数量の整合が取りやすい"],
          cons: ["発行・送付待ちでタイムラグが出る可能性"],
          requiredActions: ["追加INV/PL発行可否の確認", "発行予定日の確定"],
        },
        {
          id: "escalateDeliveryRisk",
          title: "納期リスクとして社内エスカレーション",
          summary: "顧客納期がタイトな場合、優先対応や代替案（在庫融通等）の検討を開始する。",
          pros: ["遅延前に社内合意形成ができる"],
          cons: ["検討コストが増える可能性"],
          requiredActions: ["顧客要求納期の再確認", "代替在庫/優先出荷の可否検討"],
        },
      ],
    };
  }

  const shortageQty =
    typeof siQuantity === "number" && typeof invoiceQuantity === "number" ? Math.max(0, siQuantity - invoiceQuantity) : 0;
  return {
    incidentId: incident.id,
    affectedProducts,
    shortageQty,
    currentStock: 0,
    allocatedQty: 0,
    availableQty: 0,
    nextShipmentQty: 0,
    nextShipmentEta: "",
    canCoverByNextShipment: false,
    customerImpact: "数量差異を検知。在庫/次便情報が未連携のため、影響は未算出（mock）。",
    deliveryRisk: "medium",
    recommendedDecision: "分納/次便の見込みを確認し、顧客納期影響を評価する。",
    decisionOptions: [
      {
        id: "confirmFacts",
        title: "事実確認（数量・出荷予定）",
        summary: "SI/INV差異の原因（分納・誤記・追加書類）を確認し、次便/納期へ反映する。",
      },
    ],
  };
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

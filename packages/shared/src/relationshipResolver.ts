import type { TradeCase } from "./domain";

export type OperationalContextResolution = {
  invoice?: string;
  shipment?: string;
  si?: string;
  plStatus?: "missing" | "received" | "unknown";
  tradeCaseId?: string;
  relatedDocuments?: Array<{ id: string; label: string; status?: string; note?: string }>;
};

export function resolveOperationalContext(params: {
  entityType: "Document" | "Shipment" | "SI";
  entityId: string;
  tradeCases: TradeCase[];
}): OperationalContextResolution | null {
  const entityType = params.entityType;
  const entityId = String(params.entityId || "").trim().toUpperCase();
  const tradeCases = Array.isArray(params.tradeCases) ? params.tradeCases.filter(Boolean) : [];
  if (!entityId || !tradeCases.length) return null;

  const normalizeInv = (raw: string) => {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return "";
    const m = s.match(/\bINV[-\s]?(\d{1,8})\b/i);
    return m ? `INV-${m[1]}` : s;
  };

  const invNo = entityType === "Document" ? normalizeInv(entityId) : "";

  const matched = (() => {
    if (entityType === "Shipment") {
      return tradeCases.find((tc) => String(tc?.shipmentEntity?.id || "").toUpperCase() === entityId) || null;
    }
    if (entityType === "SI") {
      return (
        tradeCases.find((tc) => String(tc?.siEntity?.siNo || "").toUpperCase() === entityId) ||
        tradeCases.find((tc) => Array.isArray(tc?.siNumbers) && tc.siNumbers.map((x) => String(x).toUpperCase()).includes(entityId)) ||
        null
      );
    }
    // Document (INV) -> Shipment slice
    if (invNo) {
      const byShipmentInvoices =
        tradeCases.find((tc) => {
          const sh = tc?.shipmentEntity;
          const invs = [...(sh?.supplierInvoices || []), ...(sh?.switchInvoices || [])].map(normalizeInv).filter(Boolean);
          return invs.includes(invNo);
        }) || null;
      if (byShipmentInvoices) return byShipmentInvoices;

      const byInvoiceRefs =
        tradeCases.find((tc) => {
          const invs = Array.isArray(tc?.invoiceNumbers) ? tc.invoiceNumbers : [];
          return invs.map((x) => normalizeInv(x?.invoiceNo || "")).includes(invNo);
        }) || null;
      return byInvoiceRefs;
    }
    return null;
  })();

  if (!matched) return null;

  const shipmentId = String(matched?.shipmentEntity?.id || "").trim() || (Array.isArray(matched?.shipmentRefs) ? String(matched.shipmentRefs[0] || "") : "");
  const siNo =
    String(matched?.siEntity?.siNo || "").trim() ||
    (Array.isArray(matched?.siNumbers) ? String(matched.siNumbers[0] || "") : "");

  const plStatus: OperationalContextResolution["plStatus"] = (() => {
    const docs = matched?.caseProgress?.documents;
    if (Array.isArray(docs)) {
      const pl = docs.find((d) => String(d?.id || "").toLowerCase() === "pl" || String(d?.label || "").toUpperCase() === "PL");
      const st = String(pl?.status || "").trim().toLowerCase();
      if (st === "missing") return "missing";
      if (st === "done") return "received";
      if (st) return "unknown";
    }

    const docList = Array.isArray(matched?.documents) ? matched.documents : [];
    const hasPackingList = docList.some((d) => String(d?.type || "") === "PackingList");
    if (!hasPackingList) return "unknown";
    const received = docList.some((d) => String(d?.type || "") === "PackingList" && Boolean(d?.receivedAt));
    return received ? "received" : "missing";
  })();

  const relatedDocuments = Array.isArray(matched?.caseProgress?.documents)
    ? matched.caseProgress.documents
        .map((d) => ({
          id: String(d?.id || "").trim(),
          label: String(d?.label || "").trim(),
          status: d?.status ? String(d.status) : undefined,
          note: d?.note ? String(d.note) : undefined,
        }))
        .filter((d) => d.id || d.label)
    : undefined;

  return {
    invoice: invNo || undefined,
    shipment: shipmentId || undefined,
    si: siNo ? siNo.toUpperCase() : undefined,
    plStatus,
    tradeCaseId: String(matched.id || "").trim() || undefined,
    relatedDocuments,
  };
}


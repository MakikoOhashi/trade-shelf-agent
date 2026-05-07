export type TradeType = "import" | "triangular";

export type ShipmentState =
  | "notArranged"
  | "bookingRequested"
  | "shippingPending"
  | "shipped"
  | "inTransit"
  | "arrived"
  | "customsCleared"
  | "delivered"
  | "completed";

export type TradeDocumentType =
  | "SI"
  | "Invoice"
  | "PackingList"
  | "BL"
  | "ArrivalNotice"
  | "ForwarderMail"
  | "Other";

export type TradeDocument = {
  id: string;
  type: TradeDocumentType;
  title: string;
  source: "supplier" | "forwarder" | "customer" | "internal" | "unknown";
  issuedAt?: string;
  receivedAt?: string;
  fileName?: string;
  url?: string;
  summary?: string;
  extracted?: {
    invoiceQuantity?: number;
    siQuantity?: number;
    eta?: string;
    etd?: string;
    vessel?: string;
    voyage?: string;
    blNumber?: string;
  };
};

export type IncidentType =
  | "invoiceQuantityMismatch"
  | "missingDocument"
  | "delayedShipment"
  | "etaChanged"
  | "supplierNoResponse"
  | "partialShipment"
  | "marginRisk"
  | "duplicateCase"
  | "staleCase";

export type Incident = {
  id: string;
  type: IncidentType;
  severity: "low" | "medium" | "high";
  status: "open" | "inProgress" | "resolved";
  summary: string;
  detectedAt: string;
  relatedDocumentIds?: string[];
  details?: Record<string, string | number | boolean | null>;
};

export type SupplierBehavior =
  | "frequentDelay"
  | "frequentPartialInvoice"
  | "slowReply"
  | "documentErrorProne"
  | "stable"
  | "highRisk";

export type MarginRisk =
  | "costIncrease"
  | "freightIncrease"
  | "exchangeRateImpact"
  | "quantityShortage"
  | "discountRequest"
  | "unexpectedCharge";

export type TimelineEvent = {
  id: string;
  at: string;
  type:
    | "caseCreated"
    | "statusChanged"
    | "documentReceived"
    | "incidentDetected"
    | "emailReceived"
    | "note";
  message: string;
  shipmentState?: ShipmentState;
  relatedDocumentId?: string;
  relatedIncidentId?: string;
};

export type ActionProposal = {
  id: string;
  type:
    | "requestDocument"
    | "confirmQuantity"
    | "followUpSupplier"
    | "followUpForwarder"
    | "updateEta"
    | "reviewMargin"
    | "other";
  priority: "low" | "medium" | "high";
  status: "proposed" | "approved" | "done" | "dismissed";
  title: string;
  description: string;
  dueBy?: string;
  suggestedMessage?: string;
};

export type Party = {
  id: string;
  name: string;
  country?: string;
  contactEmail?: string;
};

export type TradeProduct = {
  id: string;
  name: string;
  sku?: string;
  quantityOrdered: number;
  quantityInstructed?: number;
  quantityInvoiced?: number;
  unitPrice?: number;
  currency?: "USD" | "JPY" | "CNY" | "EUR" | "GBP" | "Other";
};

export type TradeCase = {
  id: string;
  title: string;
  tradeType: TradeType;
  supplier: Party;
  customer: Party;
  products: TradeProduct[];
  documents: TradeDocument[];
  shipmentState: ShipmentState;
  incidents: Incident[];
  timeline: TimelineEvent[];
  nextActions: ActionProposal[];
  updatedAt: string;
  createdAt?: string;
  supplierBehaviorHints?: SupplierBehavior[];
  marginRiskHints?: MarginRisk[];
};

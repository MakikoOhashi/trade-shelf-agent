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

export type MovementStage =
  | "notArranged"
  | "preparingShipment"
  | "readyToShip"
  | "exportCustoms"
  | "inTransit"
  | "importCustoms"
  | "waitingWarehouseReceipt"
  | "warehouseReceived"
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

export type IncidentSeverity = "low" | "medium" | "high" | "critical";

export type IncidentConfidence = number; // 0.0 - 1.0

export type Incident = {
  id: string;
  type: IncidentType;
  severity: IncidentSeverity;
  status: "open" | "inProgress" | "resolved";
  summary: string;
  detectedAt: string;
  confidence?: IncidentConfidence;
  relatedDocumentIds?: string[];
  details?: Record<string, string | number | boolean | null>;
};

export type DeliveryRisk = "low" | "medium" | "high";

export type ProductAllocation = {
  productId: string;
  sku?: string;
  name?: string;
  siQty?: number;
  invoiceQty?: number;
  shortageQty?: number;
  currentStock?: number;
  allocatedQty?: number;
  availableQty?: number;
};

export type NextShipmentPlan = {
  qty: number;
  eta: string; // ISO date (YYYY-MM-DD) or ISO datetime
  note?: string;
};

export type InventorySnapshot = {
  sku: string;
  productName: string;
  onHandQty: number;
  allocatedQty: number;
  availableQty: number;
  warehouse?: string;
  updatedAt: string;
};

export type SalesCommitment = {
  id: string;
  customerName: string;
  sku: string;
  committedQty: number;
  requestedDeliveryDate: string;
  priority: "low" | "medium" | "high";
  impactNote?: string;
};

export type InboundPlan = {
  id: string;
  sku: string;
  qty: number;
  eta: string;
  status: "planned" | "booked" | "shipped" | "customs" | "warehousePending";
  relatedSiNo?: string;
  relatedInvoiceNo?: string;
  relatedBlNo?: string;
};

export type SimilarPastCase = {
  id: string;
  title: string;
  similarity: number;
  issue: string;
  decisionTaken: string;
  outcome: string;
};

export type StakeholderResponse = {
  id: string;
  salesRep: string;
  customer: string;
  responseStatus: string;
  requestedAction: string;
  deadline: string;
  escalationRule: string;
  note?: string;
  /**
   * AI summary comment generated from Teams/email threads (future).
   * Display alongside stakeholder response for quick triage.
   */
  aiComment?: string;
};

export type DocumentStatus = {
  id: string;
  docType: "SI" | "INV" | "PL" | "BL";
  status: "missing" | "received";
  riskNote?: string;
};

export type ResolutionStepStatus =
  | "notStarted"
  | "waiting"
  | "confirmed"
  | "blocked"
  | "skipped"
  | "escalated";

export type ResolutionStep = {
  id: string;
  label: string;
  ownerType: "supplier" | "forwarder" | "sales" | "warehouse" | "internal";
  ownerName?: string;
  status: ResolutionStepStatus;
  question: string;
  expectedAnswer?: string;
  receivedAnswer?: string;
  dueAt?: string;
  blockingDecision: boolean;
  nextIfConfirmed?: string;
  nextIfRejected?: string;
  nextIfNoReply?: string;
};

export type ResolutionWorkflow = {
  caseId: string;
  incidentId?: string;
  currentStepId: string;
  steps: ResolutionStep[];
  fallbackRoute?: {
    triggerCondition: string;
    suggestedAction: string;
    escalationTarget?: string;
  };
};

export type ProgressStatus =
  | "done"
  | "waiting"
  | "missing"
  | "blocked"
  | "inProgress"
  | "notStarted"
  | "needsFix";

export type ProgressItem = {
  id: string;
  label: string;
  status: ProgressStatus;
  note?: string;
  blocking?: boolean;
  updatedAt?: string;
};

export type CaseProgress = {
  caseId: string;
  overallPercent: number;
  currentStatusLabel: string;
  blockingSummary: string[];
  documents: ProgressItem[];
  bookingSchedule: ProgressItem[];
  resolution: ProgressItem[];
};

export type DecisionContext = {
  caseId: string;
  inventory: InventorySnapshot[];
  salesCommitments: SalesCommitment[];
  inboundPlans: InboundPlan[];
  similarPastCases: SimilarPastCase[];
  stakeholderResponses?: StakeholderResponse[];
  documentStatus?: DocumentStatus[];
  resolutionWorkflow?: ResolutionWorkflow;
  supplierReliability?: {
    supplierName: string;
    onTimeRate: number;
    documentDelayRate: number;
    commonIssues: string[];
  };
  agentRecommendation: {
    summary: string;
    reasoning: string[];
    suggestedActionType:
      | "markAsPartialShipment"
      | "linkToNextShipment"
      | "requestConfirmation"
      | "escalate"
      | "hold";
    confidence: number;
  };
};

export type DecisionOption = {
  id: string;
  title: string;
  summary: string;
  pros?: string[];
  cons?: string[];
  requiredActions?: string[];
};

export type ImpactAnalysis = {
  incidentId: string;
  affectedProducts: ProductAllocation[];
  shortageQty: number;
  currentStock: number;
  allocatedQty: number;
  availableQty: number;
  nextShipmentQty: number;
  nextShipmentEta: string;
  canCoverByNextShipment: boolean;
  customerImpact: string;
  deliveryRisk: DeliveryRisk;
  recommendedDecision: string;
  decisionOptions: DecisionOption[];
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
    | "note"
    | "humanIntervention";
  message: string;
  shipmentState?: ShipmentState;
  relatedDocumentId?: string;
  relatedIncidentId?: string;
  actor?: string;
  actionType?: string;
  label?: string;
  note?: string;
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
  approvalStatus?: ActionProposalStatus;
  title: string;
  description: string;
  target?: "supplier" | "forwarder" | "customer" | "internal" | "unknown";
  message?: string;
  rationale?: string;
  confidence?: IncidentConfidence;
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
  caseProgress?: CaseProgress;
  decisionContext?: DecisionContext;
  /**
   * Operations graph refs (View Lens 用)
   * - SI / Invoice / BL / Shipment / Supplier などの識別子で同じ業務データを再構成する。
   */
  siNumbers?: string[];
  invoiceNumbers?: InvoiceRef[];
  blNumbers?: string[];
  shipmentRefs?: string[];
  supplierIds?: string[];
  products: TradeProduct[];
  documents: TradeDocument[];
  shipmentState: ShipmentState;
  movementStage?: MovementStage;
  incidents: Incident[];
  timeline: TimelineEvent[];
  nextActions: ActionProposal[];
  updatedAt: string;
  createdAt?: string;
  supplierBehaviorHints?: SupplierBehavior[];
  marginRiskHints?: MarginRisk[];
};

export type InvoiceRefType = "supplierInvoice" | "switchInvoice";

export type InvoiceRef =
  | {
      invoiceNo: string;
      type: "supplierInvoice";
      supplier: string;
      qty?: number;
      relatedSiNo?: string;
    }
  | {
      invoiceNo: string;
      type: "switchInvoice";
      issuer: string;
      customer: string;
      qty?: number;
      relatedSiNo?: string;
    };

export type HumanInterventionType =
  | "approve"
  | "reject"
  | "correct"
  | "replaceDocument"
  | "markAsPartialShipment"
  | "linkToNextShipment"
  | "markAsNoIssue"
  | "escalate"
  | "requestConfirmation"
  | "startSalesCheck"
  | "considerAirSwitch"
  | "hold";

export type HumanIntervention = {
  id: string;
  type: HumanInterventionType;
  incidentId: string;
  note: string;
  createdBy: "user";
  createdAt: string;
};

export type ActionProposalStatus =
  | "draft"
  | "pendingApproval"
  | "approved"
  | "rejected"
  | "executed";

export type IncidentLog = {
  id: string;
  caseId: string;
  incidentId: string;
  at: string;
  message: string;
  proposalId?: string;
  interventionId?: string;
};

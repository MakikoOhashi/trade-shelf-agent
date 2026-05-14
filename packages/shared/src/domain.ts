export type TradeType = "import" | "triangular";

export type OperationalEntityType = "case" | "shipment" | "si";

export type RawRequestSource =
  | "teams"
  | "web"
  | "email"
  | "manualMemo";

export type OperationalThreadMessageRole =
  | "requester"
  | "agent"
  | "system"
  | "external";

export type OperationalThreadEvidence = {
  label: string;
  type: "email" | "document" | "shipment" | "si" | "issue";
  refId?: string;
  url?: string;
};

export type OperationalThreadMessage = {
  id: string;
  role: OperationalThreadMessageRole;
  sender: string;
  text: string;
  createdAt: string;
  evidence?: OperationalThreadEvidence[];
  proposedAction?: {
    label: string;
    type:
      | "sendSupplierPush"
      | "createIssue"
      | "addCommentToIssue"
      | "draftTeamsReply";
    draftBody?: string;
  };
};

export type OperationalThreadCandidate = {
  id: string;
  title: string;
  status?: string;
  action?: string;
  tradeCaseId?: string;
  linkedShipmentId?: string;
  linkedSiNo?: string;
  linkedIssueId?: string;
  linkedCustomer?: string;
  messages?: OperationalThreadMessage[];
};

export type ShipmentEntity = {
  id: string;
  blNo?: string;
  bookingNo?: string;
  containerNo?: string;
  supplierInvoices?: string[];
  switchInvoices?: string[];
  eta?: string;
  shipmentState?: string;
};

export type SIEntity = {
  id: string;
  siNo: string;
  requestedDeliveryDate?: string;
  relatedShipmentIds?: string[];
  relatedInvoiceNos?: string[];
  salesOwners?: string[];
};

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

export type DecisionTreeNodeStatus =
  | "current"
  | "available"
  | "completed"
  | "blocked"
  | "notReached"
  | "skipped";

export type DecisionTreeBranch = {
  label: string;
  value: string;
  nextNodeId?: string;
  actionLabel: string;
  explanation?: string;
  requiredContext?: Array<
    | "documents"
    | "inventory"
    | "salesCommitments"
    | "inboundPlans"
    | "stakeholderResponses"
    | "supplierReliability"
    | "freightCost"
  >;
};

export type ResolutionDecisionTreeNode = {
  id: string;
  title: string;
  question: string;
  ownerType: "supplier" | "forwarder" | "sales" | "warehouse" | "internal";
  ownerName?: string;
  status: DecisionTreeNodeStatus;
  dueAt?: string;
  blockingDecision: boolean;
  receivedAnswer?: string;
  branches: DecisionTreeBranch[];
};

export type ResolutionDecisionTree = {
  caseId: string;
  incidentId?: string;
  currentNodeId: string;
  nodes: ResolutionDecisionTreeNode[];
  fallbackRoute?: {
    triggerCondition: string;
    suggestedAction: string;
    escalationTarget?: string;
  };
};

export type AgentRunStepStatus =
  | "detected"
  | "proposed"
  | "approved"
  | "sent"
  | "waitingReply"
  | "replyReceived"
  | "classified"
  | "completed"
  | "blocked"
  | "held";

export type AgentRunActionType =
  | "detectIncident"
  | "proposeSupplierConfirmation"
  | "sendSupplierEmail"
  | "classifySupplierReply"
  | "proposeSalesCheck"
  | "sendTeamsMessage"
  | "aggregateSalesResponses"
  | "proposeFinalDecision"
  | "humanApproval"
  | "hold"
  | "escalate";

export type AgentRunStep = {
  id: string;
  title: string;
  status: AgentRunStepStatus;
  actionType: AgentRunActionType;
  actor: "agent" | "human" | "supplier" | "sales" | "forwarder" | "system";
  summary: string;
  evidence?: string[];
  proposedMessage?: {
    channel: "email" | "teams";
    to: string[];
    subject?: string;
    body: string;
  };
  classification?: {
    label: string;
    confidence: number;
    reasoning?: string[];
  };
  requiresHumanApproval: boolean;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
};

export type ResolutionAgentRun = {
  id: string;
  caseId: string;
  incidentId?: string;
  currentStepId: string;
  status: "running" | "waitingHumanApproval" | "waitingExternalReply" | "completed" | "blocked";
  progressPercent: number;
  nextHumanAction?: {
    label: string;
    description: string;
    actionType: AgentRunActionType;
  };
  steps: AgentRunStep[];
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
  resolutionDecisionTree?: ResolutionDecisionTree;
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
  shipmentEntity?: ShipmentEntity;
  siEntity?: SIEntity;
  caseProgress?: CaseProgress;
  decisionContext?: DecisionContext;
  resolutionAgentRun?: ResolutionAgentRun;
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

  // 共通RawInputを定義

export type InputSource = "teams" | "email" | "attachment";

export type RawInputStatus =
  | "received"
  | "classified"
  | "linked"
  | "failed";

export type RawInput = {
  id: string;
  source: InputSource;
  receivedAt: string;
  senderName?: string;
  senderEmail?: string;
  channel?: string;
  subject?: string;
  rawText: string;
  attachmentNames?: string[];
  status: RawInputStatus;
};

// AI後の中間モデルを作る
export type OperationalThread = {
  id: string;
  rawInputId: string;
  title: string;
  intent:
    | "missing_document_check"
    | "eta_change"
    | "quantity_mismatch"
    | "shipment_status_check"
    | "air_change_check"
    | "unknown";
  summary: string;
  extractedEntities: {
    siIds?: string[];
    shipmentIds?: string[];
    invoiceIds?: string[];
    supplierNames?: string[];
    documentTypes?: string[];
  };
  confidence: number;
};

  // EntityLinkを作る
export type EntityType =
  | "SI"
  | "Shipment"
  | "Issue"
  | "Document"
  | "Supplier";


export type EntityLink = {
  id: string;
  threadId: string;
  entityType: EntityType;
  entityId: string;
  confidence: number;
  reason: string;
};

export type ActivityEventType =
  | "raw_input_received"
  | "classified"
  | "entity_linked"
  | "issue_updated"
  | "action_planned"
  | "approval_required"
  | "failed_processing";

export type ActivityEvent = {
  id: string;
  type: ActivityEventType;
  occurredAt: string;
  /**
   * Sort key for events that share the same occurredAt.
   * Smaller numbers appear first.
   */
  sequence?: number;
  title: string;
  description?: string;
  sourceRawInputId?: string;
  threadId?: string;
  linkedEntities?: EntityLink[];
  status: "ok" | "warning" | "failed";
  /**
   * UI display label (e.g. "mock ingest", "Kimi AI分類")
   */
  actor?: string;
};

export type IssueMutation = {
  issueId: string;
  action: "append_comment" | "create_issue_candidate" | "mark_approval_required";
  title: string;
  body: string;
  sourceRawInputId?: string;
  threadId?: string;
  linkedEntities?: EntityLink[];
  confidence?: number;
  sourceLabel?: string;
};

export type ActionType =
  | "human_review_only"
  | "email_required"
  | "teams_reply_required"
  | "supplier_confirmation_required"
  | "forwarder_confirmation_required"
  | "no_action";

export type ActionPlan = {
  id: string;
  sourceRawInputId: string;
  threadId: string;
  issueId?: string;
  actionTypes: ActionType[];
  title: string;
  description: string;
  confidence: number;
  linkedEntities?: EntityLink[];
  sourceLabel?: string;
  status: "planned" | "pending_approval" | "skipped";
};

export type MockIngestResult = {
  rawInput: RawInput;
  threads: OperationalThread[];
  links: EntityLink[];
  activityEvents: ActivityEvent[];
  issueMutations: IssueMutation[];
  actionPlans?: ActionPlan[];
};

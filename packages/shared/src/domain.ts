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

export type TradeCase = {
  id: string;
  title: string;
  supplier: string;
  shipmentState: ShipmentState;
  updatedAt: string;
};
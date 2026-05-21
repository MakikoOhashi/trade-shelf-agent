/**
 * Shelf mapping is UI-facing.
 *
 * Canonical shipment progress should be represented by shipmentEntity.shipmentState.
 * Shelf stages are a visual projection used by the bookshelf UI.
 *
 * State Transition Agent should update canonical shipment state,
 * not mutate shelf stage directly.
 */

export const SHELF_STAGE_IDS = {
  INSTRUCTION: "instruction",
  SUPPLIER_TO_PORT: "supplier_to_port",
  EXPORT_CUSTOMS: "export_customs",
  ON_BOARD: "on_board",
  IMPORT_CUSTOMS: "import_customs",
  WAREHOUSE_STOCKING: "warehouse_stocking",
};

export const SHELF_STAGES = [
  { id: SHELF_STAGE_IDS.INSTRUCTION, label: "出荷指図" },
  { id: SHELF_STAGE_IDS.SUPPLIER_TO_PORT, label: "仕入れ先出発〜仕入先港着" },
  { id: SHELF_STAGE_IDS.EXPORT_CUSTOMS, label: "輸出通関手続き" },
  { id: SHELF_STAGE_IDS.ON_BOARD, label: "船積輸送中（洋上）" },
  { id: SHELF_STAGE_IDS.IMPORT_CUSTOMS, label: "港着〜輸入通関手続き" },
  { id: SHELF_STAGE_IDS.WAREHOUSE_STOCKING, label: "営業倉庫へ輸送・在庫化" },
];

export function shipmentStageIndexFromState(shipmentState) {
  const s = String(shipmentState || "");
  if (s === "warehouseReceived" || s === "completed") return 5;
  if (s === "waitingWarehouseReceipt") return 5;
  if (s === "customsCleared" || s === "arrived" || s === "importCustoms") return 4;
  if (s === "inTransit") return 3;
  if (s === "exportCustoms") return 2;
  if (s === "shipped") return 1;
  return 0;
}

export function shelfStageIdFromShipmentState(shipmentState) {
  const s = String(shipmentState || "");
  if (s === "warehouseReceived" || s === "completed") return SHELF_STAGE_IDS.WAREHOUSE_STOCKING;
  if (s === "waitingWarehouseReceipt") return SHELF_STAGE_IDS.WAREHOUSE_STOCKING;
  if (s === "customsCleared" || s === "arrived" || s === "importCustoms") return SHELF_STAGE_IDS.IMPORT_CUSTOMS;
  if (s === "inTransit") return SHELF_STAGE_IDS.ON_BOARD;
  if (s === "exportCustoms") return SHELF_STAGE_IDS.EXPORT_CUSTOMS;
  if (s === "shipped") return SHELF_STAGE_IDS.SUPPLIER_TO_PORT;
  return SHELF_STAGE_IDS.INSTRUCTION;
}

export function getShelfStageById(stageId) {
  return SHELF_STAGES.find((stage) => stage.id === stageId) ?? SHELF_STAGES[0];
}

export function getShelfStageOrder(stageId) {
  const index = SHELF_STAGES.findIndex((stage) => stage.id === stageId);
  return index === -1 ? 0 : index;
}


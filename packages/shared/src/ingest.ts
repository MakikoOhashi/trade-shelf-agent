import type { RawInput, OperationalThread } from "./domain";

export function classifyRawInput(input: RawInput): OperationalThread[] {
  if (input.rawText.includes("PLまだ")) {
    return [
      {
        id: "thread-001",
        rawInputId: input.id,
        title: "PL未着確認",
        intent: "missing_document_check",
        summary: "PLの未着状況を確認する依頼",
        extractedEntities: {
          shipmentIds: ["SHP-2026-009"],
          documentTypes: ["PL"],
        },
        confidence: 0.82,
      },
      {
        id: "thread-002",
        rawInputId: input.id,
        title: "SI-224確認",
        intent: "shipment_status_check",
        summary: "SI-224の状況確認依頼",
        extractedEntities: {
          siIds: ["SI-2026-224"],
        },
        confidence: 0.74,
      },
    ];
  }

  return [
    {
      id: `thread-${input.id}`,
      rawInputId: input.id,
      title: "未分類依頼",
      intent: "unknown",
      summary: input.rawText,
      extractedEntities: {},
      confidence: 0.3,
    },
  ];
}
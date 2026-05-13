import type { RawInput } from "./domain";

export const mockRawInputs: RawInput[] = [
  {
    id: "raw-001",
    source: "teams",
    receivedAt: "2026-05-12T13:40:00Z",
    senderName: "営業A",
    channel: "Teams",
    rawText: "PLまだ？あとSI-224も確認して",
    status: "received",
  },
  {
    id: "raw-002",
    source: "email",
    receivedAt: "2026-05-12T16:18:00Z",
    senderName: "ACME Components",
    senderEmail: "sales@acme-components.example",
    subject: "Re: INV mismatch",
    rawText: "We will reissue the invoice today. Please find revised invoice attached.",
    attachmentNames: ["INV-1122-rev.pdf"],
    status: "received",
  },
];
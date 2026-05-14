// Generated from packages/shared/src/{mockTradeCases.ts,incident.ts,ingest.ts,mockInputs.ts}
// Run: (cd packages/shared && npm run build:web-vendor)


export const mockTradeCases = [
    {
        id: "TC-2026-0001",
        title: "【輸入】SI 1000pcs 指図済み / INV 400pcs のみ発行（数量差異）",
        tradeType: "import",
        siNumbers: ["SI-2026-001"],
        invoiceNumbers: [
            {
                invoiceNo: "INV-1122",
                type: "supplierInvoice",
                supplier: "ACME Components (Shenzhen)",
                qty: 400,
                relatedSiNo: "SI-2026-001",
            },
            {
                invoiceNo: "INV-1240",
                type: "supplierInvoice",
                supplier: "ACME Components (Shenzhen)",
                qty: 600,
                relatedSiNo: "SI-2026-001",
            },
        ],
        blNumbers: ["BL-SZX-7781"],
        shipmentRefs: ["SHP-2026-009"],
        shipmentEntity: {
            id: "SHP-2026-009",
            blNo: "BL-SZX-7781",
            bookingNo: "BK-88201",
            containerNo: "TCLU-998877",
            supplierInvoices: ["INV-1122", "INV-1240"],
            eta: "2026-05-12",
            shipmentState: "shippingPending",
        },
        siEntity: {
            id: "SIE-2026-001",
            siNo: "SI-2026-001",
            requestedDeliveryDate: "2026-05-15",
            relatedShipmentIds: ["SHP-2026-009"],
            relatedInvoiceNos: ["INV-1122", "INV-1240"],
            salesOwners: ["営業A", "営業B"],
        },
        supplierIds: ["SUP-ACME"],
        supplier: {
            id: "SUP-CHN-ACME",
            name: "ACME Components (Shenzhen)",
            country: "CN",
            contactEmail: "sales@acme-components.example",
        },
        customer: {
            id: "CUS-JP-KANSAI",
            name: "Kansai Trading Co., Ltd.",
            country: "JP",
            contactEmail: "procurement@kansai-trading.example",
        },
        caseProgress: {
            caseId: "TC-2026-0001",
            overallPercent: 42,
            currentStatusLabel: "仕入先回答待ち",
            blockingSummary: ["INV数量差異の理由未確認", "Packing List未着", "残600pcsの次便補充確定待ち"],
            documents: [
                { id: "si", label: "SI", status: "done", note: "1000pcs 指図済み" },
                { id: "inv", label: "INV", status: "needsFix", note: "400pcsのみ。SIとの差異あり", blocking: true },
                { id: "pl", label: "PL", status: "missing", note: "未着", blocking: true },
                { id: "dpl", label: "DPL", status: "inProgress", note: "修正中 / 受領待ち" },
                { id: "bl", label: "BL", status: "missing", note: "未着" },
            ],
            bookingSchedule: [
                { id: "booking", label: "Booking", status: "done", note: "booking済み" },
                { id: "etd", label: "ETD", status: "done", note: "2026-05-08" },
                { id: "eta", label: "ETA", status: "done", note: "2026-05-12" },
                { id: "vessel", label: "Vessel", status: "waiting", note: "船名確認待ち" },
            ],
            resolution: [
                { id: "supplier-check", label: "Supplier check", status: "waiting", note: "数量差異理由の回答待ち", blocking: true },
                { id: "next-shipment", label: "Next shipment", status: "waiting", note: "残600pcs補充可否確認待ち", blocking: true },
                { id: "sales-check", label: "Sales check", status: "notStarted", note: "必要に応じて並行開始" },
                { id: "final-decision", label: "Final decision", status: "notStarted", note: "未決定" },
            ],
        },
        decisionContext: {
            caseId: "TC-2026-0001",
            inventory: [
                {
                    sku: "UC-1M-BK",
                    productName: "USB-C Cable 1m (Black)",
                    onHandQty: 200,
                    allocatedQty: 150,
                    availableQty: 50,
                    warehouse: "JP-Tokyo-01",
                    updatedAt: "2026-05-08T01:00:00.000Z",
                },
            ],
            salesCommitments: [
                {
                    id: "SC-2026-0001",
                    customerName: "Customer A",
                    sku: "UC-1M-BK",
                    committedQty: 700,
                    requestedDeliveryDate: "2026-05-15",
                    priority: "high",
                    impactNote: "顧客A向け売約。欠品時は納期遅延ペナルティの可能性あり。",
                },
            ],
            inboundPlans: [
                {
                    id: "INB-2026-0001",
                    sku: "UC-1M-BK",
                    qty: 600,
                    eta: "2026-05-12",
                    status: "booked",
                    relatedSiNo: "SI-2026-001",
                },
            ],
            similarPastCases: [
                {
                    id: "HIS-2025-0412",
                    title: "同一仕入先で INV 分納 → 次便で吸収し納期影響なし",
                    similarity: 0.86,
                    issue: "SI 数量に対し INV が分納（部分数量）のみ先行発行",
                    decisionTaken: "分納として記録し、残数量を次便の出荷に紐づけ",
                    outcome: "次便到着後に不足を吸収し、顧客納期は維持できた",
                },
            ],
            supplierReliability: {
                supplierName: "ACME Components (Shenzhen)",
                onTimeRate: 0.82,
                documentDelayRate: 0.28,
                commonIssues: ["分納INV", "Packing List遅延"],
            },
            stakeholderResponses: [
                {
                    id: "STK-2026-0001-A",
                    salesRep: "営業A",
                    customer: "Customer A",
                    responseStatus: "NG",
                    requestedAction: "AIR希望",
                    deadline: "2026-05-12 15:00",
                    escalationRule: "期限までに代替案が確定しない場合は部長承認へエスカレーション",
                    note: "顧客側イベントがあり納期厳守",
                    aiComment: "顧客側イベントがあり納期厳守。AIR切替または優先出荷の検討が必要。",
                },
                {
                    id: "STK-2026-0001-B",
                    salesRep: "営業B",
                    customer: "Customer A",
                    responseStatus: "OK",
                    requestedAction: "SEA継続",
                    deadline: "2026-05-12 15:00",
                    escalationRule: "期限まで未確定の場合は標準案（SEA）で確定し通知",
                    note: "5/27まで許容",
                },
                {
                    id: "STK-2026-0001-C",
                    salesRep: "営業C",
                    customer: "Customer A",
                    responseStatus: "確認中",
                    requestedAction: "要確認",
                    deadline: "2026-05-12 15:00",
                    escalationRule: "期限24時間前に自動リマインド、期限超過で上長CC",
                },
                {
                    id: "STK-2026-0001-D",
                    salesRep: "営業D",
                    customer: "Customer A",
                    responseStatus: "未返信",
                    requestedAction: "要返信",
                    deadline: "2026-05-12 15:00",
                    escalationRule: "期限48時間前/24時間前で段階リマインド。期限超過で上長へ通知",
                },
            ],
            documentStatus: [
                { id: "DOCSTAT-2026-0001-SI", docType: "SI", status: "received" },
                { id: "DOCSTAT-2026-0001-INV", docType: "INV", status: "received" },
                { id: "DOCSTAT-2026-0001-PL", docType: "PL", status: "missing", riskNote: "PL遅延でブッキング/通関が遅れる可能性" },
                { id: "DOCSTAT-2026-0001-BL", docType: "BL", status: "missing", riskNote: "B/L未着で輸送確定・通関手配が遅延" },
            ],
            resolutionWorkflow: {
                caseId: "TC-2026-0001",
                incidentId: "INC-0001",
                currentStepId: "rs-1",
                steps: [
                    {
                        id: "rs-1",
                        label: "仕入先に数量差異の理由を確認",
                        ownerType: "supplier",
                        status: "waiting",
                        question: "INV 400pcs は書類上のミスですか？それとも生産ショート/分納ですか？",
                        expectedAnswer: "書類ミス / 分納 / 生産ショート / 補充不可 のいずれか",
                        dueAt: "2026-05-09 12:00",
                        blockingDecision: true,
                        nextIfConfirmed: "分納または生産ショートの場合、次便補充可否を確認",
                        nextIfNoReply: "船積み・納期影響が進む場合は営業へ影響確認を開始",
                    },
                    {
                        id: "rs-2",
                        label: "次便補充可否を確認",
                        ownerType: "supplier",
                        status: "notStarted",
                        question: "残600pcsを次便で補充できますか？ETAは2026-05-12で確定ですか？",
                        blockingDecision: true,
                    },
                    {
                        id: "rs-3",
                        label: "書類再発行可否を確認",
                        ownerType: "supplier",
                        status: "notStarted",
                        question: "追加INV/PLをいつ発行できますか？",
                        blockingDecision: true,
                    },
                    {
                        id: "rs-4",
                        label: "営業へ納期影響確認",
                        ownerType: "sales",
                        status: "notStarted",
                        question: "顧客納期に対して、遅延許容/AIR希望/分納許容の確認をお願いします",
                        blockingDecision: false,
                    },
                    {
                        id: "rs-5",
                        label: "最終対応方針を決定",
                        ownerType: "internal",
                        status: "notStarted",
                        question: "分納・次便紐付け・AIR切替・エスカレーションのどれで進めるか",
                        blockingDecision: true,
                    },
                ],
                fallbackRoute: {
                    triggerCondition: "仕入先回答が期限までにない、かつ貨物/船積が進行している",
                    suggestedAction: "営業へ暫定影響確認を開始し、重要顧客はAIR切替可能性を確認。仕入先回答待ちを続けながら、納期リスクを先に潰す。",
                    escalationTarget: "Sales Manager / Operations Lead",
                },
            },
            resolutionDecisionTree: {
                caseId: "TC-2026-0001",
                incidentId: "INC-0001",
                currentNodeId: "confirm-invoice-gap-reason",
                nodes: [
                    {
                        id: "confirm-invoice-gap-reason",
                        title: "数量差異の理由確認",
                        question: "INV 400pcs は書類上のミスですか？",
                        ownerType: "supplier",
                        ownerName: "ACME Components (Shenzhen)",
                        status: "current",
                        dueAt: "2026-05-09 12:00",
                        blockingDecision: true,
                        branches: [
                            {
                                label: "YES",
                                value: "documentMistake",
                                actionLabel: "修正版INV/PL依頼へ進む",
                                explanation: "数量差異が書類ミスなら、正しい数量のINV/PLを再発行して通常進行へ戻す。",
                                nextNodeId: "request-corrected-documents",
                                requiredContext: ["documents"],
                            },
                            {
                                label: "NO",
                                value: "notDocumentMistake",
                                actionLabel: "生産ショート・分納確認へ進む",
                                explanation: "書類ミスでない場合、生産ショート・分納・納期遅延の可能性を確認する。",
                                nextNodeId: "confirm-short-or-split",
                                requiredContext: ["inboundPlans", "salesCommitments"],
                            },
                            {
                                label: "NO REPLY",
                                value: "noReply",
                                actionLabel: "暫定ルートへ進む",
                                explanation: "期限までに仕入先回答がない場合、貨物進行・顧客納期影響を優先して営業確認を並行開始する。",
                                nextNodeId: "start-provisional-sales-check",
                                requiredContext: ["stakeholderResponses", "salesCommitments"],
                            },
                        ],
                    },
                    {
                        id: "request-corrected-documents",
                        title: "修正版書類の依頼",
                        question: "修正版INV/PLはいつ発行できますか？",
                        ownerType: "supplier",
                        status: "available",
                        blockingDecision: true,
                        branches: [
                            {
                                label: "ISSUED",
                                value: "issued",
                                actionLabel: "通常進行へ戻す",
                                explanation: "修正版書類が揃ったら、書類不備を解消して通常進行へ戻す。",
                                requiredContext: ["documents"],
                            },
                            {
                                label: "DELAYED",
                                value: "delayed",
                                actionLabel: "通関リスクとしてエスカレーション",
                                explanation: "修正版書類が遅れる場合、通関・船積影響を確認する。",
                                requiredContext: ["documents"],
                            },
                        ],
                    },
                    {
                        id: "confirm-short-or-split",
                        title: "生産ショート・分納確認",
                        question: "残600pcsは生産ショートですか？それとも次便分納ですか？",
                        ownerType: "supplier",
                        status: "available",
                        blockingDecision: true,
                        branches: [
                            {
                                label: "分納",
                                value: "splitShipment",
                                actionLabel: "次便補充可否確認へ進む",
                                nextNodeId: "confirm-next-inbound",
                                explanation: "分納であれば、残数量が次便で確実に補充されるか確認する。",
                                requiredContext: ["inboundPlans"],
                            },
                            {
                                label: "生産ショート",
                                value: "productionShortage",
                                actionLabel: "補充不可リスクとして営業確認へ進む",
                                nextNodeId: "start-sales-impact-check",
                                explanation: "生産ショートの場合、売約・顧客納期・代替案の確認が必要。",
                                requiredContext: ["inventory", "salesCommitments", "stakeholderResponses"],
                            },
                        ],
                    },
                    {
                        id: "confirm-next-inbound",
                        title: "次便補充可否確認",
                        question: "残600pcsを次便で補充できますか？ETA 2026-05-12 は確定ですか？",
                        ownerType: "supplier",
                        status: "notReached",
                        blockingDecision: true,
                        branches: [
                            {
                                label: "可能",
                                value: "canCover",
                                actionLabel: "分納として記録し、次便へ紐づけ",
                                explanation: "次便で吸収可能なら、分納として記録し顧客納期への影響を確認する。",
                                requiredContext: ["inboundPlans", "salesCommitments"],
                            },
                            {
                                label: "不可",
                                value: "cannotCover",
                                actionLabel: "営業影響確認・AIR検討へ進む",
                                nextNodeId: "start-sales-impact-check",
                                explanation: "次便で吸収できない場合、営業・顧客影響の確認が必要。",
                                requiredContext: ["inventory", "salesCommitments", "stakeholderResponses"],
                            },
                        ],
                    },
                    {
                        id: "start-sales-impact-check",
                        title: "営業影響確認",
                        question: "顧客納期に対して、遅延許容・AIR希望・分納許容を確認しますか？",
                        ownerType: "sales",
                        status: "notReached",
                        blockingDecision: false,
                        branches: [
                            {
                                label: "開始",
                                value: "start",
                                actionLabel: "営業へTeams確認文を作成",
                                explanation: "影響営業へ納期影響確認を依頼する。",
                                requiredContext: ["stakeholderResponses", "salesCommitments"],
                            },
                        ],
                    },
                    {
                        id: "start-provisional-sales-check",
                        title: "暫定営業確認",
                        question: "仕入先回答待ちのまま、営業へ暫定確認を開始しますか？",
                        ownerType: "internal",
                        status: "available",
                        blockingDecision: false,
                        branches: [
                            {
                                label: "開始",
                                value: "startProvisional",
                                actionLabel: "未回答時の暫定ルートを開始",
                                explanation: "仕入先回答を待ちながら、重要顧客への影響を先に確認する。",
                                requiredContext: ["stakeholderResponses", "salesCommitments"],
                            },
                        ],
                    },
                ],
                fallbackRoute: {
                    triggerCondition: "仕入先回答が期限までにない、かつ貨物/船積が進行している",
                    suggestedAction: "営業へ暫定影響確認を開始し、重要顧客はAIR切替可能性を確認。仕入先回答待ちを続けながら、納期リスクを先に潰す。",
                    escalationTarget: "Sales Manager / Operations Lead",
                },
            },
            agentRecommendation: {
                summary: "現有効在庫50pcsでは不足するが、次便600pcsが2026-05-12に予定されているため、分納として記録し、残数量を次便に紐づけるのが妥当",
                reasoning: [
                    "有効在庫（available）50pcsでは売約700pcsに不足",
                    "次便600pcsが2026-05-12（booked）で到着見込み",
                    "過去に同一仕入先で INV 分納があり、次便で吸収して問題なく完了した事例がある",
                    "仕入先は onTimeRate 0.82 だが documentDelayRate 0.28 とやや高く、PL 遅延が起きやすい",
                ],
                suggestedActionType: "linkToNextShipment",
                confidence: 0.74,
            },
        },
        resolutionAgentRun: {
            id: "RUN-TC-2026-0001-001",
            caseId: "TC-2026-0001",
            currentStepId: "step-propose-supplier-confirmation",
            status: "waitingHumanApproval",
            progressPercent: 35,
            nextHumanAction: {
                label: "仕入先確認メールを承認",
                description: "AIが数量差異の確認メールを作成しました。送信してよいか確認してください。",
                actionType: "sendSupplierEmail",
            },
            steps: [
                {
                    id: "step-detect-incident",
                    title: "数量差異を検知",
                    status: "completed",
                    actionType: "detectIncident",
                    actor: "agent",
                    summary: "SI 1000pcs に対して INV 400pcs のみ発行されていることを検知。",
                    evidence: ["SI quantity: 1000pcs", "INV quantity: 400pcs", "shortage: 600pcs"],
                    requiresHumanApproval: false,
                    createdAt: "2026-05-08T10:00:00.000Z",
                },
                {
                    id: "step-propose-supplier-confirmation",
                    title: "仕入先確認メールを作成",
                    status: "proposed",
                    actionType: "sendSupplierEmail",
                    actor: "agent",
                    summary: "書類上のミスか、生産ショート/分納かを確認するメールを作成。",
                    proposedMessage: {
                        channel: "email",
                        to: ["ops@acme.example"],
                        subject: "Confirmation required: INV quantity mismatch for SI-2026-001",
                        body: "SI-2026-001 では 1000pcs を指図していますが、受領した INV-1122 は 400pcs のみです。これは書類上のミスでしょうか。それとも分納・生産ショートでしょうか。残600pcsの出荷予定と追加INV/PL発行予定もご確認ください。",
                    },
                    requiresHumanApproval: true,
                    createdAt: "2026-05-08T10:05:00.000Z",
                },
                {
                    id: "step-wait-supplier-reply",
                    title: "仕入先回答待ち",
                    status: "waitingReply",
                    actionType: "sendSupplierEmail",
                    actor: "supplier",
                    summary: "メール送信後、仕入先回答を待つ。",
                    requiresHumanApproval: false,
                    createdAt: "2026-05-08T10:10:00.000Z",
                },
                {
                    id: "step-classify-supplier-reply",
                    title: "仕入先回答を分類",
                    status: "held",
                    actionType: "classifySupplierReply",
                    actor: "agent",
                    summary: "回答本文から、書類ミス/分納/生産ショート/補充不可を分類する。",
                    classification: { label: "pending", confidence: 0 },
                    requiresHumanApproval: false,
                    createdAt: "2026-05-08T10:15:00.000Z",
                },
                {
                    id: "step-propose-sales-check",
                    title: "営業確認を提案",
                    status: "held",
                    actionType: "proposeSalesCheck",
                    actor: "agent",
                    summary: "生産ショートまたは納期影響がある場合、売約を照合して影響営業へ確認を提案する。",
                    requiresHumanApproval: true,
                    createdAt: "2026-05-08T10:20:00.000Z",
                },
                {
                    id: "step-aggregate-sales-responses",
                    title: "営業回答を集約",
                    status: "held",
                    actionType: "aggregateSalesResponses",
                    actor: "agent",
                    summary: "営業A/B/C/Dからの回答を集約し、AIR/SEA継続/分納許容を整理する。",
                    requiresHumanApproval: false,
                    createdAt: "2026-05-08T10:25:00.000Z",
                },
                {
                    id: "step-propose-final-decision",
                    title: "最終対応案を作成",
                    status: "held",
                    actionType: "proposeFinalDecision",
                    actor: "agent",
                    summary: "仕入先回答・売約・在庫・次便・営業回答をもとに最終対応案を作成する。",
                    requiresHumanApproval: true,
                    createdAt: "2026-05-08T10:30:00.000Z",
                },
            ],
        },
        products: [
            {
                id: "P-USB-CABLE-01",
                name: "USB-C Cable 1m (Black)",
                sku: "UC-1M-BK",
                quantityOrdered: 1000,
                quantityInstructed: 1000,
                quantityInvoiced: 400,
                unitPrice: 0.85,
                currency: "USD",
            },
        ],
        documents: [
            {
                id: "DOC-0001-SI",
                type: "SI",
                title: "Shipping Instruction (1000 pcs)",
                source: "internal",
                issuedAt: "2026-04-18T09:00:00.000Z",
                extracted: { siQuantity: 1000 },
            },
            {
                id: "DOC-0002-INV",
                type: "Invoice",
                title: "Commercial Invoice (400 pcs)",
                source: "supplier",
                issuedAt: "2026-04-20T03:10:00.000Z",
                receivedAt: "2026-04-20T04:05:00.000Z",
                extracted: { invoiceQuantity: 400 },
            },
        ],
        shipmentState: "shippingPending",
        incidents: [
            {
                id: "INC-0001",
                type: "invoiceQuantityMismatch",
                severity: "high",
                status: "open",
                summary: "SI(1000pcs)に対しINVが400pcs分のみ発行。残数量のINV/PL手配が必要。",
                detectedAt: "2026-04-20T04:10:00.000Z",
                relatedDocumentIds: ["DOC-0001-SI", "DOC-0002-INV"],
                details: { siQuantity: 1000, invoiceQuantity: 400 },
            },
            {
                id: "INC-0002",
                type: "missingDocument",
                severity: "medium",
                status: "open",
                summary: "PL/B/L 未着。出荷前の書類不足でステータスが止まっている可能性。",
                detectedAt: "2026-04-21T00:00:00.000Z",
            },
        ],
        timeline: [
            {
                id: "TL-0001",
                at: "2026-04-18T09:00:00.000Z",
                type: "documentReceived",
                message: "SI を作成（数量 1000pcs 指図）",
                relatedDocumentId: "DOC-0001-SI",
            },
            {
                id: "TL-0002",
                at: "2026-04-20T04:05:00.000Z",
                type: "documentReceived",
                message: "仕入先より INV 受領（400pcs）",
                relatedDocumentId: "DOC-0002-INV",
            },
            {
                id: "TL-0003",
                at: "2026-04-20T04:10:00.000Z",
                type: "incidentDetected",
                message: "INV 数量差異を検知（1000 → 400）",
                relatedIncidentId: "INC-0001",
            },
            {
                id: "TL-0004",
                at: "2026-04-21T00:00:00.000Z",
                type: "statusChanged",
                message: "出荷前（書類不足の可能性）",
                shipmentState: "shippingPending",
            },
        ],
        nextActions: [
            {
                id: "ACT-0001",
                type: "confirmQuantity",
                priority: "high",
                status: "proposed",
                title: "仕入先へ残数量(600pcs)のINV/PL発行可否を確認",
                description: "SI 1000pcs に対して INV 400pcs のみ。分納なのか、INVの再発行/追加発行が必要か確認する。",
                dueBy: "2026-05-08T03:00:00.000Z",
                suggestedMessage: "SIは1000pcsで指図済みですが、INVが400pcs分のみ発行されています。残り600pcsの出荷予定と、追加INV/PLの発行可否をご確認ください。",
            },
            {
                id: "ACT-0002",
                type: "requestDocument",
                priority: "medium",
                status: "proposed",
                title: "PL/B/L の見込みと発行予定日を確認",
                description: "出荷・通関の先読みのため、PL/B/L と ETA の確定状況を確認する。",
            },
        ],
        updatedAt: "2026-05-07T01:30:00.000Z",
        createdAt: "2026-04-18T08:55:00.000Z",
        supplierBehaviorHints: ["frequentPartialInvoice", "slowReply"],
        marginRiskHints: ["quantityShortage"],
    },
    {
        id: "TC-2026-0002",
        title: "【輸入】出荷済み / ETA 変更（Forwarder メールあり）",
        tradeType: "import",
        siNumbers: ["SI-2026-002"],
        invoiceNumbers: [
            {
                invoiceNo: "INV-2044",
                type: "supplierInvoice",
                supplier: "Orion Plastics (HCMC)",
                qty: 2000,
                relatedSiNo: "SI-2026-002",
            },
        ],
        blNumbers: ["BL-HCMC-3321"],
        shipmentRefs: ["SHP-2026-010"],
        supplierIds: ["SUP-ORION"],
        supplier: {
            id: "SUP-VNM-ORION",
            name: "Orion Plastics (HCMC)",
            country: "VN",
            contactEmail: "export@orion-plastics.example",
        },
        customer: {
            id: "CUS-JP-TOKYO",
            name: "Tokyo Retail Supplies",
            country: "JP",
            contactEmail: "logistics@tokyo-retail.example",
        },
        products: [
            {
                id: "P-TRAY-02",
                name: "Display Tray (Medium)",
                sku: "TR-MED",
                quantityOrdered: 2000,
                quantityInstructed: 2000,
                quantityInvoiced: 2000,
                unitPrice: 1.15,
                currency: "USD",
            },
        ],
        documents: [
            {
                id: "DOC-0100-INV",
                type: "Invoice",
                title: "Commercial Invoice (2000 pcs)",
                source: "supplier",
                issuedAt: "2026-04-22T03:00:00.000Z",
                receivedAt: "2026-04-22T04:00:00.000Z",
                extracted: { invoiceQuantity: 2000 },
            },
            {
                id: "DOC-0100-PL",
                type: "PackingList",
                title: "Packing List (2000 pcs)",
                source: "supplier",
                issuedAt: "2026-04-22T03:00:00.000Z",
                receivedAt: "2026-04-22T04:00:00.000Z",
            },
            {
                id: "DOC-0101-BL",
                type: "BL",
                title: "B/L (Original) - BL#VN12345678",
                source: "forwarder",
                receivedAt: "2026-04-28T10:20:00.000Z",
                extracted: { blNumber: "VN12345678", vessel: "NORTH STAR", voyage: "NS0426" },
            },
            {
                id: "DOC-0102-FWDMAIL",
                type: "ForwarderMail",
                title: "Forwarder Update: ETA Revised",
                source: "forwarder",
                receivedAt: "2026-05-02T02:15:00.000Z",
                summary: "Port congestion により ETA が 5/6 → 5/10 に変更。",
                extracted: { eta: "2026-05-10T00:00:00.000Z" },
            },
        ],
        shipmentState: "inTransit",
        incidents: [
            {
                id: "INC-0101",
                type: "etaChanged",
                severity: "medium",
                status: "open",
                summary: "Forwarder 連絡により ETA が変更。納期影響の確認が必要。",
                detectedAt: "2026-05-02T02:16:00.000Z",
                relatedDocumentIds: ["DOC-0102-FWDMAIL"],
            },
        ],
        timeline: [
            {
                id: "TL-0101-INVPL",
                at: "2026-04-22T04:00:00.000Z",
                type: "documentReceived",
                message: "INV/PL 受領（書類完備）",
                relatedDocumentId: "DOC-0100-INV",
            },
            {
                id: "TL-0101",
                at: "2026-04-27T06:00:00.000Z",
                type: "statusChanged",
                message: "出荷済み（船積完了）",
                shipmentState: "shipped",
            },
            {
                id: "TL-0102",
                at: "2026-04-28T10:20:00.000Z",
                type: "documentReceived",
                message: "Forwarder より B/L 受領",
                relatedDocumentId: "DOC-0101-BL",
            },
            {
                id: "TL-0103",
                at: "2026-05-02T02:15:00.000Z",
                type: "emailReceived",
                message: "Forwarder メール受領：ETA 改定",
                relatedDocumentId: "DOC-0102-FWDMAIL",
            },
            {
                id: "TL-0104",
                at: "2026-05-02T02:16:00.000Z",
                type: "incidentDetected",
                message: "ETA変更を検知（5/6 → 5/10）",
                relatedIncidentId: "INC-0101",
            },
            {
                id: "TL-0105",
                at: "2026-05-02T02:20:00.000Z",
                type: "statusChanged",
                message: "輸送中",
                shipmentState: "inTransit",
            },
        ],
        nextActions: [
            {
                id: "ACT-0101",
                type: "updateEta",
                priority: "high",
                status: "proposed",
                title: "顧客へ ETA 変更連絡（必要なら納期調整）",
                description: "ETA 変更に伴う納期影響を確認し、必要に応じて顧客へ連絡する。",
                suggestedMessage: "Forwarderより連絡があり、港混雑の影響でETAが 2026-05-10 に変更となりました。販売/納品計画への影響があれば調整します。",
            },
            {
                id: "ACT-0102",
                type: "followUpForwarder",
                priority: "medium",
                status: "proposed",
                title: "遅延要因と追加費用の有無をForwarderに確認",
                description: "混雑起因の場合、D/Dや保管費等の追加費用が出る可能性があるため確認する。",
            },
        ],
        updatedAt: "2026-05-07T01:30:00.000Z",
        supplierBehaviorHints: ["stable"],
        marginRiskHints: ["freightIncrease", "unexpectedCharge"],
    },
    {
        id: "TC-2026-0003",
        title: "【三国間】通関完了 / 書類完備 / 正常に完了間近",
        tradeType: "triangular",
        siNumbers: ["SI-2026-003"],
        invoiceNumbers: [
            {
                invoiceNo: "SUP-INV-501",
                type: "supplierInvoice",
                supplier: "Siam Tools Co., Ltd.",
                qty: 300,
                relatedSiNo: "SI-2026-003",
            },
            {
                invoiceNo: "SW-INV-901",
                type: "switchInvoice",
                issuer: "Our Company",
                customer: "West Coast Distribution Inc.",
                qty: 300,
                relatedSiNo: "SI-2026-003",
            },
        ],
        blNumbers: ["BL-TH-99887766"],
        shipmentRefs: ["SHP-2026-011"],
        supplierIds: ["SUP-SIAM"],
        supplier: {
            id: "SUP-TH-SIAM",
            name: "Siam Tools Co., Ltd.",
            country: "TH",
            contactEmail: "export@siam-tools.example",
        },
        customer: {
            id: "CUS-US-WEST",
            name: "West Coast Distribution Inc.",
            country: "US",
            contactEmail: "ops@westcoast-dist.example",
        },
        products: [
            {
                id: "P-TOOLKIT-07",
                name: "Hand Tool Kit (7pcs)",
                sku: "HTK-7",
                quantityOrdered: 300,
                quantityInstructed: 300,
                quantityInvoiced: 300,
                unitPrice: 18.4,
                currency: "USD",
            },
        ],
        documents: [
            {
                id: "DOC-0201-INV",
                type: "Invoice",
                title: "Commercial Invoice (300 sets)",
                source: "supplier",
                issuedAt: "2026-04-10T03:00:00.000Z",
                receivedAt: "2026-04-10T04:00:00.000Z",
                extracted: { invoiceQuantity: 300 },
            },
            {
                id: "DOC-0202-PL",
                type: "PackingList",
                title: "Packing List (300 sets)",
                source: "supplier",
                issuedAt: "2026-04-10T03:00:00.000Z",
                receivedAt: "2026-04-10T04:00:00.000Z",
            },
            {
                id: "DOC-0203-BL",
                type: "BL",
                title: "Sea Waybill - BL#TH99887766",
                source: "forwarder",
                receivedAt: "2026-04-12T08:30:00.000Z",
                extracted: { blNumber: "TH99887766", vessel: "EASTERN WIND", voyage: "EW0412" },
            },
            {
                id: "DOC-0204-AN",
                type: "ArrivalNotice",
                title: "Arrival Notice",
                source: "forwarder",
                receivedAt: "2026-04-26T01:10:00.000Z",
                extracted: { eta: "2026-04-26T00:00:00.000Z" },
            },
        ],
        shipmentState: "customsCleared",
        incidents: [],
        timeline: [
            {
                id: "TL-0201",
                at: "2026-04-10T04:00:00.000Z",
                type: "documentReceived",
                message: "INV/PL 受領（書類完備）",
                relatedDocumentId: "DOC-0201-INV",
            },
            {
                id: "TL-0202",
                at: "2026-04-12T08:30:00.000Z",
                type: "documentReceived",
                message: "B/L 受領",
                relatedDocumentId: "DOC-0203-BL",
            },
            {
                id: "TL-0203",
                at: "2026-04-26T01:10:00.000Z",
                type: "documentReceived",
                message: "Arrival Notice 受領",
                relatedDocumentId: "DOC-0204-AN",
            },
            {
                id: "TL-0204",
                at: "2026-04-26T02:00:00.000Z",
                type: "statusChanged",
                message: "入港",
                shipmentState: "arrived",
            },
            {
                id: "TL-0205",
                at: "2026-04-28T07:30:00.000Z",
                type: "statusChanged",
                message: "通関完了",
                shipmentState: "customsCleared",
            },
        ],
        nextActions: [
            {
                id: "ACT-0201",
                type: "other",
                priority: "low",
                status: "proposed",
                title: "最終納品確認・案件クローズ準備",
                description: "納品完了の確認後、案件を completed に更新する。",
            },
        ],
        updatedAt: "2026-05-06T23:30:00.000Z",
        supplierBehaviorHints: ["stable"],
    },
];


function nowIso() {
    return new Date().toISOString();
}
function stableId(prefix, seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}
function hasDocType(documents, type) {
    return documents.some((d) => d && d.type === type);
}
function pickQuantityFromDocs(documents, docType, key) {
    for (const d of documents) {
        if (!d || d.type !== docType)
            continue;
        const v = d.extracted && typeof d.extracted[key] === "number" ? d.extracted[key] : undefined;
        if (typeof v === "number")
            return v;
    }
    return undefined;
}
function detectEtaChangeSignal(tradeCase) {
    if (Array.isArray(tradeCase.incidents) && tradeCase.incidents.some((i) => i && i.type === "etaChanged"))
        return true;
    const docs = Array.isArray(tradeCase.documents) ? tradeCase.documents : [];
    for (const d of docs) {
        if (!d)
            continue;
        const t = `${d.title || ""}\n${d.summary || ""}`.toLowerCase();
        if (/(eta).*(revised|change|changed|変更|改定)/i.test(t))
            return true;
        if (/(revised|変更|改定).*(eta)/i.test(t))
            return true;
    }
    const timeline = Array.isArray(tradeCase.timeline) ? tradeCase.timeline : [];
    for (const e of timeline) {
        const t = String(e && e.message ? e.message : "");
        if (/ETA/.test(t) && /(変更|改定|revised|changed)/i.test(t))
            return true;
        if (/ETA\s*.*→/.test(t))
            return true;
    }
    return false;
}
export function detectIncidents(tradeCase) {
    const documents = Array.isArray(tradeCase.documents) ? tradeCase.documents : [];
    const incidents = [];
    const siQuantity = pickQuantityFromDocs(documents, "SI", "siQuantity") ?? tradeCase.products?.[0]?.quantityInstructed;
    const invoiceQuantity = pickQuantityFromDocs(documents, "Invoice", "invoiceQuantity") ?? tradeCase.products?.[0]?.quantityInvoiced;
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
export function proposeActions(tradeCase, incidents) {
    const actions = [];
    for (const incident of incidents) {
        if (!incident)
            continue;
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
export function analyzeImpact(tradeCase, incident) {
    if (!tradeCase || !incident)
        return null;
    if (incident.type !== "invoiceQuantityMismatch")
        return null;
    const siQuantity = typeof incident.details?.siQuantity === "number" ? incident.details.siQuantity : tradeCase.products?.[0]?.quantityInstructed;
    const invoiceQuantity = typeof incident.details?.invoiceQuantity === "number" ? incident.details.invoiceQuantity : tradeCase.products?.[0]?.quantityInvoiced;
    const product = tradeCase.products?.[0];
    const affectedProducts = [
        {
            productId: product?.id || "unknown",
            sku: product?.sku,
            name: product?.name,
            siQty: typeof siQuantity === "number" ? siQuantity : undefined,
            invoiceQty: typeof invoiceQuantity === "number" ? invoiceQuantity : undefined,
            shortageQty: typeof siQuantity === "number" && typeof invoiceQuantity === "number" ? Math.max(0, siQuantity - invoiceQuantity) : undefined,
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
    const shortageQty = typeof siQuantity === "number" && typeof invoiceQuantity === "number" ? Math.max(0, siQuantity - invoiceQuantity) : 0;
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
export function approveProposal(proposalId) {
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


function ingestStableId(prefix, seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}
function ingestNowIso() {
    return new Date().toISOString();
}
export function classifyRawInput(input) {
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
export function linkThreadsToEntities(threads) {
    const links = [];
    for (const thread of threads) {
        for (const shipmentId of thread.extractedEntities.shipmentIds ?? []) {
            links.push({
                id: `link-${thread.id}-shipment-${shipmentId}`,
                threadId: thread.id,
                entityType: "Shipment",
                entityId: shipmentId,
                confidence: thread.confidence,
                reason: "extracted shipment id from classified operational thread",
            });
        }
        for (const siId of thread.extractedEntities.siIds ?? []) {
            links.push({
                id: `link-${thread.id}-si-${siId}`,
                threadId: thread.id,
                entityType: "SI",
                entityId: siId,
                confidence: thread.confidence,
                reason: "extracted SI id from classified operational thread",
            });
        }
        if (thread.title.includes("PL未着")) {
            links.push({
                id: `link-${thread.id}-issue-ISS-0002`,
                threadId: thread.id,
                entityType: "Issue",
                entityId: "ISS-0002",
                confidence: 0.86,
                reason: "PL missing check matches existing open issue",
            });
        }
    }
    return links;
}
export function buildActivityEvents(input, threads, links, options = {}) {
    const events = [];
    const actor = options.sourceLabel || "mock ingest";
    const approvalPolicy = options.approvalPolicy ?? "low_confidence";
    events.push({
        id: ingestStableId("ACT", `${input.id}:raw_input_received`),
        type: "raw_input_received",
        occurredAt: input.receivedAt || ingestNowIso(),
        title: "Raw input received",
        description: input.rawText.slice(0, 200),
        sourceRawInputId: input.id,
        status: "ok",
        actor,
    });
    events.push({
        id: ingestStableId("ACT", `${input.id}:classified`),
        type: "classified",
        occurredAt: ingestNowIso(),
        title: `${actor}: Classified into ${threads.length} thread(s)`,
        sourceRawInputId: input.id,
        status: "ok",
        actor,
    });
    events.push({
        id: ingestStableId("ACT", `${input.id}:entity_linked`),
        type: "entity_linked",
        occurredAt: ingestNowIso(),
        title: `Linked ${links.length} entit${links.length === 1 ? "y" : "ies"}`,
        sourceRawInputId: input.id,
        linkedEntities: links,
        status: "ok",
        actor,
    });
    for (const thread of threads) {
        const shouldRequireApproval = approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
        if (!shouldRequireApproval)
            continue;
        events.push({
            id: ingestStableId("ACT", `${input.id}:${thread.id}:approval_required`),
            type: "approval_required",
            occurredAt: ingestNowIso(),
            title: "Approval required",
            description: approvalPolicy === "all"
                ? `Review thread (${thread.confidence.toFixed(2)}): ${thread.title}`
                : `Low confidence thread (${thread.confidence.toFixed(2)}): ${thread.title}`,
            sourceRawInputId: input.id,
            threadId: thread.id,
            linkedEntities: links.filter((l) => l.threadId === thread.id),
            status: "warning",
            actor,
        });
    }
    return events;
}
export function buildIssueMutations(input, threads, links, options = {}) {
    const mutations = [];
    const approvalPolicy = options.approvalPolicy ?? "low_confidence";
    const sourceLabel = options.sourceLabel || "mock ingest";
    for (const thread of threads) {
        const threadLinks = links.filter((l) => l.threadId === thread.id);
        const baseFields = {
            sourceRawInputId: input.id,
            threadId: thread.id,
            linkedEntities: threadLinks,
            confidence: thread.confidence,
            sourceLabel,
        };
        if (thread.title.includes("PL未着")) {
            const shipmentIds = thread.extractedEntities.shipmentIds ?? [];
            const title = `PL未着確認: ${shipmentIds[0] ?? "shipment unknown"}`;
            const bodyLines = [
                `依頼: ${input.senderName ?? "unknown"} (${input.source})`,
                `内容: ${input.rawText}`,
                "",
                `Thread: ${thread.title} (confidence=${thread.confidence.toFixed(2)})`,
                `Summary: ${thread.summary}`,
                "",
                `Links: ${threadLinks.map((l) => `${l.entityType}:${l.entityId}`).join(", ") || "(none)"}`,
            ];
            mutations.push({
                issueId: "ISS-0002",
                action: "append_comment",
                title,
                body: bodyLines.join("\n"),
                ...baseFields,
            });
            const shouldRequireApproval = approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
            if (shouldRequireApproval) {
                mutations.push({
                    issueId: "ISS-0002",
                    action: "mark_approval_required",
                    title: "Approval required: low confidence classification",
                    body: `Thread ${thread.id} confidence=${thread.confidence.toFixed(2)} for "${thread.title}"`,
                    ...baseFields,
                });
            }
            continue;
        }
        if (thread.title.includes("SI-224") || (thread.extractedEntities.siIds ?? []).some((s) => s.includes("224"))) {
            const siId = (thread.extractedEntities.siIds ?? [])[0] ?? "SI-UNKNOWN";
            const candidateId = `ISS-CAND-${ingestStableId("SI", siId).slice(-6).toUpperCase()}`;
            const title = `SI確認: ${siId}`;
            const bodyLines = [
                `依頼: ${input.senderName ?? "unknown"} (${input.source})`,
                `内容: ${input.rawText}`,
                "",
                `Thread: ${thread.title} (confidence=${thread.confidence.toFixed(2)})`,
                `Summary: ${thread.summary}`,
                "",
                `Links: ${threadLinks.map((l) => `${l.entityType}:${l.entityId}`).join(", ") || "(none)"}`,
            ];
            mutations.push({
                issueId: candidateId,
                action: "create_issue_candidate",
                title,
                body: bodyLines.join("\n"),
                ...baseFields,
            });
            const shouldRequireApproval = approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
            if (shouldRequireApproval) {
                mutations.push({
                    issueId: candidateId,
                    action: "mark_approval_required",
                    title: "Approval required: low confidence classification",
                    body: `Thread ${thread.id} confidence=${thread.confidence.toFixed(2)} for "${thread.title}"`,
                    ...baseFields,
                });
            }
            continue;
        }
        // Default: create a candidate issue for anything else.
        const candidateId = `ISS-CAND-${ingestStableId("THR", thread.id).slice(-6).toUpperCase()}`;
        mutations.push({
            issueId: candidateId,
            action: "create_issue_candidate",
            title: `Thread: ${thread.title}`,
            body: `Summary: ${thread.summary}\n\nRaw: ${input.rawText}`,
            ...baseFields,
        });
        const shouldRequireApproval = approvalPolicy === "all" ? true : approvalPolicy === "low_confidence" ? thread.confidence < 0.7 : false;
        if (shouldRequireApproval) {
            mutations.push({
                issueId: candidateId,
                action: "mark_approval_required",
                title: "Approval required: low confidence classification",
                body: `Thread ${thread.id} confidence=${thread.confidence.toFixed(2)} for "${thread.title}"`,
                ...baseFields,
            });
        }
    }
    return mutations;
}
export function buildIngestResultFromThreads(input, threads, options = {}) {
    const links = linkThreadsToEntities(threads);
    const activityEvents = buildActivityEvents(input, threads, links, options);
    const issueMutations = buildIssueMutations(input, threads, links, options);
    const issueUpdatedEvents = issueMutations.map((m) => ({
        id: ingestStableId("ACT", `${input.id}:issue_updated:${m.issueId}:${m.action}:${m.title}`),
        type: "issue_updated",
        occurredAt: ingestNowIso(),
        title: `${m.action}: ${m.issueId}`,
        description: m.title,
        sourceRawInputId: input.id,
        status: m.action === "mark_approval_required" ? "warning" : "ok",
        actor: options.sourceLabel || "mock ingest",
    }));
    return {
        rawInput: { ...input, status: "linked" },
        threads,
        links,
        activityEvents: [...activityEvents, ...issueUpdatedEvents],
        issueMutations,
    };
}
export function runMockIngest(input) {
    const threads = classifyRawInput(input);
    return buildIngestResultFromThreads(input, threads, {
        sourceLabel: "mock ingest",
        approvalPolicy: "low_confidence",
    });
}


export const mockRawInputs = [
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

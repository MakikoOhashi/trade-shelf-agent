# Agent Processors（現状実装ベース）

Trade Shelf Agent は「単一の人格AI」ではなく、**業務処理単位の processor（処理器）** を連結して動かす設計を取っています。

このドキュメントは、理想の multi-agent 構想ではなく、`README.md` / `docs/current-architecture.md` / `apps/api/server.mjs` / `packages/shared/src/*.ts` / `apps/web/app.js` の **現状実装** に即して整理します。

## 前提：デモの入口と基本データ

- 入力（入口）
  - Web: `POST /ingest/mock` / `POST /ingest/llm`（`apps/api/server.mjs`）
  - Slack: `/slack/events`（`apps/api/server.mjs`）
- 永続化（デモ）
  - file-backed store（`/home/data/*.json`。詳細は `docs/current-architecture.md`）
- 共有ドメイン（入出力の型）
  - `RawInput` / `OperationalThread` / `EntityLink` / `PendingClarification` / `ActionPlan` / `DraftDocument` / `ActivityEvent` など（`packages/shared/src/domain.ts`）

## Processor一覧（現状）

現状デモで動いている processor 群は、概ね以下です。

1. Intake / Classification Processor
2. Clarification Processor（pending clarification queue）
3. Relationship Resolver
4. Intake Resolver
5. Issue Planner
6. Action Planner
7. Draft Writer
8. Operational Responder（PL未着などの業務返信/承認ブリッジ）
9. Human Approval Layer
10. Activity Logger

以降、各 processor について **Responsibility / Input / Output / Current implementation / Demo behavior** を記載します。

---

## 1) Intake / Classification Processor

### 1. Responsibility
- 入力テキストを **業務スレッド（OperationalThread）** に分解・分類する
- 文中の番号（SI / SHP / INV など）を抽出し、後続の紐付けの起点を作る
- Azure OpenAI / Foundry が利用できる場合は LLM、無い場合は mock / rule ベースにフォールバックする

分類する業務意図（ドメイン表現としての例）：
- **PL到着確認**（「PLまだ？」「PL届いた？」など）
- **状態更新**（「出荷済みにして」「通関に進んだ」など）
- **出荷状況確認**（「いつ出る？」「今どこ？」など）
- **ETA変更**（「ETAが前倒し/遅れた」など）
- **情報不足**（対象番号が無い、複数候補があり確定できない）

ただし現状実装の intent 値は、`apps/api/server.mjs` の `CLASSIFY_SYSTEM_PROMPT` / `CLASSIFY_INTENTS` に定義された以下へ正規化されます（デモ都合で最小集合）：
- `missing_document_check`（PL到着確認はここに寄ることが多い）
- `shipment_status_check`（出荷状況確認）
- `eta_change`（ETA変更）
- `quantity_mismatch`（数量差異）
- `air_change_check`（Air/便変更の確認）
- `unknown`（情報不足など）

「状態更新」は intent というより、後段の **状態遷移候補検出 → 承認**（`packages/shared/src/ingest.ts` の `buildStateTransitionCandidates()` など）として扱います。

### 2. Input
- `RawInput`（`rawText`, `senderName`, `source`, `channel`, `threadTs` など）

### 3. Output
- `OperationalThread[]`
  - `intent`（現状: `missing_document_check` / `shipment_status_check` / `eta_change` / `quantity_mismatch` / `air_change_check` / `unknown`）
  - `extractedEntities`（例: `siIds`, `shipmentIds`, `invoiceIds`, `documentTypes`）

### 4. Current implementation
- rule / mock
  - `packages/shared/src/ingest.ts` の `classifyRawInput()`
- LLM classification（利用可能な場合）
  - `apps/api/server.mjs` の `classifyThreadsWithLlm()`（system prompt: `CLASSIFY_SYSTEM_PROMPT`）
  - `apps/api/server.mjs` の `linkEntitiesByRules()`（LLM結果へ entity を補強）
- 共通のパイプライン入口
  - `packages/shared/src/ingest.ts` の `runIngestPipeline()` / `buildIngestResultFromThreads()`

### 5. Demo behavior
- Web の「Requests」からテキストを投げると、スレッド（タイトル/要約/intent）が結果として表示される
- Slack のメッセージでも同様に classification が走り、Activity に処理の痕跡が残る（表示は UI 側で整形）

---

## 2) Clarification Processor（不足情報の確認）

### 1. Responsibility
- 対象（SI / Shipment / INV）が特定できない入力に対して、**確認質問を生成**し、返信待ち状態を作る
- 後から来た返信を、元の問い合わせに **再接続** して ingest を継続する

### 2. Input
- `RawInput`
- 既存の `PendingClarification[]`（キュー）

### 3. Output
- `PendingClarification`（新規作成 or 更新）
- `ActivityEvent[]`（`clarification_required` / `clarification_waiting` / `clarification_matched` / `reminder_planned` など）
- （デモ上）返信文の下書き：`DraftDocument`（`channel: "teams"` 相当の文面）

### 4. Current implementation
- context判定（「後続へ進めるか / 不足か」）
  - `packages/shared/src/ingest.ts` の `resolveContext()`
- pending clarification の生成・マッチ・replay
  - `packages/shared/src/ingest.ts` の `runIngestPipeline()`（`matchPendingClarification()` を使い、必要に応じて元依頼を replay）
- pending queue の永続化（デモ）
  - `apps/api/server.mjs`（`pending-clarifications.json`）

### 5. Demo behavior
- 例: `PLまだ？` のように対象が無い場合、確認質問が Activity / Draft として見える
- 返信で `SI-2026-001` や `INV-1234` を送ると、`clarification_matched` が記録され、元依頼へ対象が付与されて ingest が再実行される

---

## 3) Relationship Resolver

### 1. Responsibility
- 貿易実務の「番号の相互関係（INV / SI / Shipment / PL…）」を解決し、
  - `INV → Shipment → SI` のような連鎖を **TradeCase** へ寄せる
  - **PL status（missing / received / unknown）** を解決する

### 2. Input
- `EntityLink[]`（特に `Document` = INV）
- `TradeCase[]`（デモでは mock data）

### 3. Output
- 追加の `EntityLink[]`（例: Document しか無い thread に SI / Shipment を補う）
- Operational context（PL status など）の解決結果（内部的に利用）

### 4. Current implementation
- `packages/shared/src/relationshipResolver.ts` の `resolveOperationalContext()`
- `packages/shared/src/ingest.ts` の `runIngestPipeline()` 内で、
  - Document（INV）から `resolveOperationalContext()` を呼び、SI / Shipment リンクを追加する処理

### 5. Demo behavior
- INVだけ書いた問い合わせでも、Shelf 上の対象案件へ寄せられ、PL未着などが判定できるようになる

---

## 4) Intake Resolver

### 1. Responsibility
- classification 結果を「業務としてどう扱うか」に落とし込む
  - `status_query`（状況返信）
  - `needs_clarification`（不足情報）
  - `issue_candidate_required`（対応が必要そう）
  - `informational_only`（記録のみ）

### 2. Input
- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`

### 3. Output
- `IntakeResolution[]`

### 4. Current implementation
- `packages/shared/src/ingest.ts` の `resolveIntake()`

### 5. Demo behavior
- Activity に `intake_resolved` が積まれ、「状況照会として処理」「不足情報が必要」等の説明が表示される

---

## 5) Issue Planner

### 1. Responsibility
- thread を Issue として扱う必要がある場合に、**Issue候補（mutation）** を生成する
- 承認ポリシーに応じて `mark_approval_required` を追加する（現状はデモ用の単純なポリシー）

### 2. Input
- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`
- `IntakeResolution[]`

### 3. Output
- `IssueMutation[]`

### 4. Current implementation
- `packages/shared/src/ingest.ts` の `buildIssueMutations()`

### 5. Demo behavior
- 承認センター（Approvals）に Issue/承認候補として表示される（表示の粒度はデモ仕様）

---

## 6) Action Planner

### 1. Responsibility
- thread の intent / intake 状態から「次に何をするべきか」を `ActionPlan` として列挙する
- `approvalPolicy`（例: `all` / `low_confidence`）や、Relationship Resolver の PL未着判定により `pending_approval` を付与する

### 2. Input
- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`
- `IntakeResolution[]`
- `IssueMutation[]`

### 3. Output
- `ActionPlan[]`

### 4. Current implementation
- `packages/shared/src/ingest.ts` の `planNextActions()`
- `packages/shared/src/ingest.ts` の `runIngestPipeline()` 内で `pending_approval` 判定を付与

### 5. Demo behavior
- 承認が必要なアクションは「承認待ち」として UI に現れる

---

## 7) Draft Writer

### 1. Responsibility
- `ActionPlan` を元に、外部送信の前段階として **下書き（DraftDocument）** を生成する
- PL状況など relationship 解決結果を反映して文面を切り替える

### 2. Input
- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`
- `ActionPlan[]`
- `TradeCase[]`（PL status 判定に利用）

### 3. Output
- `DraftDocument[]`（`channel: "email"` / `"teams"` など）

### 4. Current implementation
- `packages/shared/src/ingest.ts` の `buildDraftDocuments()`

### 5. Demo behavior
- PL未着の場合、仕入先督促メール案（`email`）が `pending_approval` で生成される
- 営業への返信候補（`teams`）も併せて生成される

---

## 8) Operational Responder

### 1. Responsibility
- Relationship Resolver の結果（例: PL未着）を踏まえて、「今この問い合わせにどう返すか」を **canonical text** として組み立てる
- その結果を、承認センターのアイテム（例: 仕入先督促）へブリッジする

### 2. Input
- `DraftDocument[]`（特に `email` の `pending_approval`）
- `EntityLink[]` と `TradeCase[]`（PL status 判定）

### 3. Output
- `ActivityEvent`（`operational_responder`）
- （デモ上）承認センターに登録される `supplier_followup` approval item

### 4. Current implementation
- canonical reply text（PL未着の返信文）
  - `packages/shared/src/ingest.ts` の `buildMissingPlSupplierFollowupReplyText()`
- operational responder event の生成
  - `packages/shared/src/ingest.ts` の `runIngestPipeline()`（`operational_responder` event を積む）
- 承認センターへの enqueue（デモ）
  - `apps/api/server.mjs` の `maybeEnqueueDemoApprovalFromSupplierFollowupDraft()`

### 5. Demo behavior
- 「PLまだ？」→ 対象が解決できると、PL未着の説明＋「承認センターを見てください」が Activity に出る
- 承認センターには「仕入先督促メール」が pending で現れる

---

## 9) Human Approval Layer

### 1. Responsibility
- 外部送信や状態変更を **自動実行しない**（デモでも人間承認を必須にする）
- 承認後に、必要なら Slack へ返信送信、またはデモデータ更新（状態更新）を行う

### 2. Input
- `approval_required` / `DraftDocument(status=pending_approval)` / `operational_responder` などの signals
- 人間の承認操作（UI 経由の API 呼び出し）

### 3. Output
- approval item の `status` 更新（`pending` → `approved` など）
- （デモ上）Slack 送信 / TradeCase 状態更新 / Activity 記録

### 4. Current implementation
- 承認アイテムの生成（デモ）
  - `apps/api/server.mjs` の
    - `maybeEnqueueDemoApprovalFromApprovalRequiredEvent()`（状態更新候補）
    - `maybeEnqueueDemoApprovalFromSupplierFollowupDraft()`（仕入先督促）
- 承認 API
  - `apps/api/server.mjs` の `POST /api/demo/approvals/approve`

### 5. Demo behavior
- Approval Center で「承認」すると、承認済みになり、必要に応じて Slack 送信や状態更新が走る

---

## 10) Activity Logger

### 1. Responsibility
- 「AIが何を判断し、何を作り、どこで止めたか」を時系列で残す
- Clarification / classification / entity linking / approval required 等を同一 timeline 上に並べられるようにする

### 2. Input
- ingest pipeline の各段階の結果（Context / Links / Plans / Drafts / Approvals など）

### 3. Output
- `ActivityEvent[]`（shared layer）
- UI表示用の feed item（server側で整形）

### 4. Current implementation
- activity event の生成
  - `packages/shared/src/ingest.ts` の `runIngestPipeline()`（`activityEvents` を返す）
- UI向け整形＋永続化（デモ）
  - `apps/api/server.mjs` の `activityEventToFeedItem()` / `pushActivityItem()` / `activity-events.json`

### 5. Demo behavior
- Activity タブで「依頼受信 → Context判定 → 分類/紐付け → 下書き生成 → 承認待ち」などが時系列に表示される

---

## Design Note

Trade Shelf Agent は、単一のチャットAIとしてではなく、業務フローを処理する processor 群として設計しています。

営業は Slack / Web から問い合わせるだけでよく、AI側が分類・紐付け・状態判断・次アクション生成を行います。

一方で、外部送信や状態変更は Human-in-the-loop として人間承認を残します（現状実装でもこの方針を優先しています）。

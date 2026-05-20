# Agent Processors

## 基本思想

Trade Shelf Agent は、「なんでも答える貿易AI」を作るものではない。

代わりに、小さな Processor（処理器）を連結した構造を採用する。

各 Processor は:

- 明確な責務
- 構造化された入力 / 出力
- failure handling
- 次処理への明示的トリガー

を持つ。

目的は:

- AI挙動を観測可能にする
- 処理状態を追跡可能にする
- 人間が途中介入できるようにする
- JSON出力を小さく保つ
- 「分類」と「文章生成」を分離する

ことである。

AIの主用途は:

- 分類
- 分解
- 抽出
- 紐付け
- 行動計画
- 下書き生成

であり、「自由意思を持つ業務AI」ではない。

---

## Pending Clarification Queue（文脈接続）

Teams thread / replyToId があれば使う。ただし実務では営業が別投稿する可能性が高いので、必須にしない。

代わりに「pending clarification queue」を持つ。

例:

1. Human Input: `PLまだ？`
2. Context Resolver: `missing_context`
3. Clarification Draft: `どのSIまたはShipmentのPLでしょうか？`
4. Pending Clarification Queue に追加: `CLR-xxxx`（status: `awaiting_clarification_reply`）
5. Human Input: `SI-224だよ`
6. Pending Matcher: requester + channel + 直近 + missingFields を満たす pending をマッチ
7. Context Resolver: `resolved_enough`
8. 先ほどの質問への返信として処理: `PLまだ？ 対象: SI-2026-224`

---

# Processor Pipeline

```mermaid
flowchart TD

A[Human Input / Agent Observation]

A --> B[Context Resolver]

B -->|missing_context| C[Clarification Draft]
C --> D[Human Reply Waiting]
D --> E[Reminder Planner]
E --> F[Human Reply]
F --> A

B -->|ambiguous| G[Candidate Suggestions]
G --> H[Awaiting Human Selection]
H --> I[Reminder Planner (selection)]
I --> J[Human Selection]
J --> A

B -->|resolved_enough| ExecutionTimelineAgent[Execution Timeline Agent]
ExecutionTimelineAgent --> AgentObservation[Agent Observation: timeline_deviation]
AgentObservation --> K[Tagger]

K --> L[Thread Splitter]

L --> M[Entity Linker]

M --> N[Intake Resolver]

N -->|status_query| O[Reply Action]

N -->|informational_only| P[Timeline Event Only]

N -->|issue_candidate_required| Q[Issue Planner]

Q --> R[Action Planner]

R --> S[Draft Writer]

S --> T[Approval Handler]

T --> U[Event Logger]
```

Context Resolver について:

- Context Resolver は「Taggerできるだけの文脈があるか」を判定する
- `missing_context` / `ambiguous` は Issue化しない（pipeline を停止）
- clarification / selection への返信は conversation context を持った新しい Human Input として再投入される

各 Processor は、処理結果を Orchestrator / Router に返す。

Orchestrator は:

- 処理成功判定
- 次に動かす Processor
- Human Review が必要か
- 処理停止すべきか

を判断する。

Processor 同士は直接呼び出さない。

---

# Processor Definitions

---

## Execution Timeline Agent（納期逆算・逸脱検出）

役割:

- 顧客納期・ETD/ETA・Booking・工場出荷・書類準備などから「理想実行シナリオ（逆算タイムライン）」を組み立てる
- 現在状態と比較し、遅延・逸脱・納期リスク（timeline deviation）を検出する

入力（例）:

- Human Input（顧客納期 / 希望納期の更新）
- Teams / Email（フォワーダー・仕入先からの進捗）
- Document arrival（PL/BL/INVなどの到着）
- Shipment state（Booking/ETD/ETA/通関/配送）
- Customer delivery date（顧客納期）
- Supplier / forwarder updates（出荷予定・確定・変更）

出力（例）:

- `timeline_deviation` observation（遅延/逸脱の構造化情報）
- risk summary（納期・物流リスク要約）
- recommended next action（次にやるべきアクション候補）
- issue candidate signal（必要なら Issue化候補シグナル）

既存 flow との接続:

- Execution Timeline Agent は Issue を直接作らない
- `timeline_deviation` を Agent Observation として出力する
- その後は既存の `Tagger → Intake Resolver → Issue Planner → Action Planner → Draft Writer → Approval Handler` に乗せる
- 遅延・逸脱が業務対応を必要とする閾値を超えた場合、`timeline_deviation` に `issue_candidate_required` の signal を付与できる
- Issue Planner は internal Issue Candidate を自動作成してよい（外部送信はしない）
- 仕入先・顧客・フォワーダーなど外部関係者への送信は Approval Handler による人間承認を必須とする

## Processor I/O shape（最小）

各 Processor は「最小の I/O shape（入力/出力）」を持つ。ここで示す shape は、Orchestrator が Processor を差し替え可能に保つための契約である。

### RawInput（最小）

- `id`
- `source`
- `rawText`
- `receivedAt`
- `senderName`
- `channel`

### Tagger / Thread Splitter

input:

- `RawInput`

output:

- `OperationalThread[]`

### Entity Linker

input:

- `OperationalThread[]`

output:

- `EntityLink[]`

### Intake Resolver

input:

- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`

output:

- `IntakeResolution[]`

### Issue Planner

input:

- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`
 - `IntakeResolution[]`

output:

- `IssueMutation[]`

### Action Planner

input:

- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`
 - `IntakeResolution[]`
- `IssueMutation[]`

output:

- `ActionPlan[]`

### Draft Writer

input:

- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`
- `IssueMutation[]`
- `ActionPlan[]`

output:

- `DraftDocument[]`

### Approval Handler

input:

- `ActionPlan[]`
- `DraftDocument[]`

output:

- `ActionPlan[]`（status updated）
- `DraftDocument[]`（status updated）

### Event Logger

input:

- `RawInput`
- `OperationalThread[]`
- `EntityLink[]`
- `IssueMutation[]`
- `ActionPlan[]`

output:

- `ActivityEvent[]`

---

# State Machines（最小）

## ActionPlan

- `planned`
  - → `pending_approval`（承認が必要な場合）
  - → `skipped`（human_review_only などでスキップ扱いにする場合）
- `pending_approval`
  - → `approved`
  - → `held`
  - → `edited`
- `approved`
  - → `mock_sent`

## Draft

- `drafted`
  - → `pending_approval`（必要なら）
- `pending_approval`
  - → `approved`
  - → `held`
  - → `edited`
- `approved`
  - → `mock_sent`

## 1. Tagger

### 役割

受信した入力が「何の話か」を分類する。

### Input

- RawInput

### Output

- tags
- intent candidates
- confidence

### 例

- missing_document
- si_check
- quantity_mismatch
- eta_change
- air_change_check
- supplier_reply
- unknown

### やらないこと

- Issue作成
- メール作成
- 承認
- 外部送信

### Failure

- failed_processing event
- manual_review_required tag

---

## 2. Thread Splitter

### 役割

1つの RawInput を複数の業務スレッドへ分解する。

### 例

入力:

```text
PLまだ？あとSI-224も確認して
```

出力:

- THR-1: PL確認
- THR-2: SI-224確認

### Output

- OperationalThread[]

### やらないこと

- 最終行動決定
- draft作成
- approval判定

### Failure

- split_failed
- ambiguous_threading

---

## 3. Entity Linker

### 役割

各 OperationalThread が、どの Entity に関係するか紐付ける。

### Entity Types

- SI
- Shipment
- Document
- Supplier
- Issue

### Output

- EntityLink[]

### 例

```json
{
  "entityType": "SI",
  "entityId": "SI-2026-224"
}
```

### やらないこと

- draft作成
- approval
- action決定

### Failure

- entity_not_found
- ambiguous_entity_match

---

## 4. Intake Resolver

### 役割

営業・Teams・メール由来の雑な入力を、すぐ Issue 化せずに「業務的に解決可能な形」へ整理する。

- 既存 SI / Shipment / Document / Issue に紐付けられるか判定する
- 情報不足なら `needs_clarification` にする
- ただの状況照会なら `status_query` にする
- 本当に業務上の異常・対応が必要な場合だけ `issue_candidate_required` にして Issue Planner に渡す

### 例

- 「SI-224の状況を教えて」→ `status_query`（Issue化しない、状況返信候補を作る）
- 「PLまだ？」→ `needs_clarification`（Issue化しない、「どのSI/ShipmentのPLか」を返す）
- 「INVがSIと数量違う」→ `issue_candidate_required`（Issue Planner へ進む）

### Output

- IntakeResolution[]

---

## 5. Issue Planner

### 役割

各 thread が:

- 既存Issue更新か
- 新規Issue候補作成か

を決定する。

### Output

- IssueMutation
- IssueCandidate
- issueId
- candidateId
- status

### 例

- pending_approval
- review_required
- resolved_candidate

### やらないこと

- メール生成
- Teams返信生成

### Failure

- issue_match_failed
- duplicate_issue_candidate

---

## 6. Action Planner

### 役割

「次に何をすべきか」を決める。

### Action Tags

- human_review_only
- email_required
- teams_reply_required
- supplier_confirmation_required
- forwarder_confirmation_required
- no_action

### Output

- action tags
- next action candidates

### やらないこと

- draft生成
- 外部送信

### Failure

- no_clear_action
- conflicting_actions

---

## 7. Draft Writer

### 役割

必要時のみ、外部送信用の文案を生成する。

### Trigger

Action Planner が:

- email_required
- teams_reply_required

などを付与した場合のみ動作。

### Output

- Email draft
- Teams reply draft

### やらないこと

- 承認
- 自動送信

### Failure

- draft_generation_failed
- unsafe_draft_detected

---

## 8. Approval Handler

### 役割

AI提案に対し、人間が:

- approve
- edit
- hold
- reject

を行う。

### Human Actions

- Approve
- Edit
- Hold
- Reject

### Output

- approval status
- approval event
- edited draft
- execution permission

### やらないこと

- 無承認送信

### Failure

- approval_timeout
- rejected_by_human

---

## 9. Event Logger

### 役割

全処理を Activity Feed に記録する。

### Event Examples

- raw_input_received
- classified
- entity_linked
- issue_updated
- approval_required
- email_draft_created
- approved
- failed_processing

### 目的

システム状態を:

- traceable
- auditable
- debuggable

にする。

---

# Orchestrator / Router

## 役割

Processor 実行フローを管理する。

Processor 同士は直接次を呼ばない。

代わりに:

```text
Processor
↓
構造化結果を返す
↓
Orchestrator が状態確認
↓
次Processorを決定
```

という流れを取る。

### 例

```text
Action Planner
↓
email_required tag
↓
Orchestrator が Draft Writer を起動
```

もし:

```text
failed_processing
```

なら:

```text
Human Review queue
```

へルーティングする。

---

# Activity Feed の思想

Activity Feed は単なるログではない。

「処理状態の可視化」である。

Activity Feed では:

- 今どの Processor が処理したか
- どこまで進んだか
- どこで止まったか
- 人間確認が必要か

を把握できる必要がある。

---

# 設計思想

Trade Shelf Agent は:

- chatbot
- 自律AI秘書
- 曖昧な貿易AI

を作るものではない。

作っているのは:

- operational decomposition system
- event-driven workflow layer
- human-in-the-loop operational intelligence system

である。

AIの主役割は:

- classify
- split
- link
- plan
- draft

であり、自律実行ではない。

# Agent Processors (Orchestrator / Processor 分離)

Azure Hackathon - Shelf の「入力→整理→Issue→承認→ログ」を壊れにくくするための設計メモ。

## 目的
- 単一LLMの“なんでも屋”化を避け、責務を固定して品質と再現性を上げる
- Human approval を前提に、判断材料の整理とログ可視化を主戦場にする

## 全体像
- **Orchestrator LLM**
  - 入力を受け取り、必要な Processor を選び、結果を統合して Issue を作る
  - Human 承認ステップを挟み、最終適用（または却下）までの状態遷移を統制する
  - 活動ログ（何を受け取り、どのProcessorを呼び、何が出て、どう判断されたか）を出力する
- **Processor LLMs（役割別）**
  - 1つの Processor は 1つの責務に集中し、入出力を固定する

## Processor の責務（最小セット）
1. **分類（Classifier）**
   - 入力を「どのドメイン/ワークスペース/論点か」に分類する
   - 例: shipment / SI / docs / issue-type（質問/変更依頼/確認依頼/エスカレーション）
2. **抽出（Extractor）**
   - 入力から事実・要件・制約・期限・関係者を抽出する
   - “解釈”ではなく“拾う”を優先し、抜けの質問（clarifying questions）も列挙する
3. **紐付け（Linker）**
   - 既存の Shelf / Issues / Documents / 過去ログ へ関連付け候補を出す
   - 例: 既存Issueの重複検知、関連ドキュメント候補、影響範囲候補
4. **提案（Proposer）**
   - 具体的な次アクション案を複数提示する（案A/B/C）
   - それぞれに: 期待効果 / リスク / 必要な確認 / 最小実行手順 を付ける

## データフロー（状態遷移）
1. Input 受信
2. Orchestrator が Processor を選択して順次実行
3. 統合して Issue（判断単位）を作成
4. Human approval（承認/差し戻し/却下）
5. Apply（反映）または Close
6. 活動ログに出力（再現可能な履歴）

## ログ（最低限ほしい項目）
- `event_id`（連番/一意ID）
- `received_at`（受信時刻）
- `input_source`（メール/フォーム/Slack等）
- `orchestrator_decision`（どのProcessorを呼んだか、順序）
- `processor_outputs`（要約＋主要フィールド）
- `issue_id`（作成/紐付け先）
- `human_decision`（承認/差し戻し/却下）
- `applied_changes`（実際に反映した内容）

## 守るルール（運用のための制約）
- Processor は「文章をうまくする」より「構造を揃える」を優先
- Orchestrator は “勝手に確定” しない（Human approval を通す）
- 迷ったら Processor を増やすより、入出力スキーマを締める

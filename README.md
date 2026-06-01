# Trade Shelf Agent

散在するメール・書類・メモを「ぶち込み箱」に入れるだけで、AI が案件ごとに整理し、状態別の棚に並べる商社向けの業務エージェントです（輸入・三国間貿易）。

> Drop messy emails and documents into an inbox. AI organizes them into operational shelves, detects incidents, and helps teams take action with approval workflows.

## 目的

このプロジェクトは単なる管理画面ではなく、人間の頭の中にある貿易業務の状態を構造化し、AI が理解・検知・提案・支援できる業務レイヤを作ることを目的とします。


## 対象業務

- 輸入業務
- 三国間取引
- 商社の営業事務・貿易事務
- SI / INV / PL / ETA / Forwarder mail / 商品紐付け / 状態遷移 / 差異検知


## Domain Extension Strategy

Trade Shelf Agent の中核は、輸入・三国間取引の業務状態を構造化する Trade Ops Layer である。

初期デモでは、実務解像度を高めるために Textile Intelligence を第一弾ドメイン拡張として扱う。

- mtr 管理
- 反数管理
- 数量許容差
- 分納判断
- 染め直し履歴
- 不良履歴
- 仕入先ごとの癖

ただし、これらは Core ではなく Domain Module として扱う。  
将来的には Shopify App / ERP / Outlook などから Core API を利用できる構造を維持する。

## Hackathon

- 応募先: Microsoft Agent Hackathon 2026（Zenn）
  - https://zenn.dev/hackathons/microsoft-agent-hackathon-2026
- テーマ: 商社向け「輸入・三国間貿易の管理棚エージェント」

## コア体験

1. 左の「ぶち込み箱」にメール・書類・メモを投入
2. AI が案件・書類・数量・日付・状態を抽出
3. ユーザーが確認モーダルで承認
4. 右の本棚 UI に案件が状態別に整理される
5. 異常があれば AI が検知し、対応案を提示する

## UI イメージ（左 Inbox / 右 Shelf）

- 左: メール/書類/メモなどをそのまま投入する Inbox
- 中間: AI 抽出結果の確認モーダル（Human-in-the-loop）
- 右: 案件を状態別の「棚」に整理して格納（いつでも参照可能）

## できること（Core Features）

- Inbox intake（テキスト貼り付けから開始、将来的にファイル投入）
- AI classification（案件候補・書類種別・取引要素の抽出/紐付け）
- Shelf UI（状態別ステータスボード）
- Incident detection（差異・不足・遅延などの検知）
- Action proposal + approval（対応案の提示→承認→実行）
- Searchable timeline（案件の時系列ログ）

## 想定ユースケース

- 商社の輸入 / 三国間取引オペレーション
- メール・書類が多く、案件の進捗把握が属人化している現場
- 出荷待ち、書類不足、変更対応、INV 不足などの異常検知
- 日常整理 + インシデント対応（対応ログを残す）

## インシデント対応（例）

- 期待: SI 1000
- 実績: INV 400
- 乖離を検知 → 影響を要約 → 対応案（例: 仕入先へ確認メール案 / 追加 INV 依頼 / 社内エスカレーション）を提示
- ユーザー承認後に実行し、対応ログ（何を・いつ・誰が承認したか）を保存

## Agentic Workflow

「情報を入れる → 構造化 → 異常検知 → 承認 → 実行 → ログ/学習」までを一連の業務フローとして扱います（図: `docs/workflow.md`）。

現状実装ベースのアーキテクチャ図: `docs/current-architecture.md`

- AI inference / operational context generation: Trade Shelf Agent は Slack や Email 等の communication input から、AI による operational context generation を行います。一部の shipment context / document status / ETA 情報は AI inference による補完情報として UI 上に表示されます。
- この demo は `communication → AI structuring → operational context generation → approval workflow` を実証することを目的としています。

- 現時点は demo data（mock 入力）前提
- 外部メール連携（Gmail/Outlook）、PDF/OCR、LLM API 呼び出しは未実装（設計図の可視化を優先）

### Current Flow (as implemented)

README 上の「理想」ではなく、現状の実装フローは以下です。

Slack message
→ Raw Input Intake
→ Classification
→ Relationship Resolution
→ Clarification Flow
→ Issue Candidate
→ Operational Responder（部分実装 / partially implemented）
→ Activity / Toast
→ Human Approval

現状の実装状況（正直ベース）:

- relationship resolution は動作
- state transition は動作
- Slack clarification は動作
- Operational execution responder is partially implemented（execution follow-up は実装途中）

## リポジトリ構成（想定）

```txt
apps/
  web/          # Next.js フロントエンド（Inbox/Shelf/承認UI）
  api/          # Node.js バックエンド API（解析/紐付け/検知/ログ）
packages/
  shared/       # 共通型、ドメインモデル、状態定義、インシデント種別
docs/           # 要件、画面設計、シナリオ、アーキメモ
```

## 技術方針（たたき台）

- 構成: Monorepo
- フロントエンド: Next.js / React / TypeScript / Tailwind CSS
- バックエンド: Node.js / TypeScript（REST API または Route Handlers を想定）
- 共有レイヤ: `packages/shared` で型とドメイン知識を共通化
- AI/推論: LLM は adapter 経由で呼び出し（モデル差し替え可能）
- データ: 初期は mock / JSON / in-memory でも可（必要に応じて DB）

## Azure デプロイ方針（たたき台）

このリポジトリは monorepo ですが、デプロイ単位はサービスごとに分けます。

- `apps/web` → Azure Container Apps
- `apps/api` → Azure Container Apps

## デモ用永続化について

現在の Trade Shelf Agent デモでは、Hackathon 用に DB を追加せず、サーバー側の JSON file-backed store へデータを保存しています。

保存対象：

- Slack event
- AI processing event
- entity linking event
- state transition candidate event
- approval / failure event
- 未知SI承認後に追加された demo-created TradeCase（Shelf item）

保存先：

- Activity events: `/home/data/activity-events.json`
- Demo-created TradeCases: `/home/data/demo-trade-cases.json`

Azure App Service 上で server restart が発生しても、Activity timeline が維持されるようにしています。

Hackathon フェーズでは、DB 構築よりも

- communication ingest
- AI structuring
- operational timeline
- approval workflow

の実証を優先しています。

## 将来的な本番構成

本番構成では、現在の file-backed store を Azure Cosmos DB に置き換える予定です。

想定 persistent entities：

- TradeCase
- IncidentLog
- DecisionLog
- SupplierBehavior
- TimelineEvent
- ApprovalEvent

現在の実装は、

communication input
→ AI structuring
→ entity linking
→ state transition proposal
→ human approval
→ operational timeline update

という Agent workflow の実証に集中するため、軽量な persistence 構成を採用しています。

## 将来構想

最終的には Shopify App として、商品・在庫・入荷予定・貿易書類・仕入先対応をつなぐ業務レイヤへ発展させます。

ただし初期 MVP では Shopify 連携は実装せず、まずは貿易業務の状態を AI が読める形に構造化することを優先します。

## MVP スコープ

1. **Inbox**: 左側にメール/書類/メモを入力（まずはテキスト）
2. **Confirmation**: AI 抽出結果をモーダル表示し、承認後に保存
3. **Shelf**: 右側に状態別の棚（例: 出荷待ち/書類不足/返信待ち/通関中/完了）
4. **Detail**: 案件詳細のタイムライン（関連書類・更新履歴・次アクション）
5. **Incident**: 異常検知→対応案提示→承認→ログ保存

## 設計原則

- チャット UI を主役にしない（“質問に答える AI” ではなく “業務状態を再構成する AI”）
- フル自動ではなく Human-in-the-loop（承認フロー）
- 現場の入力負荷を増やさない
- 派手さより運用価値を優先する

## 開発ロードマップ（Issue）

- **Issue 1: MVP UI skeleton**
  - 左 Inbox / 右 Shelf / 確認モーダル
- **Issue 2: Trade entity parser**
  - INV / SI / qty / status / supplier の抽出と正規化
- **Issue 3: Incident scenario**
  - 期待値（例: SI 1000）と実績（例: INV 400）の差異検知と承認付き対応ログ


## Human Intervention Points

Trade Shelf Agent は、AIの検知結果をそのまま実行するのではなく、人間が業務判断を差し込める設計にする。

人間の介入は「承認」だけではない。

### 介入パターン

- Approve: AIの対応案を承認する
- Correct: AIの抽出・判断を修正する
- Replace Document: 誤ったINV / PL / SIを差し替える
- Mark as Partial Shipment: 分納として扱う
- Link to Next Shipment: 次回Shipmentに紐付ける
- Mark as No Issue: 問題なしとして記録する
- Escalate: 社内・上長・営業へエスカレーションする
- Request Confirmation: 仕入先 / Forwarder へ確認する
- Hold: 保留にして監視継続する

### 例

- INVの数量差異をAIが検知したが、実際は仕入先のINV記載ミスだったため、正しいINVに差し替える。
- SI 1000個に対してINV 400個のみだったが、残り600個は次回Shipmentに乗るため、分納として記録する。
- ETA変更はあったが、納期影響がないため No Issue として処理する。

## Azure Architecture

### Azure Container Apps
- `apps/web`
  - 本棚UI
  - ぶち込み箱
  - 案件詳細
  - 承認UI

- `apps/api`
  - ingestion
  - trade structuring
  - incident detection
  - action proposal

### Microsoft AI
- Azure OpenAI / Microsoft Foundry
- 業務テキストから TradeCase / Incident / ActionProposal を構造化
- 対応案生成

### Azure Cosmos DB
- TradeCase
- IncidentLog
- SupplierBehavior
- TimelineEvent
- ActionProposal

## API-first Design

Trade Shelf Agent は UI に閉じたアプリではなく、
AI や外部システムが利用可能な Trade Operations API として設計する。

将来的には以下との接続を想定する。

- Shopify App
- Outlook / Gmail
- ERP
- Teams / Slack
- 社内ワークフロー
- AI Agents

## Planned API

### POST /ingest
雑多なメール・書類・メモを投入し、
TradeCase 候補に構造化する。

### GET /cases
本棚に並べる案件一覧を取得する。

### GET /cases/:id
案件詳細、書類、timeline、incident を取得する。

### POST /cases/:id/approve
AI提案を人間が承認する。

### POST /incidents/detect
数量差異・書類不足・ETA変更などを検知する。

### POST /actions/propose
仕入先・Forwarder・社内向けの対応案を生成する。

### DeliveryRisk

Trade Shelf Agent は、案件の納期遅延リスクを推定する。

以下を総合して「間に合う可能性」を算出する。

- 顧客希望納期
- ETA
- Shipment 状態
- 通関平均日数
- 倉庫搬入平均日数
- 書類不足
- Supplier の遅延傾向
- Forwarder の応答速度
- 過去の Incident 履歴
- 分納傾向

例:
- deliveryConfidence: 0.91
- deliveryRisk: medium
- estimatedWarehouseArrival: 2026-05-28

Customer Requested Date
↓
Current Shipment State
↓
ETA
↓
Customs Average
↓
Warehouse Arrival Estimate
↓
Supplier Reliability
↓
Document Completeness
↓
Historical Delay Patterns
↓
Delivery Risk Score

* 船積
* ETA
* 通関
* 倉庫着
* Supplier返信速度
* Forwarderの癖
* 分納傾向
* 過去遅延
* 祝日
* 書類不足
の情報を全て統合し、
「これ多分やばいな」を検出。常にすぐに見える位置におく。

## Textile Trade Intelligence

Trade Shelf Agent は、将来的に繊維・生地取引特有の業務知識も扱う。

例:
- mtr / 反数管理
- 数量許容差（±3%）
- 分納判断
- 染め直し履歴
- 日本加工対応
- 不良反履歴
- Supplierごとの癖
- ロット差・縮率
- 工賃参考
- 過去Incidentとの比較

単なる書類管理ではなく、
繊維商社業務の暗黙知を AI が扱える構造へ変換する。

---
# Background / Why Trade Shelf Agent Exists

国際貿易、輸入、三国間貿易の現場では、日々大量の書類と連絡が飛び交っています。

Shipping Instruction（SI）、Invoice（INV）、Packing List（PL）、Bill of Lading（BL）、Booking、LC、TT送金、納期確認、分納対応など、多数の情報を継続的に確認し続けなければなりません。

さらに、情報は単一システムに集約されているわけではなく、

- 仕入先工場
- エージェント
- フォワーダー
- 船会社・航空会社
- 商社営業
- 顧客

など、多数の関係者をまたいで伝言のように流れていきます。

その結果、

- 「PLはまだ？」
- 「INV数量がSIと違う」
- 「BL番号が変わった」
- 「ETAが更新された」
- 「顧客納期に間に合うのか」
- 「TT入金は確認済みか」

といった確認・判断・追跡業務が常に発生します。

しかも、物の動き・書類の進捗・支払い状況のどれか一つでも止まると、物流全体が停止するリスクがあります。

Trade Shelf Agent は、そうした実務上の“混乱”を整理するために設計された、動的状態管理棚（Dynamic Operational Shelf）です。

これは単なるDocument Management Systemではありません。

Trade Shelf Agent は、

- 書類
- 会話
- 状態変化
- 異常
- 判断待ち
- フォローアップ履歴

を一つの operational layer として再構成します。

また、このプロジェクトは、私自身が貿易営業事務・生産管理として行っていた実務を、AI Agent に置き換えていくための基盤でもあります。

Trade Shelf Agent は、

- 仕入先
- 得意先
- 営業
- フォワーダー

の間に立ち、

- 問い合わせに返答し
- 情報を整理し
- 状態を追跡し
- 人間へ判断を促す

“実務オペレーション支援エージェント” を目指しています。

# Future Vision

- 書類間の自動整合性チェック
  - SI / INV / PL / BL / LC の内容照合
  - 数量差異・条件差異・日付差異の検知
  - 分納・統合出荷時の不整合検出

- 貿易オペレーションの状態再構成
  - 「今どこで止まっているか」の可視化
  - 書類不足・返信待ち・承認待ちの自動整理
  - サプライヤー・フォワーダー・営業との会話履歴統合

- フォローアップエージェント
  - 未着PL/INV/BLへの自動督促
  - 顧客向け進捗回答生成
  - ETA変更通知
  - 分納確認・納期調整支援

- 金流・契約条件との統合
  - TT送金確認
  - LC条件充足確認
  - 支払期限・回収状況追跡

- 実務ナレッジ蓄積
  - サプライヤー対応履歴
  - 過去インシデント分析
  - 遅延・差異パターン検知
  - エスカレーション提案

- Agentic Trade Operations
  - Teams / Email / ERP / Excel を横断した状態管理
  - 人間の判断が必要なものだけを棚上げ
  - 実務オペレーション全体の半自動化

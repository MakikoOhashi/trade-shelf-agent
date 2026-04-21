# Trade Shelf Agent

散在するメール・書類・メモを「ぶち込み箱」に入れるだけで、AI が案件ごとに整理し、状態別の棚に並べる商社向けの業務エージェントです（輸入・三国間貿易）。

> Drop messy emails and documents into an inbox. AI organizes them into operational shelves, detects incidents, and helps teams take action with approval workflows.

## Hackathon

- 応募先: Microsoft Agent Hackathon 2026（Zenn）
  - https://zenn.dev/hackathons/microsoft-agent-hackathon-2026
- テーマ: 商社向け「輸入・三国間貿易の管理棚エージェント」

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

- フロントエンド: Next.js / TypeScript / Tailwind CSS
- バックエンド: Node.js / TypeScript（REST API または Route Handlers を想定）
- 共有レイヤ: `packages/shared` で型とドメイン知識を共通化
- AI/推論: LLM は adapter 経由で呼び出し（モデル差し替え可能）
- データ: 初期は mock / JSON / in-memory でも可（必要に応じて DB）

## Azure デプロイ方針（たたき台）

このリポジトリは monorepo ですが、デプロイ単位はサービスごとに分けます。

- `apps/web` → Azure Container Apps
- `apps/api` → Azure Container Apps

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

## 技術
- Frontend: TypeScript, React, Next.js
- Backend: Node.js, TypeScript
- Shared: shared package for types and domain logic
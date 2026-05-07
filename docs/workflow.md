# Agentic Workflow（設計図）

Trade Shelf Agent は単なる管理画面ではなく、散在する業務情報を構造化し、異常検知し、人間承認を挟んで対応ログまで残す **Agentic Workflow** を目指します。

> NOTE: 現時点では workflow 可視化（設計図）を優先し、デモ用の入力（mock / demo data）を前提にしています。  
> 外部メール連携（Gmail / Outlook 等）、PDF/OCR、LLM API 呼び出しは本リポジトリでは **未実装** です。

## Workflow

```mermaid
flowchart TD
  %% Intake
  A[ぶち込み箱] --> B{投入物}
  B -->|メール| C1[メール]
  B -->|書類| C2[書類]
  B -->|メモ| C3[メモ]

  %% Structuring
  C1 --> D[取引要素の抽出]
  C2 --> D
  C3 --> D

  D --> E[SI / INV / PL / ETA / 数量の抽出]
  E --> F[TradeCase への紐付け]
  F --> G[状態再構成]
  G --> H[本棚UI（Shelf）に反映]

  %% Detection -> Response
  H --> I[異常検知（差異・不足・遅延）]
  I --> J{インシデント?}
  J -->|No| H
  J -->|Yes| K[対応案生成]
  K --> L[Human-in-the-loop 承認]
  L --> M{承認?}
  M -->|差し戻し| K
  M -->|承認| N[アクション実行（手動/半自動）]
  N --> O[インシデントログ保存]
  O --> P[仕入先傾向・過去対応の蓄積]
  P --> I
```

## 補足

- 「アクション実行」は現時点では UI 上の操作・ステータス更新・メモ追記などを想定し、外部送信（メール自動送信等）は対象外です。
- 「蓄積」はナレッジ/ログとして将来の対応案生成・異常検知の精度向上に活用します。


# Incident Layer（インシデント層）モデル定義（mock）

## 目的

Incident Layer は、`TradeCase`（案件）から「異常・リスク・対応遅れ」を検知し、対応案（ActionProposal）を生成し、人間の介入（承認・補正）を扱える土台を提供する。

このリポジトリではまず **mock / rule-based** により、

- `TradeCase` → `detectIncidents()` → `Incident[]`
- `Incident[]` → `proposeActions()` → `ActionProposal[]`
- `approveProposal()` による承認状態の遷移

を実装し、DB/API/LLM 連携は後続で追加する。

## 何を異常（Incident）とみなすか

以下は代表例（ルールや閾値は運用で変更される前提）。

- INV数量不足（Shipping Instruction / 注文数量に対して Invoice 数量が不足）
- ETA変更（Forwarder 連絡などにより ETA が改定）
- 書類不足（Invoice / PackingList / BL 等の不足）
- Supplier未返信（一定期間フォローしても返信がない）
- 長期間更新なし（案件更新・イベントが一定期間止まっている）
- 分納（Partial shipment: 分割出荷が発生、または予定されている）
- Freight急増（輸送費が急増し利益を圧迫）
- 粗利低下（想定利益率の低下、値引き要求、為替影響など）
- 通関遅延（通関工程が想定より長い）
- Duplicate案件（同一案件の重複登録や二重計上）

## Severity（重要度）

- `low`：注意喚起レベル（監視）
- `medium`：対応推奨（通常の優先度）
- `high`：重要（納期・費用・品質に影響しやすい）
- `critical`：最重要（即時対応が必要、重大な損失/停止リスク）

## Confidence（確度）

検知・推定の確度を `0.0〜1.0` の数値で表す。

- 0.0：根拠なし（ほぼ推測）
- 0.5：可能性あり
- 0.8：高い確度
- 0.95：ほぼ確実

## ActionProposal（対応案）

Incident に紐づく「次にやること」の候補。少なくとも以下の情報を持つ。

- `type`：対応の種類（例: 書類依頼、数量確認、Forwarderフォロー 等）
- `target`：誰に対するアクションか（supplier / forwarder / customer / internal 等）
- `message`：相手に送る想定文面（mock では雛形）
- `rationale`：なぜそれが必要か（根拠・背景）
- `confidence`：提案の妥当性確度（0.0〜1.0）

## Impact Analysis（影響分析）

Incident を検知した後に「メールを出す」だけで終わらず、**在庫・売約・次便・顧客納期への影響**を先回りで整理して、人間が判断できる材料を提示する層。

このリポジトリではまず **mock / rule-based** として実装し、API / DB / LLM 連携は後続で追加する。

### 目的

- 数量差異や遅延の影響を、数値・根拠つきで一覧化する
- 「どの判断が取り得るか（Decision Options）」を並べ、推奨案を示す
- 人間の介入（分納扱い／次便紐付け／顧客確認など）の判断を速くする

### 出力（例）

- affectedProducts（影響対象 SKU）
- shortageQty / currentStock / allocatedQty / availableQty
- nextShipmentQty / nextShipmentEta / canCoverByNextShipment
- customerImpact（顧客への影響の要約）
- deliveryRisk（low/medium/high）
- recommendedDecision（推奨判断の文）
- decisionOptions（意思決定の候補）

## Human Intervention（人間の介入）

人間が介入して、提案や案件状態を調整する操作。

- `approve`：提案を承認
- `correct`：提案内容を修正（文面/宛先/期限 等）
- `replaceDocument`：書類差し替え（誤添付や再発行対応）
- `markAsPartialShipment`：分納として扱う
- `linkToNextShipment`：次便（次回出荷）に紐づける
- `markAsNoIssue`：問題なしとしてクローズ（誤検知）
- `escalate`：上長・関係部門へエスカレーション
- `requestConfirmation`：社内/顧客へ確認依頼
- `hold`：保留（条件待ち）

## Approval 状態（提案の状態）

ActionProposal の承認・実行状態を表す。

- `draft`：下書き（まだ提示しない/編集中）
- `pendingApproval`：承認待ち
- `approved`：承認済み
- `rejected`：却下
- `executed`：実行済み（送信/更新などが完了）

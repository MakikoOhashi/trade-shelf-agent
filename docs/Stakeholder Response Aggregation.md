# Stakeholder Response Aggregation / Stakeholder Coordination Layer

## 概要

Trade Shelf Agent は単なる貿易管理画面ではない。

メール・PDF・チャット・在庫・売約・入荷予定を横断的に構造化し、

- 問題検知
- 関係整理
- 関係者確認
- 判断提案
- Human Approval
- Decision Log化

までを支援する Trade Operations Intelligence Layer を目指す。

特に重要なのは、

「複数関係者の状態を集約し、次アクションを提案すること」

である。

---

# 構成固定

## Input

1. Outlook / Gmail
   - メール本文

2. メール添付PDF
   - INV
   - PL
   - SI
   - BL

3. Teams / Chat
   - 営業確認
   - Forwarder確認
   - 仕入先確認
   - エスカレーション

---

## Core

4. Azure AI Document Intelligence
   - PDF抽出
   - OCR
   - 書類構造化

5. Azure OpenAI
   - 構造化
   - SI / INV / BL 紐付け
   - Incident検知
   - 判断提案
   - 類似案件検索
   - 要確認事項整理

6. Cosmos DB
   保存対象:
   - TradeGraph
   - Incident
   - HumanIntervention
   - DecisionLog
   - StakeholderResponse
   - Timeline

---

## Reference

7. Excel Online / SharePoint
   - 在庫表
   - 売約表
   - 入荷予定表
   - SKU情報

8. Cosmos DB
   - 過去案件
   - 過去判断
   - 仕入先傾向
   - Incident履歴

---

## Output

9. Teams
   - 営業確認
   - エスカレーション
   - 承認依頼
   - 判断提案
   - 状況共有

---

# 基本ワークフロー

メール / PDF / チャットを取り込む

↓

SI・INV・BL・Shipment・在庫・売約・次便へ自動紐付け

↓

不足・遅延・数量差異・書類不足を検知

↓

在庫・売約・次便・過去案件を照合

↓

営業・Forwarder・仕入先へ確認事項を整理

↓

Teamsへ確認依頼・状況共有を出す

↓

関係者回答を集約

↓

AIが次アクションを提案

↓

人間が承認・修正・保留・エスカレーション

↓

DecisionLog に記録

---

# Stakeholder Response Aggregation

## 対応したい実務状態

1 Shipment
↓
複数商品
↓
複数営業
↓
複数顧客
↓
回答状態がバラバラ
↓
全体判断がまだ未確定

---

# Example

## Shipment Delay Detected

ETA:
5/18 → 5/25

---

## Affected Sales

### 営業A
- NG
- AIR希望

### 営業B
- 5/27まで許容

### 営業C
- 確認中

### 営業D
- 未返信

---

## Decision Deadline

5/12 15:00

---

## Current Recommendation

- AのみAIR切替
- B/C/Dは船維持
- C/D未返信時は営業責任者へ escalation

---

# このレイヤーでやりたいこと

Trade Shelf Agent は、

「AIが勝手に判断する」

のではなく、

「AIが関係整理・状況集約・判断材料整理・次アクション提案を行い、
最終判断は人間が行う」

ことを重視する。

---

# Human-in-the-loop

## AI

- detects
- structures
- links
- retrieves
- summarizes
- proposes

---

## Human

- negotiates
- confirms
- approves
- escalates
- overrides
- decides

---

# 目指す状態

担当者が、

- メールを探し回らなくていい
- 在庫表を探さなくていい
- 売約表を探さなくていい
- 次便予定を探さなくていい
- 過去案件を探さなくていい

状態を作る。

AIが必要情報を整理し、

「今、誰に何を確認すべきか」
「どの判断が現実的か」

を提示する。

その上で、人間が最終判断を行う。
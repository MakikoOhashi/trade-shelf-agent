# 業務モデル設計

Trade Shelf Agent は、貿易業務を単なる画面ではなく、AI が理解できる業務モデルとして構造化する。

## 中核モデル

### TradeCase
貿易案件の最小単位。

- caseId
- customer
- supplier
- tradeType: import / triangular
- status
- products
- documents
- shipment
- incidents
- timeline
- nextActions

### ShipmentState
船積・輸送・入港・通関の状態。

- notArranged
- bookingRequested
- shippingPending
- shipped
- inTransit
- arrived
- customsCleared
- delivered
- completed

### TradeDocument
案件に紐づく書類。

- SI
- Invoice
- PackingList
- B/L
- ArrivalNotice
- ForwarderMail
- Other

### MissingDocument
不足している書類や情報。

- missingInvoice
- missingPackingList
- missingBL
- missingETA
- missingQuantityConfirmation
- missingSupplierReply
- missingForwarderReply

### IncidentType
AI が検知すべき異常。

- invoiceQuantityMismatch
- missingDocument
- delayedShipment
- etaChanged
- supplierNoResponse
- partialShipment
- marginRisk
- duplicateCase
- staleCase

### SupplierBehavior
仕入先ごとの傾向。

- frequentDelay
- frequentPartialInvoice
- slowReply
- documentErrorProne
- stable
- highRisk

### MarginRisk
利益が崩れる可能性。

- costIncrease
- freightIncrease
- exchangeRateImpact
- quantityShortage
- discountRequest
- unexpectedCharge

---

## 状態遷移

TradeCase は以下のように進む。

1. 情報投入
2. 案件候補作成
3. 書類紐付け
4. 状態判定
5. 不足検知
6. 異常検知
7. 対応案生成
8. ユーザー承認
9. ログ保存
10. 完了または継続監視

---

## AI が扱うべき問い

- この案件は今どこで止まっているか
- 誰の返信待ちか
- どの書類が足りないか
- 数量に差異はあるか
- ETA変更の影響はあるか
- 過去に似たインシデントはあったか
- 次に誰へ何を送るべきか
- この仕入先は遅延傾向があるか
- 粗利リスクはあるか

---

## 設計原則

- UIではなく業務状態を中心に設計する
- AIが読める構造にする
- 人間の承認を必ず挟む
- 完全自動化より、見落とし防止と判断支援を優先する
- 現場の入力負荷を増やさない
- メール・書類・メモから自然に状態を再構成する
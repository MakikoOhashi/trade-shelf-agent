# Workspace上部ピル（Document tabs）の役割・紐付け調査（2026-05-29）

## TL;DR（今回の結論）

- Workspace上部に表示されている「ピル」は、実装上は **Document Workspace の document tabs（`renderDocumentTabs`）**。
- 現状は **Document entity / operational context / missing state / shipment state** がすべて同じ「documents配列」に混在しており、スコープ（TradeCase/Shipment/Document）が崩れやすい。
- 「全Shipmentで INV-1122/INV-1240 が表示される」原因は、`buildDocumentWorkspaceDocuments()` が **Shipment単位でINVを絞り込んでいない**（`tc.invoiceNumbers` をそのまま全部tabsへ出している）ため。

---

## 0. 前提：このリポジトリの “TradeCase” の扱い（mock）

`packages/shared/src/mockTradeCases.ts` のコメント通り、Shelf redesign のmockでは

- **Book = shipment slice**（分納を複数TradeCase行で表現）
- `TC-2026-0001`（planned/unshipped）と `TC-2026-0001-S1`, `TC-2026-0001-S2`（分納1/2）が別TradeCaseとして並ぶ

一方で、`baseTc20260001` をspreadしているため、下記のような“混在”が起きやすいです。

- `invoiceNumbers` が **SI/TradeCase（master）側の情報として 2件（INV-1122, INV-1240）を保持したまま**
- `shipmentEntity.supplierInvoices` は **Shipment slice に応じて 1件（S1は1122 / S2は1240）**

この **二重の参照（tradeCase-scoped と shipment-scoped）** を、UI側が意識して分離できていないのが今回の根本要因です。

---

## 1. Workspace上部ピルの生成元（どのfieldから？スコープは？）

### ピルが生成される場所

- Document Workspace の上部ピル（タブ）は、`apps/web/app.js` の `renderDocumentTabs()` が `documents[]` をループして生成しています。
  - ラベルは `d.label`（なければ `d.id`）
  - missing状態は `d.status === "missing"` で “書類待ち” のミニpillを付与

### ピル一覧（例）と生成元

以下は、質問に挙がっているピルの「現状の生成元」です（Document Workspace想定）。

#### D. Shipment / workflow state（Shipment-scoped-ish）

- `Shipment`
  - 生成元：`apps/web/app.js` の `buildDocumentWorkspaceDocuments()` が `shipmentDoc` を常に追加
  - スコープ：現状は `tc.shipmentEntity` 依存（=表示しているTradeCase行のShipment slice）
  - 備考：本来は “document” ではなく “shipment context view” だが、tabsに混在

#### A. Document entity（ただしスコープが混線）

- `SI-2026-001`
  - 生成元：`buildSiWorkspaceDocuments()` → `siDoc`（`label: siNo`）
  - スコープ：TradeCase（正確には master instruction / SI）

- `INV-1122`, `INV-1240`
  - 生成元：`buildDocumentWorkspaceDocuments()` 内の `invoiceNos` → `invDocs`
    - `invoiceNos` は以下をマージして `uniqStrings()`：
      - `tc.invoiceNumbers[].invoiceNo`（tradeCase-scoped）
      - `tc.shipmentEntity.supplierInvoices[]`（shipment-scoped）
      - `tc.siEntity.relatedInvoiceNos[]`（SI-scoped）
  - スコープ：**本来は shipment-scoped であるべきだが、現状は tradeCase/SI 由来も混ざる**

- `BL-SZX-7781`
  - 生成元：`buildDocumentWorkspaceDocuments()` の `blDoc`（`label: blNo`）
    - `blNo = sh?.blNo || tc?.blNumbers?.[0] || "BL-SZX-7781"`
  - スコープ：現状は shipmentEntity優先（shipment slice）だが、tradeCase fallback もあり混線しうる

#### B. Missing state（missing placeholderとして tabs に混在）

- `PL missing`
  - 生成元：`buildDocumentWorkspaceDocuments()` の `plDoc`
  - スコープ：現状は **ハードコード**（`const hasAnyPlMissing = true;`）で常に `status: "missing"`
  - 備考：missing “state” を “document tab” として表現している

#### C. Operational context（TradeCase-scoped）

- `Sales response`
  - 生成元：`buildSiWorkspaceDocuments()` の `sales-response` を `buildDocumentWorkspaceDocuments()` で `label: "Sales response"` に差し替えてtabsへ混在
  - スコープ：TradeCase（意思決定メモ）

- `売約`
  - 生成元：`buildSiWorkspaceDocuments()` の `sales-commitment` を `buildDocumentWorkspaceDocuments()` で `label: "売約"` に差し替えてtabsへ混在
  - スコープ：TradeCase（sales commitments）

---

## 2. Document viewer の紐付け（何に紐づいているか）

### 現状の仕組み

- “ピル” 自体は `renderDocumentTabs()` が単にボタンを出しているだけで、viewerのstateは `workspaceUiByModalId` の `activeDocId` で管理。
- `openDocumentWorkspace(tradeCaseId, focusType, focusId, initialDocId)`（`apps/web/app.js`）で
  1) `documents = buildDocumentWorkspaceDocuments(tc, type, id)` を生成
  2) `resolveFocusDocId({ focusType, focusId, documents })` を優先して `ui.activeDocId` を決める
  3) `documentWorkspaceRenderer.renderDocumentWorkspace()` がtabs + viewer を描画

### 「なぜ全shipmentでINV-1122が表示されてしまったのか」

1) split shipment の各TradeCase行（例：`TC-2026-0001-S1`, `TC-2026-0001-S2`）は、`shipmentEntity` は異なるが `invoiceNumbers` は同一（baseをspread）  
2) `buildDocumentWorkspaceDocuments()` は tabs用の `invoiceNos` を作る際に
   - `tc.invoiceNumbers`（= INV-1122 + INV-1240）をそのまま含める  
   - その結果、S1/S2どちらのShipment sliceでも **両方のINVが tabs に出る**
3) つまり「表示」自体が tabs生成ロジックで起きており、viewerの紐付けより前に混線している

---

## 3. 現状の問題点（構造として壊れやすいところ）

- `documents[]` が “Document entity” だけではなく、以下まで兼務している
  - shipment context（`Shipment`）
  - operational context（`Sales response`, `売約`）
  - missing placeholder（`PL missing`）
- `buildDocumentWorkspaceDocuments()` の `invoiceNos` が **複数スコープ（TradeCase/SI/Shipment）を素直にunion** している  
  → “Shipmentを切り替えたらtabsが変わる” という期待が崩れる
- PL missing が **ハードコードで常時missing** なので、Shipment状態に関係なく混乱を招く

---

## 4. 推奨構造（Trade Shelf Agentとして自然なrelationship）

期待イメージ（提示いただいたものに合わせて定義）：

- TradeCase（master）
  - SI（master instruction）
  - Shipments（0..n）
    - shipment.documents（0..n）
      - Invoice（0..n）
      - BL（0..1）
      - PL（0..1）
      - …（必要に応じて）
  - operational context（Sales response / 売約 / decision logs / risk tags など）

### ピル（Workspace上部）の責務定義（提案）

- **Document entity pills**：Shipment（もしくはSI）にぶら下がる “document” のみ  
  例：`INV-1122`, `INV-1240`, `BL-...`, `PL-...`, `SI-...`
- **Missing state**：document entity のステータスとして表現（tabsの中で “未着” バッジ等）  
  例：`PL`（status: missing）※「PL missing」という別pillにしない
- **Operational context**：tabsではなく別UI（右ペイン/summary/notes）へ  
  例：`Sales response`, `売約`
- **Shipment/workflow state**：ヘッダやサマリとして表示（tabsに混ぜない）  
  例：`Shipment`, `inTransit`

---

## 5. 最小修正案（demoを壊さず、まず崩れを止める）

「実装は今回しない」前提で、修正点だけを最小に列挙します。

### (A) INVが全Shipmentに出る問題を止める（最優先）

- `buildDocumentWorkspaceDocuments()` の `invoiceNos` を **shipment-scoped優先で絞る**
  - `type === "shipment"` の時は `sh.supplierInvoices`（および `sh.switchInvoices` があれば）を優先し、`tc.invoiceNumbers` はfallbackにする
  - あるいは `tc.invoiceNumbers` から `shipmentRefs / shipmentId` による紐付けキーを導入する（ただし今回は構造変更が大きい）

### (B) Operational context を tabs から外す（混在の解消）

- `Sales response` / `売約` を `documents[]` へ入れない
- 右ペインの “状況/メモ” に寄せる（既に `buildWorkspaceOperationalSummary()` があるので、そこへ統合しやすい）

### (C) PL missing のハードコードをやめる

- `hasAnyPlMissing = true` を撤廃し、`tc.caseProgress.documents` や `decisionContext.documentStatus` 等からmissing判定する
  - もしくは demo維持のため、**shipment slice ごとに** missing を出すように “条件” だけを調整する

---

## 6. 追跡用：主要な関数・ファイル

- tabs/pill生成：`apps/web/app.js` → `renderDocumentTabs()`
- Workspace documents組み立て：`apps/web/app.js` → `buildDocumentWorkspaceDocuments()`
- focus → activeDocId：`apps/web/app.js` → `resolveFocusDocId()`, `resolveInitialDocId()`
- split shipment mock：`packages/shared/src/mockTradeCases.ts`（`baseTc20260001` と `mockTradeCases`）


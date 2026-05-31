# Manual QA: State Transition Candidate（手動 apply）

目的: Phase 6-1〜6-4 の StateTransitionCandidate flow が壊れていないか確認する（実装変更なし）。

確認したい項目（対応表）:
1. candidate が出る ingest サンプルを流す → **Test 1**
2. Workspace右ペインに表示される → **Test 2**
3. ボタン押下前は棚が動かない → **Test 3**
4. ボタン押下後だけ棚が動く → **Test 4**
5. 再押下できない → **Test 4**
6. conflict時に棚が動かない → **Test 5**
7. Activity Log と case timeline に残る → **Test 6**
8. Approval Center に出ない → **Test 7**

## 前提

- `apps/web` の UI モックを使用（データは in-memory / mock）。
- 初期データに `Shipment SHP-2026-009` を持つ `TradeCase TC-2026-0001` が存在し、`shipmentState` が `shippingPending` で開始する。
- 起動:
  - `cd apps/web`
  - `python3 -m http.server 5173`
  - ブラウザで `http://localhost:5173`
- 途中で状態が崩れたら、ページをリロードして最初から（in-memory state がリセットされる想定）。

## candidate が出る ingest 入力例（固定）

以下は **(a) PL キーワードで高 confidence thread を作りつつ**、**(b) shipped / departed で state transition signal を出し**、**(c) SHP-2026-009 で TradeCase と紐づけ**るための入力。

```txt
PL update for SHP-2026-009: Goods have shipped today and departed from the supplier warehouse. Please proceed with the next step.
```

ポイント:
- `PL` を含める（`missing_document_check` thread が生成され、confidence が 0.8 以上になりやすく、UI で「この状態に反映」ボタンが出る）
- `SHP-2026-009` を含める（既存 mock TradeCase の Shipment に一致させる）
- `shipped / departed` を含める（`shippingPending → inTransit` の候補が生成される）

---

## Test 1: Candidate generation

Input:
- 上記「candidate が出る ingest 入力例」を使用

Steps:
1. 画面上部タブで `Approvals` を開く
2. 右側の `業務連絡を試す` に入力を貼り付ける
3. `分類モード` が `モック` になっていることを確認
4. `モックを実行` を押す

Expected:
- `詳細（debug）` を開くと `stateTransitionCandidates` 相当の出力が 1 件以上ある（少なくとも Shipment 向けが出る）
- candidate の `id` が `STC-` で始まる
- candidate の `entityType` が `Shipment`、`entityId` が `SHP-2026-009`
- candidate の `fromState` が `shippingPending`、`toState` が `inTransit`
- candidate の `decision` が `auto_apply`（この場合 UI に手動 apply ボタンが出る）

## Test 2: Workspace display

Steps:
1. タブで `Shelf` を開く
2. `TC-2026-0001` の案件カードを開く（案件詳細モーダル）
3. `Shipment Workspace を開く` を押す
4. Workspace 内の右ペイン（右カラム）を確認する

Expected:
- 右ペインに `状態遷移候補 / State Transition Candidate` セクションが表示される
- `shippingPending → inTransit` のカードが表示される
- `この状態に反映` ボタンが表示される（未適用状態）

## Test 3: No movement before apply

Steps:
1. **apply ボタンを押さずに**、`Shelf` タブに戻る（または案件詳細の表示を確認）

Expected:
- `TC-2026-0001` の棚位置が ingest 前と変わらない（`shippingPending` のまま）
- 案件詳細の `shipmentState` 表示が `shippingPending` のまま

## Test 4: Manual apply

Steps:
1. `Shipment Workspace` に戻る
2. `状態遷移候補` カードの `この状態に反映` を押す

Expected:
- `Shipment SHP-2026-009` の `shipmentState` が `inTransit` に更新される
- `Shelf` 上で `TC-2026-0001` が `inTransit` 側の棚（例: 「船積輸送中（洋上）」相当）へ移動する
- 同じ candidate のボタンが `disabled` になり、表示が `反映済み` になる（再押下できない）

## Test 5: Conflict

狙い: `current state !== fromState` のとき apply されず、棚も動かないこと。

Steps:
1. **Test 4 を完了した状態**（すでに `inTransit`）で、もう一度 Test 1 と同じ ingest input を流して candidate を再生成する
2. 生成された `shippingPending → inTransit` candidate の `この状態に反映` を押す

Expected:
- `conflict` 扱いとなり、状態更新が発生しない（`shipmentState` は `inTransit` のまま）
- `Shelf` 上の棚位置が変わらない
- Activity Log に conflict の記録が残る（Test 6 参照）

## Test 6: Logs（Activity Log / case timeline）

Steps:
1. タブで `Activity` を開く
2. ingest 実行後のログを確認する
3. manual apply 後のログを確認する
4. `Shelf` → `TC-2026-0001` 案件詳細 → `timeline`（時系列）を確認する

Expected:
- Activity に `状態遷移候補を検出`（`state_transition_candidate_detected`）が残る
- Activity に `状態遷移を手動反映`（manual apply）が残る
- case timeline に `statusChanged` 相当のイベントが追加される（文面に `状態遷移を反映: Shipment SHP-2026-009 shippingPending → inTransit` が含まれる）
- conflict テストを実施した場合、Activity に `反映せず（conflict）` が残る

## Test 7: Approval Center（Issues / 承認センター）

Steps:
1. タブで `Issues` を開く（左が Approval Center / 承認センター）
2. candidate に関連しそうな新規 Issue / Approval が増えていないか確認する

Expected:
- StateTransitionCandidate は Approval Center に出ない
- candidate 生成だけで `ActionPlan` や `IssueMutation` が新規作成されない（少なくとも candidate 起因で勝手に増えない）

---

## Console / Debug 確認ポイント（可能なら）

この UI は `<script type="module">` のため、DevTools Console で `state` がそのまま参照できない場合があります。
その場合は次のどれかで確認します（実装変更なしで可能な範囲）:

- `Issues` の ingest 結果 `詳細（debug）` を開き、threads / links / activityEvents の増加を目視する
- DevTools で `applyStateTransitionCandidate` に breakpoint を置き、Scope 上の `state.latestIngestResult.stateTransitionCandidates` / `state.appliedStateTransitionCandidateIds` を確認する
- DevTools で `recordTimelineEvent` に breakpoint を置き、対象 `tradeCase.timeline` が更新されることを確認する


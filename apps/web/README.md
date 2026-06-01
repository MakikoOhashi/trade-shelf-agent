# Web UI (apps/web)

このフォルダは、Trade Shelf Agent のデモ用 Web UI（framework-less SPA）です。
Slack と Web は入口が違うだけで、どちらも同じ ingest pipeline を通ります（詳細は `docs/current-architecture.md`）。

## What you can do in the demo UI

- Shelf: TradeCase（案件）を「棚/本」の比喩で一覧し、状態と詰まりを把握する
- Document Workspace: 案件に紐づく書類・番号・状況を横断して確認する
- Approvals: 外部送信や状態更新など、Human-in-the-loop が必要な候補を承認する
- Activity: ingest の分類・紐付け・下書き生成・承認待ち等の履歴を時系列で確認する
- Requests (Inbox / Conversation hub): Slack 相当の会話を「完全再現」するものではなく、デモ用に投入/追跡できるビュー

## Notes

- この UI はデモ向け実装です（新機能追加ではなく、現状実装の説明を優先しています）。
- 実行方法はリポジトリルートの `README.md` を参照してください。


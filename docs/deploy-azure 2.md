# Azure App Service (Linux) 一体デプロイ手順

この手順は **Trade Shelf Agent を Azure App Service (Linux) 1つで Web + API 一体デプロイ** するための最小構成です。

## 前提

- Node.js: **20**（App Service の Runtime stack で Node 20 を選択）
- Web と API は同一オリジン
  - Web: `/`
  - API: `/ingest/mock`, `/ingest/llm`, `/ai/classify`, `/ai/ping`
- `apps/api/server.mjs` が `apps/web` を静的配信する（このリポジトリでは既に対応済み）

## 1) App Service を作る

Azure Portal で App Service を作成します。

- Publish: **Code**
- Operating System: **Linux**
- Runtime stack: **Node 20 LTS**
- Region / Resource Group: 既存 Foundry と同じ Resource Group に追加でOK

## 2) App Settings（環境変数）を設定する

App Service → Configuration → Application settings に以下を追加します。

必須（LLM 分類 / LLM ingest を使う場合）:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`

任意:

- `PORT`（未設定なら `3000`）
- `HOST`（未設定なら `0.0.0.0`）

注意:

- `AZURE_OPENAI_*` が未設定でも、静的 UI と `/ingest/mock` は動作します。
- `/ai/ping` と `/ai/classify` と `/ingest/llm` は、未設定時は `ok: false` を返します。

## 3) Startup Command

以下のどちらでも OK です。

- `npm start`
- `node apps/api/server.mjs`

`npm start` を使う場合、リポジトリ root の `package.json` に `start` script が必要です（本リポジトリは追加済み）。

## 4) デプロイ

代表的な方法のいずれかでデプロイします。

- GitHub Actions（推奨）
- Zip Deploy
- ローカル Git（App Service の Deployment Center を使用）

デプロイ後は App Service のログ（Log stream）で起動確認します。

## 5) 動作確認 URL

App Service の URL を `https://<app-name>.azurewebsites.net` とすると:

- `https://<app-name>.azurewebsites.net/`
- `https://<app-name>.azurewebsites.net/ai/ping`
- `https://<app-name>.azurewebsites.net/ingest/mock`
- `https://<app-name>.azurewebsites.net/ingest/llm`

`/ai/ping` は Azure OpenAI の設定が正しければ `ok: true` になります。


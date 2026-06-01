# Current Architecture (as implemented)

この図は「理想構成」ではなく、`README.md` / `apps/api/server.mjs` / `packages/shared/src/ingest.ts` / `packages/shared/src/relationshipResolver.ts` の **現状実装** をベースにしています。

```mermaid
flowchart TD

%% =========================
%% Clients / Channels
%% =========================
subgraph Clients["Clients / Channels"]
  WEB["Web UI (apps/web)"]
  SLACK["Slack (workspace)"]
end

%% =========================
%% Hosting
%% =========================
subgraph Azure["Azure App Service (Linux) - single deployment"]
  API["Node server (apps/api/server.mjs)\n- serves SPA static (apps/web)\n- provides /slack, /ingest, /api endpoints"]
  STORE["File-backed demo store\nTRADE_SHELF_DATA_DIR=/home/data\n- activity-events.json\n- demo-approvals.json\n- demo-trade-cases.json\n- pending-clarifications.json\n- trade-case-overrides.json"]
end

WEB -->|"GET / (SPA), assets"| API

%% =========================
%% External AI + Slack API
%% =========================
subgraph External["External Services"]
  AOAI["Azure OpenAI / Foundry\n(OpenAI client with AZURE_OPENAI_ENDPOINT)"]
  SLACK_API["Slack Web API\nchat.postMessage (thread reply)"]
end

%% =========================
%% Ingest entrypoints
%% =========================
subgraph Entrypoints["Entrypoints (demo paths)"]
  SLACK_EVENTS["/slack/events\nSlack Events API receiver"]
  INGEST_MOCK["/ingest/mock\n(runMockIngest)"]
  INGEST_LLM["/ingest/llm\n(ingestWithLlmOrMock)"]
end

SLACK -->|"Events API: message"| SLACK_EVENTS
SLACK_EVENTS --> API

WEB -->|"POST /ingest/mock\n(raw text)"| INGEST_MOCK --> API
WEB -->|"POST /ingest/llm\n(raw text)"| INGEST_LLM --> API

%% =========================
%% Ingest pipeline (shared)
%% =========================
subgraph Pipeline["Ingest pipeline (packages/shared/src/ingest.ts)"]
  RAW["RawInput\n(id, rawText, senderName, source, threadTs, receivedAt)"]
  CONTEXT["resolveContext()\n- enough? / needs clarification?"]
  CLASSIFY["LLM classification (optional)\nclassifyThreadsWithLlm()\n+ linkEntitiesByRules()"]
  BUILD["buildIngestResultFromThreads()\n(runIngestPipeline-compatible output)"]
  RULES["Rule-based linking / canonicalization\n- EntityLink\n- issue link resolution\n- state transition candidates"]
  REL["relationship resolver\nresolveOperationalContext()\n(packages/shared/src/relationshipResolver.ts)\n- map INV/SI/SHP -> TradeCase\n- PL status (missing/received/unknown)"]
  DRAFTS["Draft documents / Action plans\n- supplier followup email draft\n- teams reply draft\n(status: drafted / pending_approval)"]
  EVENTS["Activity events\n(type: classified/entity_linked/.../approval_required)\n+ pendingClarifications update"]
end

API -->|"construct RawInput"| RAW --> CONTEXT
CONTEXT -->|"resolved enough"| CLASSIFY --> BUILD --> RULES --> REL --> DRAFTS --> EVENTS
CONTEXT -->|"clarification required"| EVENTS

CLASSIFY -->|"uses"| AOAI

%% =========================
%% Operational responder (server-side glue)
%% =========================
subgraph Responder["Operational Responder (apps/api/server.mjs)\n(server-side glue for demo)"]
  OR_PL["PL missing detection bridge\n- reads ingestResult.drafts/activityEvents\n- creates approval item for supplier followup\n- optionally replies in Slack thread"]
end

EVENTS -->|"approval_required / operational_responder"| OR_PL
OR_PL -->|"chat.postMessage (thread reply)"| SLACK_API --> SLACK

%% =========================
%% UI surfaces
%% =========================
subgraph UISurfaces["UI surfaces (apps/web/app.js)"]
  ACT_FEED["Activity log\nGET /api/activity"]
  APPROVALS["Approval Center\nGET /api/demo/approvals\nPOST /api/demo/approvals/approve"]
  SHELF["Shelf\nGET /api/demo/tradecases\n(GET/POST) /api/demo/tradecase-overrides"]
end

API -->|"persist snapshots"| STORE
STORE -->|"load on startup"| API

API --> ACT_FEED --> WEB
API --> APPROVALS --> WEB
API --> SHELF --> WEB

%% =========================
%% Key Scenario (demo path)
%% =========================
subgraph Scenario["Scenario: 営業問い合わせ → clarification → PL未着判定 → supplier followup draft → approval"]
  S1["1) 営業が Slack で問い合わせ\n(例: INV/PL状況確認)"]
  S2["2) /slack/events で受信\nRawInput化 + activity記録"]
  S3["3) resolveContext()\n情報不足なら pending clarification を生成\n(clarification_required / clarification_waiting)"]
  S4["4) 営業が Slack thread で追加情報返信\n(例: INV-1234 / SI-2026-001)"]
  S5["5) pending clarification match\n(original + resolved entities で再構成して ingest 継続)"]
  S6["6) relationship resolver で TradeCase へ紐付け\nPL status = missing を判定"]
  S7["7) supplier followup email draft 生成\n+ approval_required へ追加"]
  S8["8) Web UI の Approval Center で承認\n(POST /api/demo/approvals/approve)"]
end

S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8
S2 -.-> SLACK_EVENTS
S3 -.-> EVENTS
S5 -.-> Pipeline
S6 -.-> REL
S7 -.-> DRAFTS
S8 -.-> APPROVALS
```


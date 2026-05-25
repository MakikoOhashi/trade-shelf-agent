/**
 * Approval Center is a human decision surface.
 *
 * It should not become a dumping ground for every Incident,
 * internal Issue Candidate, or normal State Transition.
 *
 * Internal-only state updates may be logged to Activity Log and Workspace.
 * External actions and high-risk decisions require explicit human approval.
 */

export function createApprovalCenterRenderer(deps) {
  const {
    DEBUG_PRE_ISSUE,
    approvalStatusLabelJa,
    buildIssueLikeFromMutation,
    classifyLabelJaFromIntent,
    computeConversationThreadsFromRawRequests,
    confidenceLabelJa,
    dedupePreIssueItems,
    detectIncidents,
    displayConversationStatusLabel,
    escapeHtml,
    extractMutationParsed,
    findActionPlanIdFromAnyId,
    findCanonicalConversationIdByOperationalThreadId,
    findCanonicalConversationIdBySourceRawInputId,
    formatLocalTime,
    formatRequestSourceLabel,
    getAvailableApprovalActions,
    getConversationThreadMessageCount,
    getMutationOpenId,
    getPreIssueItemKey,
    getTradeCaseById,
    groupIssueMutationsForApproval,
    hasApprovalCandidateForThread,
    incidentTitleJa,
    isPendingActionItem,
    isPreIssueConversationThread,
    isPreIssueItem,
    matchesMutationId,
    normalizeConversationStatusKey,
    normalizeMutationTitle,
    nowIso,
    resolveThreadForApprovalCandidate,
    resolveThreadForPreIssueItem,
    shortId,
    shouldShowApprovalActionButtons,
    summarizeEntitiesJa,
  } = deps || {};

  const renderApprovalCenter = (params) => {
    const state = params?.state;

  const renderIssues = () => {
    /**
     * Approval Center view
     *
     * 表示上は「承認センター」だが、概念としては
     * - external action の実行前（pending approval）
     * - high-risk な human decision
     * にフォーカスした運用を想定する。
     *
     * Incident（検知結果）や通常の State Transition（内部状態遷移）の全量を
     * ここに集約する、という意図ではない。
     */
    const severityScore = { critical: 4, high: 3, medium: 2, low: 1 };
    const maxSeverity = (list) => {
      const incs = Array.isArray(list) ? list : [];
      let best = "low";
      for (const i of incs) {
        const s = String(i?.severity || "low").toLowerCase();
        if ((severityScore[s] || 0) > (severityScore[best] || 0)) best = s;
      }
      return best;
    };

    const issueNoForCase = (tcId) => {
      const n = state.issueSeqByTradeCaseId && typeof state.issueSeqByTradeCaseId[tcId] === "number" ? state.issueSeqByTradeCaseId[tcId] : null;
      const nn = typeof n === "number" && Number.isFinite(n) ? n : 0;
      return `ISS-${String(Math.max(0, nn)).padStart(4, "0")}`;
    };

    const relativeUpdatedText = (iso) => {
      if (!iso) return "-";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "-";
      const diffMs = Date.now() - d.getTime();
      const min = Math.max(0, Math.round(diffMs / 60000));
      if (min < 60) return `${min}分前`;
      const hr = Math.round(min / 60);
      if (hr < 24) return `${hr}時間前`;
      const day = Math.round(hr / 24);
      return `${day}日前`;
    };

    const severityLabelJa = (sevLike) => {
      const sev = String(sevLike || "").toLowerCase();
      if (sev === "critical" || sev === "high") return "高";
      if (sev === "medium") return "中";
      if (sev === "low") return "低";
      return "中";
    };

    const computeLastUpdatedIso = (tc) => {
      const timeline = Array.isArray(tc && tc.timeline) ? tc.timeline : [];
      const atList = timeline.map((x) => (x && x.at ? String(x.at) : "")).filter(Boolean);
      let best = atList.length ? atList[0] : "";
      for (const at of atList) {
        if (!best) best = at;
        if (String(at) > String(best)) best = at;
      }
      if (best) return best;
      const eta = tc?.shipmentEntity?.eta ? String(tc.shipmentEntity.eta) : "";
      if (eta && /^\d{4}-\d{2}-\d{2}$/.test(eta)) return `${eta}T00:00:00.000Z`;
      return "";
    };

    const buildIssueForCase = (tc) => {
      if (!tc) return null;
      const incidents = Array.isArray(tc?.incidents) ? tc.incidents : detectIncidents(tc);
      const activeIncidents = incidents.filter((i) => i && i.status !== "resolved");
      const blocking = Array.isArray(tc?.caseProgress?.blockingSummary) ? tc.caseProgress.blockingSummary.filter(Boolean) : [];
      const run = tc && tc.resolutionAgentRun ? tc.resolutionAgentRun : null;
      const steps = run && Array.isArray(run.steps) ? run.steps : [];
      const current = run && run.currentStepId ? steps.find((s) => s && s.id === run.currentStepId) : null;

      const missingDocs = Array.isArray(tc?.decisionContext?.documentStatus)
        ? tc.decisionContext.documentStatus.filter((d) => d && String(d.status || "").toLowerCase().includes("missing"))
        : [];

      const title = tc?.title || tc?.siEntity?.siNo || tc?.shipmentEntity?.id || `Case ${tc.id}`;
      const severity = maxSeverity(activeIncidents);

      // Status bucket
      let statusKey = "completed";
      let aiProposal = "完了（要対応なし）";
      let why = "アクション対象がありません。";
      let draft = null;

      const requiresApproval = Boolean(current && current.requiresHumanApproval && current.proposedMessage && current.status !== "sent");
      if (requiresApproval) {
        statusKey = "requiresApproval";
        const msg = current.proposedMessage;
        draft = {
          channel: msg.channel || "-",
          to: Array.isArray(msg.to) ? msg.to : [],
          subject: msg.subject || "",
          body: msg.body || "",
        };
        aiProposal = run?.nextHumanAction?.description || "外部送信文面を作成しました。承認してください。";
        const mismatch = activeIncidents.find((i) => i && i.type === "invoiceQuantityMismatch") || null;
        if (mismatch) {
          why = "INV と SI の数量差異を検知。顧客納期へ影響しうるため。";
        } else if (missingDocs.length) {
          why = "必須書類が未着。出荷/納期へ影響しうるため。";
        } else {
          why = "外部送信前は人間承認が必要なため。";
        }
      } else if (run && (run.status === "waitingExternalReply" || run.status === "waitingExternal")) {
        statusKey = "waitingExternal";
        aiProposal = "外部回答を待機中（仕入先/営業など）";
        why = "前ステップの依頼に対する返答待ちです。";
      } else if (blocking.length || missingDocs.length) {
        statusKey = "blocked";
        const blockText = blocking[0] || (missingDocs[0] ? `${missingDocs[0].docType} missing` : "blocked");
        aiProposal = `ブロック解除の確認: ${blockText}`;
        why = "期限/書類不足などにより進行が止まっています。";
      } else if (activeIncidents.length) {
        statusKey = "requiresApproval";
        const top = activeIncidents.slice().sort((a, b) => (severityScore[String(b?.severity || "low")] || 0) - (severityScore[String(a?.severity || "low")] || 0))[0];
        aiProposal = top ? `状況確認と方針決定: ${top.title || incidentTitleJa(top)}` : "状況確認と方針決定";
        why = "異常検知（インシデント）があります。";
      }

      const updatedAt = computeLastUpdatedIso(tc);
      return {
        id: tc.id,
        tradeCaseId: tc.id,
        issueNo: issueNoForCase(tc.id),
        title,
        severity,
        statusKey,
        aiProposal,
        why,
        draft,
        siNo: tc?.siEntity?.siNo || (Array.isArray(tc?.siNumbers) ? tc.siNumbers[0] : ""),
        shipmentId: tc?.shipmentEntity?.id || (Array.isArray(tc?.shipmentRefs) ? tc.shipmentRefs[0] : ""),
        updatedAt,
        updatedText: relativeUpdatedText(updatedAt),
        commentCount: Array.isArray(tc?.timeline) ? tc.timeline.length : 0,
      };
    };

    const allCases = Array.isArray(state.tradeCases) ? state.tradeCases.filter(Boolean) : [];
    const issues = allCases.map(buildIssueForCase).filter(Boolean);

    const statusTextByKey = {
      requiresApproval: "requires approval",
      blocked: "blocked",
      waitingExternal: "waiting supplier",
      completed: "completed",
    };

    const statusIcon = (k) => {
      const map = { requiresApproval: "○", blocked: "●", waitingExternal: "◑", completed: "✓" };
      return map[k] || "○";
    };

    function getIssueListIcon(item) {
      const status = item && typeof item === "object" ? item.status || item.approvalStatus || item.state || item.statusKey : "";
      const normalized = String(status || "").trim().toLowerCase().replace(/_/g, " ");
      if (["completed", "resolved", "mock sent", "sent"].includes(normalized)) return "✓";
      return "○";
    }

    function issueListStatusLabelJa(statusLike) {
      const raw = String(statusLike || "").trim();
      const normalized = raw.toLowerCase().replace(/_/g, " ");
      if (!normalized) return "-";
      if (normalized === "pending approval" || normalized === "requires approval" || normalized === "pending approval") return "確認待ち";
      if (normalized === "edited") return "編集済み";
      if (normalized === "on hold" || normalized === "held") return "保留中";
      if (normalized === "mock sent") return "完了";
      if (normalized === "approved") return "承認済み";
      if (normalized === "completed" || normalized === "resolved") return "完了";
      return raw.replace(/_/g, " ");
    }

    function deriveStatusForMockIssue(it, statusText) {
      if (it && it.status) return String(it.status);
      if (it && it.statusKey === "completed") return "completed";
      if (it && it.statusKey === "requiresApproval") return "pending_approval";
      return String(statusText || "");
    }

    const issueRow = (it) => {
      const sev = String(it.severity || "low").toLowerCase();
      const sevClass = sev === "critical" || sev === "high" ? "is-high" : sev === "medium" ? "is-medium" : "is-low";
      const statusText = statusTextByKey[it.statusKey] || it.statusKey;
      const linkText = [it.siNo, it.shipmentId].filter(Boolean).join(" / ") || "-";
      const cc = typeof it.commentCount === "number" ? it.commentCount : 0;
      const listStatus = deriveStatusForMockIssue(it, statusText);
      return `<div class="issue-row" role="button" tabindex="0" data-issue-open="${escapeHtml(it.tradeCaseId)}">
        <div class="issue-row__left">
          <div class="issue-row__icon" aria-hidden="true">${escapeHtml(getIssueListIcon({ status: listStatus }))}</div>
          <div class="issue-row__title">${escapeHtml(it.title)}</div>
        </div>
        <div class="issue-row__right">
          <div class="issue-row__meta">
            <span class="issue-pill nt-mono">#${escapeHtml(it.issueNo)}</span>
            <span class="issue-pill ${sevClass}">${escapeHtml(severityLabelJa(sev))}</span>
            <span class="issue-pill">${escapeHtml(issueListStatusLabelJa(listStatus))}</span>
            <span class="issue-pill">${escapeHtml(linkText)}</span>
            <span class="issue-pill">${escapeHtml(it.updatedText || "-")}</span>
            <span class="issue-pill">${escapeHtml(`返信${String(cc)}`)}</span>
          </div>
        </div>
      </div>`;
    };

  const pendingMutations = Array.isArray(state.issueMutationItems) ? state.issueMutationItems.filter(Boolean) : [];

    const renderPendingMutations = () => {
      const actionLabel = (a) => {
        const v = String(a || "");
        if (v === "append_comment") return "既存Issue更新";
        if (v === "create_issue_candidate") return "新規Issue候補";
        if (v === "mark_approval_required") return "承認待ち";
        return v || "-";
      };
      if (!pendingMutations.length) return "";
      const groups = groupIssueMutationsForApproval(pendingMutations);
      const conversationThreads = computeConversationThreadsFromRawRequests(state.rawRequests);
      const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];

      const approvalStatusForGroup = (g) => {
        if (!g) return { status: "pending_approval", actionPlanId: "" };
        const issueId = String(g?.issueId || "").trim();
        const threadId = String(g?.threadId || "").trim();
        const actionPlan =
          plans.find((p) => (issueId && String(p?.issueId || "") === issueId) || (threadId && String(p?.threadId || "") === threadId)) || null;
        const actionPlanId = actionPlan && actionPlan.id ? String(actionPlan.id) : "";
        const approvalEntry = actionPlanId ? state.approvalsByActionPlanId?.[actionPlanId] : null;
        const status = String((approvalEntry && approvalEntry.status) || (actionPlan && actionPlan.status) || "pending_approval");
        return { status, actionPlanId };
      };

      const rows = groups
        .map((g) => {
          const rep = g.representative;
          if (!rep) return "";

          const { status: groupStatus } = approvalStatusForGroup(g);
          if (!isPendingActionItem({ status: groupStatus })) return "";
          const issueId = String(g.issueId || "");
          const repAction = String(rep?.action || "");
          const title = normalizeMutationTitle(String(rep?.title || "")) || "-";
          const parsed = extractMutationParsed(rep);

          const classification = classifyLabelJaFromIntent(parsed.intent);
          const entitiesText = summarizeEntitiesJa(parsed.entities);
          const confText = confidenceLabelJa(parsed.confidence);
          const source = String(rep?.source || "").trim() || "Kimi AI分類";

          const extraActions = Array.isArray(g.others)
            ? g.others
                .map((x) => String(x?.action || ""))
                .filter(Boolean)
                .map(actionLabel)
                .filter(Boolean)
            : [];
          const extraText = extraActions.length ? ` / ${[...new Set(extraActions)].join("・")}` : "";

          const pills = [];
          if (classification && classification !== "-") pills.push(`<span class="issue-pill">${escapeHtml(`分類: ${classification}`)}</span>`);
          if (entitiesText && entitiesText !== "-") pills.push(`<span class="issue-pill">${escapeHtml(`関連: ${entitiesText}`)}</span>`);
          if (confText && confText !== "-") pills.push(`<span class="issue-pill">${escapeHtml(`信頼度: ${confText}`)}</span>`);
          pills.push(`<span class="issue-pill is-source">${escapeHtml(`source: ${source}`)}</span>`);

          const baseAction = repAction === "mark_approval_required" ? "" : actionLabel(repAction);
          const actionText = `${baseAction}${extraText}`.replace(/^\s*\/\s*/, "").trim();
          const approvalMutation =
            repAction === "mark_approval_required"
              ? rep
              : (Array.isArray(g?.others) ? g.others : []).find((x) => String(x?.action || "") === "mark_approval_required");
          const approvalBody = String(approvalMutation?.body || "").trim();
          const approvalMsg = approvalBody ? approvalBody.split("\n")[0].trim() : repAction === "mark_approval_required" ? "承認待ちの対応候補です。" : "";

          const sourceThread = resolveThreadForApprovalCandidate({ ...rep, issueId: g.issueId, threadId: g.threadId }, conversationThreads);
          const evidenceSummary = (() => {
            if (!sourceThread) return "";
            const src = formatRequestSourceLabel(sourceThread.sourceChannel);
            const who = String(sourceThread.requesterName || "—");
            const count = typeof sourceThread.messageCount === "number" ? sourceThread.messageCount : 0;
            return `根拠: ${src} · ${who} · ${count} messages`;
          })();

          return `<div class="pending-mutations__item" role="button" tabindex="0" data-mutation-open="${escapeHtml(getMutationOpenId(rep))}">
            <div class="pending-mutations__top">
              <div class="pending-mutations__title-row">
                <div class="pending-mutations__title">${escapeHtml(title)}</div>
                <span class="issue-pill is-approval">承認待ち</span>
              </div>
              <div class="pending-mutations__sub">
                <span class="issue-pill nt-mono">#${escapeHtml(issueId || "-")}</span>
                ${actionText ? `<span class="issue-pill">${escapeHtml(actionText)}</span>` : ""}
                ${approvalMsg ? `<span class="issue-pill is-message">${escapeHtml(approvalMsg)}</span>` : ""}
              </div>
            </div>
            <div class="pending-mutations__meta">
              ${pills.join("")}
            </div>
            ${
              sourceThread
                ? `<div class="candidate-card-actions">
                  <button class="btn btn--ghost btn--small evidence-thread-button" type="button" data-conversation-thread-open="${escapeHtml(
                    String(sourceThread.id || ""),
                  )}">根拠会話を見る</button>
                  ${evidenceSummary ? `<div class="evidence-summary">${escapeHtml(evidenceSummary)}</div>` : ""}
                </div>`
                : ""
            }
          </div>`;
        })
        .join("");
      return `<section class="pending-mutations" aria-label="Pending AI mutations">
        <div class="pending-mutations__h">対応待ち</div>
        <div class="pending-mutations__subline muted">AIが整理済みの対応案です。承認・編集・保留できます。</div>
        ${rows}
      </section>`;
    };

    const renderPreIssueThreads = () => {
      const list = Array.isArray(state.rawRequests) ? state.rawRequests.filter(Boolean) : [];
      const conversationThreads = computeConversationThreadsFromRawRequests(list);
      const approvalSide = {
        actionPlans: Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans : [],
        issueMutations: Array.isArray(state.issueMutationItems) ? state.issueMutationItems : [],
      };
      const intakeCandidates = conversationThreads.filter((t) => isPreIssueConversationThread(t) && !hasApprovalCandidateForThread(t, approvalSide));
      const replyCandidates = (() => {
        const resolutions = Array.isArray(state.latestIngestResult?.intakeResolutions) ? state.latestIngestResult.intakeResolutions.filter(Boolean) : [];
        const resolutionItems = resolutions.filter((r) => r && r.shouldCreateIssue === false && isPreIssueItem({ kind: "pending_clarification", status: r.status }));

        const pending = Array.isArray(state.pendingClarifications) ? state.pendingClarifications.filter(Boolean) : [];
        const pendingAwaiting = pending.filter((p) => {
          const st = String(p?.status || "");
          return st === "awaiting_clarification_reply" || st === "awaiting_human_selection";
        });

        const byId = new Map();

        for (const p of pendingAwaiting) {
          const id = String(p?.id || "").trim();
          const key = `pc:${id || shortId()}`;
          const threadId = (() => {
            const explicit = String(p?.threadId || "").trim();
            if (explicit) return explicit;

            const sourceRawInputId = String(p?.sourceRawInputId || "").trim();
            if (!sourceRawInputId) return "";

            const plans = Array.isArray(approvalSide.actionPlans) ? approvalSide.actionPlans.filter(Boolean) : [];
            const fromPlan =
              plans.find((ap) => {
                if (!ap) return false;
                if (String(ap.sourceRawInputId || "") !== sourceRawInputId) return false;
                const types = Array.isArray(ap.actionTypes) ? ap.actionTypes.map(String) : [];
                return types.includes("teams_reply_required") || types.includes("email_required");
              }) || null;
            if (fromPlan && fromPlan.threadId) return String(fromPlan.threadId);

            const resolutions = Array.isArray(state.latestIngestResult?.intakeResolutions)
              ? state.latestIngestResult.intakeResolutions.filter(Boolean)
              : [];
            const fromResolution =
              resolutions.find((r) => {
                if (!r) return false;
                if (String(r.sourceRawInputId || "") !== sourceRawInputId) return false;
                return r.shouldCreateIssue === false;
              }) || null;
            if (fromResolution && fromResolution.threadId) return String(fromResolution.threadId);

            return "";
          })();
          byId.set(key, {
            id: key,
            kind: "clarification_reply_candidate",
            threadId,
            operationalThreadId: threadId,
            sourceThreadId: threadId,
            canonicalConversationId: findCanonicalConversationIdBySourceRawInputId(p?.sourceRawInputId) || findCanonicalConversationIdByOperationalThreadId(threadId),
            conversationThreadId:
              findCanonicalConversationIdBySourceRawInputId(p?.sourceRawInputId) ||
              findCanonicalConversationIdByOperationalThreadId(threadId) ||
              undefined,
            requesterName: String(p?.requesterName || "").trim() || "—",
            sourceChannel: String(p?.sourceChannel || "").trim(),
            followUpAt: p?.followUpAt ? String(p.followUpAt) : "",
            missingFields: Array.isArray(p?.missingFields) ? p.missingFields.map((x) => String(x ?? "").trim()).filter(Boolean) : [],
            bodyText: String(p?.clarificationQuestion || "").trim() || "対象のSIまたはShipmentを教えてください。",
          });
        }

        for (const r of resolutionItems) {
          const threadId = String(r?.threadId || "").trim();
          if (!threadId) continue;
          const key = `ir:${threadId}`;
          const thr =
            conversationThreads.find((t) => t && String(t.representativeThreadId || "") === threadId) ||
            conversationThreads.find((t) => t && String(t.id || "") === threadId) ||
            null;
          byId.set(key, {
            id: key,
            kind: "clarification_reply_candidate",
            threadId,
            operationalThreadId: threadId,
            sourceThreadId: threadId,
            canonicalConversationId: findCanonicalConversationIdBySourceRawInputId(r?.sourceRawInputId) || findCanonicalConversationIdByOperationalThreadId(threadId),
            conversationThreadId:
              findCanonicalConversationIdBySourceRawInputId(r?.sourceRawInputId) ||
              findCanonicalConversationIdByOperationalThreadId(threadId) ||
              undefined,
            requesterName: String(thr?.requesterName || "").trim() || "—",
            sourceChannel: String(thr?.sourceChannel || "").trim(),
            followUpAt: "",
            missingFields: Array.isArray(r?.missingFields) ? r.missingFields.map((x) => String(x ?? "").trim()).filter(Boolean) : [],
            bodyText:
              String((r?.status === "status_query" ? r?.statusAnswer : r?.clarificationQuestion) || "").trim() ||
              "対象のSIまたはShipmentを教えてください。",
          });
        }

        return Array.from(byId.values()).filter(Boolean);
      })();

      const rawPreIssueItems = [
        ...replyCandidates.map((item) => ({ ...item, __source: "replyCandidates" })),
        ...intakeCandidates.map((item) => ({ ...item, __source: "intakeCandidates" })),
      ];

      if (DEBUG_PRE_ISSUE) {
        console.table(
          rawPreIssueItems.map((item) => ({
            rawKey: getPreIssueItemKey(item),
            source: item.__source,
            id: item.id,
            kind: item.kind,
            status: item.status || item.resolutionStatus,
            sourceThreadId: item.sourceThreadId,
            conversationThreadId: item.conversationThreadId,
            relatedConversationId: item.relatedConversationId,
            threadId: item.threadId,
            requester: item.requester || item.requesterName || item.sender,
            channel: item.channel || item.sourceChannel,
            message:
              item.lastMessageText ||
              item.lastMessage ||
              item.message ||
              item.body ||
              item.draftBody ||
              item.bodyText ||
              item.text ||
              item.bodyText,
            followUp: item.followUp || item.followUpAt,
            missing: item.missing || item.missingContext || (Array.isArray(item.missingFields) ? item.missingFields.join(",") : ""),
          })),
        );
      }

      const preIssueItems = dedupePreIssueItems([...replyCandidates, ...intakeCandidates]);
      const activeConversationThreadId =
        state.activeConversationThreadId || (preIssueItems.find((x) => x && x.kind !== "clarification_reply_candidate")?.id ?? null);

      if (DEBUG_PRE_ISSUE) {
        console.table(
          preIssueItems.map((item) => ({
            key: getPreIssueItemKey(item),
            id: item.id,
            kind: item.kind,
            status: item.status || item.resolutionStatus,
            sourceThreadId: item.sourceThreadId,
            conversationThreadId: item.conversationThreadId,
            relatedConversationId: item.relatedConversationId,
            threadId: item.threadId,
            requester: item.requester || item.requesterName || item.sender,
            channel: item.channel || item.sourceChannel,
            message:
              item.lastMessageText ||
              item.lastMessage ||
              item.message ||
              item.body ||
              item.draftBody ||
              item.bodyText ||
              item.text ||
              item.bodyText,
            followUp: item.followUp || item.followUpAt,
            missing: item.missing || item.missingContext || (Array.isArray(item.missingFields) ? item.missingFields.join(",") : ""),
          })),
        );
      }

      const sourceLabel = (s) => {
        const v = String(s || "").toLowerCase();
        if (v === "teams") return "Teams";
        if (v === "web") return "Web";
        if (v === "email") return "Email";
        if (v === "manualmemo") return "Manual memo";
        return v || "-";
      };

      const statusBadgeHtml = (status) => {
        const s = normalizeConversationStatusKey(status);
        const label = displayConversationStatusLabel(s);
        const cls = s === "awaiting_clarification" ? "is-pending" : s === "matched" ? "is-matched" : "";
        return `<span class="request-inbox-badge ${cls}">${escapeHtml(label)}</span>`;
      };

      const renderThreadCard = (t) => {
          const isActive = Boolean(activeConversationThreadId && String(t.id) === String(activeConversationThreadId));
          const src = sourceLabel(t.sourceChannel);
          const updated = String(t.updatedAt || "");
          const title = String(t.title || "会話");
          const last = String(t.lastMessageText || "");
          const count = typeof t.messageCount === "number" ? t.messageCount : 0;
          const si = Array.isArray(t.relatedSiIds) ? t.relatedSiIds.filter(Boolean) : [];
          const siChips = si.length ? si.map((x) => `<span class="mini-chip">${escapeHtml(x)}</span>`).join("") : "";
          const sourceThread = resolveThreadForPreIssueItem(t, conversationThreads);
          const openThreadId = sourceThread ? String(sourceThread.id || "") : "";
          const canOpenThread = Boolean(openThreadId.trim());

          return `<div class="conversation-thread-card conversation-thread-card--preissue ${isActive ? "selected" : ""}" role="button" tabindex="0" ${
            canOpenThread ? `data-conversation-thread-open="${escapeHtml(openThreadId)}"` : ""
          }>
            <div class="conversation-thread-meta">
              <div class="conversation-thread-meta__left">
                <div class="conversation-thread-card__sender">${escapeHtml(String(t.requesterName || "—"))}</div>
                <span class="request-channel-badge">${escapeHtml(src)}</span>
                <span class="conversation-thread-card__time nt-mono">${escapeHtml(updated)}</span>
              </div>
              <div class="conversation-thread-meta__right">${statusBadgeHtml(t.status)}</div>
            </div>
            <div class="conversation-thread-card__title">${escapeHtml(title)}</div>
            <div class="conversation-thread-card__preview">${escapeHtml(`最終メッセージ: ${last}`)}</div>
            <div class="conversation-thread-card__foot">
              <span class="nt-mono">${escapeHtml(String(count))} messages</span>
              <span class="conversation-thread-card__foot-right">
                ${siChips ? `<span class="conversation-thread-card__chips">${siChips}</span>` : ""}
                <button class="btn btn--ghost btn--small" type="button" ${canOpenThread ? `data-conversation-thread-open="${escapeHtml(openThreadId)}"` : ""} ${
                  canOpenThread ? "" : "disabled"
                }>会話を見る</button>
              </span>
            </div>
          </div>`;
      };

      const renderReplyCard = (c) => {
          const requester = String(c.requesterName || "—");
          const src = sourceLabel(c.sourceChannel);
          const followUpText = c.followUpAt ? formatLocalTime(String(c.followUpAt)) : "";
          const missing = Array.isArray(c.missingFields) ? c.missingFields.filter(Boolean) : [];
          const missingText = missing.length ? missing.join(", ") : "SI or Shipment";
          const sourceThread = resolveThreadForPreIssueItem(c, conversationThreads);
          const openThreadId = sourceThread ? String(sourceThread.id || "") : "";
          const canOpenThread = Boolean(openThreadId.trim());
          const preview = String(c.bodyText || "対象のSIまたはShipmentを教えてください。").trim();

          const metaChips = [
            `<span class="mini-chip">requester: ${escapeHtml(requester)}</span>`,
            `<span class="mini-chip">missing: ${escapeHtml(missingText)}</span>`,
            followUpText ? `<span class="mini-chip">followUp: <span class="nt-mono">${escapeHtml(followUpText)}</span></span>` : "",
          ]
            .filter(Boolean)
            .join("");

          return `<div class="conversation-thread-card conversation-thread-card--preissue reply-candidate-card" aria-label="Clarification reply candidate">
            <div class="conversation-thread-meta">
              <div class="conversation-thread-meta__left">
                <div class="conversation-thread-card__sender">${escapeHtml(requester)}</div>
                ${src ? `<span class="request-channel-badge">${escapeHtml(src)}</span>` : ""}
              </div>
              <div class="conversation-thread-meta__right">
                <span class="request-inbox-badge is-pending">不足情報の確認待ち</span>
              </div>
            </div>
            <div class="conversation-thread-card__title">${escapeHtml("確認返信候補")}</div>
            <div class="conversation-thread-card__preview">${escapeHtml(preview)}</div>
            <div class="conversation-thread-card__foot">
              <span class="conversation-thread-card__chips">${metaChips}</span>
              <span class="conversation-thread-card__foot-right">
                <button class="btn btn--ghost btn--small" type="button" ${canOpenThread ? `data-conversation-thread-open="${escapeHtml(openThreadId)}"` : ""} ${
                  canOpenThread ? "" : "disabled"
                }>会話を見る</button>
                <button class="btn btn--primary btn--small" type="button" data-clarification-mock-send="${escapeHtml(String(c.id || ""))}">確認返信を送る</button>
                <button class="btn btn--small" type="button" data-clarification-hold="${escapeHtml(String(c.id || ""))}">保留</button>
              </span>
            </div>
          </div>`;
      };

      const cardsHtml = preIssueItems
        .map((item) => {
          if (!item) return "";
          if (item.kind === "clarification_reply_candidate") return renderReplyCard(item);
          return renderThreadCard(item);
        })
        .filter(Boolean)
        .join("");
      const totalCount = preIssueItems.length;

      return `<section class="request-inbox-panel request-inbox-panel--preissue" aria-label="Pre-issue requests">
        <div class="request-inbox-panel__head">
          <div class="request-inbox-panel__title">Issue作成前案件</div>
          <div class="request-inbox-panel__count nt-mono">${escapeHtml(String(totalCount))}</div>
        </div>
        <div class="request-inbox-panel__sub muted">確認が必要な依頼をここで補完し、Issue候補へ進めます。</div>
        <div class="conversation-thread-list">${
          cardsHtml ||
          `<div class="requests-empty">
            <div class="requests-empty__title">Issue化前の確認案件はありません。</div>
            <div class="requests-empty__sub">新しい依頼を取り込むと、確認が必要なものだけここに表示されます。</div>
          </div>`
        }</div>
      </section>`;
    };

    const renderReplyCandidates = () => {
      const resolutions = Array.isArray(state.latestIngestResult?.intakeResolutions) ? state.latestIngestResult.intakeResolutions.filter(Boolean) : [];
      const list = resolutions.filter((r) => r && r.shouldCreateIssue === false && (r.status === "status_query" || r.status === "needs_clarification"));
      const pending = Array.isArray(state.pendingClarifications) ? state.pendingClarifications.filter(Boolean) : [];
      const pendingAwaiting = pending.filter((p) => {
        const st = String(p?.status || "");
        return st === "awaiting_clarification_reply" || st === "awaiting_human_selection";
      });
      if (!list.length && !pendingAwaiting.length) return "";

      const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
      const drafts = Array.isArray(state.latestIngestResult?.drafts) ? state.latestIngestResult.drafts.filter(Boolean) : [];

      const pendingRows = (() => {
        const row = (p) => {
          const original = String(p?.originalRawText || "").trim();
          const q = String(p?.clarificationQuestion || "").trim();
          const requester = String(p?.requesterName || "").trim();
          const followUpAt = p?.followUpAt ? formatLocalTime(String(p.followUpAt)) : "";
          const missing = Array.isArray(p?.missingFields) ? p.missingFields.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
          const missingText = missing.length ? missing.join(", ") : "-";
          const pill = `<span class="issue-pill is-approval">不足情報の確認待ち</span>`;
          const sub = [
            requester ? `requester: ${requester}` : "",
            followUpAt ? `followUp: ${followUpAt}` : "",
            missingText ? `missing: ${missingText}` : "",
          ]
            .filter(Boolean)
            .join(" / ");
          const summary = q || original || "-";
          const summaryText = summary.replace(/\n/g, " ").slice(0, 120);
          return `<div class="pending-mutations__item">
            <div class="pending-mutations__top">
              <div class="pending-mutations__title-row">
                <div class="pending-mutations__title">${escapeHtml("確認返信候補（pending clarification）")}</div>
                ${pill}
              </div>
              <div class="pending-mutations__sub">
                ${sub ? `<span class="issue-pill">${escapeHtml(sub)}</span>` : ""}
                ${summaryText ? `<span class="issue-pill is-message">${escapeHtml(summaryText)}</span>` : ""}
              </div>
            </div>
          </div>`;
        };

        return pendingAwaiting.map((p) => row(p)).join("");
      })();

      const rows = list
        .map((r) => {
          const threadId = String(r?.threadId || "");
          const plan = plans.find((p) => p && String(p.threadId || "") === threadId) || null;
          if (!plan || !plan.id) return "";
          const apId = String(plan.id);
          const approvalEntry = state.approvalsByActionPlanId?.[apId] || null;
          const approvalStatus = String((approvalEntry && approvalEntry.status) || plan.status || "pending_approval");

          const draft = drafts.find((d) => d && String(d.actionPlanId || "") === apId && String(d.channel || "") === "teams") || null;
          const summary = r?.status === "status_query" ? String(r.statusAnswer || "") : String(r.clarificationQuestion || "");
          const summaryText = summary ? summary.replace(/\n/g, " ").slice(0, 90) : "";

          return `<div class="pending-mutations__item" role="button" tabindex="0" data-reply-candidate-open="${escapeHtml(apId)}">
            <div class="pending-mutations__top">
              <div class="pending-mutations__title-row">
                <div class="pending-mutations__title">${escapeHtml(String(plan.title || "確認返信候補"))}</div>
                <span class="issue-pill is-approval">確認返信候補</span>
              </div>
              <div class="pending-mutations__sub">
                <span class="issue-pill">${escapeHtml(approvalStatusLabelJa(approvalStatus))}</span>
                ${draft ? `<span class="issue-pill">draft: ${escapeHtml(String(draft.channel || "teams"))}</span>` : ""}
                ${summaryText ? `<span class="issue-pill is-message">${escapeHtml(summaryText)}</span>` : ""}
              </div>
            </div>
          </div>`;
        })
        .join("");

      return `<section class="pending-mutations" aria-label="Reply candidates">
        <div class="pending-mutations__h">確認返信候補</div>
        ${pendingRows}
        ${rows}
      </section>`;
    };

    const renderReplyCandidateDetail = (actionPlanId) => {
      const apId = String(actionPlanId || "").trim();
      if (!apId) return `<div class="nt-muted">Not found</div>`;

      const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
      const drafts = Array.isArray(state.latestIngestResult?.drafts) ? state.latestIngestResult.drafts.filter(Boolean) : [];
      const resolutions = Array.isArray(state.latestIngestResult?.intakeResolutions) ? state.latestIngestResult.intakeResolutions.filter(Boolean) : [];
      const links = Array.isArray(state.latestIngestResult?.links) ? state.latestIngestResult.links.filter(Boolean) : [];

      const plan = plans.find((p) => p && String(p.id || "") === apId) || null;
      if (!plan) return `<div class="nt-muted">確認返信候補が見つかりませんでした。</div>`;

      const threadId = String(plan.threadId || "");
      const resolution = resolutions.find((r) => r && String(r.threadId || "") === threadId) || null;
      const threadLinks = threadId ? links.filter((l) => String(l?.threadId || "") === threadId) : [];

      const approvalEntry = state.approvalsByActionPlanId?.[apId] || null;
      const approvalStatus = String((approvalEntry && approvalEntry.status) || plan.status || "pending_approval");
      const availableActions = getAvailableApprovalActions(approvalStatus);

      const draft = drafts.find((d) => d && String(d.actionPlanId || "") === apId && String(d.channel || "") === "teams") || drafts.find((d) => d && String(d.actionPlanId || "") === apId) || null;
      const bodyText = draft ? String(draft.body || "") : resolution?.status === "status_query" ? String(resolution.statusAnswer || "") : String(resolution?.clarificationQuestion || "");

      const linked = threadLinks.length
        ? `<div class="kv" style="margin-top:6px;"><span class="muted">linked</span> ${escapeHtml(threadLinks.map((l) => `${l.entityType}:${l.entityId}`).join(", "))}</div>`
        : "";

      const draftPreviewHtml = `<section class="detail-section issue-draft-preview" aria-label="Draft Preview">
        <h3 class="detail-section__title">Draft Preview</h3>
        <div class="kv">
          <span class="muted">channel</span> teams
        </div>
        <pre class="pre pre--compact">${escapeHtml(bodyText || "")}</pre>
      </section>`;

      return `<section class="issue-history-page" aria-label="Reply candidate detail">
        <div class="issue-history-header">
          <button class="btn btn--small btn--ghost" type="button" data-reply-back="1">← Back</button>
          <div class="issue-history-header__title">
            <div class="issue-history-header__h">${escapeHtml(String(plan.title || "確認返信候補"))}</div>
            <div class="issue-history-header__badges">
              <span class="issue-pill">${escapeHtml(approvalStatusLabelJa(approvalStatus))}</span>
              <span class="issue-pill">確認返信候補</span>
            </div>
          </div>
        </div>
        ${
          shouldShowApprovalActionButtons(approvalStatus)
            ? `<div class="issue-current-actions" aria-label="Next actions" style="margin: 12px 0;">
          ${availableActions.approve ? `<button class="btn btn--primary btn--small" type="button" data-reply-approve="${escapeHtml(apId)}">Approve</button>` : ""}
          ${availableActions.edit ? `<button class="btn btn--small" type="button" data-reply-edit="${escapeHtml(apId)}">Edit draft</button>` : ""}
          ${availableActions.hold ? `<button class="btn btn--small" type="button" data-reply-hold="${escapeHtml(apId)}">Hold</button>` : ""}
          ${availableActions.resume ? `<button class="btn btn--small" type="button" data-reply-resume="${escapeHtml(apId)}">Resume</button>` : ""}
          ${availableActions.mock_send ? `<button class="btn btn--small" type="button" data-reply-mock-send="${escapeHtml(apId)}">Mock send</button>` : ""}
        </div>`
            : `<div class="issue-current-actions" aria-label="Next actions" style="margin: 12px 0;">
          <span class="issue-pill">${escapeHtml(approvalStatusLabelJa(approvalStatus) || approvalStatus)}</span>
        </div>`
        }
        ${linked}
        ${draftPreviewHtml}
      </section>`;
    };

    const renderIssueList = () => {
      const sorted = issues
        .slice()
        .sort((a, b) => {
          const sa = severityScore[String(a?.severity || "low").toLowerCase()] || 0;
          const sb = severityScore[String(b?.severity || "low").toLowerCase()] || 0;
          if (sb !== sa) return sb - sa;
          const ua = String(a?.updatedAt || "");
          const ub = String(b?.updatedAt || "");
          if (ub !== ua) return ub > ua ? 1 : -1;
          return String(a?.issueNo || "").localeCompare(String(b?.issueNo || ""));
        });
      const body = sorted.length ? sorted.map(issueRow).join("") : `<div class="nt-muted">No items</div>`;

      const renderIssueListLane = () => {
        const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
        const runtimePlans = plans
          .filter((p) => String(p?.issueId || "").trim())
          .filter((p) => String(p?.status || "") !== "skipped");

        const conversationThreads = computeConversationThreadsFromRawRequests(state.rawRequests);
        const allMutations = Array.isArray(state.issueMutationItems) ? state.issueMutationItems.filter(Boolean) : [];

        const runtimeRows = runtimePlans
          .slice()
          .sort((a, b) => {
            const aa = String(state.approvalsByActionPlanId?.[String(a?.id || "")]?.updatedAt || a?.updatedAt || "");
            const bb = String(state.approvalsByActionPlanId?.[String(b?.id || "")]?.updatedAt || b?.updatedAt || "");
            return String(bb).localeCompare(String(aa)) || String(b?.id || "").localeCompare(String(a?.id || ""));
          })
          .map((ap) => {
            const apId = String(ap?.id || "").trim();
            const issueId = String(ap?.issueId || "").trim();
            const threadId = String(ap?.threadId || "").trim();
            const title = String(ap?.title || "").trim() || issueId || apId || "Issue";

            const approvalEntry = apId ? state.approvalsByActionPlanId?.[apId] : null;
            const approvalStatus = String((approvalEntry && approvalEntry.status) || ap?.status || "pending_approval");

            const updatedAt = String((approvalEntry && approvalEntry.updatedAt) || ap?.updatedAt || "");
            const updatedText = relativeUpdatedText(updatedAt);

          const mutation =
              allMutations.find((m) => (issueId && String(m?.issueId || "") === issueId) || (threadId && String(m?.threadId || "") === threadId)) ||
              null;
            const mutationOpenId = getMutationOpenId(mutation) || getMutationOpenId(ap) || apId;

            const sourceThread = threadId ? conversationThreads.find((t) => t && String(t?.representativeThreadId || "") === threadId) : null;
            const cc = sourceThread && typeof sourceThread.messageCount === "number" ? sourceThread.messageCount : 0;

            const linkedEntities = Array.isArray(ap?.linkedEntities) ? ap.linkedEntities.filter(Boolean) : [];
            const si = linkedEntities.find((l) => String(l?.entityType || "").toLowerCase() === "si") || null;
            const shipment = linkedEntities.find((l) => String(l?.entityType || "").toLowerCase() === "shipment") || null;
            const linkText = [si?.entityId ? String(si.entityId) : "", shipment?.entityId ? String(shipment.entityId) : ""].filter(Boolean).join(" / ") || "-";

            const sevText = "中";

            const pills = [
              `<span class="issue-pill nt-mono">#${escapeHtml(issueId || apId || "-")}</span>`,
              `<span class="issue-pill is-medium">${escapeHtml(sevText)}</span>`,
              `<span class="issue-pill">${escapeHtml(issueListStatusLabelJa(approvalStatus))}</span>`,
              `<span class="issue-pill">${escapeHtml(linkText)}</span>`,
              `<span class="issue-pill">${escapeHtml(updatedText || "-")}</span>`,
              `<span class="issue-pill">${escapeHtml(`返信${String(cc)}`)}</span>`,
            ].join("");

            return `<div class="issue-row" role="button" tabindex="0" data-mutation-open="${escapeHtml(mutationOpenId)}">
              <div class="issue-row__left">
                <div class="issue-row__icon" aria-hidden="true">${escapeHtml(getIssueListIcon({ status: approvalStatus }))}</div>
                <div class="issue-row__title">${escapeHtml(title)}</div>
              </div>
              <div class="issue-row__right">
                <div class="issue-row__meta">${pills}</div>
              </div>
            </div>`;
          })
          .join("");

        const hasAny = Boolean(runtimeRows) || sorted.length > 0;
        const sampleHeading = sorted.length ? `<div class="issue-list__subheading">サンプル案件</div>` : "";
        const sampleBody = sorted.length ? body : "";
        const empty = !hasAny ? `<div class="nt-muted" style="padding: 12px;">No items</div>` : "";

        return `<section class="issue-list" aria-label="Issue list">
          <div class="issue-list__section-title">案件一覧</div>
          <div class="issue-list__section-sub muted">Issue化された案件です。対応待ち・対応済みをまとめて確認できます。</div>
          ${runtimeRows || ""}
          ${sampleHeading}
          ${sampleBody}
          ${empty}
        </section>`;
      };

      return `<div class="operations-main-column" aria-label="Operations main column">
        ${renderPreIssueThreads()}
        ${renderIssueListLane()}
      </div>`;
    };

    const renderTimelineItem = (item) => {
      const t = String(item?.type || "");
      const at = item?.at ? formatLocalTime(item.at) : "";
      const label = item?.label ? String(item.label) : t || "comment";
      const body = item?.bodyHtml ? String(item.bodyHtml) : escapeHtml(String(item?.message || ""));
      const actor = item?.actor ? String(item.actor) : "";
      const meta = [label, actor].filter(Boolean).join(" ・ ");
      return `<div class="issue-timeline-item ${escapeHtml(`tl-${t || "comment"}`)}">
        <div class="issue-timeline-item__dot" aria-hidden="true"></div>
        <div class="issue-timeline-item__card">
          <div class="issue-timeline-item__meta">
            <span class="issue-timeline-item__label">${escapeHtml(meta || "-")}</span>
            ${at ? `<span class="issue-timeline-item__at">${escapeHtml(at)}</span>` : ""}
          </div>
          <div class="issue-timeline-item__body">${body}</div>
        </div>
      </div>`;
    };

    const renderIssueHistoryTimeline = (items) => {
      const list = Array.isArray(items) ? items.filter(Boolean) : [];
      if (!list.length) return `<div class="nt-muted">No history</div>`;

      const rows = list
        .map((it, idx) => {
          const at = it?.at ? formatLocalTime(String(it.at)) : "";
          const timeHtml = at ? `<div class="issue-history-time">${escapeHtml(at)}</div>` : `<div class="issue-history-time"></div>`;
          const isCard = Boolean(it?.isCard);
          const bodyHtml = isCard ? String(it?.bodyHtml || "") : `<div class="issue-history-text">${String(it?.textHtml || "")}</div>`;
          const isLast = idx === list.length - 1;
          return `<div class="issue-history-item ${isCard ? "is-card" : "is-log"}">
            <div class="issue-history-rail" aria-hidden="true">
              <div class="issue-history-dot"></div>
              ${isLast ? "" : `<div class="issue-history-line"></div>`}
            </div>
            <div class="issue-history-main">${bodyHtml}</div>
            ${timeHtml}
          </div>`;
        })
        .join("");

      return `<div class="issue-history-timeline" aria-label="Issue history timeline">${rows}</div>`;
    };

    const renderMutationDetail = (mutationId) => {
      const mutId = String(mutationId || "").trim();
      let mut =
        pendingMutations.find((x) => matchesMutationId(x, mutId)) ||
        (Array.isArray(state.issueMutationItems) ? state.issueMutationItems.find((x) => matchesMutationId(x, mutId)) : null) ||
        null;

      if (!mut && mutId) {
        const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
        const plan = plans.find((p) => p && String(p.id || "") === mutId) || null;
        if (plan) {
          const issueId = String(plan.issueId || "").trim();
          const threadId = String(plan.threadId || "").trim();
          const fromLinked =
            (Array.isArray(state.issueMutationItems)
              ? state.issueMutationItems.find(
                  (x) => x && ((issueId && String(x.issueId || "") === issueId) || (threadId && String(x.threadId || "") === threadId)),
                )
              : null) || null;
	          mut =
	            fromLinked ||
	            ({
	              id: mutId,
	              actionPlanId: mutId,
	              relatedActionPlanId: mutId,
	              issueId: issueId || mutId,
	              threadId,
	              operationalThreadId: threadId || undefined,
	              canonicalConversationId:
	                findCanonicalConversationIdBySourceRawInputId(plan.sourceRawInputId) ||
	                findCanonicalConversationIdByOperationalThreadId(threadId) ||
	                undefined,
	              sourceThreadId: threadId || String(plan.sourceThreadId || "").trim() || undefined,
	              conversationThreadId:
	                findCanonicalConversationIdBySourceRawInputId(plan.sourceRawInputId) ||
	                findCanonicalConversationIdByOperationalThreadId(threadId) ||
	                undefined,
	              relatedConversationId: String(plan.relatedConversationId || "").trim(),
	              action: "mark_approval_required",
	              title: String(plan.title || "Issue candidate"),
	              body: String(plan.description || ""),
	              sourceRawInputId: String(plan.sourceRawInputId || ""),
	              linkedEntities: Array.isArray(plan.linkedEntities) ? plan.linkedEntities : [],
              confidence: typeof plan.confidence === "number" ? plan.confidence : undefined,
              sourceLabel: String(plan.sourceLabel || ""),
            });
        }
      }

      if (!mut)
        return `<div class="detail-empty">
          <div class="nt-muted">LLM候補が見つかりませんでした。</div>
          <div class="nt-mono nt-muted">Mutation detail not found: ${escapeHtml(mutId || "(empty)")}</div>
        </div>`;

      const normalizedMut = { ...mut, title: normalizeMutationTitle(mut?.title) };
      const issueLike = buildIssueLikeFromMutation(normalizedMut);
      const sev = String(issueLike.severity || "low").toLowerCase();
      const sevClass = sev === "critical" || sev === "high" ? "is-high" : sev === "medium" ? "is-medium" : "is-low";

      const statusText = issueLike.statusText || "requires approval";
      const cs = issueLike.currentStatus || {};

      const conversationThreads = computeConversationThreadsFromRawRequests(state.rawRequests);
      let sourceThread = resolveThreadForApprovalCandidate(normalizedMut, conversationThreads);
      if (
        !sourceThread &&
        (String(normalizedMut?.sourceThreadId || "") ||
          String(normalizedMut?.conversationThreadId || "") ||
          String(normalizedMut?.threadId || "") ||
          String(normalizedMut?.issueId || ""))
      ) {
        console.warn("Missing sourceThread for issue candidate detail", {
          candidateId: normalizedMut?.id,
          sourceThreadId: normalizedMut?.sourceThreadId,
          conversationThreadId: normalizedMut?.conversationThreadId,
          threadId: normalizedMut?.threadId,
          issueId: normalizedMut?.issueId,
        });
      }

      const nextActionFromPlans = (() => {
        const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
        const threadId = mut?.threadId ? String(mut.threadId) : "";
        const issueId = mut?.issueId ? String(mut.issueId) : "";
        const matched = plans.find((p) => (threadId && String(p?.threadId || "") === threadId) || (issueId && String(p?.issueId || "") === issueId));
        return matched && matched.title ? String(matched.title) : "";
      })();

      const matchedPlan = (() => {
        const plans = Array.isArray(state.latestIngestResult?.actionPlans) ? state.latestIngestResult.actionPlans.filter(Boolean) : [];
        const threadId = mut?.threadId ? String(mut.threadId) : "";
        const issueId = mut?.issueId ? String(mut.issueId) : "";
        return plans.find((p) => (threadId && String(p?.threadId || "") === threadId) || (issueId && String(p?.issueId || "") === issueId)) || null;
      })();

      const actionPlanId = matchedPlan && matchedPlan.id ? String(matchedPlan.id) : "";
      const resolvedActionPlanId = actionPlanId || findActionPlanIdFromAnyId(String(mut?.issueId || "") || String(mut?.threadId || "") || "");

      if (!sourceThread && resolvedActionPlanId) {
        sourceThread = resolveThreadForApprovalCandidate({ ...normalizedMut, actionPlanId: resolvedActionPlanId }, conversationThreads);
      }
      const approvalEntry = resolvedActionPlanId ? state.approvalsByActionPlanId?.[resolvedActionPlanId] : null;
      const approvalStatus = String((approvalEntry && approvalEntry.status) || (matchedPlan && matchedPlan.status) || "pending_approval");
      const availableActions = getAvailableApprovalActions(approvalStatus);
      const canApprove = Boolean(availableActions.approve);
      const canEdit = Boolean(availableActions.edit);
      const canHold = Boolean(availableActions.hold);
      const canMockSend = Boolean(availableActions.mock_send);

      const draftPreview = issueLike && issueLike.draft ? issueLike.draft : null;

      const actionKey = resolvedActionPlanId || String(issueLike.id || "");

      const currentActionButtonsHtml = (() => {
        if (!shouldShowApprovalActionButtons(approvalStatus)) return "";
        const parts = [];
        if (availableActions.approve)
          parts.push(
            `<button class="btn btn--primary btn--small" type="button" data-mutation-approve="${escapeHtml(actionKey)}">Approve</button>`,
          );
        if (availableActions.edit)
          parts.push(
            `<button class="btn btn--small" type="button" data-mutation-edit="${escapeHtml(actionKey)}">Edit draft</button>`,
          );
        if (availableActions.hold)
          parts.push(`<button class="btn btn--small" type="button" data-mutation-hold="${escapeHtml(actionKey)}">Hold</button>`);
        if (availableActions.resume)
          parts.push(`<button class="btn btn--small" type="button" data-mutation-resume="${escapeHtml(actionKey)}">Resume</button>`);
        if (availableActions.mock_send)
          parts.push(
            `<button class="btn btn--small" type="button" data-mutation-mock-send="${escapeHtml(actionKey)}">Mock send</button>`,
          );
        return parts.join("");
      })();

      const currentStatusHtml = `<section class="issue-current-status ${sevClass}" aria-label="Current Status">
        <div class="issue-current-title">Current Status</div>
        <div class="issue-current-rows">
          <div class="issue-current-row"><span class="k">Current Status</span><span class="v">${escapeHtml(approvalStatusLabelJa(approvalStatus) || String(cs.status || "人間承認待ち"))}</span></div>
          <div class="issue-current-row issue-current-row--pending"><span class="k">承認待ち</span><span class="v">${escapeHtml(String(nextActionFromPlans || cs.nextAction || "AI提案内容の確認"))}</span></div>
          <div class="issue-current-row"><span class="k">AI提案</span><span class="v">${escapeHtml(String(cs.aiProposal || "-"))}</span></div>
        </div>
        ${currentActionButtonsHtml ? `<div class="issue-current-actions" aria-label="Next actions">${currentActionButtonsHtml}</div>` : ""}
      </section>`;

      const processorFlowHtml = (() => {
        const result = state.latestIngestResult || null;
        const hasRaw = Boolean(result && result.rawInput);
        const threads = Array.isArray(result?.threads) ? result.threads.filter(Boolean) : [];
        const links = Array.isArray(result?.links) ? result.links.filter(Boolean) : [];
        const intake = Array.isArray(result?.intakeResolutions) ? result.intakeResolutions.filter(Boolean) : [];
        const muts = Array.isArray(result?.issueMutations) ? result.issueMutations.filter(Boolean) : [];
        const plans = Array.isArray(result?.actionPlans) ? result.actionPlans.filter(Boolean) : [];
        const drafts = Array.isArray(result?.drafts) ? result.drafts.filter(Boolean) : [];
        const events = Array.isArray(result?.activityEvents) ? result.activityEvents.filter(Boolean) : [];

        const threadId = mut?.threadId ? String(mut.threadId) : "";
        const threadEvents = threadId ? events.filter((e) => String(e?.threadId || "") === threadId) : events;
        const hasFailed = threadEvents.some((e) => String(e?.type || "") === "failed_processing");

        const stepDefs = [
          { key: "request", label: "依頼受信", done: hasRaw },
          { key: "tagger", label: "Tagger", done: threads.length > 0 },
          { key: "splitter", label: "Thread Splitter", done: threads.length > 0 },
          { key: "linker", label: "Entity Linker", done: links.length > 0 },
          { key: "intake", label: "Intake Resolver", done: intake.length > 0 },
          { key: "issue", label: "Issue Planner", done: muts.length > 0 },
          { key: "action", label: "Action Planner", done: plans.length > 0 },
          { key: "draft", label: "Draft Writer", done: drafts.length > 0 },
          { key: "approval", label: "Approval", done: approvalStatus !== "pending_approval" && Boolean(approvalStatus) },
        ];

        const currentKey = (() => {
          if (hasFailed) return "";
          if (approvalStatus === "pending_approval") return "approval";
          if (!drafts.length) return "draft";
          if (!plans.length) return "action";
          if (!muts.length) return "issue";
          if (!intake.length) return "intake";
          if (!links.length) return "linker";
          if (!threads.length) return "tagger";
          if (!hasRaw) return "request";
          return "";
        })();

        const classFor = (d) => {
          if (hasFailed && d.key === currentKey) return "failed";
          if (d.key === currentKey) return "current";
          if (d.done) return "done";
          return "pending";
        };

        const statusText = (cls) => {
          if (cls === "done") return "done";
          if (cls === "current") return "current";
          if (cls === "failed") return "failed";
          return "pending";
        };

        const stepsHtml = stepDefs
          .map((d) => {
            const cls = classFor(d);
            return `<li class="processor-step ${escapeHtml(cls)}">
              <div class="processor-step__left">
                <div class="processor-step__dot" aria-hidden="true"></div>
                <div class="processor-step__line" aria-hidden="true"></div>
              </div>
              <div class="processor-step__body">
                <div class="processor-step__label">${escapeHtml(d.label)}</div>
                <div class="processor-step__meta muted">${escapeHtml(statusText(cls))}</div>
              </div>
            </li>`;
          })
          .join("");

        return `<section class="detail-section processor-flow" aria-label="Processor Flow">
          <h3 class="detail-section__title">Processor Flow</h3>
          <ul class="processor-flow__steps">${stepsHtml}</ul>
        </section>`;
      })();

      const draftPreviewHtml = draftPreview
        ? `<section class="detail-section issue-draft-preview" aria-label="Draft Preview">
            <h3 class="detail-section__title">Draft Preview</h3>
            <div class="kv">
              <span class="muted">channel</span> ${escapeHtml(String(draftPreview.channel || "-"))}
              <span class="muted">to</span> ${escapeHtml((Array.isArray(draftPreview.to) ? draftPreview.to : []).join(", ") || "-")}
              ${draftPreview.subject ? `<span class="muted">subject</span> ${escapeHtml(String(draftPreview.subject))}` : ""}
            </div>
            <pre class="pre pre--compact">${escapeHtml(String(draftPreview.body || ""))}</pre>
          </section>`
        : "";

      const emailDraftHtml = `<div class="issue-email-draft">
        <div class="kv">
          <span class="muted">channel</span> ${escapeHtml(String(issueLike.draft?.channel || "-"))}
          <span class="muted">to</span> ${escapeHtml((issueLike.draft?.to || []).join(", ") || "-")}
          ${issueLike.draft?.subject ? `<span class="muted">subject</span> ${escapeHtml(String(issueLike.draft.subject))}` : ""}
        </div>
        <pre class="pre pre--compact">${escapeHtml(String(issueLike.draft?.body || ""))}</pre>
        <div class="issue-actions">
          <button class="btn btn--primary btn--small" type="button" data-mutation-mock-send="${escapeHtml(actionKey)}" ${
            canMockSend ? "" : "disabled"
          }>Mock send</button>
          <button class="btn btn--small" type="button" data-mutation-edit="${escapeHtml(actionKey)}" ${canEdit ? "" : "disabled"}>Edit draft</button>
          <button class="btn btn--small" type="button" data-mutation-hold="${escapeHtml(actionKey)}" ${canHold ? "" : "disabled"}>Hold</button>
        </div>
      </div>`;

      const timeline = Array.isArray(issueLike.timeline) ? issueLike.timeline.slice() : [];
      const draftAt = timeline.length ? String(timeline[timeline.length - 1]?.at || nowIso()) : nowIso();
      timeline.push({
        id: `email:${issueLike.issueNo}`,
        at: draftAt,
        type: "emailDraft",
        label: "Email draft",
        actor: "trade-shelf-agent",
        bodyHtml: emailDraftHtml,
      });

      timeline.sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || "")));
      const timelineHtml = timeline.length ? timeline.map(renderTimelineItem).join("") : `<div class="nt-muted">No timeline yet</div>`;

      const sidebarRows = [];
      if (cs.classification && cs.classification !== "-") {
        sidebarRows.push(
          `<div class="issue-sidebar-row"><div class="issue-sidebar__k">分類</div><div class="issue-sidebar__v">${escapeHtml(String(cs.classification))}</div></div>`
        );
      }
      if (cs.entitiesText && cs.entitiesText !== "-") {
        sidebarRows.push(
          `<div class="issue-sidebar-row"><div class="issue-sidebar__k">関連エンティティ</div><div class="issue-sidebar__v">${escapeHtml(String(cs.entitiesText))}</div></div>`
        );
      }
      if (cs.confidenceText && cs.confidenceText !== "-") {
        sidebarRows.push(
          `<div class="issue-sidebar-row"><div class="issue-sidebar__k">信頼度</div><div class="issue-sidebar__v">${escapeHtml(String(cs.confidenceText))}</div></div>`
        );
      }
      sidebarRows.push(
        `<div class="issue-sidebar-row"><div class="issue-sidebar__k">source</div><div class="issue-sidebar__v">${escapeHtml(String(cs.source || "Kimi AI分類"))}</div></div>`
      );

      const metaPanelHtml = `<aside class="issue-meta-panel" aria-label="Meta Panel">
        ${sidebarRows.join("")}
      </aside>`;

      const actionCardHtml =
        draftPreview &&
        (approvalStatus === "pending_approval" ||
          approvalStatus === "edited" ||
          approvalStatus === "held" ||
          approvalStatus === "approved" ||
          approvalStatus === "planned")
          ? `<div class="issue-action-card" aria-label="Human action card">
              <div class="issue-action-card__title">AIが仕入先確認メールを作成しました。</div>
              <div class="issue-draft-preview">
                <div class="kv">
                  <span class="muted">channel</span> ${escapeHtml(String(draftPreview.channel || "-"))}
                  <span class="muted">to</span> ${escapeHtml((Array.isArray(draftPreview.to) ? draftPreview.to : []).join(", ") || "-")}
                  ${draftPreview.subject ? `<span class="muted">subject</span> ${escapeHtml(String(draftPreview.subject))}` : ""}
                </div>
                <pre class="pre pre--compact">${escapeHtml(String(draftPreview.body || ""))}</pre>
              </div>
              <div class="issue-action-buttons">
                ${
                  shouldShowApprovalActionButtons(approvalStatus)
                    ? `${availableActions.approve ? `<button class="btn btn--primary btn--small" type="button" data-mutation-approve="${escapeHtml(actionKey)}">Approve</button>` : ""}${
                        availableActions.edit ? `<button class="btn btn--small" type="button" data-mutation-edit="${escapeHtml(actionKey)}">Edit</button>` : ""
                      }${availableActions.hold ? `<button class="btn btn--small" type="button" data-mutation-hold="${escapeHtml(actionKey)}">Hold</button>` : ""}${
                        availableActions.resume ? `<button class="btn btn--small" type="button" data-mutation-resume="${escapeHtml(actionKey)}">Resume</button>` : ""
                      }${
                        availableActions.mock_send
                          ? `<button class="btn btn--small" type="button" data-mutation-mock-send="${escapeHtml(actionKey)}">Mock send</button>`
                          : ""
                      }`
                    : `<span class="issue-pill">${escapeHtml(approvalStatusLabelJa(approvalStatus) || approvalStatus)}</span>`
                }
              </div>
            </div>`
          : "";

      const ingestEvents = Array.isArray(state.latestIngestResult?.activityEvents) ? state.latestIngestResult.activityEvents.filter(Boolean) : [];
      const threadIdForEvents = mut?.threadId ? String(mut.threadId) : "";
      const relatedEvents = threadIdForEvents ? ingestEvents.filter((e) => String(e?.threadId || "") === threadIdForEvents) : ingestEvents;
      const lines = relatedEvents
        .slice()
        .sort((a, b) => {
          const atA = String(a?.occurredAt || "");
          const atB = String(b?.occurredAt || "");
          if (atA !== atB) return atB.localeCompare(atA);
          return (b?.sequence ?? -999) - (a?.sequence ?? -999) || String(a?.id || "").localeCompare(String(b?.id || ""));
        })
        .map((e) => {
          const at = String(e?.occurredAt || "");
          const label = String(e?.title || e?.type || "log");
          const desc = String(e?.description || "").trim();
          const text = desc ? `${label}：${desc}` : label;
          return { id: String(e?.id || shortId()), at, textHtml: escapeHtml(text) };
        });

      const historyItems = [];
      if (actionCardHtml) historyItems.push({ id: `card:${actionKey}`, at: nowIso(), isCard: true, bodyHtml: actionCardHtml });
      historyItems.push(...lines);

      const historyHtml = renderIssueHistoryTimeline(historyItems);

      const evidenceHtml = (() => {
        if (!sourceThread) return "";
        const evidenceMessageCount = getConversationThreadMessageCount(sourceThread);
        if (!evidenceMessageCount) return "";
        const src = formatRequestSourceLabel(sourceThread.sourceChannel);
        const who = String(sourceThread.requesterName || sourceThread.requester || sourceThread.sender || "—");
        const summary = `根拠: ${src} · ${who} · ${evidenceMessageCount} messages`;
        const threadId = String(sourceThread.id || "").trim();
        if (threadId) {
          if (!state.conversationThreadCacheById || typeof state.conversationThreadCacheById !== "object") {
            state.conversationThreadCacheById = {};
          }
          state.conversationThreadCacheById[threadId] = sourceThread;
        }
        return `<div class="candidate-card-actions" aria-label="Evidence thread">
          <div class="evidence-summary">${escapeHtml(summary)}</div>
          <button class="btn btn--ghost btn--small evidence-thread-button" type="button" data-conversation-thread-open="${escapeHtml(
            threadId,
          )}">根拠会話を見る</button>
        </div>`;
      })();

      return `<section class="issue-history-page" aria-label="LLM mutation detail">
        <div class="issue-history-header">
          <button class="btn btn--small btn--ghost" type="button" data-mutation-back="1">← Back</button>
          <div class="issue-history-header__title">
            <div class="issue-history-header__h">${escapeHtml(issueLike.title)}</div>
            <div class="issue-history-header__badges">
              <span class="issue-pill nt-mono">#${escapeHtml(issueLike.issueNo)}</span>
              <span class="issue-pill ${sevClass}">${escapeHtml(severityLabelJa(sev))}</span>
              <span class="issue-pill">${escapeHtml(statusText)}</span>
              <span class="issue-pill">${escapeHtml(approvalStatusLabelJa(approvalStatus) || approvalStatus)}</span>
            </div>
          </div>
        </div>
        <div class="issue-history-body">
          ${evidenceHtml}
          ${historyHtml}
        </div>
      </section>`;
    };

    const renderIssueDetail = (tradeCaseId) => {
	      const tc = tradeCaseId ? getTradeCaseById(tradeCaseId) : null;
	      const it = issues.find((x) => x && x.tradeCaseId === tradeCaseId) || null;
	      if (!tc || !it) return `<div class="nt-muted">Issue not found</div>`;

	      const statusText = statusTextByKey[it.statusKey] || it.statusKey;
	      const statusJaByKey = {
	        requiresApproval: "人間承認待ち",
	        blocked: "ブロック中",
	        waitingExternal: "外部回答待ち",
	        completed: "完了",
	      };
	      const sev = String(it.severity || "low").toLowerCase();
	      const sevClass = sev === "critical" || sev === "high" ? "is-high" : sev === "medium" ? "is-medium" : "is-low";

	      const rawTimeline = Array.isArray(tc.timeline) ? tc.timeline.slice() : [];

	      const derived = [];
	      derived.push({
	        id: `ai-class:${tradeCaseId}`,
	        at: it.updatedAt || nowIso(),
        type: "aiClassification",
        label: "AI comment",
        actor: "trade-shelf-agent",
        message: it.why || "classified",
      });

	      if (it.statusKey === "requiresApproval" && it.draft && it.draft.body) {
	        const derivedAt = it.updatedAt || nowIso();
	        derived.push({
	          id: `draft-prop:${tradeCaseId}`,
	          at: derivedAt,
	          type: "draftProposal",
	          label: "Draft proposal",
	          actor: "trade-shelf-agent",
	          message: it.aiProposal || "Draft proposal ready.",
	        });
	        derived.push({
	          id: `email-draft:${tradeCaseId}`,
	          at: derivedAt,
	          type: "emailDraft",
	          label: "Email draft",
	          actor: "trade-shelf-agent",
	          bodyHtml: `<div class="issue-email-draft">
	            <div class="kv">
              <span class="muted">channel</span> ${escapeHtml(String(it.draft.channel || "-"))}
              <span class="muted">to</span> ${escapeHtml((it.draft.to || []).join(", ") || "-")}
              ${it.draft.subject ? `<span class="muted">subject</span> ${escapeHtml(String(it.draft.subject))}` : ""}
            </div>
            <pre class="pre pre--compact">${escapeHtml(String(it.draft.body || ""))}</pre>
            <div class="issue-actions">
              <button class="btn btn--primary btn--small" type="button" data-issue-approve="${escapeHtml(it.tradeCaseId)}">Approve send</button>
              <button class="btn btn--small" type="button" data-issue-edit="${escapeHtml(it.tradeCaseId)}">Edit draft</button>
              <button class="btn btn--small" type="button" data-issue-hold="${escapeHtml(it.tradeCaseId)}">Hold</button>
            </div>
          </div>`,
        });
      }

      const allTimeline = derived.concat(
        rawTimeline.map((x) => ({
          id: x?.id || shortId(),
          at: x?.at || "",
          type: x?.type || "comment",
          label: x?.label || x?.type || "comment",
          actor: x?.actor || "",
          message: x?.message || "",
        })),
      );

	      allTimeline.sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || "")));
	      const timelineHtml = allTimeline.length ? allTimeline.map(renderTimelineItem).join("") : `<div class="nt-muted">No timeline yet</div>`;

	      const lastAtRaw = allTimeline.length ? String(allTimeline[allTimeline.length - 1]?.at || "") : "";
	      const lastAtText = lastAtRaw ? formatLocalTime(lastAtRaw) : it.updatedAt ? formatLocalTime(it.updatedAt) : "-";

	      const labels = [];
	      const incs = Array.isArray(tc.incidents) ? tc.incidents : [];
	      for (const i of incs) {
	        const type = String(i?.type || "");
        if (type === "invoiceQuantityMismatch") labels.push("quantity mismatch");
        if (type === "missingDocument") labels.push("missing document");
        if (type === "deliveryRisk") labels.push("delivery risk");
      }
      const labelHtml = labels.length ? labels.slice(0, 5).map((x) => `<span class="issue-label">${escapeHtml(x)}</span>`).join("") : `<span class="nt-muted">-</span>`;

	      const assignee = it.statusKey === "waitingExternal" ? "Supplier waiting" : it.statusKey === "requiresApproval" ? "Ops user" : "AI Agent";

	      const dueDate = tc?.siEntity?.requestedDeliveryDate ? String(tc.siEntity.requestedDeliveryDate) : "";
	      const overdue = dueDate && new Date(dueDate).getTime() < new Date().setHours(0, 0, 0, 0);
      const dueHtml = dueDate
        ? `<div class="issue-sidebar-row"><div class="issue-sidebar__k">Deadline / SLA</div><div class="issue-sidebar__v">${escapeHtml(dueDate)} ${
            overdue ? `<span class="issue-overdue">OVERDUE</span>` : ""
          }</div></div>`
        : `<div class="issue-sidebar-row"><div class="issue-sidebar__k">Deadline / SLA</div><div class="issue-sidebar__v">-</div></div>`;

      const siNo = String(tc?.siEntity?.siNo || (Array.isArray(tc?.siNumbers) ? tc.siNumbers[0] : "") || "SI-2026-001");
      const shipmentId = String(tc?.shipmentEntity?.id || (Array.isArray(tc?.shipmentRefs) ? tc.shipmentRefs[0] : "") || "SHP-2026-009");
      const invoiceNo = String(tc?.invoiceNumbers?.[0]?.invoiceNo || (Array.isArray(tc?.shipmentEntity?.supplierInvoices) ? tc.shipmentEntity.supplierInvoices[0] : "") || "INV-1122");

      const relatedItems = [
        {
          key: "siWorkspace",
          label: "SI Workspace",
          badge: "SI",
          newUrl: `/mock/workspace/si/${encodeURIComponent(siNo)}`,
          hereDataAttr: `data-issue-open-si="${escapeHtml(it.tradeCaseId)}"`,
        },
        {
          key: "shipmentWorkspace",
          label: "Shipment Workspace",
          badge: "SHP",
          newUrl: `/mock/workspace/shipment/${encodeURIComponent(shipmentId)}`,
          hereDataAttr: `data-issue-open-shipment="${escapeHtml(it.tradeCaseId)}"`,
        },
        {
          key: "salesInventoryBalance",
          label: "Sales / Inventory Balance",
          badge: "BI",
          newUrl: `/mock/sales-inventory-balance/${encodeURIComponent(siNo)}`,
        },
        {
          key: "inboundSchedule",
          label: "Inbound Schedule",
          badge: "SHP",
          newUrl: `/mock/inbound-schedule/${encodeURIComponent(shipmentId)}`,
        },
        {
          key: "relatedInvoice",
          label: "Related Invoice",
          badge: "INV",
          newUrl: `/mock/documents/invoice/${encodeURIComponent(invoiceNo)}`,
        },
        {
          key: "relatedDocuments",
          label: "Related Documents",
          badge: "DOC",
          newUrl: `/mock/documents?shipment=${encodeURIComponent(shipmentId)}`,
        },
        {
          key: "caseDetail",
          label: "Case detail",
          badge: "CASE",
          newUrl: `/mock/case/${encodeURIComponent(it.tradeCaseId)}`,
          hereDataAttr: `data-issue-open-case="${escapeHtml(it.tradeCaseId)}"`,
        },
      ];

      const relatedLinksHtml = `<div class="issue-sidebar-row">
        <div class="issue-sidebar__k">Related links</div>
        <div class="issue-sidebar__v issue-sidebar-links issue-related-links">
          ${relatedItems
            .map((x) => {
              const badge = x.badge ? `<span class="issue-related-badge">${escapeHtml(x.badge)}</span>` : "";
              const openHere = x.hereDataAttr
                ? `<button class="issue-related-here" type="button" ${x.hereDataAttr} aria-label="Open here (modal)">Open here</button>`
                : "";
              return `<div class="issue-related-row">
                <button class="issue-related-item" type="button" data-issue-open-new="${escapeHtml(x.newUrl)}" aria-label="Open in new tab">
                  <span class="issue-related-label">${escapeHtml(x.label)}</span>
                  ${badge}
                  <span class="issue-related-ext" aria-hidden="true">↗</span>
                </button>
                ${openHere}
              </div>`;
            })
            .join("")}
        </div>
      </div>`;

	      const externalStatus = it.statusKey === "waitingExternal" ? "waiting supplier" : it.statusKey === "requiresApproval" ? "email draft" : "—";

	      const statusJa = statusJaByKey[it.statusKey] || String(statusText || it.statusKey || "-");
	      const canAct = it.statusKey === "requiresApproval" && it.draft && it.draft.body;
	      const pendingApprovalText = canAct
	        ? String(it.draft.channel || "").toLowerCase() === "email"
	          ? "仕入先確認メールの送信"
	          : "外部送信の承認"
	        : "-";
	      const currentProposalText = it.aiProposal || "-";
	      const nextActionText =
	        it.statusKey === "requiresApproval"
	          ? "Approve / Edit / Hold"
	          : it.statusKey === "waitingExternal"
	            ? "待機（外部回答）"
	            : it.statusKey === "blocked"
	              ? "ブロック解除の確認"
	              : "—";

	      const currentStatusHtml = `<section class="issue-current-status ${sevClass}" aria-label="Current Status">
	        <div class="issue-current-title">Current Status</div>
	        <div class="issue-current-rows">
	          <div class="issue-current-row"><span class="k">Status</span><span class="v">${escapeHtml(statusJa)}</span></div>
	          <div class="issue-current-row issue-current-row--pending"><span class="k">Pending approval</span><span class="v">${escapeHtml(pendingApprovalText)}</span></div>
	          <div class="issue-current-row"><span class="k">AI proposal</span><span class="v">${escapeHtml(currentProposalText)}</span></div>
	        </div>
	        <div class="issue-current-actions" aria-label="Next actions">
	          <button class="btn btn--primary btn--small" type="button" data-issue-approve="${escapeHtml(it.tradeCaseId)}" ${canAct ? "" : "disabled"}>Approve</button>
	          <button class="btn btn--small" type="button" data-issue-edit="${escapeHtml(it.tradeCaseId)}" ${canAct ? "" : "disabled"}>Edit draft</button>
	          <button class="btn btn--small" type="button" data-issue-hold="${escapeHtml(it.tradeCaseId)}">Hold</button>
	        </div>
	      </section>`;

	      const metaPanelHtml = `<aside class="issue-meta-panel issue-meta-panel--sticky" aria-label="Meta Panel">
          <div class="issue-sidebar-row"><div class="issue-sidebar__k">Assignee / Owner</div><div class="issue-sidebar__v">${escapeHtml(assignee)}</div></div>
          <div class="issue-sidebar-row"><div class="issue-sidebar__k">Labels</div><div class="issue-sidebar__v">${labelHtml}</div></div>
          ${relatedLinksHtml}
          <div class="issue-sidebar-row"><div class="issue-sidebar__k">External status</div><div class="issue-sidebar__v">${escapeHtml(externalStatus)}</div></div>
          ${dueHtml}
        </aside>`;

	      const actionCardHtml =
	        it.statusKey === "requiresApproval" && it.draft && it.draft.body
	          ? `<div class="issue-action-card" aria-label="Human action card">
	              <div class="issue-action-card__title">AIが仕入先確認メールを作成しました。</div>
	              <div class="issue-draft-preview">
	                <div class="kv">
	                  <span class="muted">channel</span> ${escapeHtml(String(it.draft.channel || "-"))}
	                  <span class="muted">to</span> ${escapeHtml((it.draft.to || []).join(", ") || "-")}
	                  ${it.draft.subject ? `<span class="muted">subject</span> ${escapeHtml(String(it.draft.subject))}` : ""}
	                </div>
	                <pre class="pre pre--compact">${escapeHtml(String(it.draft.body || ""))}</pre>
	              </div>
	              <div class="issue-action-buttons">
	                <button class="btn btn--primary btn--small" type="button" data-issue-approve="${escapeHtml(it.tradeCaseId)}" ${canAct ? "" : "disabled"}>Approve</button>
	                <button class="btn btn--small" type="button" data-issue-edit="${escapeHtml(it.tradeCaseId)}" ${canAct ? "" : "disabled"}>Edit</button>
	                <button class="btn btn--small" type="button" data-issue-hold="${escapeHtml(it.tradeCaseId)}">Hold</button>
	                <button class="btn btn--small" type="button" disabled>Mock send</button>
	              </div>
	            </div>`
	          : "";

	      const issueTimeline = derived.concat(
	        rawTimeline.map((x) => ({
	          id: x?.id || shortId(),
	          at: x?.at || "",
	          type: x?.type || "comment",
	          label: x?.label || x?.type || "comment",
	          actor: x?.actor || "",
	          message: x?.message || "",
	        })),
	      );

	      const lines = issueTimeline
	        .map((t) => {
	          const label = String(t?.label || t?.type || "log");
	          const msg = String(t?.message || "").trim();
	          const text = msg || label;
	          return { id: String(t?.id || shortId()), at: String(t?.at || ""), textHtml: escapeHtml(text) };
	        })
	        .filter(Boolean);
	      lines.sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")) || String(a?.id || "").localeCompare(String(b?.id || "")));

	      const historyItems = [];
	      if (actionCardHtml) historyItems.push({ id: `card:${it.tradeCaseId}`, at: nowIso(), isCard: true, bodyHtml: actionCardHtml });
	      historyItems.push(...lines);

	      const historyHtml = renderIssueHistoryTimeline(historyItems);

	      return `<section class="issue-history-page" aria-label="Issue detail">
          <div class="issue-history-header">
            <button class="btn btn--small btn--ghost" type="button" data-issue-back="1">← Back</button>
            <div class="issue-history-header__title">
              <div class="issue-history-header__h">${escapeHtml(it.title)}</div>
              <div class="issue-history-header__badges">
                <span class="issue-pill nt-mono">#${escapeHtml(it.issueNo)}</span>
                <span class="issue-pill ${sevClass}">${escapeHtml(severityLabelJa(sev))}</span>
                <span class="issue-pill">${escapeHtml(statusText)}</span>
              </div>
            </div>
          </div>
          <div class="issue-history-body">${historyHtml}</div>
      </section>`;
    };

    if (state.activeMutationId) return renderMutationDetail(state.activeMutationId);
    if (state.activeIssueId) return renderIssueDetail(state.activeIssueId);
    if (state.activeReplyCandidateId) return renderReplyCandidateDetail(state.activeReplyCandidateId);
    return renderIssueList();
  };
    return renderIssues();
  };

  return { renderApprovalCenter };
}

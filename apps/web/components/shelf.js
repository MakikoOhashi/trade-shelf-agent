import {
  SHELF_STAGE_IDS,
  SHELF_STAGES,
  getShelfStageById,
  getShelfStageOrder,
  shelfStageIdFromShipmentState,
  shipmentStageIndexFromState,
} from "../lib/shelfMapping.js";

function renderShelfPreviewHtml(payload, escapeHtml) {
  if (!payload) return "";
  return `
      <div class="shelf-book-info__title">${escapeHtml(String(payload.idText || "-"))}</div>
      <div class="shelf-book-info__line">${escapeHtml(String(payload.partyName || "-"))}</div>
      <div class="shelf-book-info__line">${escapeHtml(String(payload.dueLabel || "-"))}</div>
      <div class="shelf-book-info__line">状態: ${escapeHtml(String(payload.stageLabel || "-"))}</div>
      <div class="shelf-book-info__section">
        <div class="shelf-book-info__section-title">Tags</div>
        ${String(payload.tagsHtml || `<div class="shelf-book-info__tags-empty muted">-</div>`)}
      </div>
      <div class="shelf-book-info__line">Issue: ${escapeHtml(String(payload.issueLabel || "-"))}</div>
      <div class="shelf-book-info__hint">クリックでWorkspace</div>
    `.trim();
}

function deriveBlockerLabels(tc) {
  const out = [];
  const blockingSummary = Array.isArray(tc?.caseProgress?.blockingSummary) ? tc.caseProgress.blockingSummary.filter(Boolean) : [];
  for (const s of blockingSummary) out.push(String(s));

  const docs = Array.isArray(tc?.caseProgress?.documents) ? tc.caseProgress.documents : [];
  for (const d of docs) {
    if (!d || !d.blocking) continue;
    const label = String(d.label || d.id || "doc");
    const status = String(d.status || "");
    if (status.includes("missing")) out.push(`${label} missing`);
    else if (status.includes("needsFix")) out.push(`${label} needs fix`);
    else if (status) out.push(`${label} ${status}`);
    else out.push(label);
  }

  const uniq = [];
  const seen = new Set();
  for (const x of out) {
    const k = String(x).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(k);
  }
  return uniq;
}

function hasHighIssues(tc) {
  const incidents = Array.isArray(tc?.incidents) ? tc.incidents : [];
  for (const i of incidents) {
    if (!i || i.status === "resolved") continue;
    const s = String(i.severity || "").toLowerCase();
    if (s === "critical" || s === "high") return true;
  }
  return false;
}

function createShelfRenderer({
  state,
  shipments,
  escapeHtml,
  isOverdueYmd,
  resolveIssueLabelForTradeCase,
  getMockEvidenceArchiveItems,
}) {
  const resolveShipmentSequence = (tc) => {
    const siNo = String(tc?.siEntity?.siNo || "").trim();
    const shId = String(tc?.shipmentEntity?.id || "").trim();
    if (!siNo || !shId) return null;
    if (shId.startsWith("PLN-")) return null;

    const siblings = shipments
      .filter((x) => String(x?.siEntity?.siNo || "").trim() === siNo)
      .map((x) => String(x?.shipmentEntity?.id || "").trim())
      .filter((id) => id && !id.startsWith("PLN-"))
      .sort((a, b) => a.localeCompare(b));

    const idx = siblings.indexOf(shId);
    return idx === -1 ? null : idx + 1;
  };

  const buildBookSpineLabels = (tc) => {
    const siNo = String(tc?.siEntity?.siNo || "-");
    const shId = String(tc?.shipmentEntity?.id || "").trim();
    const seq = resolveShipmentSequence(tc);
    const hasRealShipment = Boolean(shId) && !shId.startsWith("PLN-");
    const siLabel = hasRealShipment && seq ? `${siNo}（分納${seq}）` : siNo;
    const shipmentLabel = hasRealShipment ? shId : "";
    return { siLabel, shipmentLabel, shipmentSequence: seq };
  };

  const renderShelfCard = (viewType, tc, opts = {}) => {
    const sh = tc && tc.shipmentEntity ? tc.shipmentEntity : null;
    const si = tc && tc.siEntity ? tc.siEntity : null;

    const { siLabel, shipmentLabel } = buildBookSpineLabels(tc);
    const idText = shipmentLabel ? `${siLabel} / ${shipmentLabel}` : siLabel;

    const salesCommitments = Array.isArray(tc?.decisionContext?.salesCommitments) ? tc.decisionContext.salesCommitments : [];
    const partyName = String(salesCommitments[0]?.customerName || tc?.customer?.name || tc?.supplier?.name || "Customer");

    const dueYmd = String(sh?.eta || si?.requestedDeliveryDate || "");
    const dueLabel = sh?.eta ? `ETA ${dueYmd}` : dueYmd ? `delivery ${dueYmd}` : "delivery未定";

    const blockers = deriveBlockerLabels(tc);
    const blockerCount = blockers.length;
    const maxTags = 3;
    const tagList = blockers.slice(0, maxTags);
    const moreCount = Math.max(0, blockerCount - tagList.length);
    const tagsHtml = [
      ...tagList.map((t) => `<span class="nt-badge is-blocker">${escapeHtml(t)}</span>`),
      ...(moreCount > 0 ? [`<span class="nt-badge is-more">+${moreCount} more</span>`] : []),
    ].join("");

    const percentRaw = typeof tc?.caseProgress?.overallPercent === "number" ? tc.caseProgress.overallPercent : 0;
    const percent = Math.max(0, Math.min(100, Math.round(percentRaw)));

    const overdue = isOverdueYmd(dueYmd);
    const blocked = blockerCount > 0;
    const high = hasHighIssues(tc);

    const cardClass = ["shelf-card", overdue ? "is-overdue" : "", blocked ? "is-blocked" : "", high ? "is-high" : ""]
      .filter(Boolean)
      .join(" ");

    const openAttr = `data-open-shipment="${escapeHtml(tc.id)}"`;
    const focusType = "shipment";
    const focusId = String(sh?.id || "").trim();
    const workspaceAttrs = `data-open-document-workspace="${escapeHtml(tc.id)}" data-focus-type="${escapeHtml(
      focusType,
    )}" data-focus-id="${escapeHtml(focusId || "-")}" data-initial-doc-id="${escapeHtml(focusType)}"`;

    void opts;
    return `<article class="${cardClass}" role="button" tabindex="0" ${openAttr} ${workspaceAttrs}>
      <div class="shelf-card__top">
        <div class="shelf-card__id">${escapeHtml(idText)}</div>
      </div>
      <div class="shelf-card__party nt-muted">${escapeHtml(partyName)}</div>
      <div class="shelf-card__meta nt-muted">${escapeHtml(dueLabel)}</div>
      ${tagsHtml ? `<div class="shelf-card__tags">${tagsHtml}</div>` : ""}
      <div class="nt-progress">
        <div class="nt-progress__bar" aria-hidden="true"><div class="nt-progress__fill" style="width:${percent}%"></div></div>
        <div class="nt-progress__label">${percent}%</div>
      </div>
    </article>`;
  };

  const renderShelfBook = (viewType, tc) => {
    const sh = tc && tc.shipmentEntity ? tc.shipmentEntity : null;
    const si = tc && tc.siEntity ? tc.siEntity : null;

    const previewId = String(tc?.id || "").trim();
    const { siLabel, shipmentLabel } = buildBookSpineLabels(tc);
    const idText = shipmentLabel ? `${siLabel} / ${shipmentLabel}` : siLabel;

    const salesCommitments = Array.isArray(tc?.decisionContext?.salesCommitments) ? tc.decisionContext.salesCommitments : [];
    const partyName = String(salesCommitments[0]?.customerName || tc?.customer?.name || tc?.supplier?.name || "Customer");

    const dueYmd = String(sh?.eta || si?.requestedDeliveryDate || "");
    const dueLabel = sh?.eta ? (dueYmd ? `ETA ${dueYmd}` : "ETA未定") : dueYmd ? `delivery ${dueYmd}` : "delivery未定";

    const blockers = deriveBlockerLabels(tc);
    const blockerCount = blockers.length;
    const overdue = isOverdueYmd(dueYmd);

    const isCompletedShipmentState = (shipmentState) => {
      const s = String(shipmentState || "");
      return s === "warehouseReceived" || s === "completed";
    };

    const stageId = shelfStageIdFromShipmentState(sh?.shipmentState);
    const completed = isCompletedShipmentState(sh?.shipmentState);

    const riskClass = overdue ? "is-overdue" : blockerCount > 0 ? "is-blocker" : completed ? "is-completed" : "is-normal";

    const issueLabel = resolveIssueLabelForTradeCase(tc);

    const focusType = "shipment";
    const focusId = String(sh?.id || "").trim();
    const workspaceAttrs = `data-open-document-workspace="${escapeHtml(tc.id)}" data-focus-type="${escapeHtml(
      focusType,
    )}" data-focus-id="${escapeHtml(focusId || "-")}" data-initial-doc-id="${escapeHtml(focusType)}"`;

    const tagsHtml = blockers.length
      ? `<ul class="shelf-book-info__tags">${blockers.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`
      : `<div class="shelf-book-info__tags-empty muted">-</div>`;

    return {
      stageId,
      blocker: blockerCount > 0,
      overdue,
      completed,
      __tc: tc,
      previewId,
      previewPayload: {
        idText,
        partyName,
        dueLabel,
        stageLabel: getShelfStageById(stageId).label || "-",
        tagsHtml,
        issueLabel,
      },
      html: `<button class="shelf-book ${riskClass}" type="button" ${workspaceAttrs} data-shelf-preview-id="${escapeHtml(
        previewId,
      )}" aria-label="${escapeHtml(idText)}">
        <span class="shelf-book__title">
          <span class="shelf-book__spine">
            <span class="shelf-book__spine-line">${escapeHtml(siLabel)}</span>
            ${shipmentLabel ? `<span class="shelf-book__spine-line shelf-book__spine-line--sub">${escapeHtml(shipmentLabel)}</span>` : ""}
          </span>
        </span>
        <span class="shelf-book__sub">${escapeHtml(partyName)}</span>
      </button>`,
    };
  };

  const renderTradeBookshelf = (viewType) => {
    const items = shipments
      .filter((tc) => !!tc?.shipmentEntity)
      .map((tc) => renderShelfBook(viewType, tc));

    const nextPreviewPayloadById = {};
    for (const it of items) {
      const key = String(it?.previewId || "").trim();
      if (!key) continue;
      nextPreviewPayloadById[key] = it?.previewPayload || null;
    }
    state.shelfPreviewPayloadById = nextPreviewPayloadById;

    const timestampMs = (tc) => {
      const sh = tc && tc.shipmentEntity ? tc.shipmentEntity : null;
      const best = String(sh?.updatedAt || sh?.createdAt || tc?.updatedAt || tc?.createdAt || "");
      const t = Date.parse(best);
      return Number.isFinite(t) ? t : 0;
    };

    const stageSections = SHELF_STAGES.map((stage) => {
      const stageItems = items
        .filter((x) => x && x.stageId === stage.id)
        .sort((a, b) => {
          const ta = timestampMs(a?.__tc || null);
          const tb = timestampMs(b?.__tc || null);
          if (tb !== ta) return tb - ta;
          const aKey = String(a?.overdue ? "0" : "1") + String(a?.blocker ? "0" : "1");
          const bKey = String(b?.overdue ? "0" : "1") + String(b?.blocker ? "0" : "1");
          return aKey.localeCompare(bKey);
        });

      const count = stageItems.length;
      const blockerCount = stageItems.filter((x) => x && x.blocker).length;
      const overdueCount = stageItems.filter((x) => x && x.overdue).length;

      return `<section class="shelf-genre" aria-label="${escapeHtml(stage.label)}">
        <div class="shelf-genre__header">
          <h2 class="shelf-genre__title">${escapeHtml(stage.label)}</h2>
          <div class="shelf-genre__meta">
            <span class="shelf-count">${count}</span>
            <span class="shelf-badge ${blockerCount ? "is-blocker" : ""}">blocker ${blockerCount}</span>
            <span class="shelf-badge ${overdueCount ? "is-overdue" : ""}">overdue ${overdueCount}</span>
          </div>
        </div>
        <div class="shelf-books" role="list">
          ${stageItems.length ? stageItems.map((x) => x.html).join("") : `<div class="shelf-empty nt-muted">No records</div>`}
        </div>
      </section>`;
    }).join("");

    void viewType;
    return `<div class="trade-bookshelf" aria-label="Shipments Slice Bookshelf">
      ${stageSections}
    </div>`;
  };

  const renderShelfRow = (row) => {
    const { stageLabel, cardsHtml, count, overdueCount, blockerCount } = row;
    const metaBits = [
      blockerCount > 0
        ? `<span class="shelf-row__pill is-blocker">⚠ blocker ${blockerCount}</span>`
        : `<span class="shelf-row__pill">blocker 0</span>`,
      overdueCount > 0
        ? `<span class="shelf-row__pill is-overdue">⏰ overdue ${overdueCount}</span>`
        : `<span class="shelf-row__pill">overdue 0</span>`,
    ].join("");

    return `<div class="shelf-row">
      <div class="shelf-row__header">
        <div class="shelf-row__title">
          ${escapeHtml(stageLabel)} <span class="stage-count">${count}</span>
        </div>
        <div class="shelf-row__meta">${metaBits}</div>
      </div>
      <div class="shelf-row__body" role="region" aria-label="${escapeHtml(stageLabel)} shelf">
        <div class="shelf-row__rail">
          ${cardsHtml || `<div class="nt-muted shelf-row__empty">No records</div>`}
        </div>
      </div>
    </div>`;
  };

  const renderShelfBoard = (viewType) => {
    const isShipment = viewType === "shipments";
    const stages = SHELF_STAGES.map((s, idx) => ({ label: s.label, idx }));

    const rowsHtml = stages
      .map(({ label, idx }) => {
        const stageItems = shipments
          .filter((tc) => {
            if (!tc) return false;
            if (isShipment) {
              const sh = tc.shipmentEntity;
              return shipmentStageIndexFromState(sh?.shipmentState) === idx;
            }

            if (!tc.siEntity) return false;
            const si = tc.siEntity;
            let sIdx = 0;
            const relIds = si.relatedShipmentIds || [];
            if (relIds.length > 0) {
              const relStageIndices = relIds.map((id) => {
                const shTc = shipments.find((x) => x?.shipmentEntity?.id === id);
                return shTc ? shipmentStageIndexFromState(shTc.shipmentEntity.shipmentState) : 0;
              });
              sIdx = Math.min(...relStageIndices);
            }
            return sIdx === idx;
          })
          .sort((a, b) => {
            const da = isShipment ? String(a?.shipmentEntity?.eta || "") : String(a?.siEntity?.requestedDeliveryDate || "");
            const db = isShipment ? String(b?.shipmentEntity?.eta || "") : String(b?.siEntity?.requestedDeliveryDate || "");
            return da.localeCompare(db);
          });

        let overdueCount = 0;
        let blockerCount = 0;
        for (const tc of stageItems) {
          const blockers = deriveBlockerLabels(tc);
          if (blockers.length) blockerCount += 1;
          const due = isShipment ? tc?.shipmentEntity?.eta : tc?.siEntity?.requestedDeliveryDate;
          if (isOverdueYmd(due)) overdueCount += 1;
        }

        const cardsHtml = stageItems.map((tc) => renderShelfCard(viewType, tc, { stageIndex: idx })).join("");
        return renderShelfRow({ stageLabel: label, cardsHtml, count: stageItems.length, overdueCount, blockerCount });
      })
      .join("");

    return `<section class="shelf-board" aria-label="${isShipment ? "Shipments Shelf" : "SI Shelf"}">${rowsHtml}</section>`;
  };

  const renderShipments = () => {
    return renderTradeBookshelf("shipments");
  };

  const renderSi = () => {
    return renderTradeBookshelf("si");
  };

  const renderShelf = () => {
    const query = String(state.shelfSearchQuery || "").trim();

    const normalizeQ = (s) => String(s || "").toLowerCase();
    const matches = (hay, q) => {
      const h = normalizeQ(hay);
      const qq = normalizeQ(q);
      if (!qq) return false;
      return h.includes(qq);
    };

    const buildSearchResults = (q) => {
      const qq = String(q || "").trim();
      if (!qq) return [];

      const results = [];
      const seen = new Set();
      const add = (r) => {
        if (!r || !r.key) return;
        if (seen.has(r.key)) return;
        seen.add(r.key);
        results.push(r);
      };

      const tradeCases = Array.isArray(state.tradeCases) ? state.tradeCases.filter(Boolean) : [];
      for (const tc of tradeCases) {
        const title = String(tc?.title || "");
        const siNos = Array.isArray(tc?.siNumbers) ? tc.siNumbers.filter(Boolean) : [];
        const invs = Array.isArray(tc?.invoiceNumbers) ? tc.invoiceNumbers.filter(Boolean) : [];
        const shipmentRefs = Array.isArray(tc?.shipmentRefs) ? tc.shipmentRefs.filter(Boolean) : [];
        const suppliers = [
          ...(Array.isArray(tc?.suppliers) ? tc.suppliers.filter(Boolean) : []),
          ...invs.map((x) => x && x.supplier).filter(Boolean),
        ].map((x) => String(x));

        if (matches(title, qq)) {
          add({
            key: `case:${tc.id}`,
            type: "Case",
            label: String(tc.id || ""),
            description: title,
            openType: "case",
            openId: String(tc.id || ""),
          });
        }

        for (const si of siNos) {
          if (matches(si, qq)) {
            add({
              key: `si:${si}:${tc.id}`,
              type: "SI",
              label: si,
              description: "出荷指図",
              openType: "si",
              openId: String(tc.id || ""),
            });
          }
        }

        for (const inv of invs) {
          const invNo = inv && inv.invoiceNo ? String(inv.invoiceNo) : "";
          if (!invNo) continue;
          if (matches(invNo, qq) || (inv.supplier && matches(inv.supplier, qq))) {
            add({
              key: `inv:${invNo}:${tc.id}`,
              type: "INV",
              label: invNo,
              description: inv && inv.type ? String(inv.type) : "Invoice",
              openType: "shipment",
              openId: String(tc.id || ""),
            });
          }
        }

        for (const sh of shipmentRefs) {
          if (matches(sh, qq)) {
            add({
              key: `shp:${sh}:${tc.id}`,
              type: "Shipment",
              label: sh,
              description: "Shipment",
              openType: "shipment",
              openId: String(tc.id || ""),
            });
          }
        }

        for (const s of suppliers) {
          if (!s) continue;
          if (matches(s, qq)) {
            add({
              key: `supplier:${s}:${tc.id}`,
              type: "Supplier",
              label: s,
              description: title || "Related case",
              openType: "case",
              openId: String(tc.id || ""),
            });
          }
        }
      }

      const evidence = Array.isArray(getMockEvidenceArchiveItems()) ? getMockEvidenceArchiveItems().filter(Boolean) : [];
      for (const it of evidence) {
        const t = String(it?.type || "");
        const title = String(it?.title || "");
        const desc = String(it?.description || "");
        const tags = Array.isArray(it?.tags) ? it.tags.map((x) => String(x)).filter(Boolean) : [];
        const hay = [title, desc, ...tags].join(" ");
        if (!matches(hay, qq)) continue;

        if (t === "Document") {
          const docTypeGuess =
            /\\bPL\\b/i.test(hay) ? "PL" : /\\bINV\\b/i.test(hay) ? "INV" : /\\bBL\\b/i.test(hay) ? "BL" : "Document";
          add({
            key: `doc:${String(it.id)}`,
            type: docTypeGuess,
            label: title || String(it.id || "Document"),
            description: desc || "Related Document",
            openType: "evidence",
            openId: String(it.id || ""),
          });
        } else if (t === "Issue") {
          add({
            key: `issue:${String(it.id)}`,
            type: "ISS",
            label: title || "Issue",
            description: desc,
            openType: "evidence",
            openId: String(it.id || ""),
          });
        } else if (t === "Email") {
          add({
            key: `email:${String(it.id)}`,
            type: "Email",
            label: title || "Email",
            description: desc,
            openType: "evidence",
            openId: String(it.id || ""),
          });
        } else if (t === "Teams") {
          add({
            key: `teams:${String(it.id)}`,
            type: "Teams",
            label: title || "Teams",
            description: desc,
            openType: "evidence",
            openId: String(it.id || ""),
          });
        }
      }

      return results.slice(0, 30);
    };

    const results = buildSearchResults(query);

    const searchHtml = `<div class="evidence-search" aria-label="Shelf search">
      <input class="evidence-search__input" type="search" value="${escapeHtml(String(state.shelfSearchQuery || ""))}"
        placeholder="SI / INV / Shipment / Supplier / Document を検索"
        data-shelf-search="1" />
    </div>`;

    const resultsHtml = query
      ? `<section class="shelf-search-results" aria-label="検索結果">
          <div class="shelf-search-results__head">
            <div class="shelf-search-results__title">検索結果</div>
            <div class="shelf-search-results__meta nt-mono">${escapeHtml(String(results.length))}</div>
          </div>
          ${
            results.length
              ? `<ul class="shelf-search-results__list">${results
                  .map((r) => {
                    const typeChip = `<span class="mini-chip">${escapeHtml(String(r.type || ""))}</span>`;
                    const label = String(r.label || "");
                    const desc = String(r.description || "");
                    return `<li class="shelf-search-item">
                      <div class="shelf-search-item__left">
                        ${typeChip}
                        <div class="shelf-search-item__text">
                          <div class="shelf-search-item__label">${escapeHtml(label)}</div>
                          ${desc ? `<div class="shelf-search-item__desc muted">${escapeHtml(desc)}</div>` : ""}
                        </div>
                      </div>
                      <div class="shelf-search-item__right">
                        <button class="btn btn--ghost btn--small" type="button"
                          data-shelf-search-open="1"
                          data-shelf-search-open-type="${escapeHtml(String(r.openType || ""))}"
                          data-shelf-search-open-id="${escapeHtml(String(r.openId || ""))}">Open</button>
                      </div>
                    </li>`;
                  })
                  .join("")}</ul>`
              : `<div class="nt-muted">No results.</div>`
          }
        </section>`
      : "";

    const boardHtml = renderSi();
    return `<section class="nt-shelf" aria-label="Shelf">
      <div class="nt-shelf-top">
        <div class="shelf-toolbar">
          ${searchHtml}
        </div>
      </div>
      ${resultsHtml}
      ${boardHtml}
    </section>`;
  };

  return {
    renderShelf,
    renderShelfBoard,
    renderShelfBook,
    renderShelfCard,
    renderTradeBookshelf,
    renderShipments,
    renderSi,
  };
}

export { createShelfRenderer, renderShelfPreviewHtml };

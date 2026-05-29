export function createDocumentWorkspaceRenderer(deps) {
  const {
    state,
    escapeHtml,
    uniqStrings,
    normalizeFocusType,
    normalizeInvoiceNo,
    isShippingInstructionDocument,
    detectIncidents,
    buildDocumentWorkspaceDocuments,
    resolveInitialDocId,
    resolveFocusDocId,
    getWorkspaceUi,
    ensureWorkspaceUiDefaults,
    renderDocumentTabs,
    renderDocumentViewer,
    formatFocusLabel,
    prependUniqueById,
    nowIso,
    matchesMutationId,
    activityEventToFeedItem,
  } = deps || {};

  function shipmentStateToJa(shipmentState) {
    const s = String(shipmentState || "").trim();
    if (!s || s === "-") return "-";
    if (s === "shippingPending") return "出荷指図段階";
    if (s === "shipped") return "仕入れ先出発済み";
    if (s === "exportCustoms") return "輸出通関中";
    if (s === "inTransit") return "船積輸送中";
    if (s === "arrived") return "到着済み";
    if (s === "importCustoms") return "通関中";
    if (s === "customsCleared") return "通関完了";
    if (s === "waitingWarehouseReceipt") return "倉庫入荷待ち";
    if (s === "warehouseReceived" || s === "completed") return "在庫化済み";
    return s;
  }

  function resolveShipmentSequence(tc, shipmentId) {
    const shId = String(shipmentId || "").trim();
    if (!shId || shId === "-" || shId.startsWith("PLN-")) return null;
    const shipmentIds = Array.isArray(tc?.shipmentIds) ? tc.shipmentIds.filter(Boolean) : [];
    if (!shipmentIds.length) return null;

    const siblings = shipmentIds
      .map((x) => String(x).trim())
      .filter((x) => x && !x.startsWith("PLN-"))
      .sort((a, b) => a.localeCompare(b));
    if (!siblings.length) return null;
    const idx = siblings.indexOf(shId);
    return idx === -1 ? null : idx + 1;
  }

  function buildWorkspaceHeaderLabels({ tradeCase, focusType, focusId } = {}) {
    const tc = tradeCase || null;
    if (!tc) return { title: "状況", subtitle: "" };

    const type = normalizeFocusType(focusType);
    const id = String(focusId || "").trim();

    const sh = tc?.shipmentEntity || null;
    const si = tc?.siEntity || null;

    const siNo = String(si?.siNo || tc?.siNumbers?.[0] || "").trim();
    const shipmentId = String(sh?.id || "").trim();
    const hasRealShipment = Boolean(shipmentId) && !shipmentId.startsWith("PLN-");

    const title = (() => {
      if (hasRealShipment) {
        const seq = resolveShipmentSequence(tc, shipmentId);
        const seqLabel = seq ? `分納${seq}` : "分納";
        return `${seqLabel} / ${shipmentId} の状況`;
      }
      if (siNo) return `未出荷分 / ${siNo} の状況`;
      return "未出荷分 の状況";
    })();

    const invNo = (() => {
      if (type === "invoice") return normalizeInvoiceNo(id || "");
      const invoiceRefs = Array.isArray(tc?.invoiceNumbers) ? tc.invoiceNumbers.filter(Boolean) : [];
      const first = invoiceRefs[0]?.invoiceNo ? String(invoiceRefs[0].invoiceNo).trim() : "";
      if (first) return normalizeInvoiceNo(first);
      const fromShipment = Array.isArray(sh?.supplierInvoices) ? sh.supplierInvoices.filter(Boolean)[0] : "";
      if (fromShipment) return normalizeInvoiceNo(fromShipment);
      const fromSi = Array.isArray(si?.relatedInvoiceNos) ? si.relatedInvoiceNos.filter(Boolean)[0] : "";
      if (fromSi) return normalizeInvoiceNo(fromSi);
      return "";
    })();

    const blNo = (() => {
      if (type === "bl") return String(id || "").trim();
      const fromShipment = String(sh?.blNo || "").trim();
      if (fromShipment) return fromShipment;
      const fromTc = Array.isArray(tc?.blNumbers) ? String(tc.blNumbers[0] || "").trim() : "";
      return fromTc;
    })();

    const shipmentStateJa = shipmentStateToJa(sh?.shipmentState || tc?.shipmentState || "shippingPending");

    const parts = [];
    if (siNo) parts.push(`${siNo} 配下`);
    if (invNo) parts.push(invNo);
    if (blNo) parts.push(blNo);
    if (shipmentStateJa && shipmentStateJa !== "-") parts.push(shipmentStateJa);

    return {
      title,
      subtitle: parts.join("・"),
    };
  }

  function buildWorkspaceRelationshipTree(tradeCase, focusType, focusId) {
    const tc = tradeCase || null;
    const sh = tc?.shipmentEntity || null;
    const si = tc?.siEntity || null;
    const type = normalizeFocusType(focusType);
    const id = String(focusId || "").trim();

    const invoiceRefs = Array.isArray(tc?.invoiceNumbers) ? tc.invoiceNumbers.filter(Boolean) : [];
    const invNos = uniqStrings([
      ...invoiceRefs.map((x) => normalizeInvoiceNo(x?.invoiceNo)),
      ...(sh?.supplierInvoices || []).map(normalizeInvoiceNo),
      ...(si?.relatedInvoiceNos || []).map(normalizeInvoiceNo),
    ]).filter(Boolean);

    const blNo = String(sh?.blNo || (Array.isArray(tc?.blNumbers) ? tc.blNumbers[0] : "") || "").trim() || "-";
    const plLabel = "PL書類待ち";
    const shipmentId = String(sh?.id || "-");
    const siNo = String(si?.siNo || "-");

    const root = (() => {
      if (type === "si") return String(si?.siNo || id || "-");
      if (type === "invoice") return normalizeInvoiceNo(id || "-") || "-";
      if (type === "shipment") return String(sh?.id || id || "-");
      if (type === "packing_list") {
        const normalized = String(id || "").trim();
        if (!normalized || normalized === "-" || normalized === "pl-missing") return plLabel;
        return normalized;
      }
      if (type === "bl") return String(id || blNo || "-") || "-";
      return String(id || "-") || "-";
    })();

    const children = (() => {
      if (type === "si") {
        return uniqStrings([...invNos, plLabel, blNo !== "-" ? blNo : null, shipmentId !== "-" ? shipmentId : null]).filter(Boolean);
      }
      if (type === "invoice") {
        return uniqStrings([siNo !== "-" ? siNo : null, shipmentId !== "-" ? shipmentId : null, plLabel, blNo !== "-" ? blNo : null]).filter(Boolean);
      }
      if (type === "shipment") {
        return uniqStrings([siNo !== "-" ? siNo : null, ...invNos, plLabel, blNo !== "-" ? blNo : null]).filter(Boolean);
      }
      if (type === "packing_list") {
        return uniqStrings([siNo !== "-" ? siNo : null, shipmentId !== "-" ? shipmentId : null, ...invNos, blNo !== "-" ? blNo : null]).filter(Boolean);
      }
      if (type === "bl") {
        return uniqStrings([siNo !== "-" ? siNo : null, shipmentId !== "-" ? shipmentId : null, ...invNos, plLabel]).filter(Boolean);
      }
      return uniqStrings([siNo !== "-" ? siNo : null, ...invNos, plLabel, blNo !== "-" ? blNo : null, shipmentId !== "-" ? shipmentId : null]).filter(Boolean);
    })()
      .filter((x) => x && x !== root)
      .filter(Boolean);

    return { root, children };
  }

  function renderWorkspaceRelationshipTree(tree) {
    const root = tree?.root ? String(tree.root) : "-";
    const children = Array.isArray(tree?.children) ? tree.children.filter(Boolean) : [];
    const lines = [];
    lines.push(`<div class="workspace-tree__line">${escapeHtml(root)}</div>`);
    if (!children.length) {
      lines.push(`<div class="workspace-tree__line muted">-</div>`);
    } else {
      for (let i = 0; i < children.length; i += 1) {
        const prefix = i === children.length - 1 ? "└ " : "├ ";
        lines.push(`<div class="workspace-tree__line">${escapeHtml(prefix + String(children[i]))}</div>`);
      }
    }
    return `<div class="workspace-tree mono">${lines.join("")}</div>`;
  }

  function buildWorkspaceOperationalSummary(tradeCase, focusType, focusId) {
    const tc = tradeCase || null;
    if (!tc) return { title: "状況", sections: [] };

    const type = normalizeFocusType(focusType);
    const id = String(focusId || "").trim();

    const sh = tc?.shipmentEntity || null;
    const si = tc?.siEntity || null;
    const customer = tc?.customer || null;
    const supplier = tc?.supplier || null;

    const invoiceRefs = Array.isArray(tc?.invoiceNumbers) ? tc.invoiceNumbers.filter(Boolean) : [];
    const invQtyByNo = Object.create(null);
    for (const inv of invoiceRefs) {
      const no = normalizeInvoiceNo(inv?.invoiceNo);
      if (!no) continue;
      const qty = typeof inv?.qty === "number" ? inv.qty : null;
      if (typeof qty === "number") invQtyByNo[no] = qty;
    }
    const invNos = uniqStrings([
      ...invoiceRefs.map((x) => normalizeInvoiceNo(x?.invoiceNo)),
      ...(sh?.supplierInvoices || []).map(normalizeInvoiceNo),
      ...(si?.relatedInvoiceNos || []).map(normalizeInvoiceNo),
    ]).filter(Boolean);

    const siTotalQty =
      typeof tc?.products?.[0]?.quantityInstructed === "number"
        ? tc.products[0].quantityInstructed
        : typeof tc?.products?.[0]?.quantityOrdered === "number"
          ? tc.products[0].quantityOrdered
          : null;
    const invTotalQty = invNos.reduce((sum, no) => sum + (typeof invQtyByNo[no] === "number" ? invQtyByNo[no] : 0), 0);
    const remainingQty = typeof siTotalQty === "number" ? Math.max(0, siTotalQty - invTotalQty) : null;

    if (type === "si") {
      const titleId = String(si?.siNo || id || "-");
      const splitItems = [];
      for (const no of invNos) {
        const qty = typeof invQtyByNo[no] === "number" ? invQtyByNo[no] : null;
        splitItems.push({ type: "text", label: `${no}: ${qty != null ? `${qty}pcs` : "-"}` });
      }
      if (typeof remainingQty === "number") splitItems.push({ type: "text", label: `Remaining: ${remainingQty}pcs` });
      if (!splitItems.length) splitItems.push({ type: "text", label: "-" });

      return {
        title: `${titleId} の状況`,
        sections: [
          { label: "分納状況", items: splitItems },
          { label: "書類関連", items: [{ type: "follow_up", status: "waiting_reply", label: "PL発行待ち" }] },
          { label: "物流関連", items: [{ type: "follow_up", status: "waiting_reply", label: "BL発行待ち" }, { type: "follow_up", status: "waiting_reply", label: "ETA更新待ち" }] },
        ],
      };
    }

    if (type === "invoice" || type === "packing_list" || type === "bl" || type === "shipment") {
      const titleId = type === "invoice" ? normalizeInvoiceNo(id || "-") : id || "-";
      const warehouseEta = String(sh?.eta || "2026-05-15");
      return {
        title: `${titleId} の状況`,
        sections: [
          {
            label: "書類関連",
            items: [{ type: "follow_up", status: "waiting_reply", label: "PL発行待ち（督促中）" }, { type: "follow_up", status: "waiting_reply", label: "BL未着" }],
          },
          {
            label: "物流関連",
            items: [{ type: "text", label: "工場出荷済み" }, { type: "text", label: "船ブッキング済み" }, { type: "text", label: "ETD確認中" }],
          },
          {
            label: "取引先",
            items: [
              { type: "entity", label: `Supplier: ${String(supplier?.name || "ACME Components")}` },
              { type: "entity", label: `Customer: ${String(customer?.name || "AAA Company")}（国内売約先）` },
            ],
          },
          { label: "入荷予定", items: [{ type: "date", label: `倉庫入荷予定: ${warehouseEta}` }] },
        ],
      };
    }

    return {
      title: "状況",
      sections: [{ label: "概要", items: [{ type: "text", label: "-" }] }],
    };
  }

  function renderOperationalItem(item) {
    const it = typeof item === "string" ? { label: item } : item || {};
    const label = String(it.label || it.text || "").trim();
    if (!label) return "";
    const status = String(it.status || "").trim();
    const suffix = status ? ` <span class="muted">(${escapeHtml(status)})</span>` : "";
    return `<li>${escapeHtml(label)}${suffix}</li>`;
  }

  function renderWorkspaceOperationalSummaryHtml(summary) {
    const s = summary || null;
    const sections = Array.isArray(s?.sections) ? s.sections.filter(Boolean) : [];
    const title = String(s?.title || "").trim();
    if (!title && !sections.length) return `<div class="muted">-</div>`;

    const titleHtml = title ? `<div class="workspace-kv"><div><span class="mono">■</span> ${escapeHtml(title)}</div></div>` : "";
    const sectionsHtml = sections
      .map((sec) => {
        const label = String(sec?.label || "").trim();
        const items = Array.isArray(sec?.items) ? sec.items : [];
        const itemsHtml = items.map(renderOperationalItem).filter(Boolean).join("");
        return `<div class="workspace-kv">
        <div><span class="muted">${escapeHtml(label || "-")}</span></div>
        ${itemsHtml ? `<ul class="list">${itemsHtml}</ul>` : `<div class="muted">-</div>`}
      </div>`;
      })
      .join("");

    return `${titleHtml}${sectionsHtml || `<div class="muted">-</div>`}`;
  }

  function buildDocumentCheckResults(tc, focusType, focusId) {
    const type = normalizeFocusType(focusType);
    const id = String(focusId || "").trim();
    const documents = buildDocumentWorkspaceDocuments(tc, type, id);

    const sh = tc?.shipmentEntity || null;
    const si = tc?.siEntity || null;

    const invoiceRefs = Array.isArray(tc?.invoiceNumbers) ? tc.invoiceNumbers.filter(Boolean) : [];
    const invByNo = new Map();
    for (const inv of invoiceRefs) {
      const no = normalizeInvoiceNo(inv?.invoiceNo);
      if (!no) continue;
      invByNo.set(no, inv);
    }

    const incidents = detectIncidents(tc);
    const mismatch = incidents.find((i) => i && i.type === "invoiceQuantityMismatch") || null;
    const details = mismatch && mismatch.details && typeof mismatch.details === "object" ? mismatch.details : null;
    const siQty =
      typeof details?.siQuantity === "number"
        ? details.siQuantity
        : typeof tc?.products?.[0]?.quantityInstructed === "number"
          ? tc.products[0].quantityInstructed
          : null;
    const siNo = String(si?.siNo || tc?.siNumbers?.[0] || "").trim();

    const statusRank = (s) => {
      if (s === "error") return 3;
      if (s === "warning") return 2;
      return 1;
    };

    const anyDocMissing = (pred) => documents.some((d) => pred(d) && String(d?.status || "") === "missing");
    const anyDocPresent = (pred) => documents.some((d) => pred(d) && String(d?.status || "") !== "missing");

    const formatQty = (qty) => (typeof qty === "number" ? `${qty}pcs` : "-");
    const invoiceQtyByNo = (invoiceNo) => {
      const invNo = normalizeInvoiceNo(invoiceNo);
      if (!invNo) return null;
      const ref = invByNo.get(invNo) || null;
      return typeof ref?.qty === "number" ? ref.qty : null;
    };

    const buildQuantityCheck = () => {
      const invDocs = documents.filter((d) => String(d?.id || "").startsWith("inv-"));
      const invDocNos = invDocs.map((d) => String(d?.label || "").trim()).filter(Boolean);

      const invNosForSi = uniqStrings([...(si?.relatedInvoiceNos || []), ...invDocNos]).map(normalizeInvoiceNo).filter(Boolean);
      const invNosForShipment = uniqStrings([...(sh?.supplierInvoices || []), ...(sh?.switchInvoices || []), ...invDocNos])
        .map(normalizeInvoiceNo)
        .filter(Boolean);

      const focusInvNo = type === "invoice" ? normalizeInvoiceNo(id) : null;

      const lines = [];
      let status = "warning";

      if (type === "invoice") {
        const invNo = focusInvNo || invNosForSi[0] || invNosForShipment[0] || invDocNos[0] || "INV-";
        const invQty = invoiceQtyByNo(invNo);
        const isMismatch = siQty != null && invQty != null && invQty !== siQty;
        lines.push(`${invNo}: ${formatQty(invQty)} / ${siNo || "SI"}: ${formatQty(siQty)}`);
        if (isMismatch) {
          lines.push("このINV単体ではSI数量と一致しません。分納確認が必要です。");
          status = "warning";
        } else if (invQty == null || siQty == null) {
          status = "warning";
        } else {
          status = "ok";
        }
      } else if (type === "shipment") {
        const invNos = invNosForShipment.length ? invNosForShipment : invNosForSi;
        let total = 0;
        let known = true;
        for (const invNo of invNos) {
          const q = invoiceQtyByNo(invNo);
          if (q == null) known = false;
          if (q != null) total += q;
        }
        lines.push(`shipmentに紐づくINV合計 = ${known ? `${total}pcs` : "-"}`);
        lines.push(`SI数量 = ${formatQty(siQty)}`);
        status = known && siQty != null && total === siQty ? "ok" : "warning";
      } else {
        const invNos = invNosForSi.length ? invNosForSi : invDocNos.map(normalizeInvoiceNo).filter(Boolean);
        let total = 0;
        let known = true;
        for (const invNo of invNos) {
          const q = invoiceQtyByNo(invNo);
          if (q == null) {
            known = false;
            lines.push(`${invNo}: -`);
            continue;
          }
          total += q;
          lines.push(`${invNo}: ${q}pcs`);
        }
        if (siQty != null) {
          lines.push(`合計数量 = ${known ? `${total}pcs` : "-"} / SI数量 = ${siQty}pcs`);
        }
        const anySplit = invNos.length >= 2;
        status = known && siQty != null && total === siQty ? (anySplit ? "warning" : "ok") : "warning";
      }

      return {
        key: "quantity",
        label: "数量チェック",
        status,
        summary: lines.join("\n"),
      };
    };

    const buildPlCheck = () => {
      const isMissing = anyDocMissing((d) => String(d?.id || "") === "pl-missing" || String(d?.type || "").toLowerCase().includes("packing"));
      const isPresent = anyDocPresent((d) => String(d?.id || "") !== "pl-missing" && String(d?.type || "").toLowerCase().includes("packing"));
      if (isPresent) {
        return { key: "pl", label: "PLチェック", status: "ok", summary: "OK" };
      }
      const summary = type === "invoice" ? "このINVに対応するPL未着" : "PL未着";
      return { key: "pl", label: "PLチェック", status: "warning", summary };
    };

    const buildBlCheck = () => {
      const hasBl = Boolean(String(sh?.blNo || "").trim());
      const blNo = String(sh?.blNo || tc?.blNumbers?.[0] || "").trim();
      const summary = hasBl ? `${blNo || "BL"} linked` : "未着";
      return { key: "bl", label: "BLチェック", status: hasBl ? "ok" : "warning", summary };
    };

    const buildShipmentCheck = () => {
      const hasShipment = Boolean(String(sh?.id || tc?.shipmentState || "").trim());
      const shipmentId = String(sh?.id || tc?.shipmentRefs?.[0] || "").trim();
      if (type === "shipment") {
        return { key: "shipment", label: "Shipmentチェック", status: "warning", summary: "ETA/Booking確認中" };
      }
      return {
        key: "shipment",
        label: "Shipmentチェック",
        status: hasShipment ? "ok" : "warning",
        summary: hasShipment ? `${shipmentId || "Shipment"} linked` : "未登録",
      };
    };

    const checksBase = [
      { key: "product", label: "品番チェック", status: "ok", summary: "OK" },
      { key: "color", label: "色番チェック", status: "ok", summary: "OK" },
    ];

    const checksByFocus = (() => {
      if (type === "shipment") return [buildQuantityCheck(), buildPlCheck(), buildBlCheck(), buildShipmentCheck()];
      if (type === "invoice") return [buildQuantityCheck(), buildBlCheck(), buildPlCheck(), buildShipmentCheck()];
      return [buildQuantityCheck(), buildPlCheck(), buildBlCheck(), buildShipmentCheck()];
    })();

    const checks = [...checksBase, ...checksByFocus]
      .filter(Boolean)
      .map((c) => ({
        key: String(c.key || ""),
        label: String(c.label || ""),
        status: c.status === "error" || c.status === "warning" || c.status === "ok" ? c.status : "ok",
        summary: String(c.summary || ""),
        issueId: c.issueId ? String(c.issueId) : undefined,
      }))
      .filter((c) => c.key && c.label);

    // Ensure deterministic order while allowing focusType-specific inserts.
    const order = ["product", "color", "quantity", "pl", "bl", "shipment"];
    const rank = new Map(order.map((k, i) => [k, i]));
    checks.sort((a, b) => {
      const ar = rank.has(a.key) ? rank.get(a.key) : 999;
      const br = rank.has(b.key) ? rank.get(b.key) : 999;
      if (ar !== br) return ar - br;
      const sr = statusRank(b.status) - statusRank(a.status);
      if (sr) return sr;
      return String(a.label).localeCompare(String(b.label));
    });

    return { title: "AIの書類チェック", focusType: type, focusId: id || "-", checks };
  }

  function renderDocumentCheckResults(checkResults) {
    const r = checkResults && typeof checkResults === "object" ? checkResults : null;
    const checks = Array.isArray(r?.checks) ? r.checks.filter(Boolean) : [];
    const icon = (status) => {
      if (status === "warning") return "⚠";
      if (status === "error") return "!";
      return "✓";
    };
    const statusText = (status) => {
      if (status === "warning") return "要確認";
      if (status === "error") return "ERROR";
      return "OK";
    };

    const linesHtml = (summary) => {
      const s = String(summary || "").trim();
      if (!s) return `<div class="muted">-</div>`;
      const parts = s.split(/\r?\n/).map((x) => String(x).trim()).filter(Boolean);
      return parts.map((p) => `<div class="doc-check__line">${escapeHtml(p)}</div>`).join("");
    };

    return `
    <div class="doc-check-list" data-focus-type="${escapeHtml(String(r?.focusType || ""))}" data-focus-id="${escapeHtml(String(r?.focusId || ""))}">
      ${checks
        .map((c) => {
          const st = String(c?.status || "ok");
          const issueId = c?.issueId ? String(c.issueId) : "";
          const summaryRaw = String(c?.summary || "").trim();
          const hideSummary = st === "ok";
          const hideIssue = st === "ok";
          return `
            <div class="doc-check doc-check--${escapeHtml(st)}" data-check-key="${escapeHtml(String(c?.key || ""))}" data-status="${escapeHtml(st)}" ${issueId ? `data-issue-id="${escapeHtml(issueId)}"` : ""}>
              <div class="doc-check__header">
                <div class="doc-check__label">${escapeHtml(String(c?.label || ""))}</div>
                <div class="doc-check__status doc-check__status--${escapeHtml(st)}">${escapeHtml(`${icon(st)} ${statusText(st)}`)}</div>
              </div>
              ${hideSummary ? "" : `<div class="doc-check__summary">${linesHtml(c?.summary)}</div>`}
              ${!hideIssue && issueId ? `<div class="doc-check__issue mono">Issue: ${escapeHtml(issueId)}</div>` : ""}
            </div>
          `;
        })
        .join("")}
    </div>
  `;
  }

  function buildExecutionTimelineRisk(tc, focusType, focusId) {
    // NOTE: mock output for now; structure is designed to be swapped with real shipment/document state later.
    const tradeCaseId = String(tc?.id || "");
    const ft = normalizeFocusType(focusType);
    const fid = String(focusId || "").trim() || "-";
    const observation = {
      type: "timeline_deviation",
      source: "execution_timeline_agent",
      severity: "high",
      entityLinks: [
        { entityType: "SI", entityId: "SI-2026-001" },
        { entityType: "Shipment", entityId: "SHP-2026-009" },
      ],
      summary: "Booking未確定・工場未出荷のため、5/15 ETDに遅延リスクがあります。",
      issue_candidate_required: true,
    };

    const issueCandidate = {
      id: "ISS-CAND-TIMELINE-001",
      title: "ETD遅延リスク確認",
      severity: "high",
      status: "issue_candidate",
      source: "Execution Timeline Agent",
      issueType: "timeline_deviation",
      relatedSi: "SI-2026-001",
      relatedShipment: "SHP-2026-009",
      reason: "顧客納期 2026-05-25 から逆算すると、5/15 ETDが必要だが、Booking未確定・工場未出荷のため。",
      suggestedAction: "仕入先またはフォワーダーへBooking/工場出荷予定を確認する。",
    };

    return {
      tradeCaseId,
      focusType: ft,
      focusId: fid,
      riskTitle: "ETD遅延リスク",
      ideal: ["5/01までにBooking確定", "5/08までに工場出荷"],
      current: ["Booking未確定", "工場未出荷"],
      impact: ["顧客納期 5/25 に遅延リスク"],
      observation,
      issueCandidate,
      scenario: [
        {
          date: "2026-05-01",
          milestone: "Booking確定",
          status: "late",
          note: "現在未確定。遅延リスクあり。",
        },
        {
          date: "2026-05-08",
          milestone: "工場出荷",
          status: "late",
          note: "現在未出荷。ETD遅延につながる可能性。",
        },
        {
          date: "2026-05-15",
          milestone: "ETD",
          status: "at_risk",
          note: "この日までに出港しないと顧客納期に影響。",
        },
        {
          date: "2026-05-20",
          milestone: "ETA",
          status: "planned",
          note: "通関・国内配送の余裕が少ない。",
        },
        {
          date: "2026-05-25",
          milestone: "顧客納品",
          status: "deadline",
          note: "最終納期。",
        },
      ],
    };
  }

  function ensureExecutionTimelineIssueCandidateSynced(risk) {
    const r = risk && typeof risk === "object" ? risk : null;
    const cand = r && r.issueCandidate && typeof r.issueCandidate === "object" ? r.issueCandidate : null;
    const obs = r && r.observation && typeof r.observation === "object" ? r.observation : null;
    if (!cand || !obs) return;

    const id = String(cand.id || "").trim();
    if (!id) return;

    if (!Array.isArray(state.timelineIssueCandidates)) state.timelineIssueCandidates = [];
    const existing = state.timelineIssueCandidates.find((x) => x && String(x.id || "") === id) || null;

    const linkedEntities = Array.isArray(obs.entityLinks)
      ? obs.entityLinks
          .filter(Boolean)
          .map((l) => ({ entityType: String(l?.entityType || ""), entityId: String(l?.entityId || "") }))
          .filter((l) => l.entityType && l.entityId)
      : [];

    const actionPlan = {
      channel: "email",
      to: "supplier@example.invalid",
      subject: "Booking and factory shipment confirmation for SI-2026-001",
      body: "SI-2026-001 のBooking状況および工場出荷予定をご確認ください。",
    };

    const timelineCandidate = {
      id,
      title: String(cand.title || "").trim() || id,
      severity: String(cand.severity || "").trim() || "high",
      status: "pending_approval",
      source: String(cand.source || "").trim() || "Execution Timeline Agent",
      issueType: String(cand.issueType || "").trim() || "timeline_deviation",
      relatedSi: String(cand.relatedSi || "").trim() || "",
      relatedShipment: String(cand.relatedShipment || "").trim() || "",
      suggestedAction: String(cand.suggestedAction || "").trim() || "",
      linkedEntities,
      actionPlan,
    };

    if (!existing) state.timelineIssueCandidates = prependUniqueById(state.timelineIssueCandidates, [timelineCandidate]);

    // Make it visible in the existing Approvals pipeline (Issue list / detail / draft edit / approval transitions).
    if (!state.latestIngestResult) state.latestIngestResult = {};
    if (!Array.isArray(state.latestIngestResult.actionPlans)) state.latestIngestResult.actionPlans = [];
    if (!Array.isArray(state.latestIngestResult.drafts)) state.latestIngestResult.drafts = [];
    if (!state.approvalsByActionPlanId || typeof state.approvalsByActionPlanId !== "object") state.approvalsByActionPlanId = {};

    const now = nowIso();
    if (!state.approvalsByActionPlanId[id]) state.approvalsByActionPlanId[id] = { status: "pending_approval", updatedAt: now };

    const apExists = state.latestIngestResult.actionPlans.find((p) => p && String(p.id || "") === id) || null;
    if (!apExists) {
      state.latestIngestResult.actionPlans = prependUniqueById(state.latestIngestResult.actionPlans, [
        {
          id,
          issueId: id,
          title: timelineCandidate.title,
          status: "pending_approval",
          updatedAt: now,
          sourceLabel: timelineCandidate.source,
          linkedEntities,
        },
      ]);
    }

    const draftExists = state.latestIngestResult.drafts.find((d) => d && String(d.actionPlanId || "") === id) || null;
    if (!draftExists) {
      state.latestIngestResult.drafts = prependUniqueById(state.latestIngestResult.drafts, [
        {
          id: `draft:${id}`,
          actionPlanId: id,
          channel: actionPlan.channel,
          to: actionPlan.to,
          subject: actionPlan.subject,
          body: actionPlan.body,
          status: "pending_approval",
          updatedAt: now,
        },
      ]);
    }

    // Provide a "mutation" so that existing detail renderer can show it via state.activeMutationId.
    const mutExists =
      (Array.isArray(state.issueMutationItems) ? state.issueMutationItems : []).find((m) => m && matchesMutationId(m, id)) ||
      null;
    if (!mutExists) {
      const summary = String(obs.summary || "").trim() || timelineCandidate.title;
      const raw = String(cand.reason || "").trim();
      const entitiesLines = linkedEntities
        .map((l) => `Entities(${String(l.entityType)}): ${String(l.entityId)}`)
        .join("\n");
      const body = [
        `Summary: ${summary}`,
        "Intent: delivery_schedule_risk",
        "Confidence: 0.80",
        `Raw: ${raw || "-"}`,
        entitiesLines,
      ]
        .filter(Boolean)
        .join("\n");

      state.issueMutationItems = prependUniqueById(state.issueMutationItems, [
        {
          id,
          issueId: id,
          title: timelineCandidate.title,
          source: "Execution Timeline Agent",
          body,
          linkedEntities,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }

    // Activity: Timeline deviation detected (once per candidate id).
    const evId = `timeline:${id}`;
    const existingEv =
      (Array.isArray(state.latestIngestResult.activityEvents) ? state.latestIngestResult.activityEvents : []).find(
        (e) => e && String(e.id || "") === evId,
      ) || null;
    if (!existingEv) {
      const ev = {
        id: evId,
        type: "timeline_deviation_detected",
        actor: "execution_timeline_agent",
        title: "ETD遅延リスクを検出",
        occurredAt: nowIso(),
        description: "理想シナリオとの差分から Issue candidate を作成",
        relatedIssueId: id,
        linkedEntities,
      };
      state.latestIngestResult.activityEvents = prependUniqueById(state.latestIngestResult.activityEvents, [ev]);
      state.activityFeedItems = prependUniqueById(state.activityFeedItems, [activityEventToFeedItem(ev)]);
    }
  }

  function renderExecutionTimelineRiskHtml(risk) {
    const r = risk && typeof risk === "object" ? risk : null;
    const title = String(r?.riskTitle || "").trim();
    const ideal = Array.isArray(r?.ideal) ? r.ideal.filter(Boolean) : [];
    const current = Array.isArray(r?.current) ? r.current.filter(Boolean) : [];
    const impact = Array.isArray(r?.impact) ? r.impact.filter(Boolean) : [];
    const issueId = String(r?.issueCandidate?.id || "").trim();

    const list = (items) =>
      items.length
        ? `<ul class="list">${items.map((x) => `<li>${escapeHtml(String(x))}</li>`).join("")}</ul>`
        : `<div class="muted">-</div>`;

    return `
    <div class="timeline-risk">
      <div class="timeline-risk__headline">
        <span>⚠ ${escapeHtml(title || "リスク")}</span>
        ${
          issueId
            ? `<button class="pill pill--mini pill--muted mono issue-link-chip" type="button" data-open-timeline-issue="${escapeHtml(issueId)}" data-open-timeline-issue-candidate="${escapeHtml(issueId)}">Issue: ${escapeHtml(issueId)}</button>`
            : ""
        }
      </div>
      <div class="timeline-risk__grid">
        <div class="timeline-risk__block">
          <div class="timeline-risk__label">理想:</div>
          ${list(ideal)}
        </div>
        <div class="timeline-risk__block">
          <div class="timeline-risk__label">現在:</div>
          ${list(current)}
        </div>
        <div class="timeline-risk__block timeline-risk__block--impact">
          <div class="timeline-risk__label">影響:</div>
          ${list(impact)}
        </div>
      </div>
    </div>
  `;
  }

  function renderExecutionTimelineScenarioModalHtml(risk) {
    const r = risk && typeof risk === "object" ? risk : null;
    const scenario = Array.isArray(r?.scenario) ? r.scenario.filter(Boolean) : [];
    const customerDeliveryDate = "2026-05-25";

    const statusChip = (status) => {
      const st = String(status || "");
      if (st === "late") return `<span class="timeline-status timeline-status--late">遅延</span>`;
      if (st === "at_risk") return `<span class="timeline-status timeline-status--at-risk">要注意</span>`;
      if (st === "deadline") return `<span class="timeline-status timeline-status--deadline">納期</span>`;
      return `<span class="timeline-status timeline-status--planned">予定</span>`;
    };

    const itemsHtml = scenario.length
      ? `<ol class="timeline-scenario__timeline" role="list">
      ${scenario
        .map((s) => {
          const date = String(s?.date || "").trim();
          const milestone = String(s?.milestone || "").trim();
          const note = String(s?.note || "").trim();
          const status = String(s?.status || "").trim();
          const statusKey = status === "late" || status === "at_risk" || status === "deadline" || status === "planned" ? status : "planned";
          return `<li class="timeline-scenario__timeline-item timeline-scenario__timeline-item--${statusKey}">
            <div class="timeline-scenario__date mono">${escapeHtml(date || "-")}</div>
            <div class="timeline-scenario__row">
              <div class="timeline-scenario__milestone">${escapeHtml(milestone || "-")}</div>
              <div class="timeline-scenario__status">${statusChip(status)}</div>
            </div>
            <div class="timeline-scenario__note">${escapeHtml(note || "-")}</div>
          </li>`;
        })
        .join("")}
    </ol>`
      : `<div class="muted">-</div>`;

    return `
    <div class="timeline-scenario-overlay" role="dialog" aria-modal="true" aria-label="理想実行シナリオ">
      <div class="timeline-scenario-overlay__backdrop" data-close-timeline-scenario></div>
      <div class="timeline-scenario-modal">
        <div class="timeline-scenario-modal__top">
          <div class="timeline-scenario-modal__heading">
            <div class="timeline-scenario-modal__title">理想実行シナリオ</div>
            <div class="timeline-scenario-modal__subtitle">顧客納期 ${escapeHtml(customerDeliveryDate)} から逆算した理想タイムライン</div>
          </div>
          <button class="btn btn--ghost btn--tiny" type="button" data-close-timeline-scenario aria-label="Close">×</button>
        </div>
        <div class="timeline-scenario-modal__body">
          <div class="timeline-scenario__meta">
            <span class="pill pill--mini pill--muted">顧客納期: <span class="mono">${escapeHtml(customerDeliveryDate)}</span></span>
          </div>
          ${itemsHtml}
          <div class="timeline-scenario-modal__actions">
            <button class="btn btn--ghost" type="button" data-close-timeline-scenario>閉じる</button>
          </div>
        </div>
      </div>
    </div>
  `;
  }

  function renderStateTransitionCandidateCard(candidate, tradeCase) {
    const c = candidate && typeof candidate === "object" ? candidate : {};
    const id = String(c.id || "").trim();
    const entityType = String(c.entityType || "").trim();
    const entityId = String(c.entityId || "").trim();
    const fromState = String(c.fromState || "").trim();
    const toState = String(c.toState || "").trim();
    const decision = String(c.decision || "").trim();
    const confidence = typeof c.confidence === "number" ? c.confidence : null;
    const reason = String(c.reason || "").trim();

    const evidence = Array.isArray(c.evidence) ? c.evidence.filter(Boolean) : [];
    const risks = Array.isArray(c.risks) ? c.risks.filter(Boolean) : [];

    const eligibleForManualApply = decision === "auto_apply" || decision === "needs_human_review";
    const appliedIds = Array.isArray(state?.appliedStateTransitionCandidateIds) ? state.appliedStateTransitionCandidateIds.filter(Boolean).map(String) : [];
    const alreadyAppliedById = !!(id && appliedIds.includes(id));

    const currentState = (() => {
      const tc = tradeCase || null;
      if (!tc) return "";
      if (entityType !== "Shipment") return "";
      const shipmentId = String(tc?.shipmentEntity?.id || "").trim();
      if (!shipmentId || shipmentId !== entityId) return "";
      return String(tc?.shipmentEntity?.shipmentState || tc?.shipmentState || "").trim();
    })();
    const alreadyAppliedByState = !!(currentState && toState && currentState === toState);
    const alreadyApplied = alreadyAppliedById || alreadyAppliedByState;

    const decisionLabel = (() => {
      if (decision === "auto_apply") return "自動適用候補（未適用）";
      if (decision === "needs_issue_candidate") return "要Issue化（未作成）";
      if (decision === "needs_human_review") return "要人手確認";
      if (decision === "reject") return "却下候補";
      return decision || "-";
    })();

    const confidenceLabel = confidence == null ? "-" : `${Math.round(confidence * 100)}%`;

    const evidenceSummary = (() => {
      if (!evidence.length) return "";
      const summaries = evidence
        .map((e) => String(e?.summary || "").trim())
        .filter(Boolean)
        .slice(0, 3);
      if (!summaries.length) return "";
      const suffix = evidence.length > summaries.length ? `（他${evidence.length - summaries.length}件）` : "";
      return `${summaries.join(" / ")}${suffix}`;
    })();

    const risksSummary = (() => {
      if (!risks.length) return "";
      const summaries = risks
        .map((r) => String(r?.summary || "").trim())
        .filter(Boolean)
        .slice(0, 2);
      if (!summaries.length) return "";
      const suffix = risks.length > summaries.length ? `（他${risks.length - summaries.length}件）` : "";
      return `${summaries.join(" / ")}${suffix}`;
    })();

    const buttonLabel = (() => {
      if (!alreadyApplied) return "この状態に反映";
      if (alreadyAppliedByState && !alreadyAppliedById) return "既にこの状態です";
      return "反映済み";
    })();

    return `
      <article class="state-transition-candidate-card" aria-label="State transition candidate">
        <div class="state-transition-candidate-card__meta">
          <span class="mono">${escapeHtml(id || "-")}</span>
          <span class="muted">·</span>
          <span>${escapeHtml(entityType || "-")}</span>
          <span class="muted">·</span>
          <span class="mono">${escapeHtml(entityId || "-")}</span>
        </div>
        <div class="state-transition-candidate-card__title">${escapeHtml(fromState || "-")} → ${escapeHtml(toState || "-")}</div>
        <div class="state-transition-candidate-card__chips">
          <span class="pill pill--mini pill--muted">decision: ${escapeHtml(decisionLabel)}</span>
          <span class="pill pill--mini pill--muted">confidence: <span class="mono">${escapeHtml(confidenceLabel)}</span></span>
        </div>
        ${reason ? `<div class="state-transition-candidate-card__body">${escapeHtml(reason)}</div>` : ""}
        ${evidenceSummary ? `<div class="state-transition-candidate-card__sub"><span class="muted">evidence</span>: ${escapeHtml(evidenceSummary)}</div>` : ""}
        ${risksSummary ? `<div class="state-transition-candidate-card__sub"><span class="muted">risks</span>: ${escapeHtml(risksSummary)}</div>` : ""}
        ${
          eligibleForManualApply
            ? `<div class="state-transition-candidate-card__actions">
                <button
                  type="button"
                  class="btn btn--ghost"
                  data-apply-state-transition-candidate="${escapeHtml(id)}"
                  ${alreadyApplied ? "disabled" : ""}
                >
                  ${escapeHtml(buttonLabel)}
                </button>
              </div>`
            : ""
        }
      </article>
    `;
  }

  function renderStateTransitionCandidates({ candidates, tradeCase, focusId }) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!list.length) return "";
    const tc = tradeCase || null;
    const focus = String(focusId || "").trim();

    const relatedEntityIds = new Set(
      [
        focus,
        tc?.id,
        tc?.shipmentEntity?.id,
        tc?.siEntity?.id,
        tc?.siEntity?.siNo,
        ...(tc?.siNumbers ?? []),
        ...(tc?.shipmentIds ?? []),
      ]
        .filter(Boolean)
        .map((v) => String(v).trim())
        .filter(Boolean),
    );

    const relevantCandidates = list.filter((candidate) => relatedEntityIds.has(String(candidate?.entityId || "").trim()));
    if (!relevantCandidates.length) return "";

    const cardsHtml = relevantCandidates.map((c) => renderStateTransitionCandidateCard(c, tc)).join("");
    if (!cardsHtml) return "";

    return `
      <div class="workspace-section">
        <div class="workspace-section__title">
          <span>状態遷移候補</span>
          <span class="muted"> / State Transition Candidate</span>
        </div>
        <div class="state-transition-candidates__list">
          ${cardsHtml}
        </div>
      </div>
    `;
  }

  function renderDocumentWorkspace(tradeCase, { focusType, focusId, initialDocId, stateTransitionCandidates } = {}) {
    const tc = tradeCase || null;
    if (!tc) return "";

    const sh = tc.shipmentEntity || null;
    const si = tc.siEntity || null;
    const customer = tc.customer || null;
    const supplier = tc.supplier || null;

    const ui = getWorkspaceUi("document-workspace-modal");
    const type = normalizeFocusType(focusType || ui.focusType);
    const id = String(focusId || ui.focusId || "").trim();
    ui.focusType = type;
    ui.focusId = id || "-";

    const documents = buildDocumentWorkspaceDocuments(tc, type, id);

    if (initialDocId) {
      const initialResolved = resolveInitialDocId(initialDocId, documents);
      if (initialResolved) {
        ui.activeDocId = initialResolved;
        ui.activePageByDocId[initialResolved] = 0;
      }
    } else if (!ui.activeDocId) {
      const focusResolved = resolveFocusDocId({ focusType: type, focusId: id, documents });
      if (focusResolved) {
        ui.activeDocId = focusResolved;
        ui.activePageByDocId[focusResolved] = 0;
      }
    }

    const uiForTabs = ensureWorkspaceUiDefaults("document-workspace-modal", documents);
    const tabsHtml = renderDocumentTabs(documents, { activeDocId: uiForTabs.activeDocId, viewerKey: "document" });
    const viewerHtml = renderDocumentViewer(documents, { modalId: "document-workspace-modal", viewerKey: "document" });

    const activeDoc = documents.find((d) => d && d.id === uiForTabs.activeDocId) || documents[0] || null;
    const isBaselineShippingInstruction = Boolean(isShippingInstructionDocument?.(activeDoc, "document"));

    const executionTimelineRisk = buildExecutionTimelineRisk(tc, type, id);
    ensureExecutionTimelineIssueCandidateSynced(executionTimelineRisk);
    const riskHtml = renderExecutionTimelineRiskHtml(executionTimelineRisk);
    const scenarioModalHtml = (() => {
      const active = state.activeTimelineScenarioModal;
      if (!active) return "";
      if (String(active.tradeCaseId || "") !== String(tc.id || "")) return "";
      return renderExecutionTimelineScenarioModalHtml(executionTimelineRisk);
    })();

    const docCheckResults = buildDocumentCheckResults(tc, type, id);
    const docCheckHtml = !documents.length
      ? `
        <div class="doc-check-empty">
          <div class="doc-check-empty__title">関連書類未登録</div>
          <div class="doc-check-empty__body">
            Slack / Email / Upload から<br />
            書類が追加されると自動解析されます。
          </div>
        </div>
      `
      : isBaselineShippingInstruction
        ? `
          <div class="muted" style="margin-bottom:6px;">基準書類：Shipping Instruction</div>
          <div style="margin-bottom:10px;">このSIを基準に、後続の Invoice / Packing List / B/L の内容を照合します。</div>
          <div class="muted" style="margin-bottom:6px;">確認ポイント</div>
          <ul class="list">
            <li>SI番号</li>
            <li>数量</li>
            <li>納期</li>
            <li>出荷条件</li>
          </ul>
        `
        : renderDocumentCheckResults(docCheckResults);

    const relationshipTree = buildWorkspaceRelationshipTree(tc, type, id);
    const relationshipTreeHtml = renderWorkspaceRelationshipTree(relationshipTree);
    const operationalSummary = buildWorkspaceOperationalSummary(tc, type, id);
    const operationalSummaryHtml = renderWorkspaceOperationalSummaryHtml(operationalSummary);
    const stateTransitionCandidatesHtml = renderStateTransitionCandidates({
      candidates: stateTransitionCandidates,
      tradeCase: tc,
      focusId: id,
    });

    const resolveFocusMemoEntity = (focusType, focusId) => {
      const ft = normalizeFocusType(focusType);
      const raw = String(focusId || "").trim();
      const fid = ft === "invoice" ? normalizeInvoiceNo(raw) : raw;
      return fid && fid !== "-" ? { type: ft, id: fid } : null;
    };

    const focusMemoEntity = resolveFocusMemoEntity(type, id);
    const humanMemos = Array.isArray(state.humanMemos) ? state.humanMemos.filter(Boolean) : [];
    const focusMemos = focusMemoEntity
      ? humanMemos.filter((m) => {
          const linked = Array.isArray(m?.linkedEntities) ? m.linkedEntities.filter(Boolean) : [];
          return linked.some((e) => String(e?.type || "") === focusMemoEntity.type && String(e?.id || "") === focusMemoEntity.id);
        })
      : [];

    const memoLinkedChipsHtml = (memo) => {
      const linked = Array.isArray(memo?.linkedEntities) ? memo.linkedEntities.filter(Boolean) : [];
      if (!linked.length) return "";
      const chips = linked
        .map((e) => {
          const et = normalizeFocusType(e?.type);
          const eid = String(e?.id || "").trim();
          if (!et || !eid) return "";
          const label = formatFocusLabel(et, eid);
          return `<span class="pill pill--mini">${escapeHtml(String(label || eid))}</span>`;
        })
        .filter(Boolean)
        .join("");
      if (!chips) return "";
      return `<div class="human-memo__chips" aria-label="linked entities">${chips}</div>`;
    };

    const memoListHtml = (() => {
      if (!focusMemoEntity) {
        return `<div class="muted">このFocusに紐づくメモはありません。</div>`;
      }
      if (!focusMemos.length) {
        return `<div class="muted">このFocusに紐づくメモはありません。</div>`;
      }
      return focusMemos
        .slice()
        .sort((a, b) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || "")))
        .map((m) => {
          const body = String(m?.body || "").trim();
          const aiShared = !!m?.aiShared;
          const id = String(m?.id || "");
          const statusChip = aiShared
            ? `<span class="pill pill--mini pill--muted memo-action-status">AI共有済み</span>`
            : `<span class="pill pill--mini pill--muted memo-action-status">AI未共有</span>`;
          const shareBtn = aiShared
            ? ""
            : `<button class="btn btn--ghost btn--tiny memo-action-btn" type="button" data-human-memo-share="${escapeHtml(id)}">AIへ共有</button>`;
          const deleteBtn = `<button class="human-memo-delete" type="button" aria-label="メモを削除" data-human-memo-delete="${escapeHtml(id)}">×</button>`;
          return `<div class="human-memo-card" role="button" tabindex="0" data-human-memo-card="${escapeHtml(id)}">
          ${deleteBtn}
          <div class="human-memo__body">${escapeHtml(body || "-")}</div>
          ${memoLinkedChipsHtml(m)}
          <div class="human-memo__meta">
            ${statusChip}
            ${shareBtn}
          </div>
        </div>`;
        })
        .join("");
    })();

    return `
    <div class="workspace-modal">
      <div class="workspace-topbar">
        <div class="workspace-topbar__tabs">
          ${tabsHtml}
        </div>
      </div>
      <div class="workspace-layout">
        <aside class="workspace-pane workspace-pane--left" aria-label="Case context">
          <div class="workspace-section">
            <div class="workspace-section__title">現在の状況</div>
            ${operationalSummaryHtml}
          </div>

          <div class="workspace-section">
            <div class="workspace-section__title">紐付き</div>
            ${relationshipTreeHtml}
          </div>
        </aside>

        <main class="workspace-pane workspace-pane--center" aria-label="Document viewer">
          ${viewerHtml}
        </main>

        <aside class="workspace-pane workspace-pane--right" aria-label="Decision helper">
          <div class="workspace-section">
            <div class="workspace-section__title">${escapeHtml(docCheckResults?.title || "AIの書類チェック")}</div>
            ${docCheckHtml}
          </div>
          ${stateTransitionCandidatesHtml}
          <div class="workspace-section">
            <div class="workspace-section__title human-memo__header">
              <span>人間メモ</span>
              <button class="btn btn--ghost btn--tiny memo-action-btn" type="button" data-human-memo-add>+ メモ追加</button>
            </div>
            <div class="human-memo__list">
              ${memoListHtml}
            </div>
          </div>
          <div class="workspace-section">
            <div class="workspace-section__title workspace-section__header">
              <span>納期・物流リスク</span>
              <button class="btn btn--ghost btn--tiny" type="button" data-open-timeline-scenario>理想シナリオ</button>
            </div>
            ${riskHtml}
          </div>
        </aside>
      </div>
      ${scenarioModalHtml}
    </div>
  `;
  }

  return {
    buildWorkspaceHeaderLabels,
    renderDocumentWorkspace,
  };
}

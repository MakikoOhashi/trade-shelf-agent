const shelves = ["出荷待ち", "書類不足", "返信待ち", "通関中", "完了"];

const state = {
  inboxItems: [],
  shelfItems: [],
  pendingProposal: null,
};

function nowIso() {
  return new Date().toISOString();
}

function formatLocalTime(iso) {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function shortId() {
  return Math.random().toString(16).slice(2, 10);
}

function classifyToShelf(text) {
  const t = String(text || "").toLowerCase();
  if (/(完了|done|closed)/i.test(text)) return "完了";
  if (/(不足|missing|need|lack)/i.test(text)) return "書類不足";
  if (/(reply|返信待ち|返事待ち|re:)/i.test(text)) return "返信待ち";
  if (/(customs|通関)/i.test(text)) return "通関中";
  if (/(si\b|shipping instruction|shipment|出荷)/i.test(text)) return "出荷待ち";
  if (/(inv\b|invoice)/i.test(text)) return "通関中";
  return "出荷待ち";
}

function guessTitle(payload) {
  if (!payload) return "Untitled";
  if (payload.kind === "file") return payload.name || "File";
  if (payload.kind === "text") {
    const firstLine = String(payload.text || "").split("\n")[0].trim();
    return firstLine ? firstLine.slice(0, 60) : "Text";
  }
  return "Item";
}

function summarize(payload) {
  if (!payload) return "";
  if (payload.kind === "file") {
    const size = typeof payload.size === "number" ? `${Math.ceil(payload.size / 1024)} KB` : "";
    return [payload.type, size].filter(Boolean).join(" · ");
  }
  if (payload.kind === "text") {
    return String(payload.text || "").trim().slice(0, 160);
  }
  return "";
}

function log(text) {
  const logItems = document.getElementById("log-items");
  const iso = nowIso();
  const row = document.createElement("div");
  row.className = "log__item";
  row.innerHTML = `<div class="log__time">${formatLocalTime(iso)}</div><div class="log__text"></div>`;
  row.querySelector(".log__text").textContent = text;
  logItems.prepend(row);
}

function updateCounts() {
  const inboxCount = document.getElementById("inbox-count");
  inboxCount.textContent = `${state.inboxItems.length} items`;

  for (const shelfName of shelves) {
    const el = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-count]`);
    if (!el) continue;
    const count = state.shelfItems.filter((i) => i.shelf === shelfName).length;
    el.textContent = String(count);
  }
}

function renderInbox() {
  const root = document.getElementById("inbox-items");
  root.innerHTML = "";
  for (const item of state.inboxItems.slice().reverse()) {
    const el = document.createElement("div");
    el.className = "item";
    const title = guessTitle(item.payload);
    el.innerHTML = `
      <div class="item__title"></div>
      <div class="item__meta">
        <span class="pill"></span>
        <span class="pill"></span>
      </div>
    `;
    el.querySelector(".item__title").textContent = title;
    const pills = el.querySelectorAll(".pill");
    pills[0].textContent = item.payload.kind.toUpperCase();
    pills[1].textContent = formatLocalTime(item.createdAt);
    root.appendChild(el);
  }
}

function renderShelves() {
  for (const shelfName of shelves) {
    const body = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-body]`);
    if (!body) continue;
    body.innerHTML = "";
    const items = state.shelfItems.filter((i) => i.shelf === shelfName).slice().reverse();
    for (const item of items) {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.id = item.id;
      card.innerHTML = `<div class="card__title"></div><div class="card__body"></div>`;
      card.querySelector(".card__title").textContent = item.title;
      card.querySelector(".card__body").textContent = item.summary;
      card.addEventListener("click", () => openProposal(item));
      body.appendChild(card);
    }
  }
}

function addItem(payload) {
  const createdAt = nowIso();
  const id = shortId();
  state.inboxItems.push({ id, createdAt, payload });

  const title = guessTitle(payload);
  const shelf = classifyToShelf(payload.kind === "text" ? payload.text : payload.name);
  const summary = summarize(payload);

  state.shelfItems.push({
    id,
    createdAt,
    shelf,
    title,
    summary,
    payload,
  });

  updateCounts();
  renderInbox();
  renderShelves();

  log(`投入: 「${title}」→ 棚「${shelf}」へ格納（ダミー分類）`);
}

function openModal(bodyText) {
  const modal = document.getElementById("modal");
  const modalBody = document.getElementById("modal-body");
  modalBody.textContent = bodyText;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  state.pendingProposal = null;
}

function openProposal(item) {
  const base = item.payload.kind === "text" ? item.payload.text : item.payload.name;
  const proposal = proposeActionFromText(base);
  state.pendingProposal = { itemId: item.id, proposal };
  openModal(
    [
      `対象: ${item.title}`,
      `棚: ${item.shelf}`,
      "",
      "提案（ダミー）:",
      proposal,
      "",
      "※ 承認すると「実行したことにして」ログへ残します。",
    ].join("\n")
  );
}

function proposeActionFromText(text) {
  const t = String(text || "");
  const hasMismatch = /(expected|期待|si)\s*1000/i.test(t) && /(inv|invoice|実績)\s*400/i.test(t);
  if (hasMismatch) {
    return [
      "1) 仕入先へ確認（INV 数量が 400 の理由と、残数量の見込み）",
      "2) 社内に影響（納期・通関）を共有し、出荷計画を更新",
      "3) 追加 INV / 修正 INV の提出依頼",
    ].join("\n");
  }
  if (/(不足|missing)/i.test(t)) return "必要書類のリストアップ → 仕入先へ依頼メール草案を作成";
  if (/(reply|返信|re:)/i.test(t)) return "未返信相手にリマインド（丁寧/急ぎ の2パターン）";
  return "状況要約 → 次アクション案を3つ提示（ダミー）";
}

function setupDropzone() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const btnPick = document.getElementById("btn-pick");

  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ["dragenter", "dragover"].forEach((name) => {
    dropzone.addEventListener(name, (e) => {
      prevent(e);
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    dropzone.addEventListener(name, (e) => {
      prevent(e);
      dropzone.classList.remove("is-dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;

    if (dt.files && dt.files.length > 0) {
      for (const f of dt.files) {
        addItem({ kind: "file", name: f.name, type: f.type || "file", size: f.size });
      }
      return;
    }

    const text = dt.getData("text/plain");
    if (text && text.trim()) addItem({ kind: "text", text });
  });

  btnPick.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (!fileInput.files) return;
    for (const f of fileInput.files) {
      addItem({ kind: "file", name: f.name, type: f.type || "file", size: f.size });
    }
    fileInput.value = "";
  });
}

function setupTextAdd() {
  const textarea = document.getElementById("text-input");
  const btnAdd = document.getElementById("btn-add-text");
  btnAdd.addEventListener("click", () => {
    const text = textarea.value;
    if (!text || !text.trim()) return;
    addItem({ kind: "text", text });
    textarea.value = "";
  });
}

function setupModal() {
  const modal = document.getElementById("modal");
  const approve = document.getElementById("btn-approve");

  modal.addEventListener("click", (e) => {
    const target = e.target;
    if (!target) return;
    if (target.matches("[data-close]")) closeModal();
  });

  approve.addEventListener("click", () => {
    if (!state.pendingProposal) return;
    const { itemId, proposal } = state.pendingProposal;
    const item = state.shelfItems.find((i) => i.id === itemId);
    log(`承認: 「${item ? item.title : itemId}」提案を実行（ダミー）\n${proposal}`);
    closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

function seed() {
  addItem({
    kind: "text",
    text: "件名: SI 1000 / INV 400 差異\n状況: 期待 1000 に対して INV 400。\n対応: 仕入先へ確認したい。",
  });
  addItem({
    kind: "text",
    text: "Re: 通関書類の確認依頼\n不足書類があるので提出お願いします（Packing List / COO）。",
  });
  addItem({ kind: "file", name: "INV_2026-04-21.pdf", type: "application/pdf", size: 193402 });
  addItem({ kind: "file", name: "SI_Shanghai_2026-04-20.xlsx", type: "application/vnd.ms-excel", size: 55443 });
}

function clearAll() {
  state.inboxItems = [];
  state.shelfItems = [];
  state.pendingProposal = null;
  document.getElementById("inbox-items").innerHTML = "";
  for (const shelfName of shelves) {
    const body = document.querySelector(`.shelf[data-shelf="${shelfName}"] [data-body]`);
    if (body) body.innerHTML = "";
  }
  document.getElementById("log-items").innerHTML = "";
  updateCounts();
  log("クリア: 全ての棚/Inbox を空にしました");
}

function setupTopActions() {
  document.getElementById("btn-seed").addEventListener("click", seed);
  document.getElementById("btn-clear").addEventListener("click", clearAll);
  document.getElementById("btn-incident").addEventListener("click", () => {
    addItem({
      kind: "text",
      text: "INCIDENT: expected 1000 / invoiced 400 mismatch\n影響: 出荷・通関遅延の可能性。\n対応案を出して承認を取りたい。",
    });
  });
}

function main() {
  setupDropzone();
  setupTextAdd();
  setupModal();
  setupTopActions();
  updateCounts();
  log("起動: UI mock を開始");
}

main();

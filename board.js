// board.js — draws a Trello board as a shared daily checklist.
// Expects window.BOARD_CONFIG = { board, title }
// Data and passcode check come from the today-board Worker; Trello keys never reach the browser.
(() => {
  const cfg = window.BOARD_CONFIG;
  const API = (cfg && cfg.api) || "https://today-board.mike-7a9.workers.dev";
  const POLL_MS = 5000;
  const TOKEN_KEY = `today-board:${cfg && cfg.board}:token`;
  const OPEN_KEY = `today-board:${cfg && cfg.board}:open`;

  const $ = (id) => document.getElementById(id);
  const main = $("main");
  let board = null;      // {lists:[{id,name,cards:[{id,name,desc}]}]}
  let checked = {};      // {cardId: true}
  let pollTimer = null;
  let openNotes = new Set(load(OPEN_KEY, []));

  function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Light markdown: links, bold, line breaks. Everything escaped first.
  function md(text) {
    let s = esc(text.trim());
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/‌/g, "");
    return s.replace(/\n/g, "<br>");
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts.headers || {}) },
    });
    if (res.status === 401 && path !== "/login") { showLock(); throw new Error("locked"); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `error ${res.status}`);
    return body;
  }

  function setStatus(t) { $("status").textContent = t; }

  // ---- passcode screen ----
  function showLock(msg) {
    clearInterval(pollTimer);
    document.body.classList.add("locked");
    main.innerHTML = `
      <form id="lock" class="lock">
        <p class="lock-title">Guides only</p>
        <input id="pass" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="Your cell number" required>
        <button type="submit">Open</button>
        <p class="lock-msg">${esc(msg || "")}</p>
      </form>`;
    setStatus("");
    $("pass").focus();
    $("lock").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const r = await api("/login", { method: "POST", body: JSON.stringify({ board: cfg.board, phone: $("pass").value }) });
        localStorage.setItem(TOKEN_KEY, r.token);
        document.body.classList.remove("locked");
        start();
      } catch (err) { showLock(err.message === "number not recognized" ? "That number isn't on the staff list." : err.message); }
    });
  }

  // ---- board ----
  function allCards() { return board ? board.lists.flatMap((l) => l.cards) : []; }

  function progress() {
    const cards = allCards();
    const done = cards.filter((c) => checked[c.id]).length;
    $("progress-bar").style.width = cards.length ? `${(100 * done) / cards.length}%` : "0";
    $("progress-text").textContent = `${done} / ${cards.length}`;
  }

  function render() {
    if (!board.lists.length) { main.innerHTML = '<p class="empty">This board has no lists yet.</p>'; return; }
    main.innerHTML = board.lists.map((l) => `
      <h2 class="section">${esc(l.name)}</h2>
      ${l.cards.length ? `<ul class="list">${l.cards.map((c) => `
        <li class="item${checked[c.id] ? " done" : ""}" data-id="${c.id}">
          <label>
            <input type="checkbox" ${checked[c.id] ? "checked" : ""}>
            <span class="text"><span class="item-title">${esc(c.name)}</span></span>
          </label>
          ${c.desc.trim() || c.cover ? `
            <button class="notes-toggle" aria-expanded="${openNotes.has(c.id)}">${openNotes.has(c.id) ? "Hide notes" : "Notes"}</button>
            <div class="item-notes card-notes"${openNotes.has(c.id) ? "" : " hidden"}>
              ${c.cover ? `<img class="card-cover" alt="" data-src="${API}/cover/${cfg.board}/${c.id}?v=${c.cover}&auth=${encodeURIComponent(token())}">` : ""}
              ${c.desc.trim() ? `<div>${md(c.desc)}</div>` : ""}
            </div>` : ""}
        </li>`).join("")}</ul>` : '<p class="empty-list">No cards</p>'}`).join("");
    loadOpenImages();
    progress();
  }

  function loadOpenImages() {
    document.querySelectorAll(".card-notes:not([hidden]) img[data-src]").forEach((img) => {
      img.src = img.dataset.src; img.removeAttribute("data-src");
    });
  }

  function applyChecked() {
    document.querySelectorAll(".item").forEach((li) => {
      const on = !!checked[li.dataset.id];
      li.classList.toggle("done", on);
      li.querySelector("input").checked = on;
    });
    progress();
  }

  main.addEventListener("change", async (e) => {
    const li = e.target.closest(".item");
    if (!li) return;
    const id = li.dataset.id, on = e.target.checked;
    if (on) checked[id] = true; else delete checked[id];
    applyChecked();
    try {
      const r = await api(`/state/${cfg.board}/${id}`, { method: on ? "PUT" : "DELETE" });
      checked = r.checked; applyChecked(); setStatus("Saved");
    } catch (err) { if (err.message !== "locked") setStatus("Couldn't save — check signal and tap again"); }
  });

  main.addEventListener("click", (e) => {
    const btn = e.target.closest(".notes-toggle");
    if (!btn) return;
    const li = btn.closest(".item"), id = li.dataset.id, notes = li.querySelector(".card-notes");
    const open = notes.hidden;
    notes.hidden = !open;
    btn.textContent = open ? "Hide notes" : "Notes";
    btn.setAttribute("aria-expanded", open);
    open ? openNotes.add(id) : openNotes.delete(id);
    if (open) loadOpenImages();
    save(OPEN_KEY, [...openNotes]);
  });

  async function loadBoard() {
    setStatus("Loading…");
    const r = await api(`/board/${cfg.board}`);
    board = r; checked = r.checked || {};
    render();
    setStatus(`Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  }

  async function poll() {
    try { const r = await api(`/state/${cfg.board}`); checked = r.checked || {}; applyChecked(); } catch {}
  }

  async function start() {
    $("brand").textContent = cfg.title;
    $("date").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    if (!token()) return showLock();
    try { await loadBoard(); } catch (err) { if (err.message !== "locked") setStatus(err.message); return; }
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
  }

  $("refresh").addEventListener("click", () => start());
  document.addEventListener("visibilitychange", () => { if (!document.hidden && board) poll(); });
  start();
})();

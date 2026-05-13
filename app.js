// app.js — shared between today-tourcwe and today-forestparkpicnics
// Expects window.CHECKLIST_CONFIG = { sheetId, tab, title }
//
// State sync: ticks are stored in the today-state Cloudflare Worker so all
// devices viewing the same tab see the same checked items. Polled every 5s.
// localStorage holds a fallback view of last-known-good state and queues
// any tick that fails to reach the server.

(() => {
  const cfg = window.CHECKLIST_CONFIG;
  if (!cfg) { document.body.innerHTML = '<p style="padding:1rem">Missing config.</p>'; return; }

  const CSV_URL = `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(cfg.tab)}`;
  const STATE_URL = 'https://today-state.mike-7a9.workers.dev';
  const POLL_MS = 5000;
  const RETRY_MS = 3000;

  const todayKey = () => {
    const d = new Date();
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  };

  // localStorage layout:
  //   `${tab}:cache:${date}` → JSON `{idx: true}` cached server state
  //   `${tab}:queue:${date}` → JSON `{idx: 'put'|'delete'}` pending writes
  const cacheStoreKey = (date) => `${cfg.tab}:cache:${date}`;
  const queueStoreKey = (date) => `${cfg.tab}:queue:${date}`;

  // Sweep stale localStorage entries from previous days
  const today = todayKey();
  Object.keys(localStorage)
    .filter(k => k.startsWith(`${cfg.tab}:`) && !k.includes(`:${today}`))
    .forEach(k => localStorage.removeItem(k));

  // In-memory state
  let checkedState = loadCache();   // {idx: true}
  let writeQueue = loadQueue();     // {idx: 'put'|'delete'}
  let items = [];                   // [{section, item, notes}, ...]
  let pollTimer = null;

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(cacheStoreKey(today)) || '{}') || {}; }
    catch { return {}; }
  }
  function saveCache() {
    localStorage.setItem(cacheStoreKey(today), JSON.stringify(checkedState));
  }
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(queueStoreKey(today)) || '{}') || {}; }
    catch { return {}; }
  }
  function saveQueue() {
    if (Object.keys(writeQueue).length === 0) {
      localStorage.removeItem(queueStoreKey(today));
    } else {
      localStorage.setItem(queueStoreKey(today), JSON.stringify(writeQueue));
    }
  }

  // Minimal CSV parser — handles quoted fields with commas/newlines/escaped quotes
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i+1];
      if (inQuotes) {
        if (c === '"' && next === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else { field += c; }
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function formatTodayHeading() {
    const d = new Date();
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // ── Server I/O ────────────────────────────────────────────────────────
  async function fetchServerState() {
    const r = await fetch(`${STATE_URL}/state/${cfg.tab}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`state GET ${r.status}`);
    const body = await r.json();
    return body.checked || {};
  }

  async function writeServerState(idx, checked) {
    const method = checked ? 'PUT' : 'DELETE';
    const r = await fetch(`${STATE_URL}/state/${cfg.tab}/${idx}`, { method, cache: 'no-store' });
    if (!r.ok) throw new Error(`state ${method} ${r.status}`);
    return r.json();
  }

  // ── Tick handling ─────────────────────────────────────────────────────
  async function setItemChecked(idx, checked) {
    // Optimistic UI
    if (checked) checkedState[idx] = true; else delete checkedState[idx];
    saveCache();
    applyStateToDom();

    // Try to write through
    try {
      await writeServerState(idx, checked);
      // Server confirmed — drop any pending queue entry
      delete writeQueue[idx];
      saveQueue();
      setStatus(`Synced ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`);
    } catch (e) {
      // Queue for retry; UI keeps optimistic state
      writeQueue[idx] = checked ? 'put' : 'delete';
      saveQueue();
      setStatus('Saving offline — will retry');
      setTimeout(flushQueue, RETRY_MS);
    }
  }

  async function flushQueue() {
    const entries = Object.entries(writeQueue);
    if (entries.length === 0) return;
    for (const [idx, op] of entries) {
      try {
        await writeServerState(idx, op === 'put');
        delete writeQueue[idx];
      } catch {
        saveQueue();
        setTimeout(flushQueue, RETRY_MS);
        return;
      }
    }
    saveQueue();
  }

  // ── Polling ───────────────────────────────────────────────────────────
  async function poll() {
    try {
      const server = await fetchServerState();
      // Don't clobber queued writes — keep local view consistent with what
      // we've tried to send but haven't yet confirmed
      for (const [idx, op] of Object.entries(writeQueue)) {
        if (op === 'put') server[idx] = true;
        else delete server[idx];
      }
      const before = JSON.stringify(checkedState);
      const after = JSON.stringify(server);
      if (before !== after) {
        checkedState = server;
        saveCache();
        applyStateToDom();
      }
      setStatus(`Synced ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`);
      // Opportunistically retry any failed writes whenever we successfully poll
      if (Object.keys(writeQueue).length) flushQueue();
    } catch (e) {
      setStatus('Offline — using cached state');
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  function render() {
    const main = document.getElementById('main');

    if (!items.length) {
      main.innerHTML = '<p class="empty">No checklist items found. Add rows to the sheet.</p>';
      updateProgress(0, 0);
      return;
    }

    const groups = new Map();
    items.forEach((it, idx) => {
      const sec = it.section || 'Checklist';
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push({ ...it, idx });
    });

    const html = [];
    for (const [section, rows] of groups) {
      html.push(`<h2 class="section">${escapeHtml(section)}</h2>`);
      html.push('<ul class="list">');
      for (const row of rows) {
        const checked = !!checkedState[row.idx];
        html.push(`
          <li class="item ${checked ? 'done' : ''}" data-idx="${row.idx}">
            <label>
              <input type="checkbox" ${checked ? 'checked' : ''} />
              <span class="text">
                <span class="item-title">${escapeHtml(row.item)}</span>
                ${row.notes ? `<span class="item-notes">${escapeHtml(row.notes)}</span>` : ''}
              </span>
            </label>
          </li>`);
      }
      html.push('</ul>');
    }
    main.innerHTML = html.join('');

    main.querySelectorAll('.item').forEach(li => {
      const idx = li.dataset.idx;
      const cb = li.querySelector('input');
      cb.addEventListener('change', () => {
        setItemChecked(idx, cb.checked);
      });
    });

    updateProgressFromDom();
  }

  function applyStateToDom() {
    document.querySelectorAll('.item').forEach(li => {
      const idx = li.dataset.idx;
      const cb = li.querySelector('input');
      const shouldBeChecked = !!checkedState[idx];
      if (cb.checked !== shouldBeChecked) cb.checked = shouldBeChecked;
      li.classList.toggle('done', shouldBeChecked);
    });
    updateProgressFromDom();
  }

  function updateProgressFromDom() {
    const all = document.querySelectorAll('.item');
    const done = document.querySelectorAll('.item.done');
    updateProgress(done.length, all.length);
  }

  function updateProgress(done, total) {
    const bar = document.getElementById('progress-bar');
    const txt = document.getElementById('progress-text');
    const pct = total === 0 ? 0 : Math.round(done/total*100);
    bar.style.width = pct + '%';
    txt.textContent = total === 0 ? '—' : `${done} of ${total}`;
  }

  function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  // ── Initial load ──────────────────────────────────────────────────────
  async function loadChecklist() {
    setStatus('Loading…');
    try {
      const res = await fetch(CSV_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCSV(text);
      if (rows.length === 0) throw new Error('Empty sheet');
      const header = rows[0].map(s => s.trim().toLowerCase());
      const iSec = header.indexOf('section');
      const iItem = header.indexOf('item');
      const iNotes = header.indexOf('notes');
      if (iItem === -1) throw new Error('Sheet missing "item" column');
      items = rows.slice(1)
        .map(r => ({
          section: iSec >= 0 ? (r[iSec] || '').trim() : '',
          item: (r[iItem] || '').trim(),
          notes: iNotes >= 0 ? (r[iNotes] || '').trim() : '',
        }))
        .filter(r => r.item);
      render();

      // Pull server state, then start polling
      try {
        const server = await fetchServerState();
        for (const [idx, op] of Object.entries(writeQueue)) {
          if (op === 'put') server[idx] = true; else delete server[idx];
        }
        checkedState = server;
        saveCache();
        applyStateToDom();
      } catch {
        // Use cached state if server unreachable on first load
        applyStateToDom();
      }

      if (Object.keys(writeQueue).length) flushQueue();
      startPolling();

      setStatus(`Synced ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`);
    } catch (e) {
      console.error(e);
      setStatus('Could not load checklist. Pull to refresh.');
    }
  }

  // Set heading + title
  document.getElementById('brand').textContent = cfg.title;
  document.getElementById('date').textContent = formatTodayHeading();
  document.title = cfg.title;

  document.getElementById('refresh').addEventListener('click', loadChecklist);
  loadChecklist();
})();

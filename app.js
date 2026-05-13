// app.js — shared between today-tourcwe and today-forestparkpicnics
// Expects window.CHECKLIST_CONFIG = { sheetId, tab, title }
(() => {
  const cfg = window.CHECKLIST_CONFIG;
  if (!cfg) { document.body.innerHTML = '<p style="padding:1rem">Missing config.</p>'; return; }

  const CSV_URL = `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(cfg.tab)}`;

  const todayKey = () => {
    const d = new Date();
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  };

  const storeKey = (date, idx) => `${cfg.tab}:${date}:${idx}`;

  // Clear localStorage entries from previous days for this tab
  const today = todayKey();
  Object.keys(localStorage)
    .filter(k => k.startsWith(`${cfg.tab}:`) && !k.startsWith(`${cfg.tab}:${today}:`))
    .forEach(k => localStorage.removeItem(k));

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

  function render(items) {
    const main = document.getElementById('main');
    const date = todayKey();

    if (!items.length) {
      main.innerHTML = '<p class="empty">No checklist items found. Add rows to the sheet.</p>';
      updateProgress(0, 0);
      return;
    }

    // Group by section, preserving order of first appearance
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
        const checked = localStorage.getItem(storeKey(date, row.idx)) === '1';
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

    // Wire checkbox events
    main.querySelectorAll('.item').forEach(li => {
      const idx = li.dataset.idx;
      const cb = li.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) {
          localStorage.setItem(storeKey(date, idx), '1');
          li.classList.add('done');
        } else {
          localStorage.removeItem(storeKey(date, idx));
          li.classList.remove('done');
        }
        updateProgressFromDom();
      });
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  async function load() {
    const status = document.getElementById('status');
    status.textContent = 'Loading…';
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
      const items = rows.slice(1)
        .map(r => ({
          section: iSec >= 0 ? (r[iSec] || '').trim() : '',
          item: (r[iItem] || '').trim(),
          notes: iNotes >= 0 ? (r[iNotes] || '').trim() : '',
        }))
        .filter(r => r.item);
      render(items);
      const t = new Date();
      status.textContent = `Synced ${t.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`;
    } catch (e) {
      console.error(e);
      status.textContent = 'Could not load checklist. Pull to refresh.';
    }
  }

  // Set heading + title
  document.getElementById('brand').textContent = cfg.title;
  document.getElementById('date').textContent = formatTodayHeading();
  document.title = cfg.title;

  document.getElementById('refresh').addEventListener('click', load);
  load();
})();

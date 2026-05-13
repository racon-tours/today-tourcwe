# today-tourcwe

Static checklist page for tour-day guides. Deployed at **today.tourcwe.com/t2c**.

Reads checklist items from the "t2c" tab of the **Today Checklists** Google Sheet (Drive ID `1235TZ4Nh2bRzew7QJ1Vpx8R3EfTyVP33zd0H4Sb2ByU`) as published CSV via gviz. Sheet must be shared "Anyone with the link → Viewer".

## Structure

- `/` — redirects to `/t2c/`
- `/t2c/` — the checklist (config.js sets sheet + tab + title)
- `/app.js`, `/app.css` — shared core

## State

LocalStorage, keyed by `tab:YYYY-MM-DD:rowIndex`. Stale keys from previous days are pruned on each page load → fresh checklist every morning.

## Deploy

Netlify, auto-deploy from `main` branch.

## Edit the checklist

Open the **Today Checklists** sheet, t2c tab. Columns: `section | item | notes`. Page picks up changes within ~5 min (Google CSV cache); helpers can hit ↻ to force a refresh.

// Spreadsheet import, step by step: choose a CSV, match its columns to the
// fields (the server guesses first), check what would happen row by row, then
// import. The sheet stays in this tab between steps; each step sends its text
// with the mapping. Server text goes through esc() before innerHTML.

import { esc } from './util.js';

const ACTION = { add: ['New', 'good'], update: ['Update', 'accent'], same: ['Already there', ''], skip: ['Skipped', 'bad'] };

// root: an element. kind: "spend" or "budget" (the route). api(path, opts).
// extra(): more fields sent with the check and the import (the fund chosen).
// summary(result): one line, e.g. "3 added, 1 updated".
export function mountImporter(root, { kind, api, summary, after, extra = () => ({}), who = 'Row' }) {
  let st = { text: '', name: '', preview: null, mapping: {}, checked: null };

  function draw() {
    const p = st.preview;
    root.innerHTML = `
      <p><label class="file-pick">Choose a CSV file <input type="file" accept=".csv,text/csv,text/plain" data-file></label>
      ${st.name ? `<span class="muted">${esc(st.name)}, ${p ? `${p.rows} row${p.rows === 1 ? '' : 's'}` : 'reading…'}</span>` : '<span class="muted">Save the sheet as CSV first (File, Download, CSV in Google Sheets or Excel).</span>'}</p>
      ${p ? mappingView(p) : ''}
      <div data-result aria-live="polite">${st.checked ? resultView(st.checked) : ''}</div>`;
    root.querySelector('[data-file]').addEventListener('change', pick);
    root.querySelectorAll('select[data-field]').forEach((s) => s.addEventListener('change', () => {
      const v = s.value;
      if (v === '') delete st.mapping[s.dataset.field]; else st.mapping[s.dataset.field] = Number(v);
      st.checked = null;
      draw();
    }));
    root.querySelector('[data-check]')?.addEventListener('click', () => run(true));
    root.querySelector('[data-run]')?.addEventListener('click', () => run(false));
  }

  function mappingView(p) {
    const options = (id) => `<option value="">Not imported</option>${p.headers.map((h, i) => `<option value="${i}" ${st.mapping[id] === i ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}`;
    const rows = p.fields.map((f) => {
      const i = st.mapping[f.id];
      const sample = i === undefined ? '' : p.samples[i].map(esc).join(', ');
      return `<tr><td><strong>${esc(f.label)}</strong>${f.required ? ' <span class="badge warn">needed</span>' : ''}${f.hint ? `<br><span class="muted small-text">${esc(f.hint)}</span>` : ''}</td>
        <td><select data-field="${esc(f.id)}" aria-label="Column for ${esc(f.label)}">${options(f.id)}</select></td>
        <td class="muted">${sample}</td></tr>`;
    }).join('');
    const unused = p.headers.filter((_, i) => !Object.values(st.mapping).includes(i));
    const missing = p.fields.filter((f) => f.required && st.mapping[f.id] === undefined);
    return `<table class="list import-map"><thead><tr><th>Field</th><th>Column in your sheet</th><th>Sample values</th></tr></thead><tbody>${rows}</tbody></table>
      ${unused.length ? `<p class="muted">Not imported: ${unused.map(esc).join(', ')}</p>` : ''}
      <p class="import-actions"><button type="button" class="primary" data-check ${missing.length ? 'disabled' : ''}>Check the rows</button>
      <button type="button" class="accent" data-run ${st.checked && st.checked.dry_run && !missing.length ? '' : 'disabled'}>Import</button>
      <span class="status" data-status>${missing.length ? `Choose a column for ${missing.map((f) => esc(f.label)).join(' and ')}.` : st.checked ? '' : 'Check first: nothing is saved until you press Import.'}</span></p>`;
  }

  function resultView(r) {
    const lines = r.plan.map((x) => {
      const [label, tone] = ACTION[x.action] || [x.action, ''];
      return `<tr><td class="num">${x.line}</td><td><span class="badge ${tone}">${label}</span></td><td>${esc(x.name || '')}</td><td class="muted keep">${esc(x.reason || x.detail || '')}</td></tr>`;
    }).join('');
    const total = r.plan.length;
    return `<p class="${r.dry_run ? '' : 'done'}"><strong>${r.dry_run ? 'If you import:' : 'Imported:'}</strong> ${esc(summary(r))}${r.skipped.length ? `, <span class="error">${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} skipped</span>` : ''}.</p>
      ${total ? `<table class="list"><thead><tr><th class="num">Row</th><th>What happens</th><th>${esc(who)}</th><th class="keep">Detail</th></tr></thead><tbody>${lines}</tbody></table>` : ''}`;
  }

  async function pick(e) {
    const file = e.target.files[0];
    if (!file) return;
    st = { text: await file.text(), name: file.name, preview: null, mapping: {}, checked: null };
    draw();
    try {
      st.preview = await api(`/api/import/${kind}/preview`, { method: 'POST', body: { csv: st.text } });
      st.mapping = { ...st.preview.mapping };
    } catch (err) {
      st.name = '';
      draw();
      root.querySelector('[data-result]').innerHTML = `<p class="error">${esc(err.message)}</p>`;
      return;
    }
    draw();
  }

  async function run(dry) {
    const status = root.querySelector('[data-status]');
    status.textContent = dry ? 'Checking…' : 'Importing…';
    root.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      st.checked = await api(`/api/import/${kind}`, { method: 'POST', body: { csv: st.text, mapping: st.mapping, dry_run: dry, ...extra() } });
      draw();
      if (!dry) { st.preview = null; st.name = ''; const done = st.checked; st.checked = null; draw(); root.querySelector('[data-result]').innerHTML = resultView(done); after?.(done); }
    } catch (err) {
      draw();
      root.querySelector('[data-status]').textContent = err.message;
    }
  }

  draw();
}

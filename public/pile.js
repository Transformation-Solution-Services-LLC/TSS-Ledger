// A pile of files, made sense of. The person uploads every spreadsheet and
// document they have; Ledger works out the shape, asks only what it cannot
// tell, has the reading checked by three separate checkers, then shows
// everything before saving. Server text goes through esc() before innerHTML.

import { esc, day, when, money, KIND } from './util.js';

const RUNNING = ['reading', 'checking', 'importing'];
const LABEL = {
  reading: ['Reading', 'accent'], asking: ['Waiting for you', 'warn'], checking: ['Checking', 'accent'], ready: ['Ready to import', 'good'],
  unsettled: ['Needs a look', 'warn'], importing: ['Importing', 'accent'], imported: ['Imported', ''], failed: ['Stopped', 'bad'], stopped: ['Stopped', 'bad'],
};
const MAX_BYTES = 40 * 1024 * 1024;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function base64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
}

// root: an element. api(path, opts). id: an upload to open, or ''.
// go(id): opens another upload. done(): after an import.
export function mountPile(root, { api, id = '', go, done = () => {} }) {
  let timer = null;
  const alive = () => document.body.contains(root);
  const stop = () => { clearTimeout(timer); timer = null; };

  async function start() {
    if (id) return show();
    const { on, intakes } = await api('/api/intakes');
    if (!on) { root.innerHTML = '<p class="muted">Reading a pile of files is off until AI is set up.</p>'; return; }
    root.innerHTML = `
      <p class="muted">Upload every spreadsheet and document you have for your grants: QuickBooks or bank exports, budgets, award letters, Excel workbooks with many tabs. Ledger works out what each one is, asks only what it cannot tell, has its reading checked three separate times, and shows you everything before anything is saved.</p>
      <div class="card pile-drop" data-drop>
        <p><label class="file-pick">Choose files <input type="file" multiple accept=".xlsx,.xlsm,.csv,.tsv,.txt,.md,.markdown,.pdf,.docx,text/markdown" data-files></label>
        <span class="muted" data-chosen>Excel, CSV, PDF, Word or text. Up to 25 files.</span></p>
        <p class="row"><button type="button" class="primary" data-read disabled>Read these files</button><span class="status" data-status></span></p>
      </div>
      ${intakes.length ? `<h3>Earlier uploads</h3><table class="list"><thead><tr><th>When</th><th>Files</th><th>Where it stands</th></tr></thead><tbody>${intakes.map((i) => {
    const [label, tone] = LABEL[i.status] || [i.status, ''];
    return `<tr data-open="${esc(i.id)}"><td>${esc(when(i.created_at))}</td><td>${esc(i.file_names.join(', '))}</td><td><span class="badge ${tone}">${esc(label)}</span></td></tr>`;
  }).join('')}</tbody></table>` : ''}`;
    let chosen = [];
    const input = root.querySelector('[data-files]');
    const pick = (files) => {
      chosen = [...files];
      const bytes = chosen.reduce((n, f) => n + f.size, 0);
      root.querySelector('[data-chosen]').textContent = chosen.length ? `${chosen.map((f) => f.name).join(', ')}` : '';
      const status = root.querySelector('[data-status]');
      status.textContent = bytes > MAX_BYTES ? 'That is more than 40 MB. Upload fewer files at a time.' : chosen.length > 25 ? 'Choose at most 25 files.' : '';
      root.querySelector('[data-read]').disabled = !chosen.length || bytes > MAX_BYTES || chosen.length > 25;
    };
    input.addEventListener('change', () => pick(input.files));
    const drop = root.querySelector('[data-drop]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files); });
    root.querySelectorAll('[data-open]').forEach((r) => r.addEventListener('click', () => go(r.dataset.open)));
    root.querySelector('[data-read]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const status = root.querySelector('[data-status]');
      status.textContent = 'Uploading…';
      try {
        const files = await Promise.all(chosen.map(async (f) => ({ name: f.name, type: f.type, data: await base64(f) })));
        const v = await api('/api/intakes', { method: 'POST', body: { files } });
        go(v.id);
      } catch (err) {
        status.textContent = err.message;
        e.target.disabled = false;
      }
    });
  }

  async function show(v = null) {
    stop();
    if (!alive()) return;
    try { v = v || await api(`/api/intakes/${encodeURIComponent(id)}`); } catch (err) { root.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
    root.innerHTML = draw(v);
    wire(v);
    if (RUNNING.includes(v.status)) timer = setTimeout(() => show(), 2500);
  }

  function draw(v) {
    const [label, tone] = LABEL[v.status] || [v.status, ''];
    const files = `<p class="muted">${esc(v.files.map((f) => f.name).join(', '))}. Uploaded ${esc(when(v.created_at))}${v.created_by ? ` by ${esc(v.created_by)}` : ''}. <span class="badge ${tone}">${esc(label)}</span></p>`;
    const back = '<p><a href="#/import?kind=pile">Upload another pile</a></p>';
    if (v.status === 'reading') return `${files}<div class="card"><p><strong>Reading your files.</strong></p><p class="muted">This takes a minute or two. You can leave this page and come back.</p></div>`;
    if (v.status === 'failed' || v.status === 'stopped') return `${files}<div class="card"><p class="error">${esc(v.message)}</p><p><button type="button" class="primary" data-retry>Start again</button></p></div>${back}`;
    let top = '';
    if (v.status === 'asking') top = askView(v);
    else if (v.status === 'checking') top = `<div class="card"><p><strong>Checking.</strong> ${esc(cleared(v))}</p>${roundsView(v)}<p class="muted">You can leave this page and come back.</p></div>`;
    else if (v.status === 'ready') top = `<div class="card"><p class="done"><strong>Checked: three separate checks cleared it.</strong></p>${roundsView(v)}<p class="row"><button type="button" class="accent" data-import>Import</button><span class="status" data-status>Nothing is saved until you press Import.</span></p></div>`;
    else if (v.status === 'unsettled') top = `<div class="card"><p><strong>${esc(v.message)}</strong></p>${roundsView(v)}${openPoints(v)}<p class="row"><button type="button" class="accent" data-import data-anyway>Import anyway</button><button type="button" data-retry>Check again</button><span class="status" data-status></span></p></div>`;
    else if (v.status === 'importing') top = '<div class="card"><p><strong>Importing.</strong></p></div>';
    else if (v.status === 'imported') top = `<div class="card"><p class="done"><strong>Imported.</strong> ${esc(resultLine(v.result))}</p><p><a href="#/funds">See the grants</a></p></div>${back}`;
    return `${files}${top}${v.plan ? planView(v) : ''}`;
  }

  const cleared = (v) => `${v.checks.cleared} of ${v.checks.needed} checks clear so far.`;

  function roundsView(v) {
    if (!v.checks.rounds.length && !v.checks.answers_applied) return '';
    const items = [];
    if (v.checks.answers_applied) items.push('<li>Your answers were applied first.</li>');
    for (const r of v.checks.rounds) {
      if (r.failed) items.push(`<li>Check ${r.n} could not run, so another checker took its place.</li>`);
      else if (r.clear) items.push(`<li>Check ${r.n}: clear.${r.counted ? '' : ' (Not counted: the same checker answered twice.)'}</li>`);
      else items.push(`<li>Check ${r.n} found ${plural(r.mistakes.length, 'mistake')}: ${r.mistakes.map((m) => esc(m.what)).join(' ')}${r.revised ? ' Fixed, and the count started over.' : ''}</li>`);
    }
    return `<ul class="rounds">${items.join('')}</ul>`;
  }

  function openPoints(v) {
    const last = [...v.checks.rounds].reverse().find((r) => !r.failed && !r.clear);
    return last ? `<p>Open points:</p><ul>${last.mistakes.map((m) => `<li>${esc(m.where)}: ${esc(m.what)}</li>`).join('')}</ul>` : '';
  }

  function askView(v) {
    const qs = v.questions.map((q) => `<fieldset class="question"><legend>${esc(q.ask)}</legend>${q.options.map((o, i) => `<label><input type="radio" name="${esc(q.id)}" value="${i}" ${i === q.recommended ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</fieldset>`).join('');
    return `<div class="card"><h3>Here is what Ledger found</h3><p>${esc(v.summary)}</p>
      ${v.questions.length ? `<h3>${v.questions.length === 1 ? 'One question' : `${v.questions.length} questions`}</h3>${qs}` : ''}
      <label class="note"><span>Anything wrong below? Say it here (optional)</span><textarea data-note rows="2" maxlength="2000"></textarea></label>
      <p class="row"><button type="button" class="primary" data-accept>Looks right, check it</button><span class="status" data-status>Next, three separate checkers go over it. Nothing is saved yet.</span></p></div>`;
  }

  function planView(v) {
    const p = v.plan;
    const grants = p.funds.map((f) => `<tr><td><strong>${esc(f.name)}</strong> <span class="badge ${f.existing ? '' : 'good'}">${f.existing ? 'Already in Ledger' : 'New'}</span><br><span class="muted small-text">${esc(KIND[f.kind] || '')}${f.funder ? `, ${esc(f.funder)}` : ''}${f.code ? `, code ${esc(f.code)}` : ''}</span></td>
      <td class="num">${f.award ? esc(money(f.award)) : '<span class="muted">Not found</span>'}</td>
      <td>${f.start_on || f.end_on ? `${esc(day(f.start_on))} to ${esc(day(f.end_on))}` : '<span class="muted">Not found</span>'}</td>
      <td class="num">${f.budget_lines ? `${esc(money(f.budget))}<br><span class="muted small-text">${plural(f.budget_lines, 'line')}</span>` : ''}</td>
      <td class="num">${f.entries ? `${esc(money(f.spent))}<br><span class="muted small-text">${plural(f.entries, 'entry', 'entries')}</span>` : ''}</td></tr>`).join('');
    const use = { spending: 'Spending', budget: 'A budget', ignore: 'Left out' };
    const sheets = p.sheets.map((s) => `<tr><td>${esc(s.file)}${s.name ? `<br><span class="muted small-text">${esc(s.name)}</span>` : ''}</td><td>${esc(use[s.use])}<br><span class="muted small-text">${esc(s.why)}</span></td><td class="num">${s.use === 'ignore' ? '' : s.read}</td><td class="num">${s.use === 'ignore' ? '' : s.skipped}</td><td class="num">${s.use === 'ignore' ? '' : esc(money(s.total))}</td></tr>`).join('');
    const sample = p.sample.map((e) => `<tr><td>${esc(day(e.date))}</td><td>${esc(e.fund)}</td><td class="num">${esc(money(e.amount))}</td><td>${esc(e.payee)}</td><td>${e.line ? esc(e.line) : '<span class="muted">No budget line</span>'}</td></tr>`).join('');
    return `
      <h3>Grants</h3>
      <table class="list"><thead><tr><th>Grant</th><th class="num">Award</th><th>Period</th><th class="num">Budget</th><th class="num">Spending</th></tr></thead><tbody>${grants || '<tr><td colspan="5" class="muted">None found.</td></tr>'}</tbody></table>
      ${p.problems.length ? `<h3>Ledger noticed</h3><ul>${p.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <h3>Each file</h3>
      <table class="list"><thead><tr><th>File</th><th>What it is</th><th class="num">Rows read</th><th class="num">Left out</th><th class="num">Total</th></tr></thead><tbody>${sheets}</tbody></table>
      ${p.entries ? `<h3>The first spending entries</h3><table class="list"><thead><tr><th>Date</th><th>Grant</th><th class="num">Amount</th><th>Paid to</th><th>Budget line</th></tr></thead><tbody>${sample}</tbody></table>${p.entries > p.sample.length ? `<p class="muted">And ${plural(p.entries - p.sample.length, 'more entry', 'more entries')}.</p>` : ''}` : ''}
      ${p.skipped_count ? `<details><summary>${plural(p.skipped_count, 'row')} left out</summary><table class="list"><tbody>${p.skipped.map((s) => `<tr><td>${esc(s.at)}</td><td class="muted">${esc(s.reason)}</td></tr>`).join('')}</tbody></table>${p.skipped_count > p.skipped.length ? `<p class="muted">The first ${p.skipped.length} are shown.</p>` : ''}</details>` : ''}`;
  }

  function resultLine(r) {
    if (!r) return '';
    const parts = [
      r.funds_added && plural(r.funds_added, 'grant') + ' added',
      r.lines_added && plural(r.lines_added, 'budget line') + ' added',
      r.lines_updated && plural(r.lines_updated, 'budget line') + ' updated',
      `${plural(r.entries_added, 'spending entry', 'spending entries')} (${money(r.total)})`,
      r.unchanged && `${r.unchanged} already there`,
      r.skipped && `${plural(r.skipped, 'row')} left out`,
    ].filter(Boolean);
    return `${parts.join(', ')}.`;
  }

  function wire(v) {
    const status = root.querySelector('[data-status]');
    const act = async (btn, path, body, busy) => {
      root.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      if (status) status.textContent = busy;
      try {
        const next = await api(path, { method: 'POST', body });
        await show(next);
        return next;
      } catch (err) {
        root.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        if (status) status.textContent = err.message; else alert(err.message);
        return null;
      }
    };
    root.querySelector('[data-accept]')?.addEventListener('click', (e) => {
      const answers = Object.fromEntries(v.questions.map((q) => [q.id, Number(root.querySelector(`input[name="${CSS.escape(q.id)}"]:checked`)?.value ?? q.recommended)]));
      act(e.target, `/api/intakes/${v.id}/accept`, { answers, note: root.querySelector('[data-note]').value }, 'Starting the checks…');
    });
    root.querySelector('[data-import]')?.addEventListener('click', async (e) => {
      const anyway = e.target.hasAttribute('data-anyway');
      if (anyway && !confirm('The checks did not all clear this. Import anyway?')) return;
      const next = await act(e.target, `/api/intakes/${v.id}/import`, { anyway }, 'Importing…');
      if (next?.status === 'imported') done(next);
    });
    root.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', (e) => act(e.target, `/api/intakes/${v.id}/retry`, {}, 'Starting again…')));
  }

  start().catch((err) => { root.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
}

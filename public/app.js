// Ledger frontend. Vanilla modules, no build step, same as Library, Rollodex
// and Vault. All server text goes through esc() before innerHTML. Views are
// addressed by hash: #/, #/funds, #/funds/<id>, #/spending, #/import...

const $ = (sel, root = document) => root.querySelector(sel);

import { esc, day, when, KIND, STATUS, PACE, money, pct, monthLabel, launchRoute } from './util.js';
import { mountImporter } from './importer.js';

const state = { token: null, name: '', org: '', canManage: false, me: null, today: new Date().toISOString().slice(0, 10) };

try {
  state.token = sessionStorage.getItem('ledger.token');
  state.name = sessionStorage.getItem('ledger.name') || '';
  state.org = sessionStorage.getItem('ledger.org') || '';
  state.canManage = sessionStorage.getItem('ledger.manage') === '1';
} catch (_) { /* storage blocked: Cockpit signs you in each visit */ }

function remember(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* ignore */ } }

function saveSession(j) {
  state.token = j.token; state.name = j.name; state.org = j.org?.name || ''; state.canManage = Boolean(j.can_manage);
  remember('ledger.token', j.token); remember('ledger.name', j.name); remember('ledger.org', state.org); remember('ledger.manage', state.canManage ? '1' : '0');
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && !path.startsWith('/api/auth/')) { signOut(); throw Object.assign(new Error('Sign in again'), { status: 401 }); }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
  return j;
}

function signOut() {
  state.token = null;
  try { sessionStorage.removeItem('ledger.token'); } catch (_) { /* ignore */ }
  showLogin();
}

const fail = (err) => alert(err.message);
function toast(text) {
  const t = $('#toast'); if (!t) return;
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function download(path, name) {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- sign in: Cockpit sends a launch ticket in the address fragment ----

function takeTicket() {
  const m = /(?:^#|&)tss_launch=([^&]+)/.exec(location.hash);
  if (!m) return null;
  const route = location.hash.slice(1).replace(/&?tss_launch=[^&]*/, '').replace(/&?tss_to=[^&]*/, '').replace(/^&/, '');
  history.replaceState(null, '', location.pathname + location.search + (launchRoute(location.hash) || (/^\/[\w/-]*$/.test(route) ? `#${route}` : '')));
  return decodeURIComponent(m[1]);
}

async function showLogin(error = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = error;
  const h = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  const link = $('#cockpit-link');
  link.hidden = !h?.cockpit_url;
  link.onclick = () => { location.href = h.cockpit_url; };
  if (!h?.cockpit_url) $('#login-message').textContent = 'Ask your administrator to connect Ledger to Cockpit.';
  $('#dev-signin').hidden = !h?.dev_signin;
}

$('#dev-signin').addEventListener('click', async () => {
  try { saveSession(await api('/api/auth/dev', { method: 'POST' })); boot(); } catch (err) { $('#login-error').textContent = err.message; }
});

// ---- modal forms ----

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  $('#modal-body input, #modal-body select, #modal-body textarea')?.focus();
}
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

const options = (list, labels, selected) => list.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(labels?.[v] || v)}</option>`).join('');

function formData(form) {
  const out = {};
  for (const el of form.elements) if (el.name) out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return out;
}

const formEnd = '<p class="error" id="f-error"></p><div class="row"><button class="primary">Save</button><button type="button" id="cancel">Cancel</button></div></form>';

function modalForm(html, submit, after) {
  openModal(html);
  const form = $('#f');
  $('#cancel').onclick = closeModal;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await submit(formData(form)); closeModal(); await after?.(); } catch (err) { $('#f-error').textContent = err.message; }
  });
  return form;
}

function fundForm(f = {}) {
  return `<form id="f" class="form"><h3>${f.id ? 'Edit' : 'New grant or fund'}</h3>
    <label><span>Name</span><input name="name" value="${esc(f.name)}" required placeholder="Youth Diversion 2026"></label>
    <div class="two"><label><span>Kind</span><select name="kind">${options(state.me.options.kinds, KIND, f.kind || 'grant')}</select></label>
    <label><span>Funder</span><input name="funder" value="${esc(f.funder)}"></label></div>
    <div class="three"><label><span>Award</span><input name="award" inputmode="decimal" value="${f.award ? esc(f.award) : ''}" placeholder="50000"></label>
    <label><span>Starts</span><input name="start_on" type="date" value="${esc(f.start_on || '')}"></label>
    <label><span>Ends</span><input name="end_on" type="date" value="${esc(f.end_on || '')}"></label></div>
    <div class="two"><label><span>Code</span><input name="code" value="${esc(f.code)}" placeholder="The QuickBooks class, if any"></label>
    <label><span>Status</span><select name="status">${options(state.me.options.statuses, STATUS, f.status || 'active')}</select></label></div>
    <label><span>Notes</span><textarea name="notes" rows="3" placeholder="Reporting dates, what the funder restricted">${esc(f.notes)}</textarea></label>
    ${formEnd}`;
}

function lineForm(l = {}) {
  return `<form id="f" class="form"><h3>${l.id ? 'Edit budget line' : 'New budget line'}</h3>
    <label><span>Line</span><input name="name" value="${esc(l.name)}" required placeholder="Personnel"></label>
    <div class="two"><label><span>Budget</span><input name="amount" inputmode="decimal" value="${l.budget ?? ''}" required></label>
    <label><span>Code</span><input name="code" value="${esc(l.code)}" placeholder="Account number, if any"></label></div>
    ${formEnd}`;
}

function entryForm({ fund = null, funds = [] } = {}) {
  const lineOptions = (lines) => `<option value="">Not on a budget line</option>${(lines || []).filter((l) => l.id).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}`;
  return `<form id="f" class="form"><h3>${fund ? `Spending from ${esc(fund.name)}` : 'Record spending'}</h3>
    ${fund ? '' : `<label><span>Grant or fund</span><select name="fund_id" required><option value="">Choose</option>${funds.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label>`}
    <div class="two"><label><span>Date</span><input name="date" type="date" value="${esc(state.today)}" max="${esc(state.today)}" required></label>
    <label><span>Amount</span><input name="amount" inputmode="decimal" required placeholder="250.00"></label></div>
    <label><span>Budget line</span><select name="line_id">${lineOptions(fund?.lines)}</select></label>
    <div class="two"><label><span>Paid to</span><input name="payee"></label><label><span>Reference</span><input name="reference" placeholder="Check or invoice number"></label></div>
    <label><span>Memo</span><input name="memo"></label>
    <p class="muted">A refund is a negative amount. An entry cannot be edited; one made in error is voided and stays on the record.</p>
    ${formEnd}`;
}

// ---- routing ----

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [p] = hash.split('?');
  const parts = p.split('/').filter(Boolean);
  const view = parts[0] || 'home';
  document.querySelectorAll('.nav a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.view === view)));
  const show = {
    home: showHome, funds: () => (parts[1] ? showFund(parts[1]) : showFunds()), spending: showSpending,
    import: showImport, activity: showActivity,
  }[view] || showHome;
  show().catch((err) => { $('#view').innerHTML = `<p class="error">${esc(err.message)}</p>`; });
}
const params = () => new URLSearchParams(location.hash.split('?')[1] || '');

function wireRows(root = document) {
  root.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) location.hash = tr.dataset.href; }));
}

const paceBadge = (pace) => { const [label, tone] = PACE[pace] || [pace, '']; return `<span class="badge ${tone}">${esc(label)}</span>`; };
const meter = (s) => {
  const spent = Math.min(1, s.pct_spent || 0);
  const time = s.elapsed === null ? null : s.elapsed;
  return `<div class="meter" title="${esc(pct(s.pct_spent))} spent${time === null ? '' : `, ${esc(pct(time))} of the period gone`}"><div class="spent ${s.pace === 'over' ? 'over' : ''}" style="width:${Math.round(spent * 100)}%"></div>${time === null ? '' : `<div class="time" style="left:${Math.round(time * 100)}%"></div>`}</div>`;
};

function fundRows(list) {
  if (!list.length) return '<p class="empty">No grants yet.</p>';
  return `<table class="list"><thead><tr><th>Grant or fund</th><th class="num keep">Remaining</th><th class="keep">Pace</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Per month</th><th>Ends</th></tr></thead><tbody>
    ${list.map((s) => `<tr data-href="#/funds/${esc(s.id)}"><td><strong>${esc(s.name)}</strong><br><span class="muted">${esc(KIND[s.kind] || s.kind)}${s.funder ? `, ${esc(s.funder)}` : ''}</span>${meter(s)}</td>
      <td class="num keep">${esc(money(s.remaining))}<br><span class="muted">${esc(pct(s.pct_spent))} spent</span></td><td class="keep">${paceBadge(s.pace)}</td>
      <td class="num">${esc(money(s.budget))}</td><td class="num">${esc(money(s.spent))}</td><td class="num">${s.burn_rate ? esc(money(s.burn_rate)) : ''}</td><td>${esc(day(s.end_on))}</td></tr>`).join('')}
    </tbody></table>`;
}

// ---- overview ----

async function showHome() {
  const o = await api('/api/home');
  const t = o.totals;
  $('#view').innerHTML = `
    <div class="head"><div><h2>Overview</h2><p class="muted">${esc(state.org)}, as of ${esc(day(o.as_of))}</p></div>
      <div class="row"><button class="primary" id="spend">Record spending</button>${state.canManage ? '<button id="new-fund">New grant</button>' : ''}</div></div>
    <div class="tiles">
      <div class="tile"><div class="n">${esc(money(t.restricted.remaining))}</div><div class="l">Restricted, left to spend</div></div>
      <div class="tile"><div class="n">${esc(money(t.restricted.spent))}</div><div class="l">Restricted, spent of ${esc(money(t.restricted.budget))}</div></div>
      <div class="tile"><div class="n">${esc(money(t.unrestricted.remaining))}</div><div class="l">Unrestricted, left</div></div>
      <div class="tile ${t.off_pace ? 'warn' : ''}"><div class="n">${t.off_pace}</div><div class="l">Off pace</div></div>
    </div>
    ${o.needs.length ? `<div class="card needs"><h3>Look at these</h3><ul class="timeline">${o.needs.map((n) => `<li><span class="badge ${n.severity === 'overdue' ? 'bad' : 'warn'}">${n.severity === 'overdue' ? 'Over' : 'Soon'}</span><a class="what" href="${esc(n.to)}">${esc(n.title)}</a><span class="muted">${esc(n.detail)}</span></li>`).join('')}</ul></div>` : ''}
    <h3>Open grants and funds</h3>
    ${o.funds.length ? fundRows(o.funds) : `<div class="card empty-state"><p><strong>No grants yet.</strong></p><p class="muted">Add a grant with its budget, then record or import what it has spent.</p>${state.canManage ? '<p class="row"><button class="primary" id="first-fund">Add a grant</button><a href="#/import">Import a spreadsheet</a></p>' : ''}</div>`}
    ${o.recent.length ? `<h3>Latest spending</h3>${entryTable(o.recent, { withFund: true })}` : ''}`;
  wireRows();
  const newFund = () => modalForm(fundForm(), async (v) => { const f = await api('/api/funds', { method: 'POST', body: v }); location.hash = `#/funds/${f.id}`; });
  $('#new-fund')?.addEventListener('click', newFund);
  $('#first-fund')?.addEventListener('click', newFund);
  $('#spend').onclick = () => spendForm(o.funds);
}

async function spendForm(funds, fund = null) {
  if (!fund && !funds.length) return toast('Add a grant or fund first.');
  const form = modalForm(entryForm({ fund, funds }), async (v) => {
    const id = fund ? fund.id : v.fund_id;
    if (!id) throw new Error('Choose the grant or fund');
    delete v.fund_id;
    await api(`/api/funds/${id}/entries`, { method: 'POST', body: v });
    toast('Spending recorded.');
  }, route);
  if (!fund) {
    form.elements.fund_id.addEventListener('change', async () => {
      const id = form.elements.fund_id.value;
      const sel = form.elements.line_id;
      sel.innerHTML = '<option value="">Not on a budget line</option>';
      if (!id) return;
      const f = await api(`/api/funds/${id}`).catch(() => null);
      for (const l of f?.lines || []) if (l.id) sel.append(new Option(l.name, l.id));
    });
  }
}

// ---- grants and funds ----

async function showFunds() {
  const archived = params().get('archived') === '1';
  const q = params().get('q') || '';
  const { funds } = await api(`/api/funds?q=${encodeURIComponent(q)}${archived ? '&archived=1' : ''}`);
  $('#view').innerHTML = `
    <div class="head"><h2>${archived ? 'Archived grants and funds' : 'Grants and funds'}</h2>${state.canManage ? '<button class="primary" id="new-fund">New grant or fund</button>' : ''}</div>
    <div class="toolbar"><input type="search" id="q" placeholder="Search by name, funder or code" value="${esc(q)}">
      <a href="#/funds${archived ? '' : '?archived=1'}">${archived ? 'Open ones' : 'Archived'}</a></div>
    ${fundRows(funds)}`;
  wireRows();
  let timer;
  $('#q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { location.hash = `#/funds?q=${encodeURIComponent(e.target.value)}${archived ? '&archived=1' : ''}`; }, 300); });
  $('#new-fund')?.addEventListener('click', () => modalForm(fundForm(), async (v) => { const f = await api('/api/funds', { method: 'POST', body: v }); location.hash = `#/funds/${f.id}`; }));
}

function chart(monthly) {
  if (!monthly.length) return '';
  const top = Math.max(...monthly.map((m) => m.spent), 1);
  return `<div class="chart" role="img" aria-label="Spending by month">${monthly.slice(-18).map((m) => `<div class="col" title="${esc(m.month)}: ${esc(money(m.spent))}"><div style="height:${Math.max(2, Math.round((m.spent / top) * 100))}%"></div><span>${esc(monthLabel(m.month))}</span></div>`).join('')}</div>`;
}

function entryTable(entries, { withFund = false } = {}) {
  if (!entries.length) return '<p class="empty">No spending recorded yet.</p>';
  return `<table class="list entries"><thead><tr><th>Date</th><th class="num keep">Amount</th><th class="keep">${withFund ? 'Grant' : 'Line'}</th><th>Paid to</th><th>Memo</th><th></th></tr></thead><tbody>
    ${entries.map((e) => `<tr class="${e.voided_at ? 'voided' : ''}"><td>${esc(day(e.date))}</td><td class="num keep">${esc(money(e.amount))}</td>
      <td class="keep">${withFund ? `<a href="#/funds/${esc(e.fund_id)}">${esc(e.fund_name)}</a>` : esc(e.line_name || 'Not on a line')}</td>
      <td>${esc(e.payee)}${e.reference ? ` <span class="muted">#${esc(e.reference)}</span>` : ''}</td>
      <td>${esc(e.memo)}${e.voided_at ? `<br><span class="badge bad">Voided</span> <span class="muted">${esc(e.void_reason)}, by ${esc(e.voided_by)}</span>` : ''}${e.source === 'csv' ? ' <span class="badge">imported</span>' : ''}</td>
      <td class="tools">${e.can_void ? `<button class="small" data-void="${esc(e.id)}">Void</button>` : ''}</td></tr>`).join('')}
    </tbody></table>`;
}

function wireVoid(again) {
  document.querySelectorAll('[data-void]').forEach((b) => b.addEventListener('click', async () => {
    const reason = prompt('Why is this entry voided? It stays on the record, marked.');
    if (!reason) return;
    try { await api(`/api/entries/${b.dataset.void}/void`, { method: 'POST', body: { reason } }); again(); } catch (err) { fail(err); }
  }));
}

async function showFund(id) {
  const s = await api(`/api/funds/${id}`);
  const again = () => showFund(id);
  const flagBadge = { over: '<span class="badge bad">Over</span>', at_risk: '<span class="badge warn">90%+</span>', unassigned: '<span class="badge">Assign a line</span>', ok: '' };
  const fact = (l, v) => (v ? `<div><span class="muted">${esc(l)}</span><br><strong>${v}</strong></div>` : '');
  $('#view').innerHTML = `
    <p><a href="#/funds">Grants and funds</a></p>
    <div class="head"><div><h2>${esc(s.name)}</h2><p class="muted">${esc(KIND[s.kind] || s.kind)}${s.funder ? `, ${esc(s.funder)}` : ''}${s.code ? `, code ${esc(s.code)}` : ''}. ${esc(STATUS[s.status] || s.status)}${s.archived_at ? ', archived' : ''}.</p></div>
      <div class="row"><button class="primary" id="spend">Record spending</button>${state.canManage ? '<button id="edit">Edit</button>' : ''}</div></div>
    <div class="tiles">
      <div class="tile"><div class="n">${esc(money(s.remaining))}</div><div class="l">Left of ${esc(money(s.budget))}</div></div>
      <div class="tile"><div class="n">${esc(money(s.spent))}</div><div class="l">Spent, ${esc(pct(s.pct_spent) || 'no budget')}</div></div>
      <div class="tile"><div class="n">${s.burn_rate ? esc(money(s.burn_rate)) : '$0'}</div><div class="l">Spent per month</div></div>
      <div class="tile ${['fast', 'over'].includes(s.pace) ? 'warn' : ''}"><div class="n">${esc((PACE[s.pace] || [s.pace])[0])}</div><div class="l">${s.elapsed === null ? 'Set the grant period to see pace' : `${esc(pct(s.elapsed))} of the period gone`}</div></div>
    </div>
    ${meter(s)}
    <div class="facts">
      ${fact('Award', s.award ? esc(money(s.award)) : '')}
      ${fact('Period', s.start_on || s.end_on ? `${esc(day(s.start_on) || 'not set')} to ${esc(day(s.end_on) || 'not set')}` : '')}
      ${fact('Days left', s.days_left !== null ? String(s.days_left) : '')}
      ${fact('At this rate, by the end', s.projected_spend !== null && s.end_on ? `${esc(money(s.projected_spend))} spent, ${esc(money(s.projected_left))} left` : '')}
      ${fact('Money lasts', s.runway_months ? `${esc(String(s.runway_months))} months at this rate` : '')}
      ${fact('Funder in Rollodex', s.rollodex_url ? `<a href="${esc(s.rollodex_url)}" target="_blank" rel="noopener">Open</a>` : '')}
    </div>
    ${s.lines_differ_from_award ? `<p class="notice">The budget lines add up to ${esc(money(s.budget))}, not the award of ${esc(money(s.award))}.</p>` : ''}
    <div class="head sub"><h3>Budget against spending</h3>${state.canManage ? `<div class="row"><button class="small" id="add-line">Add a line</button><a class="small-text" href="#/import?fund=${esc(s.id)}&kind=budget">Import the budget</a></div>` : ''}</div>
    ${s.lines.length ? `<table class="list"><thead><tr><th>Line</th><th class="num keep">Left</th><th class="num keep">Spent</th><th class="num">Budget</th><th class="num">Used</th><th></th></tr></thead><tbody>
      ${s.lines.map((l) => `<tr><td>${esc(l.name)}${l.code ? ` <span class="muted">${esc(l.code)}</span>` : ''} ${flagBadge[l.flag] || ''}</td><td class="num keep">${esc(money(l.remaining))}</td><td class="num keep">${esc(money(l.spent))}</td><td class="num">${esc(money(l.budget))}</td><td class="num">${esc(pct(l.pct_spent))}</td>
        <td class="tools">${state.canManage && l.id ? `<button class="small" data-line="${esc(l.id)}">Edit</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : `<p class="empty">No budget lines. The award stands in as the budget${state.canManage ? '; add lines to see variance by line' : ''}.</p>`}
    <h3>Spending by month</h3>${chart(s.monthly) || '<p class="empty">Nothing spent yet.</p>'}
    <div class="head sub"><h3>Entries</h3>${state.canManage ? `<button class="small" id="export">Download CSV</button>` : ''}</div>
    ${entryTable(s.entries)}
    ${s.notes ? `<h3>Notes</h3><p class="notes">${esc(s.notes)}</p>` : ''}
    ${state.canManage ? `<p class="row">${state.me.rollodex && s.funder ? `<button id="rollodex">${s.rollodex_contact_id ? 'Link again in Rollodex' : 'Link the funder in Rollodex'}</button>` : ''}<button id="archive">${s.archived_at ? 'Unarchive' : 'Archive'}</button></p>` : ''}`;
  $('#spend').onclick = () => spendForm([], s);
  $('#edit')?.addEventListener('click', () => modalForm(fundForm(s), (v) => api(`/api/funds/${id}`, { method: 'PATCH', body: v }), again));
  $('#add-line')?.addEventListener('click', () => modalForm(lineForm(), (v) => api(`/api/funds/${id}/lines`, { method: 'POST', body: v }), again));
  document.querySelectorAll('[data-line]').forEach((b) => b.addEventListener('click', () => {
    const l = s.lines.find((x) => x.id === b.dataset.line);
    const form = modalForm(lineForm(l).replace('<p class="error"', '<button type="button" id="remove-line">Remove this line</button><p class="error"'), (v) => api(`/api/lines/${l.id}`, { method: 'PATCH', body: v }), again);
    form.querySelector('#remove-line').onclick = async () => {
      if (!confirm('Remove this line from the budget? Spending on it stays, as not on a budget line.')) return;
      try { await api(`/api/lines/${l.id}/remove`, { method: 'POST' }); closeModal(); again(); } catch (err) { fail(err); }
    };
  }));
  $('#export')?.addEventListener('click', () => download(`/api/export/entries.csv?fund_id=${id}`, `${s.name.replace(/[^\w-]+/g, '-')}-spending.csv`).catch(fail));
  $('#rollodex')?.addEventListener('click', async () => {
    try { const r = await api(`/api/funds/${id}/rollodex`, { method: 'POST' }); toast(r.created ? 'Funder added to Rollodex.' : 'Funder found in Rollodex.'); again(); } catch (err) { fail(err); }
  });
  $('#archive')?.addEventListener('click', async () => {
    try { await api(`/api/funds/${id}/${s.archived_at ? 'unarchive' : 'archive'}`, { method: 'POST' }); again(); } catch (err) { fail(err); }
  });
  wireVoid(again);
}

// ---- all spending ----

async function showSpending() {
  const p = params();
  const qs = new URLSearchParams();
  for (const k of ['fund_id', 'from', 'to', 'q']) if (p.get(k)) qs.set(k, p.get(k));
  const [{ entries }, { funds }] = await Promise.all([api(`/api/entries?${qs}`), api('/api/funds')]);
  const live = entries.filter((e) => !e.voided_at);
  const total = live.reduce((t, e) => t + Math.round(e.amount * 100), 0) / 100;
  $('#view').innerHTML = `
    <div class="head"><h2>Spending</h2><div class="row"><button class="primary" id="spend">Record spending</button>${state.canManage ? '<button id="export">Download CSV</button>' : ''}</div></div>
    <form class="toolbar" id="filters">
      <select name="fund_id"><option value="">Every fund</option>${funds.map((f) => `<option value="${esc(f.id)}" ${p.get('fund_id') === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <input type="date" name="from" value="${esc(p.get('from') || '')}" aria-label="From"><input type="date" name="to" value="${esc(p.get('to') || '')}" aria-label="To">
      <input type="search" name="q" placeholder="Paid to, memo or reference" value="${esc(p.get('q') || '')}"><button>Show</button></form>
    <p class="muted">${live.length} entr${live.length === 1 ? 'y' : 'ies'}, ${esc(money(total))}${entries.length === 500 ? ' (the latest 500)' : ''}.</p>
    ${entryTable(entries, { withFund: true })}`;
  $('#filters').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = new URLSearchParams(Object.entries(formData(e.target)).filter(([, x]) => x));
    location.hash = `#/spending?${v}`;
  });
  $('#spend').onclick = () => spendForm(funds);
  $('#export')?.addEventListener('click', () => download(`/api/export/entries.csv${p.get('fund_id') ? `?fund_id=${encodeURIComponent(p.get('fund_id'))}` : ''}`, 'ledger-spending.csv').catch(fail));
  wireVoid(showSpending);
}

// ---- import ----

async function showImport() {
  if (!state.canManage) { $('#view').innerHTML = '<p class="error">Importing is for Ledger managers.</p>'; return; }
  const { funds } = await api('/api/funds');
  const p = params();
  const kind = p.get('kind') === 'budget' ? 'budget' : 'spend';
  const chosen = p.get('fund') || '';
  const pick = (label, required) => `<label class="fund-pick"><span>${esc(label)}</span><select id="fund">${required ? '<option value="">Choose</option>' : '<option value="">None: the sheet names each row\'s fund</option>'}${funds.map((f) => `<option value="${esc(f.id)}" ${chosen === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>`;
  $('#view').innerHTML = `
    <div class="head"><h2>Import</h2></div>
    <div class="tabs" role="tablist"><a href="#/import?kind=spend${chosen ? `&fund=${esc(chosen)}` : ''}" aria-selected="${kind === 'spend'}">Spending</a><a href="#/import?kind=budget${chosen ? `&fund=${esc(chosen)}` : ''}" aria-selected="${kind === 'budget'}">A grant's budget</a></div>
    ${kind === 'spend'
      ? `<p class="muted">From QuickBooks, run Reports, Transaction Detail by Account, and export it to Excel, then save it as CSV. A bank or card export works too. Rows already imported are skipped.</p>${pick('Fund for rows that name none', false)}`
      : `<p class="muted">One row per budget line with its amount. A line already on the budget takes the sheet's amount.</p>${pick('Grant or fund', true)}`}
    ${funds.length ? '<div id="importer"></div>' : '<p class="empty">Add a grant or fund first: <a href="#/funds">Grants and funds</a>.</p>'}`;
  if (!funds.length) return;
  $('#fund').addEventListener('change', (e) => { const u = new URLSearchParams(location.hash.split('?')[1] || ''); u.set('fund', e.target.value); history.replaceState(null, '', `#/import?${u}`); });
  mountImporter($('#importer'), {
    kind, api, who: kind === 'spend' ? 'Entry' : 'Line',
    extra: () => ({ fund_id: $('#fund').value || undefined }),
    summary: (r) => (kind === 'spend'
      ? `${r.added} entr${r.added === 1 ? 'y' : 'ies'} (${money(r.total)})${r.unchanged ? `, ${r.unchanged} already there` : ''}`
      : `${r.added} added, ${r.updated} updated${r.unchanged ? `, ${r.unchanged} unchanged` : ''}, budget lines total ${money(r.total)}`),
    after: () => toast('Imported.'),
  });
}

async function showActivity() {
  const { activity } = await api('/api/activity?limit=200');
  $('#view').innerHTML = `<div class="head"><h2>Activity</h2></div>
    ${activity.length ? `<table class="list"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${activity.map((a) => `<tr><td>${esc(when(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)} ${esc(a.target)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nothing yet.</p>'}`;
}

// ---- start ----

async function boot() {
  try { state.me = await api('/api/me'); } catch (err) { if (err.status !== 401) showLogin(err.message); return; }
  state.today = state.me.today;
  state.canManage = state.me.can_manage;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = `${state.me.name}, ${state.me.org.name}`;
  document.querySelectorAll('[data-manage]').forEach((el) => { el.hidden = !state.canManage; });
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(state.me.release || 'dev')}`).catch(() => {});
}

async function start() {
  const ticket = takeTicket();
  if (ticket) {
    try { saveSession(await api('/api/auth/cockpit', { method: 'POST', body: { ticket } })); } catch (err) { return showLogin(err.message); }
  }
  if (!state.token) return showLogin();
  boot();
}

start();

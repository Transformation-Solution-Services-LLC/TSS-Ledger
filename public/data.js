// Analyze: upload a spreadsheet, see its charts, ask questions about it.
// Every figure on these screens is computed by Ledger (lib/dataset.js); the
// answers say how. Server text goes through esc() before innerHTML.

import { esc, when } from './util.js';
import { chartHtml, resultTable, formatValue } from './chart.js';

const $ = (sel, root = document) => root.querySelector(sel);
const SHEETS = '.xlsx,.xlsm,.csv,.tsv';
const ANY_FILE = '.xlsx,.xlsm,.csv,.tsv,.pdf,.docx,.txt,.md,.markdown,text/markdown';
const MAX_BYTES = 10 * 1024 * 1024;
// The width a chart gets: the page's content, less the card's padding.
const chartWidth = () => Math.max(300, (document.querySelector('#view')?.clientWidth || 640) - 40);
const chart = (c) => chartHtml(c, { width: chartWidth() });
const isSheet = (name) => /\.(xlsx|xlsm|csv|tsv|tab)$/i.test(name || '');

function base64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
}
const asUpload = async (f) => {
  if (f.size > MAX_BYTES) throw new Error(`${f.name} is larger than 10 MB.`);
  return { name: f.name, type: f.type || '', data: await base64(f) };
};

// Bold, lists and paragraphs, nothing else. Escaped first.
export function textHtml(text) {
  const blocks = String(text || '').trim().split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split('\n');
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (lines.every((l) => /^\s*([-*]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      return `<${ordered ? 'ol' : 'ul'}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+[.)])\s+/, ''))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

function dropZone(el, onFiles) {
  el.addEventListener('dragover', (e) => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); el.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
}

const tableCount = (d) => d.tables.reduce((n, t) => n + t.row_count, 0);
const datasetLine = (d) => `${tableCount(d).toLocaleString('en-US')} rows${d.tables.length > 1 ? ` in ${d.tables.length} tables` : ''}`;

// ---- the list ----

export async function showData(ctx) {
  const view = $('#view');
  const { datasets, chats, asks } = await ctx.api('/api/data');
  const names = new Map(datasets.map((d) => [d.id, d.name]));
  const mine = datasets.filter((d) => d.source !== 'ledger');
  const ledger = datasets.find((d) => d.source === 'ledger');
  view.innerHTML = `
    <div class="head"><h2>Analyze</h2></div>
    <div class="card data-drop" data-drop>
      <p><strong>Upload a spreadsheet</strong></p>
      <p class="muted">Ledger charts it right away${asks ? ' and answers your questions about it, showing how each figure was worked out' : ''}.</p>
      <p class="row"><label class="file-pick">Choose spreadsheets <input type="file" multiple accept="${SHEETS}" data-files></label><span class="muted">or drop Excel or CSV files here.</span></p>
      <p class="status" data-status role="status"></p>
    </div>
    ${mine.length || ledger ? '<h3>Your data</h3>' : ''}
    <div class="data-cards">
      ${mine.map((d) => `<a class="card data-card" href="#/data/${esc(d.id)}"><strong>${esc(d.name)}</strong><span class="muted">${esc(datasetLine(d))}</span><span class="muted small-text">Added ${esc(when(d.created_at))}</span></a>`).join('')}
      ${ledger ? `<a class="card data-card" href="#/data/ledger"><strong>${esc(ledger.name)}</strong><span class="muted">${esc(ledger.tables.map((t) => t.name).join(', '))}</span><span class="muted small-text">Always up to date</span></a>` : ''}
    </div>
    ${chats.length ? `<h3>Your chats</h3><table class="list"><thead><tr><th>Chat</th><th>About</th><th class="keep">Last</th><th class="keep"></th></tr></thead><tbody>
      ${chats.map((c) => `<tr data-href="${esc(chatHref(c))}"><td><strong>${esc(c.title)}</strong></td><td class="muted">${esc(c.dataset_ids.map((id) => names.get(id)).filter(Boolean).join(', ') || 'No data')}</td><td class="keep">${esc(when(c.updated_at))}</td>
        <td class="tools keep"><button class="small" data-delete-chat="${esc(c.id)}" aria-label="Delete ${esc(c.title)}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : ''}`;
  view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('button')) location.hash = tr.dataset.href; }));
  view.querySelectorAll('[data-delete-chat]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this chat? Its questions and answers are gone for good.')) return;
    try { await ctx.api(`/api/data-chats/${b.dataset.deleteChat}`, { method: 'DELETE' }); showData(ctx); } catch (err) { ctx.fail(err); }
  }));
  const status = $('[data-status]', view);
  const upload = async (files) => {
    const list = files.filter((f) => isSheet(f.name));
    if (!list.length) { status.textContent = 'Choose Excel (.xlsx) or CSV files.'; return; }
    status.textContent = `Reading ${list.map((f) => f.name).join(', ')}...`;
    try {
      const { datasets: made } = await ctx.api('/api/data', { method: 'POST', body: { files: await Promise.all(list.map(asUpload)) } });
      location.hash = `#/data/${made[0].id}`;
    } catch (err) { status.textContent = err.message; }
  };
  const input = $('[data-files]', view);
  input.addEventListener('change', () => upload([...input.files]));
  dropZone($('[data-drop]', view), upload);
}

const chatHref = (c) => `#/data/${encodeURIComponent(c.dataset_ids[0] || 'ledger')}?chat=${encodeURIComponent(c.id)}`;

// ---- one spreadsheet ----

export async function showDataset(ctx, id, params) {
  const view = $('#view');
  const d = await ctx.api(`/api/data/${encodeURIComponent(id)}`);
  const t = Math.min(Math.max(0, Number(params.get('t')) || 0), d.tables.length - 1);
  const table = d.tables[t];
  const chatId = params.get('chat') || '';
  const tab = (i) => { const p = new URLSearchParams(params); p.set('t', String(i)); return `#/data/${esc(id)}?${p}`; };
  view.innerHTML = `
    <p><a href="#/data">Analyze</a></p>
    <div class="head"><div><h2>${esc(d.name)}</h2><p class="muted">${esc(table ? table.facts.join(' ') : '')}</p></div>
      ${d.mine ? '<div class="row"><button id="rename">Rename</button><button id="delete">Delete</button></div>' : ''}</div>
    ${d.tables.length > 1 ? `<div class="tabs" role="tablist">${d.tables.map((x, i) => `<a href="${tab(i)}" aria-selected="${i === t}">${esc(x.name)}</a>`).join('')}</div>` : ''}
    ${table?.notes.length ? `<p class="muted small-text">${esc(table.notes.join(' '))}</p>` : ''}
    ${table ? tiles(table) : ''}
    ${table?.charts.length ? `<div class="viz-grid-cards">${table.charts.map(chart).join('')}</div>` : (table ? '<p class="muted">Nothing here to chart: the sheet has no numbers or dates Ledger could read.</p>' : '<p class="empty">Nothing recorded yet.</p>')}
    <section id="chat" class="data-chat"></section>
    ${table ? `<details class="card preview"><summary>The rows${table.row_count > table.rows.length ? ` (the first ${table.rows.length} of ${table.row_count.toLocaleString('en-US')})` : ''}</summary>
      ${resultTable({ columns: table.columns, rows: table.rows }, { max: 100 })}</details>` : ''}`;
  $('#rename')?.addEventListener('click', async () => {
    const name = prompt('Name this spreadsheet', d.name);
    if (!name) return;
    try { await ctx.api(`/api/data/${id}`, { method: 'PATCH', body: { name } }); showDataset(ctx, id, params); } catch (err) { ctx.fail(err); }
  });
  $('#delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this spreadsheet from Ledger? Your chats about it stay, without it.')) return;
    try { await ctx.api(`/api/data/${id}`, { method: 'DELETE' }); location.hash = '#/data'; } catch (err) { ctx.fail(err); }
  });
  mountChat(ctx, $('#chat'), { datasetId: id, chatId, asks: d.asks, go: (cid) => { const p = new URLSearchParams(params); if (cid) p.set('chat', cid); else p.delete('chat'); history.replaceState(null, '', `#/data/${id}?${p}`); } });
}

function tiles(table) {
  const p = table.profile;
  const nums = p.columns.filter((c) => (c.type === 'money' || c.type === 'number') && c.filled && !/^(id|num|no|#|code|zip|year)$/i.test(c.name)).slice(0, 3);
  const date = p.columns.find((c) => c.type === 'date' && c.from);
  return `<div class="tiles">
    <div class="tile"><div class="n">${esc(p.rows.toLocaleString('en-US'))}</div><div class="l">Rows</div></div>
    ${nums.map((c) => `<div class="tile"><div class="n">${esc(formatValue(c.sum, c.type, { short: true }))}</div><div class="l">${esc(c.name)}, total</div></div>`).join('')}
    ${date ? `<div class="tile"><div class="n small-n">${esc(date.from)}</div><div class="l">to ${esc(date.to)}</div></div>` : ''}
  </div>`;
}

// ---- the chat ----

function answerHtml(m) {
  const steps = m.steps || [];
  const byN = new Map(steps.map((s) => [s.n, s]));
  const charts = (m.charts || []).map((c) => { const s = byN.get(c.step); return s ? chart({ type: c.type, title: c.title, result: s.result }) : ''; }).join('');
  const tables = (m.tables || []).map((n) => { const s = byN.get(n); return s ? `<div class="answer-table"><p class="muted small-text">${esc(s.label || s.how)}</p>${resultTable(s.result)}</div>` : ''; }).join('');
  const how = steps.length ? `<details class="how"><summary>How this was worked out</summary><ol>${steps.map((s) => (s.kind === 'calc'
    ? `<li>${esc(s.label)}: ${esc(s.expression)} = <strong>${esc(formatValue(s.value, 'number'))}</strong></li>`
    : `<li>${esc(s.how)}${s.result.rows.length ? ` <span class="muted">(${esc(String(s.result.groups))} ${s.spec.group_by?.length || s.spec.measures?.length ? 'result' : 'row'}${s.result.groups === 1 ? '' : 's'} from ${esc(s.result.matched.toLocaleString('en-US'))} row${s.result.matched === 1 ? '' : 's'})</span>` : ''}</li>`)).join('')}</ol></details>` : '';
  const unchecked = m.unchecked?.length ? `<p class="notice">Not computed by Ledger: ${esc(m.unchecked.join(', '))}. Check these before you use them.</p>` : '';
  const follow = m.follow_ups?.length ? `<p class="follow">${m.follow_ups.map((q) => `<button class="small" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</p>` : '';
  return `<div class="msg assistant"><div class="answer">${textHtml(m.text)}</div>${unchecked}${charts ? `<div class="viz-grid-cards">${charts}</div>` : ''}${tables}${how}${follow}</div>`;
}

export function mountChat(ctx, root, { datasetId, chatId = '', asks, go }) {
  let chat = null;
  let timer = null;
  const alive = () => document.body.contains(root);

  async function list() {
    const { chats } = await ctx.api(`/api/data-chats?dataset=${encodeURIComponent(datasetId)}`);
    return chats;
  }

  async function open(id) {
    clearTimeout(timer);
    chat = id ? await ctx.api(`/api/data-chats/${encodeURIComponent(id)}`).catch(() => null) : null;
    go(chat?.id || '');
    await render();
  }

  async function ensure() {
    if (chat) return chat;
    chat = await ctx.api('/api/data-chats', { method: 'POST', body: { dataset_ids: [datasetId] } });
    go(chat.id);
    return chat;
  }

  async function render() {
    if (!alive()) return;
    const chats = await list();
    const busy = chat?.status === 'thinking';
    const other = chats.filter((c) => c.id !== chat?.id);
    root.innerHTML = `
      <div class="head sub"><h3>${chat ? esc(chat.title) : 'Ask about this data'}</h3>
        <div class="row">${chat ? '<button class="small" id="new-chat">New chat</button><button class="small" id="rename-chat">Rename</button><button class="small" id="delete-chat">Delete</button>' : ''}
        ${other.length ? `<select id="pick-chat" aria-label="Open a chat"><option value="">Earlier chats</option>${other.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select>` : ''}</div></div>
      ${chat && (chat.datasets.length > 1 || chat.documents.length) ? `<p class="chips">${chat.datasets.map((d) => `<span class="chip">${esc(d.name)}</span>`).join('')}${chat.documents.map((d) => `<span class="chip doc">${esc(d.name)}</span>`).join('')}</p>` : ''}
      <div class="card chat-box" data-drop>
        <div class="msgs">${(chat?.messages || []).map((m) => (m.role === 'user' ? `<div class="msg user"><p>${esc(m.text)}</p></div>` : answerHtml(m))).join('')}
          ${busy ? '<div class="msg assistant thinking" role="status">Working it out from your data.</div>' : ''}
          ${chat?.status === 'failed' && chat.error ? `<p class="error">${esc(chat.error)}</p>` : ''}
          ${!chat?.messages?.length && !busy ? `<p class="muted">${asks ? 'Ask anything about this data: totals, trends, the biggest items, what changed. Ledger computes every figure and shows how. Drop in another spreadsheet or a document to use it too.' : 'Questions are off until AI is set up.'}</p>` : ''}</div>
        ${asks ? `<form class="composer" id="ask"><button type="button" class="attach" id="attach" aria-label="Add a spreadsheet or document" title="Add a spreadsheet or document"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg></button>
          <input type="file" id="attach-file" accept="${ANY_FILE}" multiple hidden>
          <textarea name="text" rows="2" placeholder="What do you want to know?" ${busy ? 'disabled' : ''}></textarea><button class="primary" ${busy ? 'disabled' : ''}>Ask</button></form>
          <p class="status small-text" id="chat-status" role="status"></p>` : ''}
      </div>`;
    const status = $('#chat-status', root);
    const form = $('#ask', root);
    const send = async (text) => {
      if (!text.trim()) return;
      try {
        const c = await ensure();
        chat = await ctx.api(`/api/data-chats/${c.id}/messages`, { method: 'POST', body: { text } });
        await render();
        poll();
      } catch (err) { if (status) status.textContent = err.message; }
    };
    form?.addEventListener('submit', (e) => { e.preventDefault(); send(form.elements.text.value); });
    form?.elements.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    root.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => send(b.dataset.ask)));
    const addFiles = async (files) => {
      for (const f of files) {
        status.textContent = `Adding ${f.name}...`;
        try {
          const c = await ensure();
          const out = await ctx.api(`/api/data-chats/${c.id}/files`, { method: 'POST', body: { file: await asUpload(f) } });
          chat = out.chat;
          await render();
          $('#chat-status', root).textContent = out.added === 'data' ? `${f.name} is in this chat as data.` : `${f.name} is in this chat.`;
        } catch (err) { $('#chat-status', root).textContent = err.message; }
      }
    };
    $('#attach', root)?.addEventListener('click', () => $('#attach-file', root).click());
    $('#attach-file', root)?.addEventListener('change', (e) => addFiles([...e.target.files]));
    const box = $('.chat-box', root);
    if (box && asks) dropZone(box, addFiles);
    $('#new-chat', root)?.addEventListener('click', () => open(''));
    $('#pick-chat', root)?.addEventListener('change', (e) => open(e.target.value));
    $('#rename-chat', root)?.addEventListener('click', async () => {
      const title = prompt('Name this chat', chat.title);
      if (!title) return;
      try { chat = await ctx.api(`/api/data-chats/${chat.id}`, { method: 'PATCH', body: { title } }); render(); } catch (err) { ctx.fail(err); }
    });
    $('#delete-chat', root)?.addEventListener('click', async () => {
      if (!confirm('Delete this chat? Its questions and answers are gone for good.')) return;
      try { await ctx.api(`/api/data-chats/${chat.id}`, { method: 'DELETE' }); open(''); } catch (err) { ctx.fail(err); }
    });
    const msgs = $('.msgs', root);
    if (msgs && chat?.messages?.length) msgs.lastElementChild?.scrollIntoView({ block: 'nearest' });
    if (busy) poll();
  }

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!alive() || !chat) return;
      try {
        const next = await ctx.api(`/api/data-chats/${chat.id}`);
        const changed = next.status !== chat.status || next.messages.length !== chat.messages.length;
        chat = next;
        if (changed) await render();
        else if (chat.status === 'thinking') poll();
      } catch (_) { poll(); }
    }, 2000);
  }

  open(chatId).catch((err) => { root.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
}

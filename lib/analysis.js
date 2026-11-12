// Analyze: a spreadsheet in, charts out, and questions answered from it.
//
//   GET    /api/data                   the person's spreadsheets and chats
//   POST   /api/data                   upload spreadsheets (base64); each becomes a dataset
//   GET    /api/data/:id               its tables, what each holds, its charts, first rows
//   PATCH  /api/data/:id               rename
//   DELETE /api/data/:id               delete the person's copy
//   POST   /api/data/:id/query         one query (lib/dataset.js runQuery)
//   GET    /api/data-chats             the person's chats (?dataset=)
//   POST   /api/data-chats             a new chat about datasets
//   GET    /api/data-chats/:id         the chat, its answers and how each was worked out
//   PATCH  /api/data-chats/:id         rename
//   DELETE /api/data-chats/:id         delete the chat
//   POST   /api/data-chats/:id/messages  a question; answered in the background
//   POST   /api/data-chats/:id/files   a spreadsheet joins the chat as data; a
//                                      document goes to the chat's Library folder
//
// Spreadsheets and chats belong to the person who added them: another
// person's id answers 404, as another organization's does. "ledger" is the
// organization's own records (spending, budget lines, grants), read fresh
// each time, for everyone who may open Ledger.
//
// A question runs in this process, not in the request: leaving the page does
// not stop it, and the page asks again until the answer is there. Another
// source (a QuickBooks connection) adds datasets with its own `source`
// through the same store calls; nothing here is specific to uploads.

import crypto from 'node:crypto';
import { PublicError, logSafeError, normalizePublicError } from './public-error.js';
import { buildTables, profile, autoCharts, runQuery, fold, facts, QueryError } from './dataset.js';
import { summarizeFunds } from './finance.js';
import { withUsage } from './usage.js';
import { compactIfNeeded, liveMessages } from './compact.js';
import { readFile, kindOf, MAX_FILE_BYTES } from '../services/extract.js';
import * as askApi from '../services/ask.js';
import * as chatFilesApi from './chat-files.js';

export const LEDGER_ID = 'ledger';
const MAX_UPLOAD_FILES = 10;
const PREVIEW_ROWS = 100;
const STALE_MS = 10 * 60 * 1000;
const MAX_DOC_TEXT = 60000;
const MAX_CHAT_DATASETS = 8;

// The organization's own records as tables.
export function ledgerDataset({ funds, lines, entries, asOf }) {
  const fundName = new Map(funds.map((f) => [f.id, f.name]));
  const lineName = new Map(lines.map((l) => [l.id, l.name]));
  const live = entries.filter((e) => !e.voided_at);
  const summaries = summarizeFunds(funds, lines, live, asOf);
  const kind = { grant: 'Grant', restricted: 'Restricted gift', unrestricted: 'Unrestricted' };
  return {
    id: LEDGER_ID, name: "Ledger's records", source: 'ledger', owner_id: '', files: [], notes: [],
    tables: [
      {
        name: 'Spending',
        columns: [{ name: 'Date', type: 'date' }, { name: 'Amount', type: 'money' }, { name: 'Grant or fund', type: 'text' }, { name: 'Budget line', type: 'text' }, { name: 'Paid to', type: 'text' }, { name: 'Memo', type: 'text' }, { name: 'Reference', type: 'text' }],
        rows: live.map((e) => [e.date, e.amount, fundName.get(e.fund_id) || '', e.line_id ? lineName.get(e.line_id) || '' : 'Not on a budget line', e.payee || null, e.memo || null, e.reference || null]),
        notes: ['Voided entries are left out.'],
      },
      {
        name: 'Budget lines',
        columns: [{ name: 'Grant or fund', type: 'text' }, { name: 'Line', type: 'text' }, { name: 'Budget', type: 'money' }, { name: 'Spent', type: 'money' }, { name: 'Left', type: 'money' }],
        rows: summaries.flatMap((s) => s.lines.map((l) => [s.name, l.name, l.budget, l.spent, l.remaining])),
        notes: [],
      },
      {
        name: 'Grants and funds',
        columns: [{ name: 'Name', type: 'text' }, { name: 'Kind', type: 'text' }, { name: 'Funder', type: 'text' }, { name: 'Status', type: 'text' }, { name: 'Starts', type: 'date' }, { name: 'Ends', type: 'date' }, { name: 'Budget', type: 'money' }, { name: 'Spent', type: 'money' }, { name: 'Left', type: 'money' }, { name: 'Spent per month', type: 'money' }],
        rows: summaries.map((s) => [s.name, kind[s.kind] || s.kind, s.funder || null, s.status === 'active' ? 'Open' : 'Closed', s.start_on, s.end_on, s.budget, s.spent, s.remaining, s.burn_rate]),
        notes: [],
      },
    ].filter((t) => t.rows.length),
  };
}

// A table as the page shows it: what it holds, its charts with their results, the first rows.
export function tableView(table) {
  const p = profile(table);
  const charts = autoCharts(table, p).map((c) => {
    try {
      let result = runQuery(table, c.spec);
      // A group with nothing to add up (a deposit row in a spending chart) is left off the chart.
      const k = c.spec.group_by.length;
      result = { ...result, rows: result.rows.filter((r) => r.slice(k).some((v) => v !== null)) };
      if (c.fold) result = fold(result, 10);
      return { title: c.title, type: c.type, result };
    } catch (_) { return null; }
  }).filter((c) => c && c.result.rows.length >= (c.type === 'bar' ? 2 : 1));
  return { name: table.name, columns: table.columns, row_count: table.rows.length, notes: table.notes || [], profile: p, facts: facts(p), charts, rows: table.rows.slice(0, PREVIEW_ROWS) };
}

export function analysisRoutes(app, { store, wrap, requireUser, audit, clock, usage, ask = askApi, askDeps = {}, chatFiles = chatFilesApi, isId, compactAt = null }) {
  const jobs = new Set();
  const bad = (code, message) => new PublicError(400, code, message);
  const notFound = (what) => new PublicError(404, 'not_found', `No such ${what}`);
  const str = (v, max) => String(v ?? '').trim().slice(0, max);

  async function ledgerRecords(org) {
    const [live, archived, lines, entries] = await Promise.all([store.listFunds(org), store.listFunds(org, { archived: true }), store.listLines(org), store.listEntries(org, { voided: false })]);
    return ledgerDataset({ funds: [...live, ...archived], lines, entries, asOf: clock() });
  }

  async function loadDataset(req, id = req.params.id) {
    if (id === LEDGER_ID) return ledgerRecords(req.user.org_id);
    const d = isId(id) ? await store.getDataset(req.user.org_id, id) : null;
    if (!d || d.owner_id !== req.user.id) throw notFound('spreadsheet');
    return d;
  }

  async function loadChat(req, id = req.params.id) {
    let c = isId(id) ? await store.getChat(req.user.org_id, id) : null;
    if (!c || c.owner_id !== req.user.id) throw notFound('chat');
    if (c.status === 'thinking' && !jobs.has(c.id) && Date.now() - Date.parse(c.updated_at) > STALE_MS) {
      c = await store.updateChat(req.user.org_id, c.id, { status: 'failed', error: 'That question stopped before it was answered. Ask it again.' });
    }
    return c;
  }

  const datasetCard = (d) => ({
    id: d.id, name: d.name, source: d.source, files: d.files || [], created_at: d.created_at || null, updated_at: d.updated_at || null,
    tables: (d.tables || []).map((t) => ({ name: t.name, row_count: t.row_count ?? t.rows?.length ?? 0, columns: (t.columns || []).length })),
  });
  const chatCard = (c) => ({ id: c.id, title: c.title, dataset_ids: c.dataset_ids, status: c.status, message_count: c.message_count ?? c.messages?.length ?? 0, updated_at: c.updated_at });

  // Reads uploaded spreadsheets into one dataset each.
  async function datasetsFrom(req, files) {
    if (!Array.isArray(files) || !files.length) throw bad('no_file', 'Choose a spreadsheet.');
    if (files.length > MAX_UPLOAD_FILES) throw bad('too_many', `Upload at most ${MAX_UPLOAD_FILES} spreadsheets at a time.`);
    const out = [];
    for (const f of files) {
      const k = kindOf(f?.name, f?.type);
      if (!['csv', 'tsv', 'xlsx', 'xls'].includes(k)) throw bad('not_a_sheet', `${str(f?.name, 120) || 'That file'} is not a spreadsheet. Upload Excel (.xlsx) or CSV.`);
      const read = await readFile(f || {});
      const tables = buildTables(read);
      if (!tables.length) throw bad('no_table', `${read.name} has no rows to chart.`);
      out.push({ id: crypto.randomUUID(), owner_id: req.user.id, owner_name: req.user.name, name: read.name.replace(/\.(csv|tsv|tab|xlsx|xlsm)$/i, '').slice(0, 120) || 'Spreadsheet', source: 'upload', files: [read.name], notes: [], tables });
    }
    const saved = [];
    for (const d of out) saved.push(await store.createDataset(req.user.org_id, d));
    return saved;
  }

  app.get('/api/data', requireUser, wrap(async (req, res) => {
    const org = req.user.org_id;
    const [mine, chats, ledger] = await Promise.all([store.listDatasets(org, { owner_id: req.user.id }), store.listChats(org, { owner_id: req.user.id }), ledgerRecords(org)]);
    res.json({ asks: ask.configured(), datasets: [...mine.map(datasetCard), ...(ledger.tables.length ? [datasetCard(ledger)] : [])], chats: chats.map(chatCard) });
  }));

  app.post('/api/data', requireUser, wrap(async (req, res) => {
    const saved = await datasetsFrom(req, req.body?.files);
    for (const d of saved) audit(req, 'data.upload', d.name, `${d.tables.length} table${d.tables.length === 1 ? '' : 's'}`);
    res.status(201).json({ datasets: saved.map(datasetCard) });
  }));

  app.get('/api/data/:id', requireUser, wrap(async (req, res) => {
    const d = await loadDataset(req);
    res.json({ ...datasetCard(d), mine: d.id !== LEDGER_ID, tables: d.tables.map(tableView), asks: ask.configured() });
  }));

  app.patch('/api/data/:id', requireUser, wrap(async (req, res) => {
    const d = await loadDataset(req);
    if (d.id === LEDGER_ID) throw bad('fixed', "Ledger's records cannot be renamed.");
    const name = str(req.body?.name, 120);
    if (!name) throw bad('no_name', 'Give it a name.');
    res.json(datasetCard(await store.updateDataset(req.user.org_id, d.id, { name })));
  }));

  app.delete('/api/data/:id', requireUser, wrap(async (req, res) => {
    const d = await loadDataset(req);
    if (d.id === LEDGER_ID) throw bad('fixed', "Ledger's records cannot be deleted here.");
    await store.deleteDataset(req.user.org_id, d.id);
    audit(req, 'data.delete', d.name);
    res.status(204).end();
  }));

  app.post('/api/data/:id/query', requireUser, wrap(async (req, res) => {
    const d = await loadDataset(req);
    const spec = req.body || {};
    const t = d.tables.find((x) => x.name.toLowerCase() === String(spec.table || d.tables[0]?.name || '').toLowerCase());
    if (!t) throw notFound('table');
    try { res.json(runQuery(t, spec)); } catch (e) { if (e instanceof QueryError) throw bad('bad_query', e.message); throw e; }
  }));

  // ---- chats ----

  async function chatDatasets(req, ids) {
    const out = [];
    for (const id of ids) {
      try { out.push(await loadDataset(req, id)); } catch (_) { /* deleted since: left out */ }
    }
    return out;
  }

  const chatFileArgs = (req, c) => ({ app: 'ledger', org: req.user.org_id, user: { id: req.user.id, email: req.user.email, name: req.user.name }, chatId: c.id, chatTitle: c.title || 'Analyze' });

  async function chatView(req, c) {
    const files = chatFiles.chatFilesConfigured() ? await chatFiles.listChatFiles(chatFileArgs(req, c)) : [];
    return {
      id: c.id, title: c.title, status: c.status, error: c.error, dataset_ids: c.dataset_ids, updated_at: c.updated_at,
      datasets: (await chatDatasets(req, c.dataset_ids)).map(datasetCard),
      messages: c.messages,
      documents: [...(c.docs || []).map((d) => ({ name: d.name })), ...files.map((f) => ({ name: f.file_name || f.title }))],
      asks: ask.configured(),
    };
  }

  const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((x) => x === LEDGER_ID || isId(x)))].slice(0, MAX_CHAT_DATASETS);

  app.get('/api/data-chats', requireUser, wrap(async (req, res) => {
    const dataset = str(req.query.dataset, 60);
    const chats = await store.listChats(req.user.org_id, { owner_id: req.user.id, dataset_id: dataset || null });
    res.json({ chats: chats.map(chatCard) });
  }));

  app.post('/api/data-chats', requireUser, wrap(async (req, res) => {
    const ids = cleanIds(req.body?.dataset_ids);
    for (const id of ids) await loadDataset(req, id);
    const c = await store.createChat(req.user.org_id, { id: crypto.randomUUID(), owner_id: req.user.id, owner_name: req.user.name, title: str(req.body?.title, 100) || 'New chat', dataset_ids: ids });
    res.status(201).json(await chatView(req, c));
  }));

  app.get('/api/data-chats/:id', requireUser, wrap(async (req, res) => {
    res.json(await chatView(req, await loadChat(req)));
  }));

  app.patch('/api/data-chats/:id', requireUser, wrap(async (req, res) => {
    const c = await loadChat(req);
    const patch = {};
    if (req.body?.title !== undefined) { patch.title = str(req.body.title, 100); if (!patch.title) throw bad('no_title', 'Give the chat a name.'); }
    if (req.body?.dataset_ids !== undefined) { patch.dataset_ids = cleanIds(req.body.dataset_ids); for (const id of patch.dataset_ids) await loadDataset(req, id); }
    res.json(await chatView(req, await store.updateChat(req.user.org_id, c.id, patch)));
  }));

  app.delete('/api/data-chats/:id', requireUser, wrap(async (req, res) => {
    const c = await loadChat(req);
    if (jobs.has(c.id)) throw new PublicError(409, 'busy', 'Wait for the answer, then delete the chat.');
    await store.deleteChat(req.user.org_id, c.id);
    audit(req, 'data.chat_delete', c.title);
    res.status(204).end();
  }));

  const msg = (role, text, extra = {}) => ({ id: crypto.randomUUID(), role, text, at: new Date().toISOString(), ...extra });

  app.post('/api/data-chats/:id/messages', requireUser, wrap(async (req, res) => {
    const c = await loadChat(req);
    const text = str(req.body?.text, 4000);
    if (!text) throw bad('no_text', 'Write a question first.');
    if (jobs.has(c.id) || c.status === 'thinking') throw new PublicError(409, 'busy', 'The last question is still being answered.');
    if (!ask.configured()) throw new PublicError(503, 'llm_unconfigured', 'Questions are off until AI is set up.');
    const datasets = await chatDatasets(req, c.dataset_ids);
    if (!datasets.length) throw bad('no_data', 'Add a spreadsheet to this chat first.');
    const limit = usage ? await usage.check(req.user.org_id) : null;
    if (limit && !limit.allowed) throw new PublicError(429, 'usage_blocked', limit.message || 'Your organization has used its AI budget for this month.');

    const org = req.user.org_id;
    const messages = [...c.messages, msg('user', text)];
    const title = c.title === 'New chat' ? text.replace(/\s+/g, ' ').slice(0, 60) : c.title;
    const started = await store.updateChat(org, c.id, { messages, status: 'thinking', error: '', title });
    jobs.add(c.id);
    const ctx = { client: usage, org, userId: req.user.id, feature: 'ledger_ask' };
    const libraryDocs = chatFiles.chatFilesConfigured() ? await chatFiles.chatFilesContext(chatFileArgs(req, c)) : '';
    const localDocs = (c.docs || []).length ? chatFiles.filesBlock(c.docs.map((d) => ({ file_name: d.name, text: d.text }))) : '';
    const docs = [libraryDocs, localDocs].filter(Boolean).join('\n\n');
    withUsage(ctx, async () => {
      const compacted = await compactIfNeeded({
        messages: messages.slice(0, -1), compaction: c.compaction, summarize: (prompt) => ask.summarize(prompt, askDeps), ...(compactAt ? { at: compactAt } : {}),
      });
      const compaction = compacted || c.compaction || null;
      const history = liveMessages(messages.slice(0, -1), compaction);
      const out = await ask.ask({ question: text, datasets, history, compaction, docs, today: clock() }, askDeps);
      const reply = msg('assistant', out.text, { steps: out.steps, charts: out.charts, tables: out.tables, follow_ups: out.follow_ups, unchecked: out.unchecked });
      await store.updateChat(org, c.id, { messages: [...messages, reply], status: 'idle', error: '', ...(compacted ? { compaction } : {}) });
    }).catch((e) => {
      const n = normalizePublicError(e);
      logSafeError(console, n, 'data_question_failed');
      return store.updateChat(org, c.id, { status: 'failed', error: e instanceof PublicError && e.expose !== false ? e.message : 'That question could not be answered just now. Ask again.' });
    }).catch(() => {}).finally(() => jobs.delete(c.id));
    audit(req, 'data.ask', title);
    res.status(202).json(await chatView(req, started));
  }));

  // A spreadsheet dropped in a chat joins it as data; a document goes to the
  // chat's own folder in Library (or, without Library, stays with the chat as text).
  app.post('/api/data-chats/:id/files', requireUser, wrap(async (req, res) => {
    const c = await loadChat(req);
    const f = req.body?.file;
    if (!f || typeof f !== 'object' || typeof f.data !== 'string' || !f.data) throw bad('no_file', 'Choose a file.');
    const k = kindOf(f.name, f.type || f.media_type);
    if (['csv', 'tsv', 'xlsx', 'xls'].includes(k)) {
      const [d] = await datasetsFrom(req, [{ name: f.name, type: f.type || f.media_type || '', data: f.data }]);
      audit(req, 'data.upload', d.name, 'in a chat');
      const ids = cleanIds([...c.dataset_ids, d.id]);
      return res.status(201).json({ added: 'data', dataset: datasetCard(d), chat: await chatView(req, await store.updateChat(req.user.org_id, c.id, { dataset_ids: ids })) });
    }
    if (chatFiles.chatFilesConfigured()) {
      try {
        const out = await chatFiles.addChatFile({ ...chatFileArgs(req, c), file: { name: f.name, media_type: f.type || f.media_type || '', data: f.data } });
        audit(req, 'data.chat_file', c.title, out.file?.file_name || '');
        return res.status(201).json({ added: 'document', chat: await chatView(req, c) });
      } catch (e) {
        if (e instanceof chatFiles.ChatFileError) throw new PublicError(e.status, 'chat_file', e.message);
        throw e;
      }
    }
    const read = await readFile({ name: f.name, type: f.type || f.media_type, data: f.data });
    if (read.kind !== 'document') throw bad('not_a_document', 'That file could not be read.');
    const docs = [...(c.docs || []).filter((d) => d.name !== read.name), { name: read.name, text: read.text.slice(0, MAX_DOC_TEXT) }].slice(-10);
    audit(req, 'data.chat_file', c.title, read.name);
    res.status(201).json({ added: 'document', chat: await chatView(req, await store.updateChat(req.user.org_id, c.id, { docs })) });
  }));

  return { jobs, MAX_FILE_BYTES };
}

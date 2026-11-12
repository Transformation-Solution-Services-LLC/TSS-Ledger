// Analyze end to end: upload a spreadsheet, its charts, a question answered
// in the background from computed figures, files in a chat, privacy. Claude
// is stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.LEDGER_SERVICE_TOKEN = 'ledger-svc';
process.env.EXPORT_TOKEN = 'export-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.LIBRARY_URL;

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');
const { QB_DETAIL, budgetWorkbook, b64 } = await import('./fixtures/sheets.mjs');

const toolUse = (name, input, id = `tu_${Math.random().toString(36).slice(2)}`) => ({ type: 'tool_use', id, name, input });
const reply = (content) => ({ model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 }, content });

// Asks for the total by section, then answers. `wrongFirst`: the first answer
// carries a figure nothing computed, and is sent back.
function fakeClaude({ wrongFirst = false } = {}) {
  const calls = [];
  const create = async (params) => {
    calls.push(params);
    const last = params.messages[params.messages.length - 1];
    if (typeof last.content === 'string') {
      return reply([{ type: 'text', text: 'Adding it up.' }, toolUse('run_query', { table: 'qb', description: 'Spending by section', group_by: [{ column: 'Section' }], measures: [{ fn: 'sum', column: 'Amount' }] })]);
    }
    const results = last.content;
    const err = results.find((r) => r.is_error);
    if (err && /not computed/.test(err.content)) {
      return reply([toolUse('answer', { text: 'Personnel took the most: **$9,250.50** of $9,858.85.', charts: [{ step: 1, type: 'hbar', title: 'By section' }], tables: [1], follow_ups: ['Which month cost the most?'] })]);
    }
    if (results.some((r) => /"step":1/.test(r.content)) && !results.some((r) => /"step":2/.test(r.content)) && !calls.some((c) => c.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.name === 'calculate')))) {
      return reply([toolUse('calculate', { expression: '9250.5 + 520.25 + 88.1', label: 'All spending' })]);
    }
    return reply([toolUse('answer', { text: wrongFirst ? 'Personnel took the most: $9,250.50 of $9,858.85, and travel will reach $1,400.' : 'Personnel took the most: **$9,250.50** of $9,858.85.', charts: [{ step: 1, type: 'hbar', title: 'By section' }, { step: 9, type: 'bar', title: 'No such step' }], tables: [1], follow_ups: ['Which month cost the most?'] })]);
  };
  return { create, calls };
}

async function setup(claude = fakeClaude()) {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('ledger');
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => '2026-06-30', askDeps: { create: claude.create }, usage: { on: false, check: async () => null, report: async () => {} } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const signIn = async (claims) => (await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket(claims) })).body.token;
  const dana = await signIn({ permissions: ['use'] });
  const ray = await signIn({ sub: 'u-ray', name: 'Ray', permissions: ['use', 'manage'] });
  const bea = await signIn({ sub: 'u-bea', name: 'Bea', org: { id: 'org-b', name: 'Org B' }, permissions: ['use', 'manage'] });
  const settle = async (id, token = dana) => {
    for (let i = 0; i < 300; i++) {
      const r = await call('GET', `/api/data-chats/${id}`, null, token);
      if (r.body.status !== 'thinking') return r.body;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error('never answered');
  };
  return { store, call, dana, ray, bea, settle, close: () => server.close() };
}

test('an uploaded spreadsheet is read, charted and private to the person who added it', async () => {
  const t = await setup();
  try {
    const up = await t.call('POST', '/api/data', { files: [{ name: 'qb.csv', type: 'text/csv', data: b64(QB_DETAIL) }, { name: 'Budget 2026.xlsx', data: (await budgetWorkbook()).toString('base64') }] }, t.dana);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.deepEqual(up.body.datasets.map((d) => [d.name, d.tables.length]), [['qb', 1], ['Budget 2026', 4]]);
    const id = up.body.datasets[0].id;
    const v = await t.call('GET', `/api/data/${id}`, null, t.dana);
    assert.equal(v.status, 200);
    const [table] = v.body.tables;
    assert.equal(table.row_count, 7);
    assert.match(table.facts.join(' '), /Amount adds up to \$9,858\.85/);
    assert.deepEqual(table.charts.map((c) => c.title), ['Amount by month', 'Amount by Section', 'Amount by Transaction Type']);
    assert.deepEqual(table.charts[0].result.rows, [['2026-01', 3000], ['2026-02', 3450], ['2026-03', 3408.85]]);

    assert.equal((await t.call('GET', `/api/data/${id}`, null, t.ray)).status, 404, 'a colleague does not see it');
    assert.equal((await t.call('GET', `/api/data/${id}`, null, t.bea)).status, 404, 'nor another organization');
    assert.equal((await t.call('DELETE', `/api/data/${id}`, null, t.ray)).status, 404);
    const list = await t.call('GET', '/api/data', null, t.ray);
    assert.deepEqual(list.body.datasets.map((d) => d.id), [], 'Ray has nothing yet, and Ledger has no records to show');
    assert.equal((await t.call('POST', '/api/data', { files: [{ name: 'notes.pdf', data: b64('%PDF') }] }, t.dana)).status, 400, 'only spreadsheets here');

    const q = await t.call('POST', `/api/data/${id}/query`, { table: 'qb', filters: [{ column: 'Name', op: 'eq', value: 'office depot' }], measures: [{ fn: 'sum', column: 'Amount' }] }, t.dana);
    assert.equal(q.body.rows[0][0], 400);
    assert.equal((await t.call('POST', `/api/data/${id}/query`, { group_by: [{ column: 'Nope' }] }, t.dana)).body.error.startsWith('No column'), true);

    assert.equal((await t.call('PATCH', `/api/data/${id}`, { name: 'Q1 detail' }, t.dana)).body.name, 'Q1 detail');
    assert.equal((await t.call('DELETE', `/api/data/${id}`, null, t.dana)).status, 204);
    assert.equal((await t.call('GET', `/api/data/${id}`, null, t.dana)).status, 404);
  } finally { t.close(); }
});

test('a question is answered in the background from computed figures, with how and a chart', async () => {
  const claude = fakeClaude();
  const t = await setup(claude);
  try {
    const [d] = (await t.call('POST', '/api/data', { files: [{ name: 'qb.csv', data: b64(QB_DETAIL) }] }, t.dana)).body.datasets;
    const c = (await t.call('POST', '/api/data-chats', { dataset_ids: [d.id] }, t.dana)).body;
    assert.equal(c.title, 'New chat');
    const sent = await t.call('POST', `/api/data-chats/${c.id}/messages`, { text: 'Where did the money go?' }, t.dana);
    assert.equal(sent.status, 202);
    assert.equal(sent.body.status, 'thinking');
    assert.equal(sent.body.title, 'Where did the money go?');
    const done = await t.settle(c.id);
    assert.equal(done.status, 'idle', done.error);
    const a = done.messages[1];
    assert.equal(a.role, 'assistant');
    assert.equal(a.text, 'Personnel took the most: **$9,250.50** of $9,858.85.');
    assert.deepEqual(a.unchecked, [], '$9,858.85 is the computed total of the column');
    assert.equal(a.steps[0].how, 'The total of Amount for each Section in qb.');
    assert.deepEqual(a.steps[0].result.rows[0], ['6000 Personnel', 9250.5]);
    assert.equal(a.steps[1].kind, 'calc');
    assert.equal(a.steps[1].value, 9858.85);
    assert.deepEqual(a.charts, [{ step: 1, type: 'hbar', title: 'By section' }], 'a chart naming no real step is dropped');
    assert.deepEqual(a.tables, [1]);
    // What the model was given: the table's columns and a few rows, never asked to add anything itself.
    const sys = claude.calls[0].system[0].text;
    assert.match(sys, /TABLE "qb" \(from "qb"\), 7 rows/);
    assert.match(sys, /- Amount \(money\): total 9858\.85/);
    assert.match(sys, /You never compute or guess a figure yourself/);
    assert.equal(claude.calls[0].model, 'claude-opus-5-5');

    assert.equal((await t.call('GET', `/api/data-chats/${c.id}`, null, t.ray)).status, 404, 'a chat is its owner\'s alone');
    assert.equal((await t.call('POST', `/api/data-chats/${c.id}/messages`, { text: 'hi' }, t.ray)).status, 404);
    assert.equal((await t.call('GET', `/api/data-chats/${c.id}`, null, t.bea)).status, 404);
    assert.deepEqual((await t.call('GET', '/api/data-chats', null, t.ray)).body.chats, []);

    // A second question carries the first in the history.
    await t.call('POST', `/api/data-chats/${c.id}/messages`, { text: 'And by month?' }, t.dana);
    const again = await t.settle(c.id);
    assert.equal(again.messages.length, 4);
    const last = claude.calls[claude.calls.length - 1];
    assert.ok(last.messages.some((m) => m.content === 'Where did the money go?'));

    assert.equal((await t.call('DELETE', `/api/data-chats/${c.id}`, null, t.dana)).status, 204);
    assert.equal((await t.call('GET', `/api/data-chats/${c.id}`, null, t.dana)).status, 404);
  } finally { t.close(); }
});

test('an answer with a figure nothing computed is sent back before the person sees it', async () => {
  const claude = fakeClaude({ wrongFirst: true });
  const t = await setup(claude);
  try {
    const [d] = (await t.call('POST', '/api/data', { files: [{ name: 'qb.csv', data: b64(QB_DETAIL) }] }, t.dana)).body.datasets;
    const c = (await t.call('POST', '/api/data-chats', { dataset_ids: [d.id] }, t.dana)).body;
    await t.call('POST', `/api/data-chats/${c.id}/messages`, { text: 'What about travel?' }, t.dana);
    const done = await t.settle(c.id);
    const a = done.messages[1];
    assert.ok(!a.text.includes('$1,400'));
    assert.deepEqual(a.unchecked, []);
    const sentBack = claude.calls.flatMap((x) => x.messages).find((m) => Array.isArray(m.content) && m.content.some((b) => b.is_error && /not computed by Ledger: \$1,400/.test(b.content)));
    assert.ok(sentBack, 'the model was told which figure was not computed');
  } finally { t.close(); }
});

test('a spreadsheet dropped in a chat joins it as data; a document stays with the chat', async () => {
  const t = await setup();
  try {
    const c = (await t.call('POST', '/api/data-chats', { dataset_ids: [] }, t.dana)).body;
    assert.equal((await t.call('POST', `/api/data-chats/${c.id}/messages`, { text: 'Hi' }, t.dana)).status, 400, 'no data yet');
    const sheet = await t.call('POST', `/api/data-chats/${c.id}/files`, { file: { name: 'qb.csv', media_type: 'text/csv', data: b64(QB_DETAIL) } }, t.dana);
    assert.equal(sheet.status, 201, JSON.stringify(sheet.body));
    assert.equal(sheet.body.added, 'data');
    assert.equal(sheet.body.chat.datasets[0].name, 'qb');
    const doc = await t.call('POST', `/api/data-chats/${c.id}/files`, { file: { name: 'Award letter.md', media_type: 'application/octet-stream', data: b64('# Award\nMeyer Memorial Trust awards Youth Diversion $24,000 for 2026.') } }, t.dana);
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    assert.deepEqual(doc.body.chat.documents, [{ name: 'Award letter.md' }]);
    assert.equal((await t.call('POST', `/api/data-chats/${c.id}/files`, { file: { name: 'x.csv', data: b64('a,b\n1,2') } }, t.ray)).status, 404);
  } finally { t.close(); }
});

test("Ledger's own records are a dataset for everyone, and the export carries every spreadsheet and chat", async () => {
  const t = await setup();
  try {
    const f = (await t.call('POST', '/api/funds', { name: 'Youth Diversion', award: 24000 }, t.ray)).body;
    await t.call('POST', `/api/funds/${f.id}/entries`, { date: '2026-02-01', amount: 120.5, payee: 'Office Depot' }, t.dana);
    await t.call('POST', `/api/funds/${f.id}/entries`, { date: '2026-03-01', amount: 80, payee: 'Shell' }, t.dana);
    const list = await t.call('GET', '/api/data', null, t.dana);
    const ledger = list.body.datasets.find((d) => d.id === 'ledger');
    assert.deepEqual(ledger.tables.map((x) => x.name), ['Spending', 'Budget lines', 'Grants and funds']);
    const v = await t.call('GET', '/api/data/ledger', null, t.dana);
    assert.equal(v.body.mine, false);
    assert.deepEqual(v.body.tables[0].charts[0].result.rows, [['2026-02', 120.5], ['2026-03', 80]]);
    assert.equal((await t.call('DELETE', '/api/data/ledger', null, t.ray)).status, 400);
    assert.equal((await t.call('GET', '/api/data/ledger', null, t.bea)).body.tables.length, 0, 'another organization sees none of it');

    await t.call('POST', '/api/data', { files: [{ name: 'qb.csv', data: b64(QB_DETAIL) }] }, t.dana);
    await t.call('POST', '/api/data-chats', { dataset_ids: ['ledger'] }, t.dana);
    const ex = await t.call('GET', '/api/export/org', null, null, { Authorization: 'Bearer export-secret', 'X-TSS-Org': 'org-a' });
    assert.equal(ex.status, 200, JSON.stringify(ex.body));
    assert.equal(ex.body.tables.datasets.length, 1);
    assert.equal(ex.body.tables.datasets[0].tables[0].rows.length, 7);
    assert.equal(ex.body.tables.data_chats.length, 1);
  } finally { t.close(); }
});

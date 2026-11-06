// A pile of files, end to end: upload, the shape, the person's answer, the
// checks by three different models, and the import. Claude is stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.LEDGER_SERVICE_TOKEN = 'ledger-svc';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.LEDGER_REVIEW_MODELS;
delete process.env.LEDGER_MODEL;

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');
const { ShapeSchema, ReviewSchema } = await import('../services/sense.js');
const { messyShape } = await import('./fixtures/pile.mjs');

const QB = [
  'Transaction Detail by Account,,,,,',
  ',,,,,',
  'Date,Name,Memo/Description,Account,Class,Amount',
  '01/31/2026,Staffing Co,January payroll,6000 Personnel,YD,"-3,000.00"',
  '02/14/2026,Office Depot,Workbooks,Supplies,YD,-450.00',
  '02/20/2026,Meyer Memorial Trust,Grant payment received,Income,YD,"12,000.00"',
  '03/01/2026,Ana Reyes,Circle facilitation,Stipends,Reentry,"-1,200.00"',
  '03/02/2026,Coffee Shop,Board meeting,Meals,General,-40.00',
  'Total for YD,,,,,"-3,450.00"',
].join('\n');
const LETTER = 'Dear TJC,\nMeyer Memorial Trust is pleased to award Youth Diversion a grant of $24,000 for January 1, 2026 through December 31, 2026.';

async function budgetXlsx() {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Youth Diversion');
  [['Line', 'Acct', 'Budget'], ['Personnel', 6000, 18000], ['Supplies', 6400, 3000], ['Total', '', 21000]].forEach((r) => ws.addRow(r));
  wb.addWorksheet('Notes').addRow(['Call Meyer in May about the report']);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const b64 = (s) => Buffer.from(s).toString('base64');

// A stand-in for Claude. The drafter proposes the shape with one question;
// the first checker finds one mistake (the board coffee should not be
// skipped... it is told it should be ignored, which the fix keeps); every
// other check is clear. Calls are recorded.
function fakeClaude({ failModel = null, mistakesFrom = 'claude-sonnet-5-5', alwaysWrong = false } = {}) {
  const calls = [];
  let found = false;
  const call = async ({ model, schema, content }) => {
    calls.push({ model, kind: schema === ShapeSchema ? 'shape' : 'check', text: content.map((c) => c.text).join('\n') });
    if (model === failModel) { const { PublicError } = await import('../lib/public-error.js'); throw new PublicError(503, 'llm_model_missing', 'A checker is not available.'); }
    if (schema === ShapeSchema) {
      const s = messyShape();
      const fixing = content.some((c) => c.text.startsWith('MISTAKES A CHECKER FOUND'));
      if (!fixing && !content.some((c) => c.text.startsWith('YOUR SHAPE'))) {
        s.questions = [{ id: 'Q1', ask: 'Is the Reentry class the Reentry Circles grant?', options: ['Yes', 'No, leave it out'], recommended: 0 }];
        s.sheets[0].skip_when = [];
      }
      if (content.some((c) => c.text.includes('Answer: No, leave it out'))) s.sheets[0].fund_values[1].fund = '-';
      return { output: ShapeSchema.parse(s), model };
    }
    assert.equal(schema, ReviewSchema);
    if (alwaysWrong || (model === mistakesFrom && !found)) {
      found = true;
      return { output: { mistakes: [{ where: 'QuickBooks export.csv, row 6', what: 'A grant payment received is income, not spending.', fix: 'Add "grant payment received" to skip_when.' }] }, model };
    }
    return { output: { mistakes: [] }, model };
  };
  return { call, calls, reset: () => { found = false; } };
}

async function setup(claude = fakeClaude(), { configured = true } = {}) {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('ledger');
  const sense = { ...(await import('../services/sense.js')) };
  if (!configured) sense.configured = () => false;
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => '2026-06-30', senseDeps: { call: claude.call }, sense, usage: { on: false, check: async () => null, report: async () => {} } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const signIn = async (claims) => (await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket(claims) })).body.token;
  const manager = await signIn({ permissions: ['use', 'manage'] });
  const reader = await signIn({ sub: 'u-ray', name: 'Ray', permissions: ['use'] });
  const other = await signIn({ sub: 'u-b', name: 'Bea', org: { id: 'org-b', name: 'Org B' }, permissions: ['use', 'manage'] });
  const settle = async (id, token = manager) => {
    for (let i = 0; i < 200; i++) {
      const r = await call('GET', `/api/intakes/${id}`, null, token);
      if (!['reading', 'checking', 'importing'].includes(r.body.status)) return r.body;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error('never settled');
  };
  const upload = async (token = manager) => call('POST', '/api/intakes', { files: [
    { name: 'QuickBooks export.csv', type: 'text/csv', data: b64(QB) },
    { name: 'Budgets.xlsx', data: await budgetXlsx() },
    { name: 'Award letter.txt', type: 'text/plain', data: b64(LETTER) },
  ] }, token);
  return { store, call, manager, reader, other, settle, upload, close: () => server.close() };
}

test('a pile is read, asks one question, is checked until three different models clear it, then imports', async () => {
  const claude = fakeClaude();
  const t = await setup(claude);
  try {
    const up = await t.upload();
    assert.equal(up.status, 202, JSON.stringify(up.body));
    assert.equal(up.body.status, 'reading');
    assert.deepEqual(up.body.files.map((f) => [f.name, f.kind, f.sheets]), [['QuickBooks export.csv', 'sheet', 1], ['Budgets.xlsx', 'sheet', 2], ['Award letter.txt', 'document', 0]]);
    let v = await t.settle(up.body.id);
    assert.equal(v.status, 'asking');
    assert.equal(v.questions.length, 1);
    assert.equal(claude.calls[0].model, 'claude-opus-5-5', 'Opus drafts');
    assert.match(claude.calls[0].text, /\[S2\] file "Budgets.xlsx", sheet "Youth Diversion"/);
    assert.match(claude.calls[0].text, /\[D1\] document "Award letter.txt"/);
    // Ledger's own reading of the first shape (income not yet left out).
    const yd = v.plan.funds.find((f) => f.ref === 'F1');
    assert.deepEqual([yd.name, yd.award, yd.award_checked, yd.entries, yd.spent, yd.budget, yd.budget_lines], ['Youth Diversion', 24000, true, 3, -8550, 21000, 2]);

    assert.equal((await t.call('POST', `/api/intakes/${v.id}/import`, {}, t.manager)).status, 409, 'nothing imports before the checks');
    v = (await t.call('POST', `/api/intakes/${v.id}/accept`, { answers: { Q1: 0 } }, t.manager)).body;
    assert.equal(v.status, 'checking');
    v = await t.settle(v.id);
    assert.equal(v.status, 'ready', JSON.stringify(v));
    assert.equal(v.checks.cleared, 3);
    assert.equal(v.checks.answers_applied, false, 'the recommended answer needs no redraft');
    // Sonnet found a mistake, Opus fixed it, then Sonnet, Opus 5 and Fable each cleared the fixed draft.
    const checks = claude.calls.filter((c) => c.kind === 'check').map((c) => c.model);
    assert.deepEqual(checks, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1']);
    assert.ok(!checks.includes('claude-opus-5-5'), 'the drafter never checks its own draft');
    assert.deepEqual(v.checks.rounds.map((r) => [r.clear, r.revised]), [[false, true], [true, false], [true, false], [true, false]]);
    assert.equal(v.checks.rounds[0].mistakes[0].what, 'A grant payment received is income, not spending.');
    assert.match(claude.calls.find((c) => c.kind === 'check').text, /LEDGER'S READING:[\s\S]*F1 "Youth Diversion"/, 'checkers see what Ledger read');
    assert.match(claude.calls.find((c) => c.kind === 'check').text, /THE PERSON CONFIRMED:\n- Is the Reentry class the Reentry Circles grant\? Answer: Yes/);
    const ydNow = v.plan.funds.find((f) => f.ref === 'F1');
    assert.deepEqual([ydNow.entries, ydNow.spent], [2, 3450], 'the fix left the income out');
    assert.equal(JSON.stringify(v).includes('claude'), false, 'no model names reach the page');

    const done = await t.call('POST', `/api/intakes/${v.id}/import`, {}, t.manager);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, 'imported');
    assert.deepEqual(done.body.result, { funds_added: 2, lines_added: 2, lines_updated: 0, entries_added: 3, unchanged: 0, total: 4650, skipped: 4 });
    const funds = await t.store.listFunds('org-a');
    const grant = funds.find((f) => f.name === 'Youth Diversion');
    assert.deepEqual([grant.award, grant.funder, grant.code, grant.start_on, grant.end_on], [24000, 'Meyer Memorial Trust', 'YD', '2026-01-01', '2026-12-31']);
    const entries = await t.store.listEntries('org-a', { fund_id: grant.id });
    const lines = await t.store.listLines('org-a', { fund_id: grant.id });
    assert.deepEqual(entries.map((e) => [e.amount, lines.find((l) => l.id === e.line_id)?.name]).sort(), [[3000, 'Personnel'], [450, 'Supplies']]);
    assert.equal((await t.call('POST', `/api/intakes/${v.id}/import`, {}, t.manager)).status, 409, 'imported once');
    assert.ok((await t.store.activity('org-a')).some((a) => a.action === 'import.files' && /3 entries/.test(a.target)));

    // The same pile again adds nothing.
    claude.reset();
    const again = await t.upload();
    await t.settle(again.body.id);
    await t.call('POST', `/api/intakes/${again.body.id}/accept`, { answers: { Q1: 0 } }, t.manager);
    const second = await t.settle(again.body.id);
    assert.equal(second.plan.funds.length, 2);
    const re = await t.call('POST', `/api/intakes/${again.body.id}/import`, {}, t.manager);
    assert.deepEqual([re.body.result.funds_added, re.body.result.entries_added, re.body.result.unchanged], [0, 0, 3]);
  } finally { t.close(); }
});

test('an answer against the recommendation redrafts first, and a missing checker is replaced by the spare', async () => {
  const claude = fakeClaude({ failModel: 'claude-opus-5', mistakesFrom: 'none' });
  const t = await setup(claude);
  try {
    const up = await t.upload();
    await t.settle(up.body.id);
    await t.call('POST', `/api/intakes/${up.body.id}/accept`, { answers: { Q1: 1 }, note: 'Reentry is ours but not a grant here.' }, t.manager);
    const v = await t.settle(up.body.id);
    assert.equal(v.status, 'ready');
    assert.equal(v.checks.answers_applied, true);
    assert.equal(claude.calls[1].kind, 'shape', 'the drafter takes the answer first');
    assert.match(claude.calls[1].text, /Answer: No, leave it out[\s\S]*The person added: Reentry is ours/);
    assert.deepEqual(claude.calls.filter((c) => c.kind === 'check').map((c) => c.model), ['claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-haiku-5-5']);
    assert.deepEqual(v.checks.rounds.map((r) => r.failed), [false, true, false, false]);
    assert.equal(v.plan.funds.find((f) => f.ref === 'F2').entries, 0, 'Reentry rows left out as answered');
  } finally { t.close(); }
});

test('checkers that never agree end unsettled; importing then needs a confirmation', async () => {
  const t = await setup(fakeClaude({ alwaysWrong: true }));
  try {
    const up = await t.upload();
    await t.settle(up.body.id);
    await t.call('POST', `/api/intakes/${up.body.id}/accept`, {}, t.manager);
    const v = await t.settle(up.body.id);
    assert.equal(v.status, 'unsettled');
    assert.equal(v.checks.rounds.length, 10);
    assert.match(v.message, /After 10 checks the checkers still disagreed/);
    assert.equal((await t.call('POST', `/api/intakes/${v.id}/import`, {}, t.manager)).status, 400);
    const ok = await t.call('POST', `/api/intakes/${v.id}/import`, { anyway: true }, t.manager);
    assert.equal(ok.body.status, 'imported');
    assert.ok((await t.store.activity('org-a')).some((a) => /before every check cleared/.test(a.detail)));
  } finally { t.close(); }
});

test('only managers, only their organization, and a plain sentence when reading files is off', async () => {
  const t = await setup();
  try {
    assert.equal((await t.upload(t.reader)).status, 403);
    const up = await t.upload();
    assert.equal((await t.call('GET', `/api/intakes/${up.body.id}`, null, t.other)).status, 404);
    assert.equal((await t.call('POST', `/api/intakes/${up.body.id}/accept`, {}, t.other)).status, 404);
    assert.equal((await t.call('GET', '/api/intakes/not-an-id', null, t.manager)).status, 404);
    await t.settle(up.body.id);
    const list = await t.call('GET', '/api/intakes', null, t.manager);
    assert.equal(list.body.on, true);
    assert.deepEqual(list.body.intakes[0].file_names, ['QuickBooks export.csv', 'Budgets.xlsx', 'Award letter.txt']);
    assert.equal((await t.call('GET', '/api/intakes', null, t.other)).body.intakes.length, 0);
    const bad = await t.call('POST', '/api/intakes', { files: [{ name: 'old.xls', data: 'AAAA' }] }, t.manager);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /save older Excel files/);
  } finally { t.close(); }
  const off = await setup(fakeClaude(), { configured: false });
  try {
    const r = await off.upload();
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'Reading files is off until AI is set up.');
    assert.equal((await off.call('GET', '/api/intakes', null, off.manager)).body.on, false);
  } finally { off.close(); }
});

test('a failed reading is kept with a plain message and can be started again', async () => {
  let fail = true;
  const inner = fakeClaude();
  const claude = { call: async (a) => { if (fail && a.schema === ShapeSchema) { const { PublicError } = await import('../lib/public-error.js'); throw new PublicError(502, 'llm_failed', 'The files could not be read just now. Try again.'); } return inner.call(a); } };
  const t = await setup(claude);
  try {
    const up = await t.upload();
    let v = await t.settle(up.body.id);
    assert.equal(v.status, 'failed');
    assert.equal(v.message, 'The files could not be read just now. Try again.');
    fail = false;
    v = (await t.call('POST', `/api/intakes/${up.body.id}/retry`, {}, t.manager)).body;
    assert.equal(v.status, 'reading');
    v = await t.settle(up.body.id);
    assert.equal(v.status, 'asking');
  } finally { t.close(); }
});

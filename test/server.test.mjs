import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.LEDGER_SERVICE_TOKEN = 'ledger-svc';
process.env.EXPORT_TOKEN = 'ledger-export';

const { createApp, readMoney } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');

const TODAY = '2026-06-30';

async function setup({ rollodex } = {}) {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('ledger');
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => TODAY, ...(rollodex ? { rollodex } : {}) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    const text = await r.text();
    return { status: r.status, type, headers: r.headers, text, body: type.includes('json') && text ? JSON.parse(text) : text };
  };
  const signIn = async (claims) => (await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket(claims) })).body.token;
  const manager = await signIn({ permissions: ['use', 'manage'] });
  const reader = await signIn({ sub: 'u-ray', name: 'Ray', permissions: ['use'] });
  const other = await signIn({ sub: 'u-b', name: 'Bea', org: { id: 'org-b', name: 'Org B' }, permissions: ['use', 'manage'] });
  const ok = async (method, p, body, token = manager, expect = method === 'POST' ? 201 : 200) => {
    const r = await call(method, p, body, token);
    assert.equal(r.status, expect, `${method} ${p}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const service = (p, headers = {}) => call('GET', p, null, 'ledger-svc', { 'X-TSS-Org': 'org-a', 'X-TSS-App': 'watson', ...headers });
  return { store, cockpit, call, signIn, manager, reader, other, ok, service, close: () => server.close() };
}

// Two grants with budgets, and a QuickBooks Transaction Detail export.
async function twoGrants(t) {
  const youth = await t.ok('POST', '/api/funds', { name: 'Youth Diversion', funder: 'Meyer Memorial Trust', code: 'YD', award: '$24,000', start_on: '2026-01-01', end_on: '2026-12-31' });
  const reentry = await t.ok('POST', '/api/funds', { name: 'Reentry Circles', funder: 'Oregon Community Foundation', award: 6000, start_on: '2026-04-01', end_on: '2026-09-30' });
  const general = await t.ok('POST', '/api/funds', { name: 'General operating', kind: 'unrestricted', award: 40000 });
  const budget = 'Line Item,Account No,Budget\nPersonnel,6000,"18,000"\nSupplies,6400,"$3,000"\nTravel,6500,3000\nTotal,,24000\n';
  const imported = await t.ok('POST', '/api/import/budget', { csv: budget, fund_id: youth.id }, t.manager, 200);
  assert.deepEqual([imported.added, imported.updated, imported.total, imported.skipped.length], [3, 0, 24000, 1]);
  await t.ok('POST', `/api/funds/${reentry.id}/lines`, { name: 'Facilitator stipends', amount: 5000 });
  await t.ok('POST', `/api/funds/${reentry.id}/lines`, { name: 'Food', amount: 1000 });
  return { youth, reentry, general };
}
const QB = [
  'Date,Transaction Type,Num,Name,Memo/Description,Account,Class,Amount',
  '01/31/2026,Payroll Check,1001,Staffing Co,January payroll,6000 Personnel,YD,"3,000.00"',
  '02/28/2026,Payroll Check,1002,Staffing Co,February payroll,6000 Personnel,YD,"3,000.00"',
  '03/15/2026,Expense,,Office Depot,Workbooks,Expenses:Supplies,YD,450.00',
  '03/15/2026,Expense,,Office Depot,Workbooks,Expenses:Supplies,YD,450.00',
  '04/20/2026,Check,2001,Ana Reyes,Circle facilitation,Facilitator stipends,Reentry Circles,"1,200.00"',
  '05/02/2026,Credit,,Office Depot,Return,6400,YD,(50.00)',
  '05/10/2026,Expense,,Safeway,Circle snacks,Groceries,Reentry Circles,85.20',
  '06/01/2026,Expense,,Unknown,Rent,Rent,Building Fund,900',
  ',,,,Total for Expenses,,,9035.20',
].join('\n');

test('sign-in comes only from a Cockpit launch ticket for Ledger, used once', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('GET', '/api/funds')).status, 401);
    assert.equal((await t.call('POST', '/api/auth/dev')).status, 404, 'no developer sign-in unless switched on');
    const ticket = t.cockpit.ticket();
    const ok = await t.call('POST', '/api/auth/cockpit', { ticket });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.can_manage, false);
    assert.equal((await t.call('POST', '/api/auth/cockpit', { ticket })).status, 401, 'a ticket works once');
    assert.equal((await t.call('POST', '/api/auth/cockpit', { ticket: t.cockpit.ticket({ aud: 'vault' }) })).status, 401);
    const none = await t.call('POST', '/api/auth/cockpit', { ticket: t.cockpit.ticket({ permissions: [] }) });
    assert.equal(none.status, 403);
    assert.match(none.body.error, /does not include Ledger/);
    const me = await t.call('GET', '/api/me', null, t.manager);
    assert.equal(me.body.can_manage, true);
    assert.equal(me.body.today, TODAY);
    assert.deepEqual(me.body.options.kinds, ['grant', 'restricted', 'unrestricted']);
    assert.equal((await t.call('GET', '/api/health')).body.app, 'Ledger');
  } finally { t.close(); }
});

test('a spending CSV from QuickBooks imports once and gives each grant its burn rate', async () => {
  const t = await setup();
  try {
    const { youth, reentry } = await twoGrants(t);
    const preview = await t.ok('POST', '/api/import/spend/preview', { csv: QB }, t.manager, 200);
    assert.deepEqual(preview.mapping, { date: 0, amount: 7, fund: 6, line: 5, payee: 3, memo: 4, reference: 2 }, 'QuickBooks columns are recognized');

    const check = await t.ok('POST', '/api/import/spend', { csv: QB, mapping: preview.mapping, dry_run: true }, t.manager, 200);
    assert.equal(check.added, 7);
    assert.deepEqual(check.skipped.map((s) => [s.line, s.reason]), [[9, 'No fund named or coded "Building Fund"'], [10, 'No date']]);
    assert.equal((await t.ok('GET', '/api/entries')).entries.length, 0, 'a check writes nothing');
    assert.equal(check.plan.find((p) => p.line === 8).detail, '"Groceries" is not on the budget');

    const done = await t.ok('POST', '/api/import/spend', { csv: QB, mapping: preview.mapping }, t.manager, 200);
    assert.deepEqual([done.added, done.unchanged, done.total], [7, 0, 8135.2]);
    const again = await t.ok('POST', '/api/import/spend', { csv: QB, mapping: preview.mapping }, t.manager, 200);
    assert.deepEqual([again.added, again.unchanged], [0, 7], 'the same sheet twice adds nothing, the two identical rows included');

    const y = await t.ok('GET', `/api/funds/${youth.id}`);
    assert.equal(y.spent, 6850);
    assert.equal(y.remaining, 17150);
    assert.equal(y.burn_rate, 1151.92, '$6,850 over the 181 days of the year gone');
    assert.equal(y.pace, 'slow');
    assert.deepEqual(y.lines.map((l) => [l.name, l.spent, l.remaining]), [['Personnel', 6000, 12000], ['Supplies', 850, 2150], ['Travel', 0, 3000]]);
    assert.equal(y.entries.length, 5);
    const r = await t.ok('GET', `/api/funds/${reentry.id}`);
    assert.equal(r.spent, 1285.2);
    assert.equal(r.burn_rate, 429.87, 'three months since April 1');
    assert.deepEqual(r.lines.map((l) => [l.name, l.spent]), [['Facilitator stipends', 1200], ['Food', 0], ['Not on a budget line', 85.2]]);

    const home = await t.ok('GET', '/api/home');
    assert.deepEqual(home.totals.restricted, { budget: 30000, spent: 8135.2, remaining: 21864.8 });
    assert.deepEqual(home.funds.map((f) => [f.name, f.burn_rate]), [['General operating', 0], ['Reentry Circles', 429.87], ['Youth Diversion', 1151.92]]);
  } finally { t.close(); }
});

test('the importer takes Debit and Credit columns, a fund for the whole sheet, and refuses rows it cannot read', async () => {
  const t = await setup();
  try {
    const { youth } = await twoGrants(t);
    const bank = 'Posted,Description,Debit,Credit\n2026-05-01,Bus passes,120.00,\n2026-05-03,Refund,,20.00\n2026-05-04,Nothing,,\n2027-01-01,Future,5,\nnot a date,Bad,5,\n';
    const r = await t.ok('POST', '/api/import/spend', { csv: bank, fund_id: youth.id }, t.manager, 200);
    assert.equal(r.added, 2);
    assert.equal(r.total, 100);
    assert.deepEqual(r.skipped.map((s) => s.reason), ['No amount', 'Dated in the future', 'The date "not a date" could not be read']);
    const noFund = await t.ok('POST', '/api/import/spend', { csv: bank }, t.manager, 200);
    assert.match(noFund.skipped[0].reason, /choose a fund for the sheet/);
    assert.equal((await t.call('POST', '/api/import/spend', { csv: bank }, t.reader)).status, 403, 'importing is for managers');
    assert.equal((await t.call('POST', '/api/import/budget', { csv: 'Line,Budget\nA,1', fund_id: youth.id }, t.other)).status, 404, 'another organization\'s fund');
    const twice = await t.ok('POST', '/api/import/budget', { csv: 'Line Item,Account No,Budget\nPersonnel,6000,"19,000"\nSupplies,6400,3000\n', fund_id: youth.id }, t.manager, 200);
    assert.deepEqual([twice.added, twice.updated, twice.unchanged], [0, 1, 1]);
  } finally { t.close(); }
});

test('anyone with use records spending; only a manager changes a budget; an entry is voided, never deleted', async () => {
  const t = await setup();
  try {
    const { youth } = await twoGrants(t);
    const personnel = (await t.ok('GET', `/api/funds/${youth.id}`)).lines[0];
    const e = await t.ok('POST', `/api/funds/${youth.id}/entries`, { date: '2026-06-01', amount: '1,250.50', line_id: personnel.id, payee: 'Staffing Co' }, t.reader);
    assert.equal(e.amount, 1250.5);
    assert.equal((await t.call('POST', `/api/funds/${youth.id}/entries`, { date: '2026-07-01', amount: 5 }, t.reader)).status, 400, 'not in the future');
    assert.equal((await t.call('POST', `/api/funds/${youth.id}/entries`, { date: '2026-06-01', amount: 'lots' }, t.reader)).status, 400);
    assert.equal((await t.call('POST', '/api/funds', { name: 'Mine' }, t.reader)).status, 403);
    assert.equal((await t.call('PATCH', `/api/lines/${personnel.id}`, { amount: 1 }, t.reader)).status, 403);
    assert.equal((await t.call('GET', `/api/funds/${youth.id}`, null, t.other)).status, 404, 'another organization sees nothing');
    assert.equal((await t.call('POST', `/api/entries/${e.id}/void`, { reason: 'x' }, t.other)).status, 404);
    assert.equal((await t.call('POST', `/api/entries/${e.id}/void`, {}, t.reader)).status, 400, 'a reason is needed');
    await t.ok('POST', `/api/entries/${e.id}/void`, { reason: 'Wrong grant' }, t.reader, 200);
    const after = await t.ok('GET', `/api/funds/${youth.id}`);
    assert.equal(after.spent, 0);
    assert.equal(after.entries[0].void_reason, 'Wrong grant');
    await t.ok('POST', `/api/lines/${personnel.id}/remove`, null, t.manager, 200);
    assert.deepEqual((await t.ok('GET', `/api/funds/${youth.id}`)).lines.map((l) => l.name), ['Supplies', 'Travel']);
    const csv = await t.call('GET', `/api/export/entries.csv?fund_id=${youth.id}`, null, t.manager);
    assert.match(csv.text, /^date,fund,line,amount,payee/);
    assert.match(csv.text, /Youth Diversion,Personnel,1250\.50,Staffing Co,,,manual,Ray,yes,Wrong grant/);
    const log = (await t.ok('GET', '/api/activity')).activity.map((a) => a.action);
    for (const a of ['fund.add', 'import.budget', 'entry.add', 'entry.void', 'line.remove', 'export.entries']) assert.ok(log.includes(a), a);
  } finally { t.close(); }
});

test('Watson and Rook-E read each grant\'s figures with the service token, never an entry or a payee', async () => {
  const t = await setup();
  try {
    const { youth } = await twoGrants(t);
    await t.ok('POST', '/api/import/spend', { csv: QB }, t.manager, 200);
    assert.equal((await t.call('GET', '/api/service/grants', null, 'wrong', { 'X-TSS-Org': 'org-a' })).status, 401);
    assert.equal((await t.call('GET', '/api/service/grants', null, 'ledger-svc')).status, 400, 'the organization is named');
    const list = await t.service('/api/service/grants?q=meyer');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.grants.map((g) => g.name), ['Youth Diversion']);
    const g = list.body.grants[0];
    assert.equal(g.spent, 6850);
    assert.ok(g.facts.some((f) => f.includes('Spent to date: $6,850')));
    assert.doesNotMatch(JSON.stringify(list.body), /Staffing Co|payroll|Office Depot/);
    const one = await t.service(`/api/service/grants/${youth.id}`);
    assert.equal(one.body.grant.lines.length, 3);
    assert.equal((await t.service(`/api/service/grants/${youth.id}`, { 'X-TSS-Org': 'org-b' })).status, 404);
    const lines = await t.service('/api/service/budget-lines', { 'X-TSS-App': 'rook-e' });
    assert.ok(lines.body.lines.some((l) => l.fund === 'Youth Diversion' && l.line === 'Personnel' && l.budget === 18000 && l.actual === 6000));
    assert.equal(lines.body.period, `Through ${TODAY}`);
    const log = (await t.ok('GET', '/api/activity')).activity;
    assert.ok(log.some((a) => a.action === 'service.grants' && a.detail === 'for watson'));
  } finally { t.close(); }
});

test('Cockpit reads totals, Needs you and the whole record, each with its own credential', async () => {
  const t = await setup();
  try {
    const { youth } = await twoGrants(t);
    await t.ok('POST', '/api/import/spend', { csv: QB }, t.manager, 200);
    await t.ok('POST', `/api/funds/${youth.id}/entries`, { date: '2026-06-02', amount: 13000, line_id: (await t.ok('GET', `/api/funds/${youth.id}`)).lines[0].id });
    const roll = await t.service('/api/cockpit/rollup?from=2026-01-01&to=2026-06-30', { 'X-TSS-App': 'cockpit' });
    assert.equal(roll.status, 200);
    assert.equal(roll.body.metrics.spent.value, 21135.2);
    assert.equal(roll.body.metrics.lines_over.value, 1);
    assert.doesNotMatch(JSON.stringify(roll.body), /Staffing|Youth/);
    const needs = await t.service('/api/cockpit/needs-you');
    assert.deepEqual(needs.body.items.map((i) => i.id), [`over-${youth.id}`, `fast-${youth.id}`]);
    assert.equal((await t.call('GET', '/api/export/org', null, 'ledger-svc', { 'X-TSS-Org': 'org-a' })).status, 401, 'the service token cannot export');
    const exp = await t.call('GET', '/api/export/org', null, 'ledger-export', { 'X-TSS-Org': 'org-a' });
    assert.equal(exp.body.schema, 'tss.org-export/v1');
    assert.equal(exp.body.app, 'ledger');
    assert.equal(exp.body.tables.funds.length, 3);
    assert.equal(exp.body.tables.budget_lines.length, 5);
    assert.equal(exp.body.tables.entries.length, 8);
  } finally { t.close(); }
});

test('Link to Rollodex sends the funder\'s name and keeps the contact', async () => {
  const sent = [];
  const rollodex = {
    rollodexConfigured: () => true, rollodexUrl: () => 'https://rollodex.test',
    linkFunder: async (org, who, name) => { sent.push({ org, who, name }); return { contact_id: 'c-42', created: true }; },
  };
  const t = await setup({ rollodex });
  try {
    const { youth } = await twoGrants(t);
    const r = await t.ok('POST', `/api/funds/${youth.id}/rollodex`, null, t.manager, 200);
    assert.equal(r.rollodex_contact_id, 'c-42');
    assert.deepEqual(sent, [{ org: 'org-a', who: 'Dana', name: 'Meyer Memorial Trust' }]);
    assert.equal((await t.ok('GET', `/api/funds/${youth.id}`)).rollodex_url, 'https://rollodex.test/#/contacts/c-42');
    assert.equal((await t.call('POST', `/api/funds/${youth.id}/rollodex`, null, t.reader)).status, 403);
  } finally { t.close(); }
});

test('amounts as people write them', () => {
  assert.equal(readMoney('$1,250.50'), 1250.5);
  assert.equal(readMoney('(300.00)'), -300);
  assert.equal(readMoney('-$45'), -45);
  assert.equal(readMoney('45-'), -45);
  assert.equal(readMoney('USD 12'), 12);
  assert.equal(readMoney('.5'), 0.5);
  for (const v of ['', 'n/a', '12%', '1.2.3', '$']) assert.equal(readMoney(v), null, v);
});

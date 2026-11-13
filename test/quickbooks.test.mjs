// QuickBooks Online, read only: connect, sealed tokens, sync into Ledger's
import crypto from 'node:crypto';
// own records, refresh, reconnect, disconnect. Intuit is a stand-in
// (test/fixtures/quickbooks.mjs) that records every call, so the tests can
// show Ledger never sends QuickBooks anything but GET.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');
const { fakeIntuit, REALM } = await import('./fixtures/quickbooks.mjs');
const { quickbooksConfig, seal, unseal, checkQuickbooks, SCOPE, profitAndLoss } = await import('../lib/quickbooks.js');
const { _resetLiveChecks } = await import('../lib/live-check.js');

const TODAY = '2026-06-30';
const QB_ENV = { QUICKBOOKS_CLIENT_ID: 'qb-client', QUICKBOOKS_CLIENT_SECRET: 'qb-secret', QUICKBOOKS_ENVIRONMENT: 'sandbox', SESSION_SECRET: 'test-secret', NODE_ENV: 'test' };

async function setup({ env = QB_ENV } = {}) {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('ledger');
  const intuit = fakeIntuit();
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => TODAY, quickbooksEnv: () => env, quickbooksFetch: intuit.fetch });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: (r.headers.get('content-type') || '').includes('json') && text ? JSON.parse(text) : text };
  };
  const signIn = async (claims) => (await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket(claims) })).body.token;
  const manager = await signIn({ permissions: ['use', 'manage'] });
  const reader = await signIn({ sub: 'u-ray', name: 'Ray', permissions: ['use'] });
  const other = await signIn({ sub: 'u-b', name: 'Bea', org: { id: 'org-b', name: 'Org B' }, permissions: ['use', 'manage'] });
  const ok = async (method, p, body, token = manager, expect = 200) => {
    const r = await call(method, p, body, token);
    assert.equal(r.status, expect, `${method} ${p}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  // Connect the way a browser does: ask, carry the cookie to Intuit and back.
  const connect = async (token = manager, code = 'good-code') => {
    const r = await call('POST', '/api/quickbooks/connect', {}, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const url = new URL(r.body.url);
    const cookie = String(r.headers.get('set-cookie') || '').split(';')[0];
    const back = await call('GET', `/api/quickbooks/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}&realmId=${REALM}`, null, null, { cookie });
    return { url, cookie, back, state: url.searchParams.get('state') };
  };
  const settle = async () => { for (let i = 0; i < 50 && (await ok('GET', '/api/quickbooks')).syncing; i++) await new Promise((r) => setTimeout(r, 10)); };
  return { store, intuit, call, ok, manager, reader, other, connect, settle, close: () => server.close() };
}

async function grants(t) {
  const yd = await t.ok('POST', '/api/funds', { name: 'Youth Diversion', code: 'YD', award: 24000, start_on: '2026-01-01', end_on: '2026-12-31' }, t.manager, 201);
  const rc = await t.ok('POST', '/api/funds', { name: 'Reentry Circles', award: 6000, start_on: '2026-04-01', end_on: '2026-09-30' }, t.manager, 201);
  const personnel = await t.ok('POST', `/api/funds/${yd.id}/lines`, { name: 'Personnel', code: '6000', amount: 18000 }, t.manager, 201);
  const supplies = await t.ok('POST', `/api/funds/${yd.id}/lines`, { name: 'Supplies', code: '6400', amount: 3000 }, t.manager, 201);
  const stipends = await t.ok('POST', `/api/funds/${rc.id}/lines`, { name: 'Facilitator stipends', amount: 5000 }, t.manager, 201);
  return { yd, rc, personnel, supplies, stipends };
}

const onlyGets = (intuit) => {
  const api = intuit.calls.filter((c) => /quickbooks\.api\.intuit\.com$/.test(c.host));
  assert.ok(api.length > 0, 'the accounting API was read');
  assert.deepEqual([...new Set(api.map((c) => c.method))], ['GET'], 'nothing but GET reaches the accounting API');
  for (const c of intuit.calls.filter((x) => x.method !== 'GET')) {
    assert.ok(['oauth.platform.intuit.com', 'developer.api.intuit.com'].includes(c.host), `${c.method} ${c.host}${c.path} is OAuth's own`);
  }
  for (const c of api.filter((x) => x.query)) assert.match(c.query, /^SELECT \* FROM \w+( WHERE TxnDate >= '[\d-]+' AND TxnDate <= '[\d-]+')? ORDERBY Id STARTPOSITION \d+ MAXRESULTS \d+$/);
};

test('the connector is off without the Intuit app keys, and says one plain sentence', async () => {
  assert.equal(quickbooksConfig({}).status, 'off');
  assert.equal(quickbooksConfig({ QUICKBOOKS_CLIENT_ID: 'a', QUICKBOOKS_CLIENT_SECRET: 'b', NODE_ENV: 'production' }).status, 'no_key', 'production needs something to seal tokens with');
  assert.equal(quickbooksConfig({ QUICKBOOKS_CLIENT_ID: 'a', QUICKBOOKS_CLIENT_SECRET: 'b', SESSION_SECRET: 's', NODE_ENV: 'production' }).status, 'ready');
  assert.equal(quickbooksConfig(QB_ENV).apiBase, 'https://sandbox-quickbooks.api.intuit.com');
  assert.equal(quickbooksConfig({ ...QB_ENV, QUICKBOOKS_ENVIRONMENT: '' }).apiBase, 'https://quickbooks.api.intuit.com');
  assert.equal(quickbooksConfig({ ...QB_ENV, RENDER_EXTERNAL_URL: 'https://tss-ledger.onrender.com/' }).redirectUri({}), 'https://tss-ledger.onrender.com/api/quickbooks/callback');

  const t = await setup({ env: {} });
  try {
    const v = await t.ok('GET', '/api/quickbooks');
    assert.equal(v.setup, false);
    assert.equal(v.connected, false);
    const r = await t.call('POST', '/api/quickbooks/connect', {}, t.manager);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'Connecting QuickBooks is not set up yet.');
    assert.equal((await t.call('GET', '/api/health')).body.quickbooks, 'off');
    assert.equal((await t.ok('GET', '/api/me')).quickbooks, false);
  } finally { t.close(); }
});

test('tokens are sealed at rest and open only with the same key', () => {
  const key = quickbooksConfig(QB_ENV).key;
  const s = seal('at-secret-token', key);
  assert.ok(!s.includes('at-secret-token'));
  assert.equal(unseal(s, key), 'at-secret-token');
  assert.equal(unseal(s, quickbooksConfig({ ...QB_ENV, QUICKBOOKS_TOKEN_KEY: 'another' }).key), null, 'another key opens nothing');
  assert.equal(unseal(s.slice(0, -2) + 'xx', key), null, 'a changed seal opens nothing');
  assert.notEqual(seal('same', key), seal('same', key), 'a fresh nonce each time');
});

test('only a Ledger manager connects, reads or changes the connection', async () => {
  const t = await setup();
  try {
    for (const [m, p] of [['GET', '/api/quickbooks'], ['POST', '/api/quickbooks/connect'], ['POST', '/api/quickbooks/sync'], ['PATCH', '/api/quickbooks/settings'], ['POST', '/api/quickbooks/disconnect']]) {
      assert.equal((await t.call(m, p, m === 'GET' ? null : {}, t.reader)).status, 403, `${m} ${p}`);
      assert.equal((await t.call(m, p, m === 'GET' ? null : {})).status, 401, `${m} ${p} signed out`);
    }
  } finally { t.close(); }
});

test('connect asks Intuit for the accounting scope alone, and the sign-in is tied to the browser that asked', async () => {
  const t = await setup();
  try {
    await grants(t);
    const r = await t.call('POST', '/api/quickbooks/connect', {}, t.manager);
    const url = new URL(r.body.url);
    assert.equal(url.origin + url.pathname, 'https://appcenter.intuit.com/connect/oauth2');
    assert.equal(url.searchParams.get('scope'), SCOPE);
    assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
    assert.equal(url.searchParams.get('client_id'), 'qb-client');
    assert.match(url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/api\/quickbooks\/callback$/);
    const setCookie = String(r.headers.get('set-cookie'));
    assert.match(setCookie, /ledger_qbo=[^;]+; Max-Age=900; Path=\/api\/quickbooks; Expires=[^;]+; HttpOnly; SameSite=Lax/);
    const state = encodeURIComponent(url.searchParams.get('state'));

    // Someone else's browser (no cookie, or another cookie) cannot finish this sign-in.
    let back = await t.call('GET', `/api/quickbooks/callback?code=good-code&state=${state}&realmId=${REALM}`);
    assert.equal(back.status, 303);
    assert.equal(back.headers.get('location'), '/#/quickbooks?result=expired');
    back = await t.call('GET', `/api/quickbooks/callback?code=good-code&state=${state}&realmId=${REALM}`, null, null, { cookie: 'ledger_qbo=not-the-one' });
    assert.equal(back.headers.get('location'), '/#/quickbooks?result=expired');
    // The state is not a session.
    assert.equal((await t.call('GET', '/api/me', null, url.searchParams.get('state'))).status, 401);
    assert.equal(await t.store.getQuickbooks('org-a'), null, 'nothing saved');

    // A manager who says no at Intuit comes back to a plain answer.
    const cookie = setCookie.split(';')[0];
    back = await t.call('GET', `/api/quickbooks/callback?error=access_denied&state=${state}`, null, null, { cookie });
    assert.equal(back.headers.get('location'), '/#/quickbooks?result=declined');
    assert.equal(t.intuit.calls.length, 0, 'Intuit was never called');
  } finally { t.close(); }
});

test('connected: tokens sealed, spending from QuickBooks lands on the right grant and line, read only', async () => {
  const t = await setup();
  try {
    const g = await grants(t);
    const { back } = await t.connect();
    assert.equal(back.status, 303);
    assert.equal(back.headers.get('location'), '/#/quickbooks?result=connected');
    await t.settle();

    const stored = await t.store.getQuickbooks('org-a');
    assert.equal(stored.realm_id, REALM);
    assert.equal(stored.company_name, 'Reentry Partners Sandbox');
    assert.equal(stored.environment, 'sandbox');
    assert.ok(stored.access_token.startsWith('v1.') && !stored.access_token.includes('at-1'), 'the access token is sealed');
    assert.ok(stored.refresh_token.startsWith('v1.') && !stored.refresh_token.includes('rt-1'), 'the refresh token is sealed');

    const v = await t.ok('GET', '/api/quickbooks');
    assert.equal(v.connected, true);
    assert.equal(v.company_name, 'Reentry Partners Sandbox');
    assert.equal(v.connected_by, 'Dana');
    assert.ok(!JSON.stringify(v).includes('at-1') && !JSON.stringify(v).includes('v1.'), 'no token, sealed or not, leaves Ledger');
    const s = v.last_sync;
    assert.deepEqual([s.added, s.unchanged, s.replaced, s.removed, s.total, s.from, s.to], [6, 0, 0, 0, 5000, '2026-01-01', TODAY]);
    assert.deepEqual(s.no_class, { lines: 1, total: 12 });
    const admin = s.classes.find((c) => c.name === 'Admin');
    assert.deepEqual([admin.fund_id, admin.lines, admin.total], [null, 1, 80], 'a class with no grant is listed for the manager');
    assert.equal(s.classes[0].name, 'Admin', 'unmatched classes first');
    assert.equal(s.classes.find((c) => c.id === '200').fund_name, 'Reentry Circles', 'a sub-class matches by its own name');
    assert.deepEqual(v.snapshot, { from: '2026-01-01', to: TODAY, income: 24000, expenses: 5092, net: 18908 });

    const yd = await t.ok('GET', `/api/funds/${g.yd.id}`);
    assert.equal(yd.spent, 3900, '3,000 payroll + 450 supplies - 50 return + 500 journal entry');
    const line = (f, name) => f.lines.find((l) => l.name === name);
    assert.equal(line(yd, 'Personnel').spent, 3500, 'the check and the journal entry, matched by account number');
    assert.equal(line(yd, 'Supplies').spent, 400, '"6400 Supplies" matches the line coded 6400; a card credit is a refund');
    const ret = yd.entries.find((e) => e.amount === -50);
    assert.deepEqual([ret.source, ret.payee, ret.memo, ret.date], ['quickbooks', 'Office Depot', 'Return', '2026-05-02']);
    const check = yd.entries.find((e) => e.amount === 3000);
    assert.deepEqual([check.reference, check.memo, check.created_by], ['1043', 'February payroll', 'QuickBooks']);
    assert.equal(check.external_ref, `qbo:${REALM}:purchase:501:1`);
    const rc = await t.ok('GET', `/api/funds/${g.rc.id}`);
    assert.equal(rc.spent, 1100, 'a bill less a vendor credit');
    assert.equal(line(rc, 'Facilitator stipends').spent, 1100);
    assert.ok(!(await t.ok('GET', '/api/entries')).entries.some((e) => e.amount === 24000), 'a deposit is not spending');

    onlyGets(t.intuit);
    const activity = (await t.ok('GET', '/api/activity')).activity.map((a) => a.action);
    assert.ok(activity.includes('quickbooks.connect') && activity.includes('quickbooks.sync'));

    // Another organization sees no connection and none of this spending.
    assert.equal((await t.ok('GET', '/api/quickbooks', null, t.other)).connected, false);
    assert.equal((await t.ok('GET', '/api/entries', null, t.other)).entries.length, 0);
  } finally { t.close(); }
});

test('sync again adds nothing; a change in QuickBooks replaces the entry and a deletion voids it, both kept', async () => {
  const t = await setup();
  try {
    const g = await grants(t);
    await t.connect();
    await t.settle();
    let r = (await t.ok('POST', '/api/quickbooks/sync')).result;
    assert.deepEqual([r.added, r.unchanged, r.replaced, r.removed], [0, 6, 0, 0]);

    const p = t.intuit.data.Purchase.find((x) => x.Id === '501');
    p.SyncToken = '1';
    p.Line[0].Amount = 3100;
    t.intuit.data.Bill = [];
    r = (await t.ok('POST', '/api/quickbooks/sync')).result;
    assert.deepEqual([r.added, r.unchanged, r.replaced, r.removed], [1, 4, 1, 1]);
    const all = (await t.ok('GET', '/api/entries')).entries;
    const old = all.find((e) => e.amount === 3000);
    assert.deepEqual([Boolean(old.voided_at), old.void_reason, old.voided_by], [true, 'Updated from QuickBooks', 'QuickBooks']);
    const bill = all.find((e) => e.amount === 1200);
    assert.deepEqual([Boolean(bill.voided_at), bill.void_reason], [true, 'Removed in QuickBooks']);
    assert.equal((await t.ok('GET', `/api/funds/${g.yd.id}`)).spent, 4000);
    assert.equal((await t.ok('GET', `/api/funds/${g.rc.id}`)).spent, -100);

    // An entry a person voids stays voided.
    const credit = all.find((e) => e.amount === -100);
    await t.ok('POST', `/api/entries/${credit.id}/void`, { reason: 'Counted elsewhere' });
    r = (await t.ok('POST', '/api/quickbooks/sync')).result;
    assert.deepEqual([r.added, r.replaced, r.removed], [0, 0, 0]);
    assert.equal((await t.ok('GET', `/api/funds/${g.rc.id}`)).spent, 0);
  } finally { t.close(); }
});

test('spending already imported from a QuickBooks spreadsheet is not counted twice', async () => {
  const t = await setup();
  try {
    const g = await grants(t);
    const csv = 'Date,Num,Name,Memo/Description,Account,Class,Amount\n02/14/2026,1043,Staffing Co,February payroll,6000 Personnel,YD,"3,000.00"\n';
    const imported = await t.ok('POST', '/api/import/spend', { csv, mapping: { date: 0, reference: 1, payee: 2, memo: 3, line: 4, fund: 5, amount: 6 } });
    assert.equal(imported.added, 1);
    await t.connect();
    await t.settle();
    const s = (await t.ok('GET', '/api/quickbooks')).last_sync;
    assert.deepEqual([s.added, s.from_sheet], [5, 1]);
    assert.equal((await t.ok('GET', `/api/funds/${g.yd.id}`)).spent, 3900);
  } finally { t.close(); }
});

test('an expired access token is refreshed and the new refresh token kept; a refused one asks to connect again', async () => {
  const t = await setup();
  try {
    await grants(t);
    await t.connect();
    await t.settle();
    await t.store.saveQuickbooks('org-a', { access_expires_at: new Date(Date.now() - 1000).toISOString() });
    await t.ok('POST', '/api/quickbooks/sync');
    const key = quickbooksConfig(QB_ENV).key;
    const c = await t.store.getQuickbooks('org-a');
    assert.equal(unseal(c.refresh_token, key), 'rt-2', 'Intuit hands out a new refresh token each time; Ledger keeps it');
    assert.equal(unseal(c.access_token, key), 'at-2');

    // QuickBooks rejects the access token mid-sync: one refresh, then carry on.
    t.intuit.access = 'revoked-elsewhere';
    t.intuit.refresh = 'rt-2';
    await t.ok('POST', '/api/quickbooks/sync');
    assert.equal(unseal((await t.store.getQuickbooks('org-a')).refresh_token, key), 'rt-3');

    t.intuit.failRefresh = 'invalid_grant';
    t.intuit.access = 'gone';
    const r = await t.call('POST', '/api/quickbooks/sync', {}, t.manager);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'QuickBooks asks to be connected again.');
    const after = await t.store.getQuickbooks('org-a');
    assert.deepEqual([after.status, after.access_token, after.refresh_token], ['reconnect', '', ''], 'dead tokens are dropped');
    const v = await t.ok('GET', '/api/quickbooks');
    assert.deepEqual([v.connected, v.reconnect], [false, true]);
    assert.equal((await t.ok('GET', '/api/entries')).entries.filter((e) => !e.voided_at).length, 6, 'spending already brought in stays');

    // Connecting again to the same company keeps the settings and the record.
    t.intuit.failRefresh = null;
    t.intuit.codes.add('second-code');
    await t.connect(t.manager, 'second-code');
    await t.settle();
    assert.equal((await t.ok('GET', '/api/quickbooks')).connected, true);
    assert.equal((await t.ok('GET', '/api/quickbooks')).last_sync.unchanged, 6);
  } finally { t.close(); }
});

test('budgets come from QuickBooks only when a manager turns it on', async () => {
  const t = await setup();
  try {
    const g = await grants(t);
    await t.connect();
    await t.settle();
    assert.equal((await t.ok('GET', '/api/quickbooks')).last_sync.budgets, null);
    assert.ok(!t.intuit.calls.some((c) => /FROM Budget/.test(c.query)), 'not even read until asked');
    const v = await t.ok('PATCH', '/api/quickbooks/settings', { budgets: true });
    assert.equal(v.settings.budgets, true);
    const r = (await t.ok('POST', '/api/quickbooks/sync')).result;
    assert.deepEqual(r.budgets, { added: 1, updated: 1 }, 'Supplies 3,000 to 2,000; Facilitator stipends added; Personnel already 18,000; income and old budgets left out');
    const yd = await t.ok('GET', `/api/funds/${g.yd.id}`);
    assert.deepEqual(yd.lines.filter((l) => l.id).map((l) => [l.name, l.budget]), [['Personnel', 18000], ['Supplies', 2000], ['Facilitator stipends', 1500]]);
    assert.equal((await t.ok('GET', `/api/funds/${g.rc.id}`)).lines.find((l) => l.name === 'Facilitator stipends').budget, 5000, 'another grant\'s budget is untouched');
    onlyGets(t.intuit);
  } finally { t.close(); }
});

test('disconnect revokes at Intuit, deletes the tokens, and keeps the spending', async () => {
  const t = await setup();
  try {
    await grants(t);
    await t.connect();
    await t.settle();
    const v = await t.ok('POST', '/api/quickbooks/disconnect');
    assert.equal(v.connected, false);
    assert.deepEqual(t.intuit.revoked, ['rt-1']);
    assert.equal(await t.store.getQuickbooks('org-a'), null);
    assert.equal((await t.ok('GET', '/api/entries')).entries.filter((e) => !e.voided_at).length, 6);
    assert.equal((await t.call('POST', '/api/quickbooks/sync', {}, t.manager)).status, 409);
    assert.ok((await t.ok('GET', '/api/activity')).activity.some((a) => a.action === 'quickbooks.disconnect'));
    onlyGets(t.intuit);
  } finally { t.close(); }
});

test('the schedule reads every connected company once it is six hours old', async () => {
  const store = new MemoryStore();
  const intuit = fakeIntuit();
  const app = createApp({ store, verifyTicket: fakeCockpit('ledger').verifyTicket, clock: () => TODAY, quickbooksEnv: () => QB_ENV, quickbooksFetch: intuit.fetch });
  const key = quickbooksConfig(QB_ENV).key;
  intuit.access = 'at-x'; intuit.refresh = 'rt-x';
  await store.createFund('org-a', { id: crypto.randomUUID(), name: 'Youth Diversion', code: 'YD', start_on: '2026-01-01' });
  await store.saveQuickbooks('org-a', { realm_id: REALM, environment: 'sandbox', access_token: seal('at-x', key), refresh_token: seal('rt-x', key), access_expires_at: new Date(Date.now() + 3600e3).toISOString() });
  assert.deepEqual(await app.locals.quickbooks.syncDue(), ['org-a']);
  assert.equal((await store.getQuickbooks('org-a')).last_sync.added, 4);
  assert.deepEqual(await app.locals.quickbooks.syncDue(), [], 'not again until six hours pass');
  assert.deepEqual(await app.locals.quickbooks.syncDue(Date.now() + 7 * 3600e3), ['org-a']);
});

test('the live check asks Intuit about the app keys without touching a company', async () => {
  _resetLiveChecks();
  const intuit = fakeIntuit();
  assert.equal(await checkQuickbooks({ env: {}, fetchImpl: intuit.fetch }), 'off');
  assert.equal(await checkQuickbooks({ env: QB_ENV, fetchImpl: intuit.fetch }), 'ok', 'invalid_grant: Intuit took the keys');
  _resetLiveChecks();
  assert.equal(await checkQuickbooks({ env: { ...QB_ENV, QUICKBOOKS_CLIENT_SECRET: 'wrong' }, fetchImpl: intuit.fetch }), 'rejected');
  assert.ok(intuit.calls.every((c) => c.host === 'oauth.platform.intuit.com'));
  _resetLiveChecks();
});

test('profit and loss totals read from the report', () => {
  assert.deepEqual(profitAndLoss({ Rows: { Row: [{ group: 'Income', Summary: { ColData: [{ value: 'Total' }, { value: '1,000.50' }] } }, { group: 'Expenses', Summary: { ColData: [{}, { value: '400' }] } }, { group: 'OtherExpenses', Summary: { ColData: [{}, { value: '100' }] } }] } }),
    { income: 1000.5, expenses: 500, net: 500.5 });
  assert.deepEqual(profitAndLoss({}), { income: 0, expenses: 0, net: 0 });
});

test('a failed QuickBooks call keeps Intuit\'s transaction id for support', async () => {
  const { qboClient, QuickbooksError } = await import('../lib/quickbooks.js');
  const fetchImpl = async () => new Response(JSON.stringify({ Fault: {} }), { status: 403, headers: { 'content-type': 'application/json', intuit_tid: '1-abc-123' } });
  const client = qboClient({ apiBase: 'https://qb.example', realmId: '9', accessToken: async () => 't', fetchImpl });
  const err = await client.all('Account').catch((e) => e);
  assert.ok(err instanceof QuickbooksError);
  assert.equal(err.code, 'denied');
  assert.equal(err.intuit_tid, '1-abc-123');
});

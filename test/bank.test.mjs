// Bank accounts through Stripe Financial Connections, read only: a session
// for Stripe's window, saving what was linked, balances, transactions,
// unlinking, and the live key check. Stripe is a stand-in that records
// every call, so the tests show Ledger never asks for anything that moves
// money and never hands out a full account number.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');
const { bankConfig, checkBank, accountOf } = await import('../lib/bank.js');
const { remembered, _resetLiveChecks } = await import('../lib/live-check.js');

const TODAY = '2026-06-30';
const ENV = { STRIPE_SECRET_KEY: 'rk_test_ledger', STRIPE_PUBLISHABLE_KEY: 'pk_test_ledger' };

function fakeStripe() {
  const calls = [];
  const sessions = new Map();
  let n = 0;
  const account = (id) => ({
    id, object: 'financial_connections.account', institution_name: 'Columbia Bank', display_name: 'Operating', last4: '6789',
    category: 'cash', subcategory: 'checking', status: 'active',
    balance: { as_of: 1_782_000_000, current: { usd: 1_234_567 }, cash: { available: { usd: 1_200_000 } } },
    account_number: '000123456789',
  });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, '');
    const body = new URLSearchParams(init.method === 'GET' ? u.search : String(init.body || ''));
    calls.push({ method: init.method, path, body, headers: init.headers });
    const json = (status, j) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
    if (init.headers.authorization !== 'Bearer rk_test_ledger') return json(401, { error: { type: 'invalid_request_error' } });
    if (path === '/balance') return json(200, {});
    if (path === '/customers') return json(200, { id: `cus_${++n}` });
    if (init.method === 'POST' && path === '/financial_connections/sessions') {
      const id = `fcsess_test${++n}abc`;
      sessions.set(id, { id, client_secret: `${id}_secret_x`, account_holder: { type: 'customer', customer: body.get('account_holder[customer]') }, accounts: { data: [account('fca_one')] } });
      return json(200, sessions.get(id));
    }
    const sess = path.match(/^\/financial_connections\/sessions\/(.+)$/);
    if (sess) return sessions.has(sess[1]) ? json(200, sessions.get(sess[1])) : json(404, { error: { type: 'invalid_request_error' } });
    if (/\/(subscribe|refresh|disconnect)$/.test(path)) return json(200, { id: path.split('/')[3] });
    if (/^\/financial_connections\/accounts\/fca_one$/.test(path)) {
      const a = account('fca_one');
      a.balance.current.usd = 1_300_000;
      return json(200, a);
    }
    if (path === '/financial_connections/transactions') {
      return json(200, { data: [{ id: 'fctxn_1', account: body.get('account'), amount: -12550, currency: 'usd', description: 'PGE UTILITY', status: 'posted', transacted_at: 1_782_000_000 }] });
    }
    return json(404, { error: { type: 'invalid_request_error' } });
  };
  return { calls, sessions, fetchImpl };
}

async function setup({ env = ENV } = {}) {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('ledger');
  const stripe = fakeStripe();
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => TODAY, bankEnv: () => env, bankFetch: stripe.fetchImpl });
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
  const ok = async (method, p, body, token = manager, expect = 200) => {
    const r = await call(method, p, body, token);
    assert.equal(r.status, expect, `${method} ${p}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { store, stripe, call, ok, manager, reader, other, close: () => server.close() };
}

async function link(t, token = t.manager) {
  const { client_secret } = await t.ok('POST', '/api/bank/session', {}, token);
  const sessionId = client_secret.split('_secret_')[0];
  return t.ok('POST', '/api/bank/complete', { session_id: sessionId }, token);
}

test('the keys: both needed, and from the same mode', () => {
  assert.equal(bankConfig({}).status, 'off');
  assert.equal(bankConfig({ STRIPE_SECRET_KEY: 'rk_test_x' }).status, 'no_key');
  assert.equal(bankConfig({ STRIPE_SECRET_KEY: 'rk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' }).status, 'no_key');
  assert.equal(bankConfig({ STRIPE_SECRET_KEY: '"sk_live_x"', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' }).mode, 'live');
});

test('a manager links a bank account: read only, the organization\'s own customer, no full account number', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('GET', '/api/bank', null, t.reader)).status, 403, 'managers only');
    const before = await t.ok('GET', '/api/bank');
    assert.deepEqual([before.setup, before.test, before.publishable_key, before.accounts], [true, true, 'pk_test_ledger', []]);
    const done = await link(t);
    assert.equal(done.linked, 1);
    const session = t.stripe.calls.find((c) => c.path === '/financial_connections/sessions');
    assert.deepEqual(session.body.getAll('permissions[0]').concat(session.body.getAll('permissions[1]')), ['balances', 'transactions']);
    assert.ok(![...session.body.keys()].some((k) => /payment/.test(session.body.get(k)) || /payment/.test(k)), 'never asks for payments');
    assert.equal(session.body.get('account_holder[type]'), 'customer');
    assert.equal(session.headers['stripe-version'], '2026-10-28.endive');
    assert.ok(t.stripe.calls.some((c) => c.path === '/financial_connections/accounts/fca_one/subscribe' && c.body.get('features[0]') === 'transactions'));
    const page = await t.ok('GET', '/api/bank');
    assert.equal(page.accounts.length, 1);
    const a = page.accounts[0];
    assert.deepEqual([a.institution, a.name, a.last4, a.balance.current, a.balance.available], ['Columbia Bank', 'Operating', '6789', 12345.67, 12000]);
    assert.doesNotMatch(JSON.stringify(await t.store.getBank('org-a')), /000123456789/, 'the full number is never kept');
    assert.ok((await t.store.activity('org-a')).some((l) => l.action === 'bank.link'));
    // Linking the same account again keeps one.
    await link(t);
    assert.equal((await t.ok('GET', '/api/bank')).accounts.length, 1);
  } finally { t.close(); }
});

test('another organization cannot finish this organization\'s link or read its accounts', async () => {
  const t = await setup();
  try {
    const { client_secret } = await t.ok('POST', '/api/bank/session');
    await t.ok('POST', '/api/bank/session', {}, t.other);
    const theirs = await t.call('POST', '/api/bank/complete', { session_id: client_secret.split('_secret_')[0] }, t.other);
    assert.equal(theirs.status, 404);
    assert.equal((await t.call('POST', '/api/bank/complete', { session_id: 'nope' }, t.manager)).status, 400);
    await link(t);
    assert.equal((await t.call('GET', '/api/bank/accounts/fca_one/transactions', null, t.other)).status, 404);
    assert.deepEqual((await t.ok('GET', '/api/bank', null, t.other)).accounts, []);
  } finally { t.close(); }
});

test('balance refresh, transactions in local days and dollars, and unlink keeps the record', async () => {
  const t = await setup();
  try {
    await link(t);
    const fresh = await t.ok('POST', '/api/bank/accounts/fca_one/refresh');
    assert.equal(fresh.balance.current, 13000);
    const { transactions } = await t.ok('GET', '/api/bank/accounts/fca_one/transactions');
    assert.deepEqual(transactions[0], { id: 'fctxn_1', date: '2026-06-20', description: 'PGE UTILITY', amount: -125.5, status: 'posted' });
    await t.ok('POST', '/api/bank/accounts/fca_one/unlink');
    assert.deepEqual((await t.ok('GET', '/api/bank')).accounts, []);
    const kept = (await t.store.getBank('org-a')).accounts[0];
    assert.equal(kept.status, 'disconnected');
    assert.ok(kept.removed_at, 'unlinked, not deleted');
    assert.equal((await t.call('POST', '/api/bank/accounts/fca_one/refresh', null, t.manager)).status, 404);
  } finally { t.close(); }
});

test('without keys the page says so, and nothing calls Stripe', async () => {
  const t = await setup({ env: {} });
  try {
    assert.deepEqual(await t.ok('GET', '/api/bank'), { setup: false, accounts: [] });
    assert.equal((await t.call('POST', '/api/bank/session', null, t.manager)).status, 503);
    assert.equal(t.stripe.calls.length, 0);
  } finally { t.close(); }
});

test('live check: ok, rejected, off', async () => {
  _resetLiveChecks();
  const s = fakeStripe();
  assert.equal(await checkBank({ env: ENV, fetchImpl: s.fetchImpl, remembered }), 'ok');
  _resetLiveChecks();
  assert.equal(await checkBank({ env: { ...ENV, STRIPE_SECRET_KEY: 'rk_test_wrong' }, fetchImpl: s.fetchImpl, remembered }), 'rejected');
  assert.equal(await checkBank({ env: {}, remembered }), 'off');
  _resetLiveChecks();
});

test('what Ledger keeps of an account', () => {
  const a = accountOf({ id: 'fca_x', last4: '12-34', institution_name: 'B', balance: null, account_number: '999' }, 'Kim');
  assert.equal(a.last4, '1234');
  assert.equal(a.balance, null);
  assert.equal(a.linked_by, 'Kim');
  assert.equal(JSON.stringify(a).includes('999'), false);
});

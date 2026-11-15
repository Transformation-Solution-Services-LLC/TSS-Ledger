// Bank accounts, read only, through Stripe Financial Connections.
//
// A Ledger manager links the organization's bank account on Stripe's own
// window (Stripe.js): Ledger never sees the bank sign-in or a full account
// number. Ledger then reads, from Stripe, the account's name, last four
// digits, balance and recent transactions, and shows them next to grant
// spending. Nothing moves money: the permissions asked are balances and
// transactions, never payments.
//
// Keys on tss-ledger: STRIPE_SECRET_KEY (the TSS Stripe account, a
// restricted key preferred) and STRIPE_PUBLISHABLE_KEY (pk_, for the
// window). Without both, the Bank page says it is not set up.
//
// Transactions are read from Stripe when a manager opens the page and are
// not stored or sent to any other app. Unlinking keeps the account on the
// record, marked removed.
//
//   GET  /api/bank                          the linked accounts
//   POST /api/bank/session                  a Financial Connections session for Stripe's window
//   POST /api/bank/complete                 { session_id } saves what was linked
//   POST /api/bank/accounts/:id/refresh     a fresh balance
//   GET  /api/bank/accounts/:id/transactions  the latest transactions
//   POST /api/bank/accounts/:id/unlink      stops Ledger reading it

import { PublicError, logSafeError } from './public-error.js';
import { localDay } from './finance.js';

const API = 'https://api.stripe.com/v1';
const VERSION = '2026-10-28.endive';
const TIMEOUT_MS = 20000;
const clean = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
const SECRET = /^(sk|rk)_(test|live)_/;
const PUBLISHABLE = /^pk_(test|live)_/;

export function bankConfig(env = process.env) {
  const secret = clean(env.STRIPE_SECRET_KEY);
  const publishable = clean(env.STRIPE_PUBLISHABLE_KEY);
  if (!SECRET.test(secret)) return { status: 'off' };
  if (!PUBLISHABLE.test(publishable)) return { status: 'no_key' };
  const mode = /_test_/.test(secret) ? 'test' : 'live';
  // A test secret with a live publishable key (or the other way) never works.
  if (!publishable.includes(`_${mode}_`)) return { status: 'no_key' };
  return { status: 'ready', secret, publishable, mode };
}

export class StripeError extends Error {
  constructor(status, code) { super(`stripe ${status}${code ? ` ${code}` : ''}`); this.status = status; this.code = code || ''; }
}

export function encode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x !== null && typeof x === 'object' ? encode(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

export function stripeClient(secret, fetchImpl = (...a) => globalThis.fetch(...a)) {
  return async function call(method, path, { body, idem } = {}) {
    const headers = { authorization: `Bearer ${secret}`, 'stripe-version': VERSION };
    if (idem) headers['idempotency-key'] = idem;
    let url = `${API}${path}`;
    let payload;
    if (method === 'GET' && body) url += `?${encode(body)}`;
    else if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = encode(body); }
    let r;
    try { r = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' }); } catch (_) { throw new StripeError(0, 'unreachable'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new StripeError(r.status, j?.error?.code || j?.error?.type || '');
    return j;
  };
}

// One cheap call for /api/health/live: the account's balance.
export function checkBank({ env = process.env, fetchImpl, remembered } = {}) {
  const cfg = bankConfig(env);
  if (cfg.status === 'off') return Promise.resolve('off');
  if (cfg.status === 'no_key') return Promise.resolve('no_key');
  return remembered('stripe', async () => {
    try { await stripeClient(cfg.secret, fetchImpl)('GET', '/balance'); return 'ok'; } catch (e) {
      if (e.status === 0) return 'unreachable';
      if (e.status === 401) return 'rejected';
      if (e.status === 403) return 'denied';
      if (e.status === 429) return 'rate_limited';
      return 'failed';
    }
  });
}

const dollars = (cents) => (typeof cents === 'number' ? Math.round(cents) / 100 : null);
const at = (secs) => (typeof secs === 'number' && secs > 0 ? new Date(secs * 1000).toISOString() : null);

// What Ledger keeps of a Stripe account: never a full account number.
export function accountOf(a, who = '') {
  const bal = a.balance || null;
  const cur = (m) => (m && typeof m === 'object' ? m.usd ?? Object.values(m)[0] : undefined);
  return {
    id: String(a.id),
    institution: String(a.institution_name || '').slice(0, 120),
    name: String(a.display_name || '').slice(0, 120),
    last4: String(a.last4 || '').replace(/\D/g, '').slice(-4),
    category: String(a.category || ''),
    subcategory: String(a.subcategory || ''),
    status: String(a.status || ''),
    balance: bal ? { as_of: at(bal.as_of), current: dollars(cur(bal.current)), available: dollars(cur(bal.cash?.available)) } : null,
    linked_by: who,
  };
}

export function bankRoutes(app, { store, wrap, requireManager, audit, env = () => process.env, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const config = () => bankConfig(env());
  const off = () => new PublicError(503, 'bank_off', 'Linking a bank account is not set up yet.');
  const failed = (e, what) => {
    if (e instanceof PublicError) return e;
    console.warn('stripe call failed', { code: e?.code || '', status: e?.status || 0, what });
    return new PublicError(502, 'stripe_unreachable', 'Stripe did not answer. Try again in a minute.');
  };
  const ready = () => { const c = config(); if (c.status !== 'ready') throw off(); return c; };
  const call = (c) => stripeClient(c.secret, fetchImpl);

  // The organization's record, starting fresh when the key moved between test and live.
  async function record(org, c) {
    const b = await store.getBank(org);
    if (b && b.mode && b.mode !== c.mode) return { customer_id: null, mode: c.mode, accounts: [] };
    return b || { customer_id: null, mode: c.mode, accounts: [] };
  }

  const view = (a) => ({ id: a.id, institution: a.institution, name: a.name, last4: a.last4, category: a.category, subcategory: a.subcategory, status: a.status, balance: a.balance, linked_at: a.linked_at, linked_by: a.linked_by });

  app.get('/api/bank', requireManager, wrap(async (req, res) => {
    const c = config();
    if (c.status !== 'ready') return res.json({ setup: false, accounts: [] });
    const b = await record(req.user.org_id, c);
    res.json({ setup: true, test: c.mode === 'test', publishable_key: c.publishable, accounts: (b.accounts || []).filter((a) => !a.removed_at).map(view) });
  }));

  app.post('/api/bank/session', requireManager, wrap(async (req, res) => {
    const c = ready();
    const org = req.user.org_id;
    try {
      let b = await record(org, c);
      if (!b.customer_id) {
        const cus = await call(c)('POST', '/customers', { body: { name: `Ledger: ${req.user.org_name || org}`.slice(0, 200), metadata: { org_id: org, app: 'ledger' } }, idem: `ledger-customer-${org}-${c.mode}` });
        b = await store.saveBank(org, { customer_id: cus.id, mode: c.mode, accounts: b.accounts || [] });
      }
      const s = await call(c)('POST', '/financial_connections/sessions', {
        body: {
          account_holder: { type: 'customer', customer: b.customer_id },
          permissions: ['balances', 'transactions'],
          filters: { countries: ['US'] },
          prefetch: ['balances'],
        },
      });
      res.json({ client_secret: s.client_secret });
    } catch (e) { throw failed(e, 'session'); }
  }));

  app.post('/api/bank/complete', requireManager, wrap(async (req, res) => {
    const c = ready();
    const org = req.user.org_id;
    const id = String(req.body?.session_id || '');
    if (!/^fcsess_[A-Za-z0-9]{6,120}$/.test(id)) throw new PublicError(400, 'bad_session', 'That link did not finish.');
    try {
      const b = await record(org, c);
      const s = await call(c)('GET', `/financial_connections/sessions/${encodeURIComponent(id)}`);
      // Only a session made for this organization's own customer.
      if (!b.customer_id || s.account_holder?.customer !== b.customer_id) throw new PublicError(404, 'not_found', 'No such link');
      const linked = (s.accounts?.data || []).map((a) => accountOf(a, req.user.name));
      const accounts = [...(b.accounts || [])];
      for (const a of linked) {
        // Transactions every day from now on; ask once, a second time is harmless.
        await call(c)('POST', `/financial_connections/accounts/${encodeURIComponent(a.id)}/subscribe`, { body: { features: ['transactions'] } }).catch((e) => logSafeError(console, e, 'bank_subscribe_failed'));
        const i = accounts.findIndex((x) => x.id === a.id);
        const kept = { ...a, linked_at: new Date().toISOString(), removed_at: null };
        if (i >= 0) accounts[i] = { ...accounts[i], ...kept }; else accounts.push(kept);
      }
      await store.saveBank(org, { accounts, mode: c.mode });
      for (const a of linked) audit(req, 'bank.link', `${a.institution} ${a.last4}`.trim());
      res.json({ linked: linked.length, accounts: accounts.filter((a) => !a.removed_at).map(view) });
    } catch (e) { throw failed(e, 'complete'); }
  }));

  async function owned(req, c) {
    const b = await record(req.user.org_id, c);
    const a = (b.accounts || []).find((x) => x.id === req.params.id && !x.removed_at);
    if (!a) throw new PublicError(404, 'not_found', 'No such account');
    return { b, a };
  }

  app.post('/api/bank/accounts/:id/refresh', requireManager, wrap(async (req, res) => {
    const c = ready();
    const { b, a } = await owned(req, c);
    try {
      await call(c)('POST', `/financial_connections/accounts/${encodeURIComponent(a.id)}/refresh`, { body: { features: ['balance'] } });
      const fresh = accountOf(await call(c)('GET', `/financial_connections/accounts/${encodeURIComponent(a.id)}`), a.linked_by);
      const accounts = b.accounts.map((x) => (x.id === a.id ? { ...x, ...fresh, linked_at: x.linked_at, linked_by: x.linked_by } : x));
      await store.saveBank(req.user.org_id, { accounts });
      res.json(view(accounts.find((x) => x.id === a.id)));
    } catch (e) { throw failed(e, 'refresh'); }
  }));

  app.get('/api/bank/accounts/:id/transactions', requireManager, wrap(async (req, res) => {
    const c = ready();
    const { a } = await owned(req, c);
    try {
      const list = await call(c)('GET', '/financial_connections/transactions', { body: { account: a.id, limit: 100 } });
      res.json({
        transactions: (list.data || []).map((t) => ({
          id: String(t.id),
          date: t.transacted_at ? localDay(new Date(t.transacted_at * 1000)) : null,
          description: String(t.description || '').slice(0, 200),
          amount: dollars(t.amount),
          status: String(t.status || ''),
        })),
      });
    } catch (e) { throw failed(e, 'transactions'); }
  }));

  app.post('/api/bank/accounts/:id/unlink', requireManager, wrap(async (req, res) => {
    const c = ready();
    const { b, a } = await owned(req, c);
    try {
      await call(c)('POST', `/financial_connections/accounts/${encodeURIComponent(a.id)}/disconnect`);
    } catch (e) {
      // Already disconnected at Stripe or the bank: still stop reading it here.
      if (e?.status !== 400 && e?.status !== 404) throw failed(e, 'unlink');
    }
    const accounts = b.accounts.map((x) => (x.id === a.id ? { ...x, removed_at: new Date().toISOString(), status: 'disconnected' } : x));
    await store.saveBank(req.user.org_id, { accounts });
    audit(req, 'bank.unlink', `${a.institution} ${a.last4}`.trim());
    res.json({ ok: true });
  }));
}

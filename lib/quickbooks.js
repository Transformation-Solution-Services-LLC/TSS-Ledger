// QuickBooks Online, read only.
//
// A Ledger manager connects the organization's QuickBooks company once
// (Intuit's OAuth 2.0). Ledger then reads, and only reads, what it needs to
// keep each grant's spending current: classes, accounts, expenses, checks,
// bills, vendor credits, journal entries, budgets and the profit and loss
// report (lib/quickbooks-sync.js).
//
// Read only, by construction: Intuit has one accounting scope
// (com.intuit.quickbooks.accounting) and no read-only one, so the promise is
// kept here. The client below can only send GET to the accounting API; it has
// no other method. The only POSTs Ledger ever sends Intuit are OAuth's own:
// trading the sign-in code for tokens, refreshing them, and revoking them on
// disconnect. test/quickbooks.test.mjs checks every call.
//
// Settings (tss-ledger on Render):
//   QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET   Intuit developer app keys.
//                                                    Blank: the connector is off.
//   QUICKBOOKS_ENVIRONMENT    production (default) or sandbox.
//   QUICKBOOKS_REDIRECT_URI   Optional. Default <RENDER_EXTERNAL_URL>/api/quickbooks/callback.
//   QUICKBOOKS_TOKEN_KEY      Optional. Seals the tokens at rest; SESSION_SECRET
//                             when blank. One of the two must be set in production.
//
// Tokens are sealed with AES-256-GCM before they reach the store and opened
// only to make a call. They never appear in a response, a log or an export.

import crypto from 'node:crypto';
import { remembered } from './live-check.js';

export const SCOPE = 'com.intuit.quickbooks.accounting';
export const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const API_BASE = { production: 'https://quickbooks.api.intuit.com', sandbox: 'https://sandbox-quickbooks.api.intuit.com' };
export const MINOR_VERSION = '75';
export const PAGE = 1000;
const TIMEOUT_MS = 30000;

const clean = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();

// What is set up: off (no app keys), no_key (nothing to seal tokens with), ready.
export function quickbooksConfig(env = process.env) {
  const clientId = clean(env.QUICKBOOKS_CLIENT_ID);
  const clientSecret = clean(env.QUICKBOOKS_CLIENT_SECRET);
  const environment = clean(env.QUICKBOOKS_ENVIRONMENT).toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  const secret = clean(env.QUICKBOOKS_TOKEN_KEY) || clean(env.SESSION_SECRET) || (env.NODE_ENV === 'production' ? '' : devSecret());
  const status = !clientId || !clientSecret ? 'off' : !secret ? 'no_key' : 'ready';
  const external = clean(env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
  const fixed = clean(env.QUICKBOOKS_REDIRECT_URI) || (external ? `${external}/api/quickbooks/callback` : '');
  return {
    status, clientId, clientSecret, environment, apiBase: API_BASE[environment],
    key: secret ? crypto.hkdfSync('sha256', secret, 'tss-ledger', 'quickbooks-tokens', 32) : null,
    // Intuit sends the person back here; it must be listed on the Intuit app exactly.
    redirectUri: (req) => fixed || `${req.protocol}://${req.get('host')}/api/quickbooks/callback`,
  };
}

let _dev = null;
function devSecret() { if (!_dev) _dev = crypto.randomBytes(32).toString('hex'); return _dev; }

// ---- sealing tokens at rest ----

export function seal(text, key) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

// null when the text was sealed with another key or changed.
export function unseal(sealed, key) {
  const [v, iv, tag, body] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !body) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

// ---- OAuth ----

export function authorizeUrl(cfg, { state, redirectUri }) {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri, state }).toString();
  return u.toString();
}

export class QuickbooksError extends Error {
  constructor(code, status = 0) { super(`QuickBooks: ${code}`); this.code = code; this.status = status; }
}

const basic = (cfg) => `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;

async function tokenCall(cfg, form, fetchImpl) {
  let r;
  try {
    r = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { authorization: basic(cfg), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (_) { throw new QuickbooksError('unreachable'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = String(j?.error || '');
    throw new QuickbooksError(err === 'invalid_grant' ? 'invalid_grant' : err === 'invalid_client' || r.status === 401 ? 'invalid_client' : 'token_failed', r.status);
  }
  if (!j.access_token || !j.refresh_token) throw new QuickbooksError('token_failed', r.status);
  const now = Date.now();
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    access_expires_at: new Date(now + (Number(j.expires_in) || 3600) * 1000).toISOString(),
    refresh_expires_at: new Date(now + (Number(j.x_refresh_token_expires_in) || 100 * 86400) * 1000).toISOString(),
  };
}

export const exchangeCode = (cfg, { code, redirectUri }, fetchImpl = globalThis.fetch) =>
  tokenCall(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetchImpl);

// Intuit hands back a new refresh token each time; the old one stops working, so save both.
export const refreshTokens = (cfg, refreshToken, fetchImpl = globalThis.fetch) =>
  tokenCall(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);

// Best effort: the tokens are deleted from Ledger whatever Intuit answers.
export async function revokeToken(cfg, token, fetchImpl = globalThis.fetch) {
  if (!token) return false;
  try {
    const r = await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { authorization: basic(cfg), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    await r.text().catch(() => '');
    return r.ok;
  } catch (_) { return false; }
}

// The app keys asked about for real: Intuit's token endpoint given a refresh
// token that cannot exist. invalid_grant means it took the keys; invalid_client
// means it refused them. Nothing is created and no company is touched.
export function checkQuickbooks({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = quickbooksConfig(env);
  if (cfg.status === 'off') return Promise.resolve('off');
  if (cfg.status === 'no_key') return Promise.resolve('no_key');
  return remembered('quickbooks', async () => {
    try {
      await refreshTokens(cfg, 'tss-live-check-not-a-token', fetchImpl);
      return 'ok';
    } catch (e) {
      if (e.code === 'invalid_grant') return 'ok';
      if (e.code === 'invalid_client') return 'rejected';
      if (e.code === 'unreachable') return 'unreachable';
      return 'failed';
    }
  });
}

// ---- the accounting API: GET and nothing else ----

const quote = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
export const qboDate = (d) => quote(d);

// accessToken() answers the current access token; renew() gets a new one
// after a 401 (once per call).
export function qboClient({ apiBase, realmId, accessToken, renew, fetchImpl = globalThis.fetch }) {
  const base = `${apiBase}/v3/company/${encodeURIComponent(realmId)}`;

  async function get(path, params = {}, { retried = false, waited = 0 } = {}) {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: MINOR_VERSION })) u.searchParams.set(k, v);
    let r;
    try {
      r = await fetchImpl(u.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (_) { throw new QuickbooksError('unreachable'); }
    if (r.status === 401 && !retried && renew) { await r.text().catch(() => ''); await renew(); return get(path, params, { retried: true, waited }); }
    if (r.status === 429 && waited < 2) {
      await r.text().catch(() => '');
      await new Promise((res) => setTimeout(res, Math.min(10, Number(r.headers.get('retry-after')) || 2) * 1000));
      return get(path, params, { retried, waited: waited + 1 });
    }
    const j = await r.json().catch(() => null);
    if (r.status === 401) throw new QuickbooksError('unauthorized', 401);
    if (r.status === 403) throw new QuickbooksError('denied', 403);
    if (r.status === 429) throw new QuickbooksError('rate_limited', 429);
    if (!r.ok || !j || j.Fault) throw new QuickbooksError('failed', r.status);
    return j;
  }

  // Every row of one entity, a page at a time. `where` is built here from
  // dates only; nothing a person typed reaches the query.
  async function all(entity, where = '') {
    const out = [];
    for (let start = 1; ; start += PAGE) {
      const query = `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ''} ORDERBY Id STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
      const j = await get('/query', { query });
      const rows = j.QueryResponse?.[entity] || [];
      out.push(...rows);
      if (rows.length < PAGE) return out;
      if (out.length >= 200000) throw new QuickbooksError('too_many');
    }
  }

  return {
    get,
    all,
    companyInfo: async () => (await get(`/companyinfo/${encodeURIComponent(realmId)}`)).CompanyInfo || {},
    report: (name, params) => get(`/reports/${name}`, params),
  };
}

// The profit and loss report's totals: income, expenses and net, in dollars.
export function profitAndLoss(report) {
  const rows = report?.Rows?.Row || [];
  const total = (group) => {
    const r = rows.find((x) => x.group === group);
    const cols = r?.Summary?.ColData || [];
    const raw = String(cols[cols.length - 1]?.value ?? '').replace(/,/g, '').trim();
    const v = raw === '' ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  };
  const income = total('Income');
  const expenses = total('Expenses');
  const other = total('OtherExpenses');
  return {
    income: income ?? 0,
    expenses: Math.round(((expenses ?? 0) + (other ?? 0)) * 100) / 100,
    net: total('NetIncome') ?? Math.round(((income ?? 0) - (expenses ?? 0) - (other ?? 0)) * 100) / 100,
  };
}

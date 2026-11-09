// Live provider checks for GET /api/health/live.
//
// A key being set is not a key that works. Each check makes one real, cheap
// call to the provider (a one-token Claude answer, a one-word embedding, a
// list of one) and keeps only a status word:
//   ok, off (not set up here), rejected, denied, no_credit, model_unavailable,
//   rate_limited, overloaded, unreachable, failed.
// Never a key, a body or an upstream message. A result is remembered five
// minutes when good and one minute when not, and calls in flight are shared,
// so a public page cannot run up provider calls. Same file in every TSS app.

const OK_TTL_MS = 5 * 60 * 1000;
const BAD_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 15000;

const memo = new Map(); // name -> { at, ttl, status }
const inflight = new Map(); // name -> Promise<status>

// Test seam.
export function _resetLiveChecks() { memo.clear(); inflight.clear(); }

export function passes(status) { return status === 'ok' || status === 'off'; }

export async function remembered(name, fn, { now = Date.now } = {}) {
  const hit = memo.get(name);
  if (hit && now() - hit.at < hit.ttl) return hit.status;
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    let status;
    try { status = await fn(); } catch (_) { status = 'unreachable'; }
    if (typeof status !== 'string' || !status) status = 'failed';
    memo.set(name, { at: now(), ttl: passes(status) ? OK_TTL_MS : BAD_TTL_MS, status });
    return status;
  })();
  inflight.set(name, p);
  try { return await p; } finally { inflight.delete(name); }
}

// An HTTP answer as a status word. The body is read only for the words that
// tell an empty balance from a bad request, and never kept.
export function httpStatus(code, text = '') {
  const t = String(text || '').toLowerCase();
  if (code >= 200 && code < 300) return 'ok';
  if (code === 401) return 'rejected';
  if (code === 402) return 'no_credit';
  if (code === 403) return /credit|billing|balance|quota/.test(t) ? 'no_credit' : 'denied';
  if (code === 404) return 'model_unavailable';
  if (code === 400 && /credit|billing|balance/.test(t)) return 'no_credit';
  if (code === 429) return /quota|credit|billing/.test(t) ? 'no_credit' : 'rate_limited';
  if (code === 529) return 'overloaded';
  return 'failed';
}

async function call(fetchImpl, url, init) {
  let r;
  try {
    r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (_) {
    return 'unreachable';
  }
  const text = await r.text().catch(() => '');
  return httpStatus(r.status, text.slice(0, 2000));
}

const clean = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();

// One token from the model the app answers with.
export function checkClaude({ key, model, baseUrl, authToken, fetchImpl = globalThis.fetch } = {}) {
  const k = clean(key);
  const t = clean(authToken);
  if (!k && !t) return Promise.resolve('off');
  const base = clean(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  return remembered(`claude:${model}`, () => call(fetchImpl, `${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(k ? { 'x-api-key': k } : { authorization: `Bearer ${t}` }),
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
  }));
}

// One word embedded.
export function checkVoyage({ key, model = 'voyage-3.5', fetchImpl = globalThis.fetch } = {}) {
  const k = clean(key);
  if (!k) return Promise.resolve('off');
  return remembered(`voyage:${model}`, () => call(fetchImpl, 'https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
    body: JSON.stringify({ input: ['ok'], model }),
  }));
}

// The server key read back by Composio (a list of one sign-in setup).
export function checkComposio({ key, baseUrl = 'https://backend.composio.dev/api/v3.1', fetchImpl = globalThis.fetch } = {}) {
  const k = clean(key);
  if (!k) return Promise.resolve('off');
  const base = clean(baseUrl).replace(/\/+$/, '');
  return remembered('composio', () => call(fetchImpl, `${base}/auth_configs?limit=1`, {
    method: 'GET',
    headers: { 'x-api-key': k, accept: 'application/json' },
  }));
}

// Another TSS app's GET /api/service/ping, asked with the service token this
// app holds for it: ok only when that app answers and takes the token.
export function checkTssApp({ name, url, token, path = '/api/service/ping', fetchImpl = globalThis.fetch } = {}) {
  const base = clean(url).replace(/\/+$/, '');
  if (!base) return Promise.resolve('off');
  const tok = clean(token);
  if (!tok) return Promise.resolve('no_token');
  return remembered(`app:${name}`, async () => {
    let r;
    try {
      r = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (_) { return 'unreachable'; }
    await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) return 'rejected';
    return r.ok ? 'ok' : 'failed';
  });
}

// { ok, checked_at, checks: { name: status } } from { name: Promise<status> }.
export async function runLiveChecks(entries) {
  const names = Object.keys(entries);
  const results = await Promise.all(names.map((n) => Promise.resolve(entries[n]).catch(() => 'unreachable')));
  const checks = {};
  names.forEach((n, i) => { checks[n] = results[i]; });
  return { ok: results.every(passes), checked_at: new Date().toISOString(), checks };
}

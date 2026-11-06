// The organization's monthly AI limit, kept by Cockpit.
//
// Before Ledger reads a pile of files with Claude, Ledger asks Cockpit whether
// the organization may start one (POST <COCKPIT_URL>/api/usage/check). After
// each Claude call it reports the tokens used (POST /api/usage/report), so
// Cockpit's usage page counts Ledger and the limit covers it. Both calls
// carry LEDGER_SERVICE_TOKEN, the secret Cockpit reads from this service.
// Rook-E does the same (apps/server/src/usage.ts there).
//
// Cockpit being slow or down never stops work: the check lets the run
// through, and the report is dropped (logged once). Without COCKPIT_URL or
// the token, nothing is checked or counted.
//
// The organization and person a call is for travel with the request
// (AsyncLocalStorage), so services/sense.js reports
// calls without being handed them.

import { AsyncLocalStorage } from 'node:async_hooks';
import { cockpitUrl } from './cockpit.js';

const TIMEOUT_MS = 3000;
const als = new AsyncLocalStorage();

export function createUsageClient({ url = cockpitUrl(), token = String(process.env.LEDGER_SERVICE_TOKEN || '').trim(), fetchImpl = (...a) => fetch(...a), log = console } = {}) {
  const on = Boolean(url && token);
  let warned = false;
  const warn = (err, what) => {
    if (warned) return;
    warned = true;
    log.warn?.(`usage: ${what}; Cockpit did not answer (${err?.message || err})`);
  };
  async function call(path, org, body) {
    const res = await fetchImpl(`${url}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-tss-app': 'ledger', 'x-tss-org': org },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    warned = false;
    return res.json();
  }
  return {
    on,
    // { allowed, level, message } or null when nothing could be checked.
    async check(org) {
      if (!on) return null;
      try {
        const s = await call('/api/usage/check', org, {});
        const level = s?.level === 'blocked' || s?.level === 'warning' ? s.level : 'ok';
        return { allowed: s?.allowed !== false && level !== 'blocked', level, message: typeof s?.message === 'string' ? s.message : null };
      } catch (err) {
        warn(err, 'the limit was not checked');
        return null;
      }
    },
    async report(org, { userId = null, feature, model, usage }) {
      if (!on || !usage) return;
      const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
      const input = n(usage.input_tokens), output = n(usage.output_tokens);
      const cacheRead = n(usage.cache_read_input_tokens), cacheWrite = n(usage.cache_creation_input_tokens);
      if (!input && !output && !cacheRead && !cacheWrite) return;
      try {
        await call('/api/usage/report', org, {
          calls: [{
            model: String(model || '').slice(0, 80), userId, feature,
            // Cockpit counts every prompt token as input and prices the cached ones apart.
            inputTokens: input + cacheRead + cacheWrite, outputTokens: output,
            cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
          }],
        });
      } catch (err) {
        warn(err, 'a call was not counted');
      }
    },
  };
}

// Runs `fn` with every Claude call inside it reported for this organization,
// person and feature.
export function withUsage(ctx, fn) {
  return als.run({ ...ctx }, fn);
}

// Called by the services after each Claude response. Never throws, never waits.
export function noteUsage(model, usage) {
  const ctx = als.getStore();
  if (!ctx?.client || !ctx.org) return;
  ctx.client.report(ctx.org, { userId: ctx.userId || null, feature: ctx.feature, model, usage }).catch(() => {});
}

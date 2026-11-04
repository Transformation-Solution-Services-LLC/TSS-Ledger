// Sign-in through TSS Cockpit (TSS-Dashboard).
//
// A person signs in to Cockpit and nowhere else. When they open this app from
// Cockpit, Cockpit appends a launch ticket to the address
// (`#tss_launch=<ticket>`): a JWT signed with Cockpit's Ed25519 key, valid for
// two minutes, addressed to this app, naming the person, their organization,
// their role and the permissions they hold here. The browser sends it to
// POST /api/auth/cockpit, which verifies it here and starts a session.
//
// The only setting is COCKPIT_URL. The public key comes from
// <COCKPIT_URL>/.well-known/jwks.json, so Cockpit can rotate its key without
// a change here. The contract is in TSS-Dashboard's
// docs/ADDING_AN_APPLICATION.md, "Signing in through the dashboard".

import crypto from 'node:crypto';
import { PublicError } from './public-error.js';

const SKEW_S = 30;
const KEYS_MAX_AGE_MS = 10 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;

export function cockpitUrl() {
  const raw = String(process.env.COCKPIT_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try { return new URL(raw).toString().replace(/\/+$/, ''); } catch (_) { return null; }
}

export function cockpitOrigin() {
  const url = cockpitUrl();
  return url ? new URL(url).origin : null;
}

const refused = (message = 'This sign-in link has expired or was already used. Open the app from Cockpit again.') =>
  new PublicError(401, 'launch_refused', message);

function decode(part) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch (_) { return null; }
}

// Checks a token Cockpit signed: signature against Cockpit's published key,
// issuer, audience, time and single use. Returns its claims.
// `fetchImpl` and `now` are test seams.
function createChecker({ audience, url, fetchImpl, now }) {
  let keys = null;
  let fetchedAt = 0;
  let lastRefetch = 0;
  const seen = new Map(); // jti -> expiry (ms): a token works once

  async function loadKeys() {
    let res;
    try {
      res = await fetchImpl(`${url}/.well-known/jwks.json`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch (_) {
      throw new PublicError(503, 'cockpit_unreachable', 'Cockpit could not be reached to check your sign-in. Try again in a moment.');
    }
    if (!res.ok) throw new PublicError(503, 'cockpit_unreachable', 'Cockpit could not be reached to check your sign-in. Try again in a moment.');
    const body = await res.json().catch(() => ({}));
    const next = new Map();
    for (const k of Array.isArray(body.keys) ? body.keys : []) {
      if (k?.kty !== 'OKP' || k?.crv !== 'Ed25519' || typeof k.x !== 'string' || typeof k.kid !== 'string') continue;
      try { next.set(k.kid, crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' })); } catch (_) { /* skip a bad key */ }
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid) {
    if (!keys || now() - fetchedAt > KEYS_MAX_AGE_MS) await loadKeys();
    if (!keys.has(kid) && now() - lastRefetch > UNKNOWN_KID_REFETCH_MS) {
      lastRefetch = now();
      await loadKeys();
    }
    return keys.get(kid) || null;
  }

  return async function check(token, refuse) {
    if (!url) throw new PublicError(503, 'cockpit_unconfigured', 'Sign-in through Cockpit is not set up on this server (COCKPIT_URL).');
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw refuse();
    const head = decode(parts[0]);
    const claims = decode(parts[1]);
    if (!head || !claims || head.alg !== 'EdDSA' || typeof head.kid !== 'string') throw refuse();

    const key = await keyFor(head.kid);
    if (!key) throw refuse();
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')); } catch (_) { ok = false; }
    if (!ok) throw refuse();

    const t = Math.floor(now() / 1000);
    let issuer = null;
    try { issuer = new URL(String(claims.iss)).origin; } catch (_) { /* refused below */ }
    if (issuer !== new URL(url).origin) throw refuse();
    if (claims.aud !== audience) throw refuse();
    if (typeof claims.exp !== 'number' || claims.exp < t - SKEW_S) throw refuse();
    if (typeof claims.nbf === 'number' && claims.nbf > t + SKEW_S) throw refuse();
    if (typeof claims.iat !== 'number' || claims.exp - claims.iat > 600) throw refuse();
    if (typeof claims.jti !== 'string' || !claims.jti) throw refuse();
    if (typeof claims.sub !== 'string' || typeof claims.org?.id !== 'string' || !claims.org.id) throw refuse();

    for (const [jti, exp] of seen) if (exp < now()) seen.delete(jti);
    if (seen.has(claims.jti)) throw refuse();
    seen.set(claims.jti, (claims.exp + SKEW_S) * 1000);
    return claims;
  };
}

// Returns verify(ticket) -> { sub, name, email, org: { id, name }, role, permissions }.
// `fetchImpl` and `now` are test seams.
export function createTicketVerifier({ audience, url = cockpitUrl(), fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const check = createChecker({ audience, url, fetchImpl, now });
  return async function verify(ticket) {
    const claims = await check(ticket, refused);
    // A server-to-server message from Cockpit (marked `use`) never signs anyone in.
    if (claims.use !== undefined) throw refused();
    return {
      sub: claims.sub,
      name: String(claims.name || claims.email || 'Staff').slice(0, 100),
      email: String(claims.email || '').slice(0, 200),
      org: { id: claims.org.id.slice(0, 100), name: String(claims.org.name || claims.org.id).slice(0, 200) },
      role: String(claims.role || ''),
      permissions: Array.isArray(claims.permissions) ? claims.permissions.map(String) : [],
    };
  };
}

// A server-to-server message from Cockpit (lib/cockpit-link.js): signed with
// the same key as a launch ticket, addressed to this app, and marked with
// what it is for (`use`: "access" or "audit"). A launch ticket is never
// taken for a message. Returns verify(token) -> the message's claims.
export function createMessageVerifier({ audience, use, url = cockpitUrl(), fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const check = createChecker({ audience, url, fetchImpl, now });
  const refuse = () => new PublicError(401, 'message_refused', 'This request was not signed by Cockpit.');
  return async function verify(token) {
    const claims = await check(token, refuse);
    if (claims.use !== use) throw refuse();
    return claims;
  };
}

// Lets Cockpit frame this app and nobody else. Without COCKPIT_URL the app
// cannot be framed at all.
export function frameHeaders(_req, res, next) {
  const origin = cockpitOrigin();
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self'${origin ? ` ${origin}` : ''}`);
  if (!origin) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
}

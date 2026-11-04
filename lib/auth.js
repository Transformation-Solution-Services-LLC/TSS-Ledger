// Sessions and service access.
//
// People sign in to TSS Cockpit, never here: lib/cockpit.js verifies the
// launch ticket Cockpit sends and this file turns it into a short HMAC session
// token for this tab. The session carries the person's organization and their
// Ledger permissions from Cockpit: "use" (read every fund, budget and
// entry, record a spend entry) and "manage" (add and change funds and
// budgets, import, export, void any entry, read the activity log).
//
// A second credential, LEDGER_SERVICE_TOKEN, lets Cockpit read totals (GET
// /api/cockpit/rollup) and lets Watson and Rook-E read grant figures (GET
// /api/service/grants) without a person. It names the organization it asks
// for in X-TSS-Org and never gets a payee, a memo or a single entry.

import crypto from 'node:crypto';
import { withCockpitAccess } from './cockpit-link.js';

// One working day. Turning someone off in Cockpit takes effect when this ends.
export const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

let _bootSecret = null;
function sessionSecret() {
  // A random per-boot secret means tokens stop working after a restart,
  // which is safer than a predictable default.
  if (!_bootSecret) _bootSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  return _bootSecret;
}

export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

// Compare digests so differing lengths do not leak through the comparison.
function sameSecret(given, expected) {
  if (!expected) return false;
  const ha = crypto.createHash('sha256').update(String(given || '')).digest();
  const hb = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// The password-less developer sign-in, for running without Cockpit. Off
// unless DEV_SIGNIN is on, and never in production.
export function devSignInEnabled() {
  if (process.env.NODE_ENV === 'production') return false;
  return ['1', 'true', 'on', 'yes'].includes(String(process.env.DEV_SIGNIN || '').trim().toLowerCase());
}

// A session token for a person Cockpit vouched for.
export function sessionFor(person) {
  return sign({
    sub: person.sub,
    name: person.name,
    email: person.email || '',
    org: person.org,
    perms: person.permissions,
    // When the session began: a change made in Cockpit after it wins (lib/cockpit-link.js).
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  });
}

export function serviceTokenMatches(given) {
  return sameSecret(given, process.env.LEDGER_SERVICE_TOKEN || '');
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

// Staff only.
export function requireUser(req, res, next) {
  const payload = verifyToken(bearer(req));
  if (!payload || typeof payload.org?.id !== 'string') {
    return res.status(401).json({ error: 'Sign in again', code: 'authentication_required' });
  }
  // A change made in Cockpit since this session began replaces what it carries.
  withCockpitAccess(req, res, next, payload, Array.isArray(payload.perms) ? payload.perms.map(String) : [], (perms) => {
    req.user = {
      id: String(payload.sub || ''),
      name: String(payload.name || 'Staff'),
      email: String(payload.email || ''),
      kind: 'staff',
      org_id: payload.org.id,
      org_name: String(payload.org.name || payload.org.id),
      can_manage: perms.includes('manage'),
    };
    next();
  });
}

// Staff whose role in Cockpit includes "Manage Ledger".
export function requireManager(req, res, next) {
  requireUser(req, res, () => {
    if (!req.user.can_manage) {
      return res.status(403).json({ error: 'Your role in Cockpit can use Ledger but not change budgets. Ask your administrator.', code: 'not_permitted' });
    }
    next();
  });
}

// Cockpit's server, holding the service token and naming an organization.
export function requireService(req, res, next) {
  const token = bearer(req);
  if (!token || !serviceTokenMatches(token)) {
    return res.status(401).json({ error: 'Service token required', code: 'authentication_required' });
  }
  const org = String(req.headers['x-tss-org'] || '').trim().slice(0, 100);
  if (!org) return res.status(400).json({ error: 'Name the organization in X-TSS-Org', code: 'org_required' });
  const app = String(req.headers['x-tss-app'] || 'service').slice(0, 40);
  req.user = { id: `service:${app}`, name: app, kind: 'service', org_id: org, org_name: org, can_manage: false };
  next();
}

// Cockpit's "Export everything": EXPORT_TOKEN, a credential of its own that
// only Cockpit's server holds (never the service token other apps share), and
// the organization in X-TSS-Org. Unset, organization export is off.
export function requireExport(req, res, next) {
  const token = bearer(req);
  if (!token || !sameSecret(token, process.env.EXPORT_TOKEN || '')) {
    return res.status(401).json({ error: 'Export token required', code: 'authentication_required' });
  }
  const org = String(req.headers['x-tss-org'] || '').trim().slice(0, 100);
  if (!org) return res.status(400).json({ error: 'Name the organization in X-TSS-Org', code: 'org_required' });
  req.user = { id: 'service:cockpit-export', name: 'Cockpit export', kind: 'export', org_id: org, org_name: org, can_manage: false };
  next();
}

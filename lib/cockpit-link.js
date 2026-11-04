// Cockpit, server to server: access changes in, the audit trail out.
//
// The same file in Library, Rollodex, Ledger, Sherlock and Watson. Cockpit's
// side is TSS-FullStack apps/api/src/appLink.ts; the contract is in its
// docs/ADDING_AN_APPLICATION.md, "Access and the audit log".
//
// Both requests are signed by Cockpit with the key it signs launch tickets
// with, checked here by lib/cockpit.js against <COCKPIT_URL>/.well-known/
// jwks.json, so this app needs no secret for them. Each is marked with what
// it is for (`use`), so neither can be used as the other or as a sign-in.
//
//   POST /api/cockpit/access  { message }   use "access"
//     The people of one organization and the permissions each now holds
//     here. A session started before a person's access last changed follows
//     the new access on its next request; one left with no way in is ended
//     ("Open it from Cockpit again"). A session started after (a fresh
//     launch) carries Cockpit's current word already.
//
//   GET /api/cockpit/audit?after=<id>&limit=<n>   Authorization: Bearer <message>   use "audit"
//     This app's audit entries for the organization, oldest first, after
//     the given id. Cockpit keeps them in its one append-only log; here they
//     wait until Cockpit has read them.
//
// Storage: Postgres when a pool is given (tables <prefix>_cockpit_access and
// <prefix>_cockpit_audit, created if missing), memory otherwise. Both keep
// the same contract (test/cockpit-link.test.mjs runs it against both).

import { createMessageVerifier } from './cockpit.js';
import { PublicError } from './public-error.js';

const MAX_PEOPLE = 5000;
const clip = (v, n) => (v === undefined || v === null ? '' : String(v).replace(/\u0000/g, '').slice(0, n));
const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
const cleanPerms = (list) => [...new Set((Array.isArray(list) ? list : []).map((p) => clip(p, 60)).filter(Boolean))].sort();

class MemoryLinkStore {
  constructor() {
    this.kind = 'memory';
    this.access = new Map();
    this.audit = [];
    this.seq = 0;
  }
  async init() { return this; }
  async getAccess(org, sub) {
    const r = this.access.get(`${org}\n${sub}`);
    return r ? { ...r, perms: [...r.perms] } : null;
  }
  async putAccess(org, sub, perms, at) {
    this.access.set(`${org}\n${sub}`, { org_id: org, sub, perms: [...perms], changed_at: at });
  }
  async append(e) {
    this.seq += 1;
    this.audit.push({ id: this.seq, ...e });
  }
  async after(org, afterId, limit) {
    return this.audit.filter((e) => e.org_id === org && e.id > afterId).slice(0, limit).map((e) => ({ ...e }));
  }
  async close() {}
}

class PostgresLinkStore {
  constructor(pool, prefix) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new Error('cockpit-link: bad table prefix');
    this.kind = 'postgres';
    this.pool = pool;
    this.access = `${prefix}_cockpit_access`;
    this.audit = `${prefix}_cockpit_audit`;
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.access} (
        org_id text NOT NULL,
        sub text NOT NULL,
        perms jsonb NOT NULL,
        changed_at bigint NOT NULL,
        PRIMARY KEY (org_id, sub)
      );
      CREATE TABLE IF NOT EXISTS ${this.audit} (
        id bigserial PRIMARY KEY,
        org_id text NOT NULL,
        at timestamptz NOT NULL DEFAULT now(),
        actor_id text NOT NULL DEFAULT '',
        actor_name text NOT NULL DEFAULT '',
        actor_email text NOT NULL DEFAULT '',
        action text NOT NULL,
        target text NOT NULL DEFAULT '',
        detail text NOT NULL DEFAULT '',
        ip text NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS ${this.audit}_org ON ${this.audit} (org_id, id);
    `);
    return this;
  }
  async getAccess(org, sub) {
    const { rows } = await this.pool.query(`SELECT org_id, sub, perms, changed_at FROM ${this.access} WHERE org_id = $1 AND sub = $2`, [org, sub]);
    return rows[0] ? { ...rows[0], changed_at: Number(rows[0].changed_at) } : null;
  }
  async putAccess(org, sub, perms, at) {
    await this.pool.query(
      `INSERT INTO ${this.access} (org_id, sub, perms, changed_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, sub) DO UPDATE SET perms = EXCLUDED.perms, changed_at = EXCLUDED.changed_at`,
      [org, sub, JSON.stringify(perms), at],
    );
  }
  async append(e) {
    await this.pool.query(
      `INSERT INTO ${this.audit} (org_id, at, actor_id, actor_name, actor_email, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.org_id, e.at, e.actor_id, e.actor_name, e.actor_email, e.action, e.target, e.detail, e.ip],
    );
  }
  async after(org, afterId, limit) {
    const { rows } = await this.pool.query(
      `SELECT id, org_id, at, actor_id, actor_name, actor_email, action, target, detail, ip FROM ${this.audit} WHERE org_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [org, afterId, limit],
    );
    return rows.map((r) => ({ ...r, id: Number(r.id), at: new Date(r.at).toISOString() }));
  }
  async close() {}
}

/**
 * The link for one app.
 *
 * - audience: this app's id in Cockpit (`rollodex`), the same as its launch tickets.
 * - canEnter(perms): whether a set of permissions lets a person in at all.
 * - pool: a pg Pool for Postgres storage; memory without one.
 * - prefix: the table prefix (`rollodex`).
 * - verifyAccess / verifyAudit / now: test seams.
 */
export function createCockpitLink({ audience, canEnter, pool = null, prefix = audience, verifyAccess, verifyAudit, now = () => Date.now(), log = console } = {}) {
  if (!audience || typeof canEnter !== 'function') throw new Error('cockpit-link needs an audience and canEnter');
  const store = pool ? new PostgresLinkStore(pool, prefix) : new MemoryLinkStore();
  const checkAccess = verifyAccess || createMessageVerifier({ audience, use: 'access' });
  const checkAudit = verifyAudit || createMessageVerifier({ audience, use: 'audit' });

  const link = {
    get kind() { return store.kind; },
    init: async () => { await store.init(); return link; },
    close: () => store.close(),

    // What a session may do now: its own permissions, or, when Cockpit has
    // changed this person's access since the session began, Cockpit's. Null
    // when that leaves the person no way in.
    async permsFor({ org, sub, iat = 0, perms = [] }) {
      const rec = sub ? await store.getAccess(org, sub) : null;
      if (!rec || rec.changed_at <= iat) return perms;
      return canEnter(rec.perms) ? rec.perms : null;
    },

    // Applies Cockpit's word on these people. Returns how many changed.
    async applyAccess(org, people) {
      let changed = 0;
      const at = now();
      for (const p of people) {
        const sub = clip(p?.sub, 100);
        if (!sub) continue;
        const perms = cleanPerms(p.permissions);
        const rec = await store.getAccess(org, sub);
        if (rec && sameSet(cleanPerms(rec.perms), perms)) continue;
        await store.putAccess(org, sub, perms, at);
        // A first word from Cockpit about someone matches what their session
        // already carries; only a real change is a change.
        if (rec) changed += 1;
      }
      return changed;
    },

    // One audit entry. Never throws: losing the app's request over its log
    // would be worse, and the failure is logged.
    async record({ org, actorId = '', actor = '', email = '', action, target = '', detail = '', ip = '' }) {
      try {
        await store.append({
          org_id: clip(org, 100),
          at: new Date(now()).toISOString(),
          actor_id: clip(actorId, 100),
          actor_name: clip(actor, 200),
          actor_email: clip(email, 200),
          action: clip(action, 80),
          target: clip(target, 300),
          detail: typeof detail === 'string' ? clip(detail, 2000) : clip(JSON.stringify(detail), 2000),
          ip: clip(ip, 64),
        });
      } catch (err) {
        log.error?.(`cockpit-link: audit write failed (${err?.code || err?.name || 'error'})`);
      }
    },

    // Middleware that records every change a person makes (and every export
    // and refusal) as it finishes, for an app without its own activity log:
    // "POST /api/documents/:id/draft" on the document's id. Successful reads
    // other than exports are not recorded.
    requestTrail() {
      return (req, res, next) => {
        res.on('finish', () => {
          const user = req.user;
          if (!user || user.kind !== 'staff' || !req.route) return;
          const pattern = `${req.baseUrl || ''}${req.route.path}`;
          const writes = req.method !== 'GET' && req.method !== 'HEAD';
          const refused = res.statusCode === 401 || res.statusCode === 403;
          if (!refused && (res.statusCode >= 400 || (!writes && !/export/.test(pattern)))) return;
          link.record({
            org: user.org_id,
            actorId: user.id,
            actor: user.name,
            email: user.email,
            action: `${refused ? 'refused ' : ''}${req.method} ${pattern}`,
            target: req.params?.id || '',
            detail: req.params && Object.keys(req.params).length > 1 ? JSON.stringify(req.params) : '',
            ip: req.ip,
          });
        });
        next();
      };
    },

    // The entries after `afterId`, for Cockpit.
    after: (org, afterId, limit) => store.after(org, afterId, limit),

    // Mounts the two routes. `wrap` turns a rejected promise into the app's
    // error response.
    routes(app, { wrap }) {
      app.post('/api/cockpit/access', wrap(async (req, res) => {
        const claims = await checkAccess(clip((req.body || {}).message, 2_000_000));
        const people = Array.isArray(claims.people) ? claims.people : null;
        if (!people || people.length > MAX_PEOPLE) throw new PublicError(400, 'bad_message', 'The message names no people.');
        const changed = await link.applyAccess(claims.org.id, people);
        if (changed) {
          await link.record({ org: claims.org.id, actorId: 'cockpit', actor: 'Cockpit', action: 'cockpit_access_applied', detail: `${changed} ${changed === 1 ? 'person' : 'people'} changed`, ip: req.ip });
        }
        res.json({ ok: true, changed });
      }));

      app.get('/api/cockpit/audit', wrap(async (req, res) => {
        const header = String(req.headers.authorization || '');
        const claims = await checkAudit(header.startsWith('Bearer ') ? header.slice(7) : '');
        const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(req.query.limit) || 500)));
        const rows = await link.after(claims.org.id, after, limit);
        res.json({
          events: rows.map((r) => ({
            id: String(r.id),
            at: r.at,
            actor_id: r.actor_id || null,
            actor_name: r.actor_name || null,
            actor_email: r.actor_email || null,
            action: r.action,
            target: r.target || null,
            detail: r.detail || null,
            ip: r.ip || null,
          })),
          next: rows.length ? String(rows[rows.length - 1].id) : (after ? String(after) : null),
        });
      }));
    },
  };
  return link;
}

// For lib/auth.js: replaces a session's permissions with Cockpit's newer word,
// or answers 401 when that leaves no way in. `done(perms)` continues.
export function withCockpitAccess(req, res, next, payload, perms, done) {
  const link = req.app?.locals?.cockpitLink;
  if (!link) return done(perms);
  link.permsFor({ org: payload.org.id, sub: String(payload.sub || ''), iat: Number(payload.iat) || 0, perms }).then((held) => {
    if (!held) return res.status(401).json({ error: 'Your access to this app changed in Cockpit. Open it from Cockpit again.', code: 'access_changed' });
    return done(held);
  }, next);
}

// A pg Pool from DATABASE_URL for an app that has no database of its own
// (Sherlock, Watson), or null. DATABASE_SSL is `require` (certificate
// checked), `no-verify`, or blank, the same as the rate limiter's.
export async function linkPoolFromEnv(env = process.env) {
  const url = String(env.DATABASE_URL || '').trim();
  if (!url) return null;
  const { default: pg } = await import('pg');
  const ssl = String(env.DATABASE_SSL || '').trim().toLowerCase();
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    ssl: ssl === 'require' ? { rejectUnauthorized: true } : ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', () => {});
  return pool;
}

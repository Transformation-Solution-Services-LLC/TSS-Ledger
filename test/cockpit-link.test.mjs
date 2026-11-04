// lib/cockpit-link.js: access changes from Cockpit reach open sessions, and
// the audit trail Cockpit reads. The same file in Library, Rollodex, Ledger,
// Sherlock and Watson. With TEST_DATABASE_URL the contract also runs on
// Postgres.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeCockpit } from './cockpit-fixture.mjs';
import { createCockpitLink } from '../lib/cockpit-link.js';
import { requireUser, sessionFor } from '../lib/auth.js';

const AUD = 'app-under-test';
const canEnter = (p) => p.includes('use') || p.includes('manage');

async function pgPool() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query('DROP TABLE IF EXISTS linktest_cockpit_access, linktest_cockpit_audit');
  return pool;
}

async function harness({ pool = null, now } = {}) {
  const cockpit = fakeCockpit(AUD);
  const link = await createCockpitLink({
    audience: AUD,
    canEnter,
    pool,
    prefix: 'linktest',
    verifyAccess: cockpit.verifyMessage('access'),
    verifyAudit: cockpit.verifyMessage('audit'),
    ...(now ? { now } : {}),
  }).init();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.locals.cockpitLink = link;
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  link.routes(app, { wrap });
  app.get('/api/me', requireUser, (req, res) => res.json({ id: req.user.id }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ code: err.code }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { cockpit, link, base, close: () => new Promise((r) => server.close(r)) };
}

const person = (permissions, sub = 'u-dana') => ({ sub, name: 'Dana', email: 'dana@example.org', org: { id: 'org-a', name: 'Org A' }, permissions });
const me = (base, token) => fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
const push = (h, people, over = {}) => fetch(`${h.base}/api/cockpit/access`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: h.cockpit.message('access', { people, ...over }) }),
});

for (const kind of ['memory', 'postgres']) {
  test(`${kind}: a change in Cockpit reaches a session already open`, async (t) => {
    const pool = kind === 'postgres' ? await pgPool() : null;
    if (kind === 'postgres' && !pool) return t.skip('TEST_DATABASE_URL not set');
    const h = await harness({ pool });
    try {
      const issuedAt = Date.now();
      const token = sessionFor(person(['use', 'manage']));
      assert.equal((await me(h.base, token)).status, 200);
      const held = () => h.link.permsFor({ org: 'org-a', sub: 'u-dana', iat: issuedAt, perms: ['use', 'manage'] });
      assert.deepEqual(await held(), ['use', 'manage']);

      // Cockpit's first word matches what the session carries: nothing changes.
      let r = await push(h, [{ sub: 'u-dana', permissions: ['use', 'manage'] }]);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).changed, 0);

      await new Promise((res) => setTimeout(res, 5));
      r = await push(h, [{ sub: 'u-dana', permissions: ['use'] }]);
      assert.equal((await r.json()).changed, 1);
      assert.deepEqual(await held(), ['use'], 'manage taken away mid-session');
      assert.equal((await me(h.base, token)).status, 200, 'still in with use');

      await new Promise((res) => setTimeout(res, 5));
      await push(h, [{ sub: 'u-dana', permissions: [] }]);
      r = await me(h.base, token);
      assert.equal(r.status, 401);
      assert.equal((await r.json()).code, 'access_changed');

      // A fresh launch after the change carries Cockpit's current word itself.
      await new Promise((res) => setTimeout(res, 5));
      const fresh = sessionFor(person(['use', 'manage']));
      assert.equal((await me(h.base, fresh)).status, 200);

      // Someone else is untouched.
      const other = sessionFor(person(['use', 'manage'], 'u-lee'));
      assert.equal((await me(h.base, other)).status, 200);
      assert.deepEqual(await h.link.permsFor({ org: 'org-a', sub: 'u-lee', iat: 0, perms: ['use', 'manage'] }), ['use', 'manage']);
    } finally {
      await h.close();
      await pool?.end();
    }
  });

  test(`${kind}: the audit trail, oldest first, after a cursor, one organization only`, async (t) => {
    const pool = kind === 'postgres' ? await pgPool() : null;
    if (kind === 'postgres' && !pool) return t.skip('TEST_DATABASE_URL not set');
    const h = await harness({ pool });
    try {
      await h.link.record({ org: 'org-a', actorId: 'u-dana', actor: 'Dana', email: 'dana@example.org', action: 'contact_added', target: 'c1', detail: 'Ann Lee', ip: '203.0.113.9' });
      await h.link.record({ org: 'org-b', actorId: 'u-x', actor: 'X', action: 'contact_added' });
      await h.link.record({ org: 'org-a', actorId: 'u-dana', actor: 'Dana', action: 'gift_added', target: 'g1' });
      const read = (after) => fetch(`${h.base}/api/cockpit/audit?limit=1${after ? `&after=${after}` : ''}`, {
        headers: { authorization: `Bearer ${h.cockpit.message('audit')}` },
      }).then((r) => r.json());
      let page = await read();
      assert.equal(page.events.length, 1);
      assert.deepEqual(
        { ...page.events[0], id: undefined, at: undefined },
        { id: undefined, at: undefined, actor_id: 'u-dana', actor_name: 'Dana', actor_email: 'dana@example.org', action: 'contact_added', target: 'c1', detail: 'Ann Lee', ip: '203.0.113.9' },
      );
      page = await read(page.next);
      assert.equal(page.events.length, 1);
      assert.equal(page.events[0].action, 'gift_added');
      const end = await read(page.next);
      assert.deepEqual(end.events, []);
      assert.equal(end.next, page.next, 'the cursor stays put at the end');
    } finally {
      await h.close();
      await pool?.end();
    }
  });
}

test('only a message Cockpit signed for this use is accepted', async () => {
  const h = await harness();
  try {
    // A launch ticket is not an access message.
    let r = await fetch(`${h.base}/api/cockpit/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: h.cockpit.ticket({ people: [{ sub: 'u-dana', permissions: [] }] }) }),
    });
    assert.equal(r.status, 401);
    // An audit message is not an access message, and the other way round.
    r = await fetch(`${h.base}/api/cockpit/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: h.cockpit.message('audit', { people: [] }) }),
    });
    assert.equal(r.status, 401);
    r = await fetch(`${h.base}/api/cockpit/audit`, { headers: { authorization: `Bearer ${h.cockpit.message('access')}` } });
    assert.equal(r.status, 401);
    // Unsigned, or signed by another key.
    r = await fetch(`${h.base}/api/cockpit/audit`);
    assert.equal(r.status, 401);
    const stranger = fakeCockpit(AUD);
    r = await fetch(`${h.base}/api/cockpit/audit`, { headers: { authorization: `Bearer ${stranger.message('audit')}` } });
    assert.equal(r.status, 401);
    // Addressed to another app.
    r = await fetch(`${h.base}/api/cockpit/audit`, { headers: { authorization: `Bearer ${h.cockpit.message('audit', { aud: 'other-app' })}` } });
    assert.equal(r.status, 401);
    // A message used twice.
    const once = h.cockpit.message('audit');
    assert.equal((await fetch(`${h.base}/api/cockpit/audit`, { headers: { authorization: `Bearer ${once}` } })).status, 200);
    assert.equal((await fetch(`${h.base}/api/cockpit/audit`, { headers: { authorization: `Bearer ${once}` } })).status, 401);
  } finally {
    await h.close();
  }
});

test('a message never signs anyone in', async () => {
  const cockpit = fakeCockpit(AUD);
  await assert.rejects(cockpit.verifyTicket(cockpit.message('access', { sub: 'u-dana', permissions: ['use'] })), { status: 401 });
});

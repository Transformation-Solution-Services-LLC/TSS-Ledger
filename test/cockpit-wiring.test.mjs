// This app's wiring to Cockpit's access changes and audit log
// (lib/cockpit-link.js): a person signed in from Cockpit loses what Cockpit
// takes away on their next request, and what they do is in the trail
// Cockpit reads.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { createApp, CAN_ENTER } = await import('../server.js');
const { createCockpitLink } = await import('../lib/cockpit-link.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');
const { MemoryStore } = await import('../lib/store-memory.js');

const AUD = 'ledger';

test('a change in Cockpit applies to an open session, and the work is in the audit trail', async () => {
  const cockpit = fakeCockpit(AUD);
  const cockpitLink = createCockpitLink({ audience: AUD, canEnter: CAN_ENTER, verifyAccess: cockpit.verifyMessage('access'), verifyAudit: cockpit.verifyMessage('audit') });
  const app = createApp({ store: new MemoryStore(), verifyTicket: cockpit.verifyTicket, cockpitLink, clock: () => '2026-11-03' });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, token, headers = {}) => fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const push = (permissions) => call('POST', '/api/cockpit/access', { message: cockpit.message('access', { people: [{ sub: 'u-dana', permissions }] }) });
  const pause = () => new Promise((r) => setTimeout(r, 5));
  try {
    const signIn = await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket({ permissions: ['use', 'manage'] }) });
    assert.equal(signIn.status, 200);
    const token = (await signIn.json()).token;
    assert.equal((await call(...['GET', '/api/home', null], token)).status, 200);
    const made = await call('POST', '/api/funds', { name: 'Youth grant', award: 1000 }, token);
    assert.ok(made.status < 300, `manage works: ${made.status}`);
    await pause();
    await push(['use']);
    assert.equal((await call('POST', '/api/funds', { name: 'Second grant' }, token)).status, 403, 'manage taken away mid-session');
    assert.equal((await call(...['GET', '/api/home', null], token)).status, 200, 'still in with use');

    await pause();
    assert.equal((await push([])).status, 200);
    const gone = await call(...['GET', '/api/home', null], token);
    assert.equal(gone.status, 401);
    assert.equal((await gone.json()).code, 'access_changed');

    const trail = await (await call('GET', '/api/cockpit/audit', null, cockpit.message('audit'))).json();
    const actions = trail.events.map((e) => e.action);
    assert.ok(actions.includes('signin'), actions.join(', '));
    assert.ok(actions.some((a) => a.includes('fund')), actions.join(', '));
    assert.ok(actions.includes('cockpit_access_applied'), actions.join(', '));
    const mine = trail.events.find((e) => e.action === 'signin');
    assert.equal(mine.actor_id, 'u-dana');
    assert.equal(mine.actor_email, 'dana@example.org');
    assert.ok(mine.ip);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

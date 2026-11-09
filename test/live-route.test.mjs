import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.LEDGER_SERVICE_TOKEN = 'svc-token';
for (const k of ['ANTHROPIC_API_KEY', 'SHERLOCK_URL', 'WATSON_URL', 'LIBRARY_URL', 'COMPOSIO_API_KEY']) delete process.env[k];

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');

test('the live page and the service ping', async () => {
  const server = await new Promise((r) => { const s = createApp({ store: new MemoryStore() }).listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const got = await (await fetch(`${base}/api/health/live`)).json();
    assert.equal(got.ok, true);
    assert.equal(got.checks.claude, 'off');
    const reviewers = Object.keys(got.checks).filter((k) => k.startsWith('reviewer:'));
    assert.ok(reviewers.length >= 3, 'at least three reviewers besides the drafter');
    for (const k of reviewers) assert.equal(got.checks[k], 'off');
    assert.equal((await fetch(`${base}/api/service/ping`)).status, 401);
    assert.equal((await fetch(`${base}/api/service/ping`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(`${base}/api/service/ping`, { headers: { Authorization: 'Bearer svc-token' } })).status, 200);
  } finally { server.close(); }
});

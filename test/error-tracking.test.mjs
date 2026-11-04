// Error tracking. Nothing here reaches the network: the tracker is a stub
// fetch. The module is the same file in every TSS app (lib/error-tracking.js).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const { createErrorReporter, errorReporterFromEnv, parseDsn, scrub, setErrorReporter } = await import('../lib/error-tracking.js');
const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');

// The shape Sentry gives a project (Settings, Client Keys): key, ingest host, project number.
const SENTRY_DSN = 'https://0123456789abcdef0123456789abcdef@o4508000000000000.ingest.us.sentry.io/4508000000000001';
const quiet = { warn() {}, error() {}, log() {} };

function stubTracker() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const [header, item, event] = init.body.split('\n').map((l) => JSON.parse(l));
    sent.push({ url, headers: init.headers, header, item, event });
    return { ok: true, status: 200 };
  };
  return { sent, fetchImpl };
}

test('a Sentry DSN gives Sentry\'s envelope address; anything else turns tracking off', () => {
  assert.deepEqual(parseDsn(SENTRY_DSN), {
    key: '0123456789abcdef0123456789abcdef',
    endpoint: 'https://o4508000000000000.ingest.us.sentry.io/api/4508000000000001/envelope/',
  });
  assert.equal(parseDsn('https://k@host.example/sub/path/7').endpoint, 'https://host.example/sub/path/api/7/envelope/', 'self-hosted under a path');
  assert.equal(parseDsn('not a url'), null);
  assert.equal(parseDsn('https://host.example/42'), null, 'no key');
  assert.equal(errorReporterFromEnv('x', {}).enabled, false, 'blank keeps it off');
  assert.equal(createErrorReporter({ dsn: 'nonsense', app: 'x', logger: quiet }).enabled, false);
  assert.equal(errorReporterFromEnv('x', { ERROR_TRACKING_DSN: SENTRY_DSN }).enabled, true);
});

test('an event is a valid Sentry envelope with nothing private in it', async () => {
  const { sent, fetchImpl } = stubTracker();
  const r = createErrorReporter({ dsn: SENTRY_DSN, app: 'tss-test', environment: 'production', release: 'abc123', fetchImpl });
  r.capture(new Error('lookup failed for dana@example.org with token=s3cr3t'), { org_id: 'org-a', user_id: 'user-7', method: 'GET', route: '/api/x/:id' });
  await r.flush();
  assert.equal(sent.length, 1);
  const { url, headers, header, item, event } = sent[0];
  assert.equal(url, 'https://o4508000000000000.ingest.us.sentry.io/api/4508000000000001/envelope/');
  assert.equal(headers['content-type'], 'application/x-sentry-envelope');
  assert.match(headers['x-sentry-auth'], /^Sentry sentry_version=7, sentry_client=[^,]+, sentry_key=0123456789abcdef0123456789abcdef$/);
  assert.equal(header.event_id, event.event_id);
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.equal(item.type, 'event');
  assert.equal(event.platform, 'node');
  assert.equal(event.release, 'abc123');
  assert.match(event.user.id, /^[a-f0-9]{16}$/);
  const text = JSON.stringify(event);
  for (const secret of ['dana@example.org', 's3cr3t', 'user-7']) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.equal(scrub('Bearer abc.def'), 'Bearer [redacted]');
});

test('a server error reaches the tracker with the id the user was shown; a refusal does not', async () => {
  const { sent, fetchImpl } = stubTracker();
  setErrorReporter(createErrorReporter({ dsn: SENTRY_DSN, app: 'tss-ledger', fetchImpl }));
  const store = new MemoryStore();
  store.listFunds = async () => { throw new Error('connection terminated unexpectedly'); };
  const cockpit = fakeCockpit('ledger');
  const server = await new Promise((r) => { const s = createApp({ store, verifyTicket: cockpit.verifyTicket }).listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = console.error;
  console.error = () => {};
  try {
    const token = (await (await fetch(`${base}/api/auth/cockpit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: cockpit.ticket() }) })).json()).token;
    const res = await fetch(`${base}/api/funds`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, 'The request could not be completed', 'the user never sees the cause');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    const { event } = sent[0];
    assert.equal(event.tags.app, 'tss-ledger');
    assert.equal(event.tags.diagnostic_id, body.diagnostic_id);
    assert.equal(event.tags.org, 'org-a');
    assert.deepEqual(event.request, { method: 'GET', url: '/api/funds' });
    assert.equal(event.exception.values.at(-1).value, 'connection terminated unexpectedly');
    // Not signed in: the caller's problem, not an error worth tracking.
    assert.equal((await fetch(`${base}/api/funds`)).status, 401);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
  } finally {
    console.error = errors;
    server.close();
    setErrorReporter(createErrorReporter({}));
  }
});

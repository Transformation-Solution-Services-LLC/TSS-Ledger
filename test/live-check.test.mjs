import test from 'node:test';
import assert from 'node:assert/strict';

const live = await import('../lib/live-check.js');

const answer = (status, body = '{}') => async () => new Response(body, { status });

test('a check with no key is off and makes no call', async () => {
  live._resetLiveChecks();
  let calls = 0;
  const f = async () => { calls += 1; return new Response('{}'); };
  assert.equal(await live.checkClaude({ key: '', model: 'm', fetchImpl: f }), 'off');
  assert.equal(await live.checkVoyage({ key: '  ', fetchImpl: f }), 'off');
  assert.equal(await live.checkComposio({ key: '', fetchImpl: f }), 'off');
  assert.equal(await live.checkTssApp({ name: 'x', url: '', token: 't', fetchImpl: f }), 'off');
  assert.equal(calls, 0);
});

test('provider answers become status words, never bodies', async () => {
  const cases = [
    [200, '{}', 'ok'], [401, 'bad key sk-secret', 'rejected'], [403, 'nope', 'denied'],
    [400, 'Your credit balance is too low', 'no_credit'], [402, '', 'no_credit'], [404, '', 'model_unavailable'],
    [429, 'slow down', 'rate_limited'], [529, '', 'overloaded'], [500, '', 'failed'],
  ];
  for (const [code, body, want] of cases) {
    live._resetLiveChecks();
    assert.equal(await live.checkClaude({ key: 'k', model: `m${code}`, fetchImpl: answer(code, body) }), want, `HTTP ${code}`);
  }
});

test('the Claude check sends one token to the configured model with a trimmed key', async () => {
  live._resetLiveChecks();
  let seen = null;
  const f = async (url, init) => { seen = { url, init }; return new Response('{}'); };
  assert.equal(await live.checkClaude({ key: ' "k-1" ', model: 'claude-x', fetchImpl: f }), 'ok');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'k-1');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'claude-x');
  assert.equal(body.max_tokens, 1);
});

test('a network failure is unreachable', async () => {
  live._resetLiveChecks();
  const f = async () => { throw new Error('ECONNRESET'); };
  assert.equal(await live.checkVoyage({ key: 'k', fetchImpl: f }), 'unreachable');
  assert.equal(await live.checkComposio({ key: 'k', fetchImpl: f }), 'unreachable');
});

test('results are remembered, and calls in flight are shared', async () => {
  live._resetLiveChecks();
  let calls = 0;
  const f = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return new Response('{}'); };
  const both = await Promise.all([live.checkComposio({ key: 'k', fetchImpl: f }), live.checkComposio({ key: 'k', fetchImpl: f })]);
  assert.deepEqual(both, ['ok', 'ok']);
  assert.equal(await live.checkComposio({ key: 'k', fetchImpl: f }), 'ok');
  assert.equal(calls, 1);
});

test('another TSS app: ok only when it takes the token', async () => {
  for (const [code, want] of [[200, 'ok'], [401, 'rejected'], [403, 'rejected'], [404, 'failed'], [502, 'failed']]) {
    live._resetLiveChecks();
    assert.equal(await live.checkTssApp({ name: 'a', url: 'https://a.example/', token: 't', fetchImpl: answer(code) }), want);
  }
  live._resetLiveChecks();
  let seen = null;
  const f = async (url, init) => { seen = { url, init }; return new Response('{}'); };
  await live.checkTssApp({ name: 'b', url: 'https://b.example/', token: 'tok', fetchImpl: f });
  assert.equal(seen.url, 'https://b.example/api/service/ping');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.equal(await live.checkTssApp({ name: 'c', url: 'https://c.example', token: '', fetchImpl: f }), 'no_token');
});

test('the summary passes only when every check is ok or off', async () => {
  assert.equal((await live.runLiveChecks({ a: 'ok', b: Promise.resolve('off') })).ok, true);
  const r = await live.runLiveChecks({ a: 'ok', b: Promise.resolve('rejected'), c: Promise.reject(new Error('x')) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks, { a: 'ok', b: 'rejected', c: 'unreachable' });
});

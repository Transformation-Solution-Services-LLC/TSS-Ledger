// The figures: spent, remaining, burn rate, pace and variance per line.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fundSummary, totals, rollup, needsYou, factLines, usd, monthsBetween } from '../lib/finance.js';

const fund = { id: 'f1', name: 'Youth Diversion', kind: 'grant', funder: 'Meyer', award: 12000, start_on: '2026-01-01', end_on: '2026-12-31', status: 'active' };
const lines = [
  { id: 'l1', fund_id: 'f1', name: 'Personnel', amount: 9000, position: 0 },
  { id: 'l2', fund_id: 'f1', name: 'Supplies', amount: 3000, position: 1 },
];
const entry = (date, amount, line_id = 'l1', extra = {}) => ({ id: `${date}-${amount}`, fund_id: 'f1', line_id, date, amount, ...extra });

test('spent, remaining and burn rate, in whole cents', () => {
  const entries = [entry('2026-01-15', 1000), entry('2026-02-15', 1000), entry('2026-03-15', 1000), entry('2026-03-20', 0.1, 'l2'), entry('2026-03-21', 0.2, 'l2')];
  const s = fundSummary(fund, lines, entries, '2026-06-30');
  assert.equal(s.budget, 12000);
  assert.equal(s.budget_from, 'lines');
  assert.equal(s.spent, 3000.3, '0.1 + 0.2 adds up exactly');
  assert.equal(s.remaining, 8999.7);
  assert.equal(s.pct_spent, 0.25);
  assert.equal(s.elapsed, 0.496);
  assert.equal(s.burn_rate, 504.54, 'per month over the 181 days gone');
  assert.equal(s.pace, 'slow', 'a quarter spent with half the year gone');
  assert.ok(s.projected_spend > 6000 && s.projected_spend < 6200);
  assert.equal(s.lines[0].remaining, 6000);
  assert.equal(s.lines[1].spent, 0.3);
  assert.deepEqual(s.monthly.map((m) => m.spent), [1000, 1000, 1000.3, 0, 0, 0]);
});

test('pace: ahead of the calendar, over budget, a line over, and voided entries count for nothing', () => {
  const fast = fundSummary(fund, lines, [entry('2026-02-01', 6000)], '2026-03-31');
  assert.equal(fast.pace, 'fast');
  const over = fundSummary(fund, lines, [entry('2026-02-01', 9500), entry('2026-02-02', 3000, 'l2')], '2026-03-31');
  assert.equal(over.pace, 'over');
  assert.equal(over.lines[0].flag, 'over');
  assert.equal(over.lines_over, 1);
  assert.equal(fundSummary(fund, lines, [entry('2026-02-01', 8200)], '2026-11-30').lines[0].flag, 'at_risk');
  const voided = fundSummary(fund, lines, [entry('2026-02-01', 9500, 'l1', { voided_at: '2026-02-02T00:00:00Z' })], '2026-03-31');
  assert.equal(voided.spent, 0);
});

test('without budget lines the award is the budget; spending on no line is shown on its own', () => {
  const s = fundSummary(fund, [], [entry('2026-02-01', 500, null)], '2026-03-01');
  assert.equal(s.budget, 12000);
  assert.equal(s.budget_from, 'award');
  assert.deepEqual(s.lines.map((l) => [l.name, l.spent]), [['Not on a budget line', 500]]);
  const differ = fundSummary({ ...fund, award: 10000 }, lines, [], '2026-03-01');
  assert.equal(differ.lines_differ_from_award, true);
  const undated = fundSummary({ ...fund, start_on: null, end_on: null }, [], [], '2026-03-01');
  assert.equal(undated.pace, 'no_dates');
});

test('totals keep restricted and unrestricted apart; Cockpit gets totals and counts only', () => {
  const general = { id: 'f2', name: 'General', kind: 'unrestricted', award: 5000, status: 'active' };
  const entries = [entry('2026-02-01', 1200), { id: 'g', fund_id: 'f2', date: '2026-02-03', amount: 300, payee: 'Secret Vendor', memo: 'private' }];
  const all = [fundSummary(fund, lines, entries, '2026-03-31'), fundSummary(general, [], entries, '2026-03-31')];
  const t = totals(all);
  assert.deepEqual(t.restricted, { budget: 12000, spent: 1200, remaining: 10800 });
  assert.deepEqual(t.unrestricted, { budget: 5000, spent: 300, remaining: 4700 });
  const r = rollup({ from: '2026-01-01', to: '2026-03-31', funds: [fund, general], lines, entries }, '2026-03-31');
  assert.equal(r.metrics.spent.value, 1500);
  assert.equal(r.metrics.restricted_spent.value, 1200);
  assert.equal(r.metrics.grants_active.value, 1);
  assert.deepEqual(r.series.spent.map((p) => p.value), [0, 1500, 0]);
  assert.doesNotMatch(JSON.stringify(r), /Secret Vendor|private|Youth Diversion/);
});

test('Needs you: a line over budget, money left near the end, and a grant past its end still open', () => {
  const over = needsYou({ funds: [fund], lines, entries: [entry('2026-02-01', 9500)] }, '2026-03-31').items;
  assert.equal(over[0].id, 'over-f1');
  assert.equal(over[0].severity, 'overdue');
  assert.equal(over[0].to, '#/funds/f1');
  assert.match(over[0].detail, /^[^:]+: \$[\d,.]+ spent of \$[\d,.]+\.$/, 'names the line over and its own budget, not the grant total');
  const ending = needsYou({ funds: [fund], lines, entries: [entry('2026-02-01', 2000)] }, '2026-11-15').items;
  assert.deepEqual(ending.map((i) => i.id), ['ending-f1']);
  assert.match(ending[0].title, /ends in 46 days with \$10,000 unspent/);
  const ended = needsYou({ funds: [fund], lines, entries: [] }, '2027-01-10').items;
  assert.deepEqual(ended.map((i) => i.id), ['ended-f1']);
  assert.deepEqual(needsYou({ funds: [{ ...fund, kind: 'unrestricted' }], lines, entries: [] }, '2027-01-10').items, [], 'unrestricted money has no deadline');
});

test('the sentences Watson cites carry Ledger\'s own figures', () => {
  const s = fundSummary(fund, lines, [entry('2026-01-15', 3000)], '2026-06-30');
  const facts = factLines(s, '2026-06-30').join('\n');
  assert.match(facts, /Spent to date: \$3,000 \(25% of budget\)\. Remaining: \$9,000\./);
  assert.match(facts, /Grant period: 2026-01-01 to 2026-12-31/);
  assert.equal(usd(1234.5), '$1,234.50');
  assert.equal(usd(-20), '-$20');
  assert.deepEqual(monthsBetween('2026-11-10', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

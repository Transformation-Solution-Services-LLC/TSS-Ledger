// The figures of Ledger, from plain lists of funds, budget lines and spend
// entries. Pure functions: the server loads one organization's rows from the
// store and asks here. Both stores give the same shapes, so this file is the
// one place a figure is defined. Every sum is taken in whole cents, so a
// thousand entries of $0.10 add up to $100.00 exactly.
//
// Dates are YYYY-MM-DD strings in the organization's local day, never
// converted through UTC.

export const FUND_KINDS = ['grant', 'restricted', 'unrestricted'];
export const FUND_STATUSES = ['active', 'closed'];
// A line at or past this share of its budget is at risk; past 100% it is over.
export const AT_RISK = 0.9;
// Spending this far ahead of the calendar (share spent minus share of the
// period gone) is "fast"; this far behind, once a quarter of the period has
// gone, is "slow" and the money may be left unspent.
export const FAST_BY = 0.1;
export const SLOW_BY = 0.15;
// A grant ending within this many days with money left is in Needs you.
export const ENDING_DAYS = 60;
const MONTH_DAYS = 365.25 / 12;

export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const zone = () => process.env.TZ_DISPLAY || 'America/Los_Angeles';

export function localDay(at = new Date(), tz = zone()) {
  const d = at instanceof Date ? at : new Date(at);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}
export const today = (tz = zone(), at = new Date()) => localDay(at, tz);

export function daysBetween(fromDay, toDay) {
  if (!fromDay || !toDay) return null;
  return Math.round((Date.parse(`${toDay}T12:00:00Z`) - Date.parse(`${fromDay}T12:00:00Z`)) / 86400000);
}

export const toCents = (n) => Math.round(Number(n || 0) * 100);
export const fromCents = (c) => Math.round(c) / 100;
export const round2 = (n) => fromCents(toCents(n));
const sumCents = (list, f) => list.reduce((s, x) => s + toCents(f(x)), 0);
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export const isRestricted = (fund) => fund.kind !== 'unrestricted';
export const liveEntries = (entries) => entries.filter((e) => !e.voided_at);
export const liveLines = (lines) => lines.filter((l) => !l.removed_at);

// "$12,500" or "$12,500.50".
export function usd(n) {
  const v = round2(n);
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function monthsBetween(from, to) {
  const out = [];
  if (!from || !to || to < from) return out;
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function lineFlag(budgetC, spentC) {
  if (spentC > budgetC && spentC > 0) return 'over';
  if (budgetC > 0 && spentC / budgetC >= AT_RISK) return 'at_risk';
  return 'ok';
}

// One fund with every figure Ledger shows for it: the budget (its lines, or
// the award when it has no lines yet), spent, remaining, burn rate, where the
// spending is heading by the end date, and each line's variance.
export function fundSummary(fund, lines, entries, asOf) {
  const ls = liveLines(lines).filter((l) => l.fund_id === fund.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name)));
  const es = liveEntries(entries).filter((e) => e.fund_id === fund.id && (!asOf || e.date <= asOf));
  const linesC = sumCents(ls, (l) => l.amount);
  const budgetC = ls.length ? linesC : toCents(fund.award);
  const spentC = sumCents(es, (e) => e.amount);
  const remainingC = budgetC - spentC;

  // The period: the grant's own dates, else from the first entry to today.
  const firstEntry = es.reduce((d, e) => (!d || e.date < d ? e.date : d), '');
  const start = fund.start_on || firstEntry || null;
  const end = fund.end_on || null;
  const length = start && end ? daysBetween(start, end) + 1 : null;
  const gone = start && asOf ? Math.max(0, daysBetween(start, asOf) + 1) : null;
  const elapsed = length && length > 0 && gone !== null ? Math.round(clamp01(gone / length) * 1000) / 1000 : null;
  const daysLeft = end && asOf ? Math.max(0, daysBetween(asOf, end)) : null;

  // Burn rate: what was spent per month of the period so far. Never less
  // than a month of time, so a grant one week old does not read as 4x.
  const monthsGone = gone !== null && gone > 0 ? Math.max(1, gone / MONTH_DAYS) : null;
  const burnC = monthsGone && spentC > 0 ? Math.round(spentC / monthsGone) : 0;
  const monthsLeft = daysLeft !== null ? daysLeft / MONTH_DAYS : null;
  const projectedC = monthsLeft !== null && monthsGone ? spentC + Math.round(burnC * monthsLeft) : null;
  const runway = burnC > 0 && remainingC > 0 ? Math.round((remainingC / burnC) * 10) / 10 : null;

  const pctSpent = share(spentC, budgetC);
  let pace = 'no_budget';
  if (budgetC > 0) {
    if (spentC > budgetC) pace = 'over';
    else if (elapsed === null) pace = 'no_dates';
    else if (pctSpent - elapsed > FAST_BY) pace = 'fast';
    else if (elapsed - pctSpent > SLOW_BY && elapsed >= 0.25) pace = 'slow';
    else pace = 'on_track';
  }

  const byLine = new Map();
  for (const e of es) {
    const k = e.line_id && ls.some((l) => l.id === e.line_id) ? e.line_id : '';
    byLine.set(k, (byLine.get(k) || 0) + toCents(e.amount));
  }
  const lineRows = ls.map((l) => {
    const b = toCents(l.amount);
    const s = byLine.get(l.id) || 0;
    return { id: l.id, name: l.name, code: l.code || '', budget: fromCents(b), spent: fromCents(s), remaining: fromCents(b - s), pct_spent: share(s, b), flag: lineFlag(b, s) };
  });
  const unassigned = byLine.get('') || 0;
  if (unassigned) lineRows.push({ id: null, name: 'Not on a budget line', code: '', budget: 0, spent: fromCents(unassigned), remaining: fromCents(-unassigned), pct_spent: null, flag: ls.length ? 'unassigned' : 'ok' });

  const monthly = new Map();
  for (const e of es) monthly.set(e.date.slice(0, 7), (monthly.get(e.date.slice(0, 7)) || 0) + toCents(e.amount));
  const months = start ? monthsBetween(start, end && asOf && end < asOf ? end : asOf || end) : [...monthly.keys()].sort();

  return {
    id: fund.id, name: fund.name, kind: fund.kind, restricted: isRestricted(fund), status: fund.status, funder: fund.funder || '', code: fund.code || '',
    start_on: fund.start_on || null, end_on: fund.end_on || null, award: round2(fund.award || 0),
    rollodex_contact_id: fund.rollodex_contact_id || null, archived_at: fund.archived_at || null,
    budget: fromCents(budgetC), budget_from: ls.length ? 'lines' : 'award',
    lines_differ_from_award: Boolean(ls.length && toCents(fund.award) && linesC !== toCents(fund.award)),
    spent: fromCents(spentC), remaining: fromCents(remainingC), pct_spent: pctSpent,
    elapsed, days_left: daysLeft, burn_rate: fromCents(burnC),
    projected_spend: projectedC === null ? null : fromCents(projectedC),
    projected_left: projectedC === null ? null : fromCents(budgetC - projectedC),
    runway_months: runway, pace,
    entries: es.length, last_entry: es.reduce((d, e) => (e.date > d ? e.date : d), '') || null,
    lines: lineRows,
    lines_over: lineRows.filter((l) => l.flag === 'over').length,
    lines_at_risk: lineRows.filter((l) => l.flag === 'at_risk').length,
    monthly: months.map((month) => ({ month, spent: fromCents(monthly.get(month) || 0) })),
  };
}

export function summarizeFunds(funds, lines, entries, asOf) {
  return funds.map((f) => fundSummary(f, lines, entries, asOf));
}

// The organization's totals, restricted and unrestricted kept apart: money
// given for one purpose is never shown as available for another.
export function totals(summaries) {
  const add = (list, k) => fromCents(list.reduce((s, f) => s + toCents(f[k]), 0));
  const active = summaries.filter((f) => f.status === 'active' && !f.archived_at);
  const restricted = active.filter((f) => f.restricted);
  const unrestricted = active.filter((f) => !f.restricted);
  return {
    funds: active.length,
    grants: active.filter((f) => f.kind === 'grant').length,
    restricted: { budget: add(restricted, 'budget'), spent: add(restricted, 'spent'), remaining: add(restricted, 'remaining') },
    unrestricted: { budget: add(unrestricted, 'budget'), spent: add(unrestricted, 'spent'), remaining: add(unrestricted, 'remaining') },
    off_pace: active.filter((f) => ['fast', 'slow', 'over'].includes(f.pace)).length,
    lines_over: active.reduce((s, f) => s + f.lines_over, 0),
  };
}

// What Cockpit may see: totals and counts. No payee, no memo, no entry.
export function rollup({ from, to, funds, lines, entries }, asOf) {
  const live = funds.filter((f) => !f.archived_at);
  const t = totals(summarizeFunds(live, lines, entries, asOf));
  const inPeriod = liveEntries(entries).filter((e) => e.date >= from && e.date <= to && live.some((f) => f.id === e.fund_id));
  const restrictedIds = new Set(live.filter(isRestricted).map((f) => f.id));
  const months = monthsBetween(from, to);
  const by = (list) => months.map((month) => ({ month, value: fromCents(sumCents(list.filter((e) => e.date.startsWith(month)), (e) => e.amount)) }));
  const restrictedSpend = inPeriod.filter((e) => restrictedIds.has(e.fund_id));
  return {
    from, to,
    metrics: {
      grants_active: { value: t.grants },
      restricted_budget: { value: t.restricted.budget },
      restricted_remaining: { value: t.restricted.remaining },
      spent: { value: fromCents(sumCents(inPeriod, (e) => e.amount)) },
      restricted_spent: { value: fromCents(sumCents(restrictedSpend, (e) => e.amount)) },
      grants_off_pace: { value: t.off_pace },
      lines_over: { value: t.lines_over },
    },
    series: { spent: by(inPeriod), restricted_spent: by(restrictedSpend) },
  };
}

// ---- Cockpit's "Needs you" list ----
//
// What a person who works in Ledger should look at: budget lines spent past
// their budget, grants spending well ahead of the calendar, grants ending
// soon with money left, and grants past their end date still open. Grant
// names appear (they are the organization's own); a payee or memo never does.
export function needsYou({ funds, lines, entries }, asOf) {
  const items = [];
  const open = funds.filter((f) => f.status === 'active' && !f.archived_at && isRestricted(f));
  for (const s of summarizeFunds(open, lines, entries, asOf)) {
    const to = `#/funds/${s.id}`;
    if (s.lines_over) items.push({ id: `over-${s.id}`, title: `${s.name}: ${s.lines_over} budget line${s.lines_over === 1 ? '' : 's'} over budget`, detail: `${usd(s.spent)} spent of ${usd(s.budget)}.`, due: asOf, severity: 'overdue', count: s.lines_over, to });
    else if (s.pace === 'over') items.push({ id: `over-${s.id}`, title: `${s.name} is over budget`, detail: `${usd(s.spent)} spent of ${usd(s.budget)}.`, due: asOf, severity: 'overdue', to });
    if (s.pace === 'fast') items.push({ id: `fast-${s.id}`, title: `${s.name} is spending ahead of schedule`, detail: `${Math.round(s.pct_spent * 100)}% spent with ${Math.round(s.elapsed * 100)}% of the grant period gone.`, due: asOf, severity: 'due', to });
    if (s.end_on && s.end_on < asOf && s.remaining > 0) {
      items.push({ id: `ended-${s.id}`, title: `${s.name} ended on ${s.end_on} and is still open`, detail: `${usd(s.remaining)} unspent. Close it or record the last costs.`, due: s.end_on, severity: 'due', to });
    } else if (s.days_left !== null && s.days_left <= ENDING_DAYS && s.budget > 0 && s.remaining / s.budget > 0.15) {
      items.push({ id: `ending-${s.id}`, title: `${s.name} ends in ${s.days_left} day${s.days_left === 1 ? '' : 's'} with ${usd(s.remaining)} unspent`, detail: `${Math.round((s.remaining / s.budget) * 100)}% of the budget is left.`, due: s.end_on, severity: 'due', to });
    }
  }
  return { as_of: asOf, items };
}

// ---- for other TSS apps (Watson, Rook-E) ----

// A grant's figures as plain sentences, every number computed here, for a
// writer to cite. Watson checks each dollar figure in a draft against them.
export function factLines(s, asOf) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const out = [`Figures from Ledger as of ${asOf}.`];
  if (s.funder) out.push(`Funder: ${s.funder}.`);
  if (s.award) out.push(`Award: ${usd(s.award)}.`);
  if (s.start_on || s.end_on) out.push(`Grant period: ${s.start_on || 'not set'} to ${s.end_on || 'not set'}.`);
  out.push(`Budget: ${usd(s.budget)}. Spent to date: ${usd(s.spent)}${s.pct_spent !== null ? ` (${pct(s.pct_spent)} of budget)` : ''}. Remaining: ${usd(s.remaining)}.`);
  if (s.elapsed !== null) out.push(`Share of the grant period gone: ${pct(s.elapsed)}.`);
  if (s.burn_rate) out.push(`Average spending per month: ${usd(s.burn_rate)}.`);
  if (s.projected_spend !== null && s.end_on) out.push(`At this rate, spending by ${s.end_on} reaches ${usd(s.projected_spend)}, leaving ${usd(s.projected_left)}.`);
  return out;
}

// The service view of a fund: no entries, no payees, no memos.
export function serviceView(s, asOf, { lines = true } = {}) {
  const { monthly, ...rest } = s;
  return { ...rest, ...(lines ? {} : { lines: undefined }), monthly, facts: factLines(s, asOf) };
}

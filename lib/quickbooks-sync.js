// What QuickBooks says, brought into Ledger's own records (read only on the
// QuickBooks side: lib/quickbooks.js).
//
// The same model as the spreadsheet import, so every figure in
// lib/finance.js works from live data:
//
//   Class         -> fund. A class matches a grant or fund by its code (the
//                    QuickBooks class, as the grant form says) or its name.
//                    A class with no fund is listed for a manager, never
//                    made into a fund on its own.
//   Account       -> budget line, matched by the line's code or name, the
//                    same rule as the spreadsheet import (findLine).
//   Expense, check, credit card charge (Purchase), Bill    -> spending
//   Vendor credit, credit card credit                       -> a refund (negative)
//   Journal entry line on an expense account                -> spending (debit) or refund (credit)
//   Budget (when the manager turns it on)                   -> budget line amounts
//   Profit and loss, this year so far                       -> totals on the QuickBooks screen
//
// Deposits and income are not spending, so they reach Ledger only as the
// profit and loss totals.
//
// Each line Ledger brings in carries external_ref (company, kind, id, line)
// and an import key that also covers QuickBooks' edit count and the fund and
// budget line it landed on. Sync again and nothing is added twice. A line
// changed in QuickBooks, or moved to another fund or budget line, comes in
// again and the old entry is voided ("Updated from QuickBooks"); one deleted
// in QuickBooks is voided too. Nothing is deleted from Ledger. An entry a
// person voided stays voided. A line already on the record from a
// spreadsheet (same fund, day, amount and payee) is not counted twice.

import crypto from 'node:crypto';
import { nameKey, findLine } from './import-map.js';
import { toCents, isDay } from './finance.js';
import { qboDate, profitAndLoss } from './quickbooks.js';

export const SOURCE = 'quickbooks';
const ACTOR = 'QuickBooks';

const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const cents = (n) => Math.round(Number(n || 0) * 100);
const dollars = (c) => c / 100;
const keyOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);

// The class -> fund map. A fund matches by code first, then name, on the
// class's own name or its full name ("Grants:Youth Diversion").
export function matchClasses(classes, funds) {
  const byKey = (k) => funds.find((f) => f.code && nameKey(f.code) === k) || funds.find((f) => nameKey(f.name) === k) || null;
  const out = new Map();
  for (const c of classes) {
    const fund = byKey(nameKey(c.Name)) || byKey(nameKey(c.FullyQualifiedName));
    out.set(String(c.Id), { id: String(c.Id), name: c.FullyQualifiedName || c.Name || '', fund });
  }
  return out;
}

// One spending line per QuickBooks line that touches spending, before funds
// are looked at: { ref, sync, date, cents, payee, memo, reference, account_id, class_id, class_name }.
export function spendingLines({ purchases = [], bills = [], credits = [], journals = [], accounts = new Map() }) {
  const out = [];
  const expense = (id) => accounts.get(String(id))?.Classification === 'Expense';
  const push = (t, kind, l, { sign, payee, accountRef, classRef }) => {
    const amount = Number(l.Amount);
    if (!Number.isFinite(amount) || !amount || !isDay(t.TxnDate)) return;
    out.push({
      ref: `${kind}:${t.Id}:${l.Id ?? ''}`, sync: String(t.SyncToken ?? ''), date: t.TxnDate, cents: sign * cents(amount),
      payee: String(payee || '').slice(0, 200), memo: String(l.Description || t.PrivateNote || '').slice(0, 1000), reference: String(t.DocNumber || '').slice(0, 100),
      account_id: accountRef?.value ? String(accountRef.value) : '', account_name: accountRef?.name || '',
      class_id: classRef?.value ? String(classRef.value) : '', class_name: classRef?.name || '',
    });
  };
  const detail = (l) => l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || null;
  for (const [list, kind, sign] of [[purchases, 'purchase', 1], [bills, 'bill', 1], [credits, 'vendorcredit', -1]]) {
    for (const t of list) {
      const s = kind === 'purchase' && t.Credit === true ? -1 : sign;
      const payee = (t.EntityRef || t.VendorRef || {}).name;
      for (const l of t.Line || []) {
        const d = detail(l);
        if (!d) continue;
        push(t, kind, l, { sign: s, payee, accountRef: d.AccountRef, classRef: d.ClassRef || t.ClassRef });
      }
    }
  }
  for (const t of journals) {
    for (const l of t.Line || []) {
      const d = l.JournalEntryLineDetail;
      if (!d?.AccountRef || !expense(d.AccountRef.value)) continue;
      push(t, 'journal', l, { sign: d.PostingType === 'Credit' ? -1 : 1, payee: d.Entity?.EntityRef?.name, accountRef: d.AccountRef, classRef: d.ClassRef });
    }
  }
  return out;
}

// From the earliest start of a fund a class points at (two years back at most), to today.
export function syncWindow(funds, asOf) {
  const floor = addDays(asOf, -730);
  const starts = funds.map((f) => f.start_on).filter(isDay).sort();
  const from = starts.length && starts[0] > floor ? starts[0] : floor;
  return { from, to: asOf };
}

// Read the company and bring its spending in. `client` is lib/quickbooks.js
// qboClient; `conn` the stored connection.
export async function syncQuickbooks({ store, org, conn, client, asOf, budgets = false }) {
  const realm = conn.realm_id;
  const [classes, accountRows, liveFunds, oldFunds] = await Promise.all([
    client.all('Class'), client.all('Account'), store.listFunds(org), store.listFunds(org, { archived: true }),
  ]);
  const funds = [...liveFunds, ...oldFunds];
  const accounts = new Map(accountRows.map((a) => [String(a.Id), a]));
  const classMap = matchClasses(classes, funds);
  const matchedFunds = [...classMap.values()].map((c) => c.fund).filter(Boolean);
  const { from, to } = syncWindow(matchedFunds.length ? matchedFunds : funds, asOf);
  const where = `TxnDate >= ${qboDate(from)} AND TxnDate <= ${qboDate(to)}`;
  const [purchases, bills, credits, journals] = await Promise.all([
    client.all('Purchase', where), client.all('Bill', where), client.all('VendorCredit', where), client.all('JournalEntry', where),
  ]);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const pl = await client.report('ProfitAndLoss', { start_date: yearStart, end_date: asOf }).then(profitAndLoss).catch(() => null);

  // Everything is read before anything is written: a failed read changes nothing.
  const lines = await store.listLines(org);
  const entries = await store.listEntries(org, { voided: true });
  const keys = new Set(entries.filter((e) => e.import_key).map((e) => e.import_key));
  const mine = `qbo:${realm}:`;
  // Spreadsheet rows already on the record, to be matched one for one.
  const sheet = new Map();
  for (const e of entries) {
    if (e.voided_at || e.source === SOURCE) continue;
    const k = [e.fund_id, e.date, toCents(e.amount), nameKey(e.payee)].join('|');
    sheet.set(k, (sheet.get(k) || 0) + 1);
  }

  const result = {
    at: new Date().toISOString(), from, to, added: 0, unchanged: 0, replaced: 0, removed: 0, from_sheet: 0, total: 0,
    classes: [...classMap.values()].map((c) => ({ id: c.id, name: c.name, fund_id: c.fund?.id || null, fund_name: c.fund?.name || '', lines: 0, total: 0 })),
    no_class: { lines: 0, total: 0 }, budgets: null,
  };
  const classRow = new Map(result.classes.map((c) => [c.id, c]));
  const fetched = new Set();
  const fetchedRefs = new Set();
  let addedC = 0;
  // Budgets first, so spending lands on the lines they add.
  if (budgets) result.budgets = await syncBudgets({ store, org, client, classMap, accounts, lines, asOf });

  for (const s of spendingLines({ purchases, bills, credits, journals, accounts })) {
    const cls = s.class_id ? classMap.get(s.class_id) : null;
    const row = s.class_id ? classRow.get(s.class_id) || (() => { const r = { id: s.class_id, name: s.class_name, fund_id: null, fund_name: '', lines: 0, total: 0 }; result.classes.push(r); classRow.set(s.class_id, r); return r; })() : null;
    if (row) { row.lines++; row.total = dollars(cents(row.total) + s.cents); } else { result.no_class.lines++; result.no_class.total = dollars(cents(result.no_class.total) + s.cents); }
    const fund = cls?.fund;
    if (!fund) continue;
    const acc = accounts.get(s.account_id);
    const own = lines.filter((l) => l.fund_id === fund.id && !l.removed_at);
    const line = acc ? findLine(own, `${acc.AcctNum || ''} ${acc.Name || ''}`) || findLine(own, acc.FullyQualifiedName) : s.account_name ? findLine(own, s.account_name) : null;
    const external_ref = `${mine}${s.ref}`;
    const import_key = keyOf(`${external_ref}|${s.sync}|${fund.id}|${line?.id || ''}|${s.cents}|${s.date}`);
    fetched.add(import_key);
    fetchedRefs.add(external_ref);
    if (keys.has(import_key)) { result.unchanged++; continue; }
    const sk = [fund.id, s.date, s.cents, nameKey(s.payee)].join('|');
    if (sheet.get(sk)) { sheet.set(sk, sheet.get(sk) - 1); result.from_sheet++; continue; }
    const e = await store.createEntry(org, {
      id: crypto.randomUUID(), fund_id: fund.id, line_id: line?.id || null, date: s.date, amount: dollars(s.cents),
      payee: s.payee, memo: s.memo, reference: s.reference, source: SOURCE, import_key, external_ref, created_by: ACTOR, created_by_id: '',
    });
    if (e === false) { result.unchanged++; continue; }
    if (!e) continue;
    keys.add(import_key);
    addedC += s.cents;
    result.added++;
  }

  // What QuickBooks no longer says, inside the window just read: voided, kept.
  for (const e of entries) {
    if (e.source !== SOURCE || e.voided_at || !String(e.external_ref || '').startsWith(mine) || e.date < from || e.date > to) continue;
    if (fetched.has(e.import_key)) continue;
    const updated = fetchedRefs.has(e.external_ref);
    await store.voidEntry(org, e.id, { by: ACTOR, reason: updated ? 'Updated from QuickBooks' : 'Removed in QuickBooks' });
    if (updated) result.replaced++; else result.removed++;
  }
  result.total = dollars(addedC);

  result.classes.sort((a, b) => Number(Boolean(a.fund_id)) - Number(Boolean(b.fund_id)) || b.lines - a.lines || a.name.localeCompare(b.name));
  return { result, snapshot: pl ? { from: yearStart, to: asOf, ...pl } : null };
}

// Active QuickBooks budgets covering today: each class's expense accounts,
// summed, become that fund's budget lines. A line already there (same code
// or name) takes QuickBooks' amount; a new one is added.
async function syncBudgets({ store, org, client, classMap, accounts, lines, asOf }) {
  const out = { added: 0, updated: 0 };
  const budgets = (await client.all('Budget')).filter((b) => b.Active !== false && (!b.StartDate || b.StartDate <= asOf) && (!b.EndDate || b.EndDate >= asOf));
  const sums = new Map(); // fund_id|account_id -> cents
  for (const b of budgets) {
    for (const d of b.BudgetDetail || []) {
      const fund = d.ClassRef?.value ? classMap.get(String(d.ClassRef.value))?.fund : null;
      const acc = d.AccountRef?.value ? accounts.get(String(d.AccountRef.value)) : null;
      if (!fund || !acc || acc.Classification !== 'Expense') continue;
      const k = `${fund.id}|${acc.Id}`;
      sums.set(k, (sums.get(k) || 0) + cents(d.Amount));
    }
  }
  for (const [k, c] of sums) {
    const [fundId, accId] = k.split('|');
    const acc = accounts.get(accId);
    const own = lines.filter((l) => l.fund_id === fundId && !l.removed_at);
    const match = findLine(own, `${acc.AcctNum || ''} ${acc.Name || ''}`) || findLine(own, acc.FullyQualifiedName);
    if (match) {
      if (toCents(match.amount) === c) continue;
      await store.updateLine(org, match.id, { amount: dollars(c) });
      match.amount = dollars(c);
      out.updated++;
    } else {
      const l = await store.createLine(org, { id: crypto.randomUUID(), fund_id: fundId, name: String(acc.Name || 'Account').slice(0, 160), code: String(acc.AcctNum || '').slice(0, 40), amount: dollars(c) });
      if (l) { lines.push(l); out.added++; }
    }
  }
  return out;
}

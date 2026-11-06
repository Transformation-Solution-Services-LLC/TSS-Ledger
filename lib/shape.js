// Making sense of a pile of files: the shape a model proposes, and what
// Ledger itself reads through it.
//
// A model never supplies a figure. It proposes a shape: which sheet holds
// spending and which a budget, which row is the header, which column is the
// date or the amount, which grant each row belongs to, and the grants
// themselves (an award only with the sentence of the document it comes
// from). Ledger then reads every value out of the files through that shape,
// the same way the CSV importer does, and counts and totals in whole cents.
// An award whose quote is not in the document, or whose quote does not hold
// that amount, is left off and said so.
//
// No DOM, no store, no model: tests import it.

import { nameKey, readDay, readMoney } from './import-map.js';
import { normalizeHeader } from './csv.js';
import { FUND_KINDS, isDay, toCents } from './finance.js';

export const COLUMN_KEYS = ['date', 'amount', 'debit', 'credit', 'fund', 'line', 'code', 'payee', 'memo', 'reference'];
export const USES = ['spending', 'budget', 'ignore'];

// ---- the files as the models see them ----

// Ids for the pile: S1, S2... for each sheet, D1, D2... for each document.
export function labelFiles(files) {
  let s = 0; let d = 0;
  return files.map((f) => (f.kind === 'sheet'
    ? { ...f, sheets: f.sheets.map((sh) => ({ ...sh, id: `S${++s}` })) }
    : { ...f, id: `D${++d}` }));
}

export const allSheets = (files) => files.flatMap((f) => (f.kind === 'sheet' ? f.sheets.map((sh) => ({ ...sh, file: f.name })) : []));
export const allDocuments = (files) => files.filter((f) => f.kind === 'document');

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function sheetText(sh, head, tail) {
  const n = sh.rows.length;
  const show = (r, i) => `row ${i + 1}: ${r.map((c) => clip(c, 60)).join(' | ')}`;
  const lines = [`[${sh.id}] file "${sh.file}"${sh.name ? `, sheet "${sh.name}"` : ''}: ${n} rows, ${sh.rows[0]?.length || 0} columns`];
  if (n <= head + tail) lines.push(...sh.rows.map(show));
  else {
    lines.push(...sh.rows.slice(0, head).map(show));
    lines.push(`... ${n - head - tail} rows not shown ...`);
    lines.push(...sh.rows.slice(n - tail).map((r, i) => show(r, n - tail + i)));
  }
  return lines.join('\n');
}

// The whole pile as text, under a size limit: every sheet's first and last
// rows, every document's text. Shortens the sheets first, then the documents.
export function digest(files, { limit = 220000 } = {}) {
  const sheets = allSheets(files);
  const docs = allDocuments(files);
  for (const [head, tail, docMax] of [[45, 10, 30000], [25, 6, 20000], [15, 4, 12000], [8, 3, 6000]]) {
    const text = [
      ...sheets.map((sh) => sheetText(sh, head, tail)),
      ...docs.map((d) => `[${d.id}] document "${d.name}"${d.pages ? `, ${d.pages} pages` : ''}\n${d.text.slice(0, docMax)}${d.text.length > docMax ? '\n... the rest of the document is not shown ...' : ''}`),
    ].join('\n\n');
    if (text.length <= limit) return text;
  }
  return [...sheets.map((sh) => sheetText(sh, 5, 2)), ...docs.map((d) => `[${d.id}] document "${d.name}"\n${d.text.slice(0, 3000)}`)].join('\n\n').slice(0, limit);
}

// ---- reading the files through a shape ----

const squash = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

// The award a document states, checked: the quote is in the document, and a
// figure in the quote is the award. Returns the amount, or null.
export function checkedAward(fund, files) {
  const award = readMoney(fund.award);
  if (award === null || award <= 0) return null;
  const doc = allDocuments(files).find((d) => d.id === fund.award_source?.document);
  const quote = squash(fund.award_source?.quote);
  if (!doc || quote.length < 6 || !squash(doc.text).includes(quote)) return null;
  const figures = (quote.match(/\$?\s?\d[\d,]*(?:\.\d{1,2})?/g) || []).map((x) => readMoney(x.replace(/\s/g, '')));
  return figures.some((n) => n !== null && toCents(n) === toCents(award)) ? award : null;
}

// The column a shape names: its header text, or "#3" for the third column.
function columnIndex(header, given) {
  const g = String(given || '').trim();
  if (!g) return -1;
  const m = /^#(\d+)$/.exec(g);
  if (m) { const i = Number(m[1]) - 1; return i >= 0 && i < header.length ? i : -2; }
  const exact = header.findIndex((h) => h.trim() === g);
  if (exact >= 0) return exact;
  const n = normalizeHeader(g);
  const i = header.findIndex((h) => normalizeHeader(h) === n);
  return i >= 0 ? i : -2;
}

const TOTAL_ROW = /^\s*(grand\s+)?(sub)?totals?\b|^\s*total\s+for\b/i;

// A line named in a sheet: its code, its name, or an account such as
// "6010 Salaries" or "Expenses:Salaries" that ends with the name or starts
// with the code. The same rule as the CSV importer.
export function findLine(lines, given) {
  const g = nameKey(given);
  if (!g) return null;
  return lines.find((l) => l.code && nameKey(l.code) === g) || lines.find((l) => nameKey(l.name) === g)
    || lines.find((l) => l.code && g.startsWith(`${nameKey(l.code)} `)) || lines.find((l) => g.endsWith(` ${nameKey(l.name)}`)) || null;
}

// What Ledger would import through this shape. funds and lines: the
// organization's own (to match existing grants). Pure: nothing is saved.
//
// Returns { funds, budget, entries, skipped, problems, sheets, totals }:
//   funds    [{ ref, existing, id, name, kind, funder, code, award, award_checked, start_on, end_on }]
//   budget   [{ fund_ref, name, code, amount, at }] lines to add or update
//   entries  [{ fund_ref, date, amount, payee, memo, reference, line, at }]
//   skipped  [{ at, reason }] rows read and left out, each with its place
//   problems [text] what in the shape does not fit the files
export function buildPlan(shape, files, { funds: own = [], lines: ownLines = [], today = '9999-12-31' } = {}) {
  const problems = [];
  const sheetsById = new Map(allSheets(files).map((sh) => [sh.id, sh]));
  const byId = new Map(own.map((f) => [f.id, f]));
  const funds = [];
  const refs = new Map();
  for (const f of shape.funds || []) {
    const ref = String(f.ref || '').trim();
    if (!ref || refs.has(ref)) { problems.push(`Grant "${f.name}" has no reference of its own.`); continue; }
    const existing = f.existing_id ? byId.get(f.existing_id) : null;
    if (f.existing_id && !existing) problems.push(`Grant "${f.name}" points at a grant Ledger does not have.`);
    let out;
    if (existing) {
      out = { ref, existing: true, id: existing.id, name: existing.name, kind: existing.kind, funder: existing.funder, code: existing.code, award: existing.award, award_checked: true, start_on: existing.start_on, end_on: existing.end_on };
    } else {
      const award = checkedAward(f, files);
      const said = readMoney(f.award);
      if (said && award === null) problems.push(`The award for "${f.name}" (${f.award}) is not stated in the quoted document, so it is left blank.`);
      const dayOr = (v) => { const d = readDay(v); return d && isDay(d) ? d : null; };
      out = {
        ref, existing: false, id: null, name: clip(f.name, 160), kind: FUND_KINDS.includes(f.kind) ? f.kind : 'grant',
        funder: clip(f.funder, 160), code: clip(f.code, 40), award: award || 0, award_checked: award !== null,
        start_on: dayOr(f.start_on), end_on: dayOr(f.end_on),
      };
      if (!out.name) { problems.push(`A grant (${ref}) has no name.`); continue; }
      if (out.start_on && out.end_on && out.end_on < out.start_on) { problems.push(`"${out.name}" ends before it starts.`); out.end_on = null; }
    }
    refs.set(ref, out);
    funds.push(out);
  }

  const budget = [];
  const entries = [];
  const skipped = [];
  const sheets = [];
  const skip = (at, reason) => skipped.push({ at, reason });

  // Budget sheets first, so spending can land on lines they add.
  const order = [...(shape.sheets || [])].sort((a, b) => (a.use === 'budget' ? 0 : 1) - (b.use === 'budget' ? 0 : 1));
  const seenSheets = new Set();
  for (const s of order) {
    const sh = sheetsById.get(s.sheet);
    if (!sh) { problems.push(`The shape names a sheet (${s.sheet}) that is not in the files.`); continue; }
    if (seenSheets.has(s.sheet)) { problems.push(`${place(sh)} is described twice.`); continue; }
    seenSheets.add(s.sheet);
    const info = { sheet: s.sheet, file: sh.file, name: sh.name, use: USES.includes(s.use) ? s.use : 'ignore', why: clip(s.why, 300), rows: 0, read: 0, skipped: 0, total: 0 };
    sheets.push(info);
    if (info.use === 'ignore') continue;
    const headerAt = Math.max(1, Math.floor(Number(s.header_row) || 1));
    const header = sh.rows[headerAt - 1] || [];
    const col = {};
    for (const k of COLUMN_KEYS) {
      const i = columnIndex(header, s.columns?.[k]);
      if (i === -2) problems.push(`${place(sh)}: no column "${s.columns[k]}" in row ${headerAt}.`);
      if (i >= 0) col[k] = i;
    }
    const fundValues = new Map((s.fund_values || []).map((v) => [nameKey(v.value), String(v.fund || '').trim()]));
    const sheetFund = s.fund ? refs.get(String(s.fund).trim()) : null;
    if (s.fund && !sheetFund) problems.push(`${place(sh)} goes to a grant (${s.fund}) the shape does not list.`);
    const last = Number(s.last_row) > headerAt ? Math.min(Number(s.last_row), sh.rows.length) : sh.rows.length;
    const skipWhen = (s.skip_when || []).map(squash).filter(Boolean);
    const flip = s.amount_sign === 'flip';
    const fundOf = (r) => {
      if (col.fund !== undefined) {
        const v = r[col.fund];
        if (nameKey(v)) {
          const ref = fundValues.get(nameKey(v));
          if (ref === '-') return { none: `"${clip(v, 40)}" is not one of these grants` };
          if (ref && refs.get(ref)) return { fund: refs.get(ref) };
          const named = funds.find((f) => nameKey(f.name) === nameKey(v) || (f.code && nameKey(f.code) === nameKey(v)));
          if (named) return { fund: named };
          if (!sheetFund) return { none: `No grant for "${clip(v, 40)}"` };
        }
      }
      return sheetFund ? { fund: sheetFund } : { none: 'No grant for this row' };
    };
    if (info.use === 'spending' && col.date === undefined) problems.push(`${place(sh)}: spending needs a date column.`);
    if (info.use === 'spending' && col.amount === undefined && col.debit === undefined && col.credit === undefined) problems.push(`${place(sh)}: spending needs an amount column (or debit and credit).`);
    if (info.use === 'budget' && (col.line === undefined || col.amount === undefined)) problems.push(`${place(sh)}: a budget needs a line column and an amount column.`);
    let totalC = 0;
    const seenLines = new Map();
    for (let i = headerAt; i < last; i++) {
      const r = sh.rows[i];
      const at = `${place(sh)}, row ${i + 1}`;
      if (!r || r.every((c) => !String(c).trim())) continue;
      info.rows++;
      const joined = squash(r.join(' '));
      if (skipWhen.some((w) => joined.includes(w)) || r.slice(0, 3).some((c) => TOTAL_ROW.test(c))) { skip(at, 'A total or heading row'); info.skipped++; continue; }
      const { fund, none } = fundOf(r);
      if (!fund) { skip(at, none); info.skipped++; continue; }
      if (info.use === 'budget') {
        const name = clip(r[col.line], 160);
        const amount = readMoney(r[col.amount]);
        if (!name) { skip(at, 'No line name'); info.skipped++; continue; }
        if (amount === null) { skip(at, r[col.amount] ? `The amount "${clip(r[col.amount], 30)}" could not be read` : 'No amount'); info.skipped++; continue; }
        if (amount < 0) { skip(at, 'A budget line cannot be below zero'); info.skipped++; continue; }
        const key = `${fund.ref}|${nameKey(name)}`;
        if (seenLines.has(key)) { skip(at, `"${name}" is already on this budget at ${seenLines.get(key)}`); info.skipped++; continue; }
        seenLines.set(key, `row ${i + 1}`);
        budget.push({ fund_ref: fund.ref, sheet: s.sheet, name, code: col.code !== undefined ? clip(r[col.code], 40) : '', amount, at });
        totalC += toCents(amount);
      } else {
        const rawDate = r[col.date];
        const date = readDay(rawDate);
        if (!date) { skip(at, 'No date'); info.skipped++; continue; }
        if (!isDay(date)) { skip(at, `The date "${clip(rawDate, 30)}" could not be read`); info.skipped++; continue; }
        if (date > today) { skip(at, 'Dated in the future'); info.skipped++; continue; }
        let amount = col.amount !== undefined && String(r[col.amount] || '').trim() ? readMoney(r[col.amount]) : null;
        if (amount === null && (col.debit !== undefined || col.credit !== undefined)) {
          const d = col.debit !== undefined ? readMoney(r[col.debit]) : null;
          const c = col.credit !== undefined ? readMoney(r[col.credit]) : null;
          if (d !== null || c !== null) amount = (toCents(d || 0) - toCents(c || 0)) / 100;
        }
        if (amount === null) { skip(at, col.amount !== undefined && r[col.amount] ? `The amount "${clip(r[col.amount], 30)}" could not be read` : 'No amount'); info.skipped++; continue; }
        if (flip) amount = -amount;
        if (!toCents(amount)) { skip(at, 'The amount is zero'); info.skipped++; continue; }
        entries.push({
          fund_ref: fund.ref, sheet: s.sheet, date, amount,
          line: col.line !== undefined ? clip(r[col.line], 160) : '',
          payee: col.payee !== undefined ? clip(r[col.payee], 200) : '',
          memo: col.memo !== undefined ? clip(r[col.memo], 1000) : '',
          reference: col.reference !== undefined ? clip(r[col.reference], 100) : '',
          at,
        });
        totalC += toCents(amount);
      }
      info.read++;
    }
    info.total = totalC / 100;
  }
  for (const sh of sheetsById.values()) if (!seenSheets.has(sh.id)) problems.push(`${place(sh)} is not described.`);

  // Each entry's budget line: the grant's lines (its own and the ones this pile adds).
  for (const e of entries) {
    const f = refs.get(e.fund_ref);
    const lines = [
      ...(f.existing ? ownLines.filter((l) => l.fund_id === f.id && !l.removed_at) : []),
      ...budget.filter((b) => b.fund_ref === e.fund_ref && !(f.existing && findLine(ownLines.filter((l) => l.fund_id === f.id), b.name))),
    ];
    const hit = e.line ? findLine(lines, e.line) : null;
    e.line_name = hit ? hit.name : '';
  }

  const totals = funds.map((f) => {
    const mine = entries.filter((e) => e.fund_ref === f.ref);
    const lines = budget.filter((b) => b.fund_ref === f.ref);
    return {
      ref: f.ref, name: f.name, existing: f.existing,
      entries: mine.length, spent: mine.reduce((n, e) => n + toCents(e.amount), 0) / 100,
      on_lines: mine.filter((e) => e.line_name).length,
      budget_lines: lines.length, budget: lines.reduce((n, b) => n + toCents(b.amount), 0) / 100,
    };
  });
  return { funds, budget, entries, skipped, problems, sheets, totals };
}

function place(sh) { return sh.name ? `"${sh.file}", sheet "${sh.name}"` : `"${sh.file}"`; }

// What the models read back: Ledger's own reading of the files through the
// shape, short enough to check. Per sheet the first rows as read, then the
// totals and every problem.
export function planText(plan) {
  const out = [];
  out.push('GRANTS:');
  for (const f of plan.funds) {
    out.push(`- ${f.ref} ${f.existing ? '(already in Ledger) ' : '(new) '}"${f.name}"${f.funder ? `, funder ${f.funder}` : ''}${f.code ? `, code ${f.code}` : ''}, ${f.kind}, award ${f.award ? `$${f.award.toFixed(2)}` : 'none'}${f.award_checked ? '' : ' (not confirmed)'}, ${f.start_on || '?'} to ${f.end_on || '?'}`);
  }
  out.push('', 'TOTALS LEDGER READ:');
  for (const t of plan.totals) out.push(`- ${t.ref} "${t.name}": ${t.budget_lines} budget lines totaling $${t.budget.toFixed(2)}; ${t.entries} spending entries totaling $${t.spent.toFixed(2)}, ${t.on_lines} of them on a budget line`);
  out.push('', 'SHEETS:');
  for (const s of plan.sheets) {
    out.push(`- ${s.sheet} "${s.file}"${s.name ? ` sheet "${s.name}"` : ''}: ${s.use}${s.use === 'ignore' ? '' : `, ${s.read} rows read, ${s.skipped} skipped, total $${s.total.toFixed(2)}`}`);
    if (s.use === 'budget') for (const b of plan.budget.filter((x) => x.sheet === s.sheet).slice(0, 12)) out.push(`    ${b.at.split(', ').pop()}: ${b.fund_ref} line "${b.name}"${b.code ? ` code ${b.code}` : ''} $${b.amount.toFixed(2)}`);
    if (s.use === 'spending') for (const e of plan.entries.filter((x) => x.sheet === s.sheet).slice(0, 12)) out.push(`    ${e.at.split(', ').pop()}: ${e.fund_ref} ${e.date} $${e.amount.toFixed(2)} ${e.payee ? `to "${e.payee}" ` : ''}${e.line ? `line "${e.line}"${e.line_name ? ` -> ${e.line_name}` : ' (no match)'}` : ''}${e.memo ? ` memo "${clip(e.memo, 60)}"` : ''}`);
  }
  if (plan.skipped.length) {
    out.push('', `SKIPPED ROWS (${plan.skipped.length}):`);
    for (const s of plan.skipped.slice(0, 40)) out.push(`- ${s.at}: ${s.reason}`);
  }
  if (plan.problems.length) out.push('', 'PROBLEMS:', ...plan.problems.map((p) => `- ${p}`));
  return out.join('\n');
}

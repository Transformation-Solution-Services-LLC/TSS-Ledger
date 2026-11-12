// A spreadsheet made into data Ledger can chart and answer questions about.
// Pure functions, no store and no model: tests import them.
//
//   buildTables(file)   a read file (services/extract.js) into tables: the
//                       header row found under any title rows, blank and
//                       total rows dropped, QuickBooks-style section rows
//                       carried down as a column, each column typed (date,
//                       money, number, text) and every cell read as that
//                       type. A sheet with months across the top also gets a
//                       long copy, one row per line and month.
//   profile(table)      what each column holds, for the page and the model.
//   autoCharts(table)   the charts a person sees first, each a query.
//   runQuery(t, spec)   filters, groups (dates by month, quarter...), sums,
//                       averages, counts. Every figure Ledger shows or an
//                       answer quotes comes from here; money in whole cents.
//   calculate(expr)     plain arithmetic on figures already computed.
//   uncheckedFigures()  figures in an answer no computation produced.
//
// A table: { name, columns: [{ name, type }], rows: [[value...]], notes }.
// A date is YYYY-MM-DD, money and numbers are numbers, text is a string, an
// empty cell is null.

import { readDay } from './import-map.js';

export const MAX_TABLE_ROWS = 50000;
export const MAX_COLUMNS = 120;
export const MAX_RESULT_ROWS = 500;
export const TYPES = ['date', 'money', 'number', 'text'];
export const BUCKETS = ['day', 'week', 'month', 'quarter', 'year'];
export const MEASURES = ['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'median'];
export const OPS = ['eq', 'ne', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'empty', 'not_empty'];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const isIsoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const cents = (n) => Math.round(Number(n) * 100);
const round = (n, d = 6) => { const f = 10 ** d; return Math.round(n * f) / f; };

// ---- reading one cell ----

// A number as people write it: "$1,250.50", "(300)", "-300", "12.5%", "1,204".
// Returns { n, money, pct } or null.
export function readNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { n: v, money: false, pct: false } : null;
  let s = String(v ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1).trim(); }
  let money = false;
  const cur = /^(USD|US\$|\$)\s*/i.exec(s);
  if (cur) { money = true; s = s.slice(cur[0].length); }
  if (/^\s*(USD|\$)$/i.test(s.slice(-4)) && /\d/.test(s)) { s = s.replace(/\s*(USD|\$)$/i, ''); money = true; }
  if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
  let pct = false;
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/,(?=\d{3}(\D|$))/g, '').replace(/\s/g, '');
  if (!/^(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return { n: neg ? -n : n, money, pct };
}

// A month heading or a month cell: "Jan", "January 2026", "Jan-26", "2026-01",
// "1/2026", or a first-of-month date. Returns { year|null, month (1-12) } or null.
export function readMonth(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]01)?$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { year: +m[1], month: +m[2] };
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { year: +m[2], month: +m[1] };
  m = /^([a-z]{3,9})\.?(?:[\s'-]*(\d{2}|\d{4}))?$/i.exec(s);
  if (m) {
    const word = m[1].toLowerCase();
    const i = MONTHS.indexOf(word.slice(0, 3));
    if (i < 0 || !(word.length === 3 || MONTH_NAMES[i].toLowerCase().startsWith(word) || word === 'sept')) return null;
    const year = m[2] ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) : null;
    return { year, month: i + 1 };
  }
  return null;
}

// A day as YYYY-MM-DD, or null. Months alone ("Jan 2026") read as the first.
export function readDate(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 40) return null;
  const d = readDay(s);
  if (isIsoDay(d)) return d;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return null;
  const month = readMonth(s);
  if (month?.year) return `${month.year}-${String(month.month).padStart(2, '0')}-01`;
  // "15 Jan 2026", "Jan 15 2026", "2026-01-15T00:00:00Z"
  const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  if (iso) return iso[1];
  const dm = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i.exec(s);
  if (dm && MONTHS.includes(dm[2].toLowerCase())) {
    const r = readDay(`${dm[2]} ${dm[1]}, ${dm[3]}`);
    return isIsoDay(r) ? r : null;
  }
  return null;
}

const MONEY_HEADER = /amount|amt|\$|cost|price|budget|actual|spent|spend|expense|revenue|income|paid|payment|balance|total|debit|credit|salary|wage|fee|grant|award|donation|gift|fund(ing)?|value|sales|invoice|usd|dollars?|variance|remaining|outlay/i;
const NOT_MEASURE = /(^|\b)(id|ids|num|no\.?|number|#|code|zip|postal|year|phone|acct|account\s*(no|number|#)|ref(erence)?|check|invoice\s*(no|number|#)|class\s*id)(\b|$)/i;
const TOTAL_ROW = /^(grand\s+)?totals?\b|^total\s+(for|of)\b|^sub-?totals?\b|^net\s+(income|total)\b|^sum\b/i;

function headerName(raw, i, seen) {
  let name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || `Column ${i + 1}`;
  const base = name;
  let n = 2;
  while (seen.has(name.toLowerCase())) name = `${base} (${n++})`;
  seen.add(name.toLowerCase());
  return name;
}

const isTextCell = (c) => c !== '' && !readNumber(c) && !readDate(c);
// A heading cell: words, or a month ("Jan-26", "2026-01") heading a column.
const isHeadCell = (c) => isTextCell(c) || (c !== '' && !readNumber(c) && Boolean(readMonth(c)));

// The header row: under any title rows, the first row that fills most of the
// sheet's width with words and has rows of data under it.
export function findHeader(rows) {
  const look = rows.slice(0, 40);
  const filled = (r) => r.filter((c) => c !== '').length;
  const widest = Math.max(0, ...rows.slice(0, 200).map(filled));
  if (widest < 2) return 0;
  for (let i = 0; i < look.length; i++) {
    const r = look[i];
    const f = filled(r);
    if (f < 2 || f < widest * 0.5) continue;
    const words = r.filter(isHeadCell).length;
    if (words / f < 0.6) continue;
    const below = rows.slice(i + 1, i + 6).filter((x) => filled(x) >= Math.min(2, f));
    if (below.length) return i;
  }
  return -1;
}

function inferType(name, values) {
  const vals = values.filter((v) => v !== '');
  if (!vals.length) return 'text';
  let nums = 0, money = 0, dates = 0, pct = 0;
  for (const v of vals) {
    const n = readNumber(v);
    if (n) { nums++; if (n.money) money++; if (n.pct) pct++; }
    if (readDate(v)) dates++;
  }
  const share = (k) => k / vals.length;
  if (share(dates) >= 0.8 && dates >= nums * 0.8) return 'date';
  if (share(nums) >= 0.8) {
    if (money || (MONEY_HEADER.test(name) && !NOT_MEASURE.test(name) && !pct)) return 'money';
    return 'number';
  }
  return 'text';
}

function readCell(type, v) {
  if (v === '' || v === null || v === undefined) return null;
  if (type === 'date') return readDate(v);
  if (type === 'money') { const n = readNumber(v); return n ? round(n.n, 2) : null; }
  if (type === 'number') { const n = readNumber(v); return n ? n.n : null; }
  return String(v).slice(0, 500);
}

// One sheet's rows of text into a table (plus its long copy when months run
// across the top). Returns [] for a sheet with nothing tabular in it.
export function sheetTables(sheetName, rawRows) {
  const rows = (rawRows || []).map((r) => (r || []).map((c) => String(c ?? '').trim()));
  if (!rows.some((r) => r.some(Boolean))) return [];
  const notes = [];
  let h = findHeader(rows);
  let headers;
  let body;
  if (h < 0) {
    const width = Math.max(...rows.map((r) => r.length));
    headers = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
    body = rows;
    notes.push('No header row was found, so the columns are numbered.');
    h = -1;
  } else {
    headers = rows[h];
    body = rows.slice(h + 1);
    const titles = rows.slice(0, h).map((r) => r.filter(Boolean).join(' ')).filter(Boolean);
    if (titles.length) notes.push(`Above the header: ${titles.join('; ').slice(0, 200).replace(/[.\s]+$/, '')}.`);
  }
  const width = headers.length;
  const kept = [];
  const sections = [];
  let section = null;
  let totals = 0, blank = 0;
  for (const r of body) {
    const cells = Array.from({ length: width }, (_, i) => r[i] ?? '');
    const filled = cells.filter(Boolean);
    if (!filled.length) { blank++; continue; }
    if (filled.slice(0, 3).some((c) => TOTAL_ROW.test(c))) { totals++; continue; }
    if (width >= 3 && filled.length === 1 && isTextCell(filled[0])) { section = filled[0].slice(0, 120); sections.push(section); continue; }
    kept.push({ cells, section });
  }
  if (totals) notes.push(`${totals} total row${totals === 1 ? '' : 's'} left out, so nothing is counted twice.`);
  const seen = new Set();
  let columns = headers.map((x, i) => ({ name: headerName(x, i, seen), index: i }));
  // Columns with nothing in them.
  columns = columns.filter((c) => kept.some((k) => k.cells[c.index] !== ''));
  if (!kept.length || !columns.length) return [];
  if (columns.length > MAX_COLUMNS) { notes.push(`Only the first ${MAX_COLUMNS} columns are read.`); columns = columns.slice(0, MAX_COLUMNS); }
  for (const c of columns) c.type = inferType(c.name, kept.map((k) => k.cells[c.index]));
  const useSections = sections.length > 0 && kept.some((k) => k.section);
  if (useSections) notes.push('Rows sit under section headings, so the heading is kept as the Section column.');
  let truncated = false;
  const list = kept.length > MAX_TABLE_ROWS ? (truncated = true, kept.slice(0, MAX_TABLE_ROWS)) : kept;
  if (truncated) notes.push(`Only the first ${MAX_TABLE_ROWS.toLocaleString('en-US')} rows are read.`);
  let unread = 0;
  const outRows = list.map((k) => {
    const row = columns.map((c) => {
      const v = readCell(c.type, k.cells[c.index]);
      if (v === null && k.cells[c.index] !== '') unread++;
      return v;
    });
    if (useSections) row.unshift(k.section);
    return row;
  });
  if (unread) notes.push(unread === 1 ? '1 cell did not match the rest of its column and is read as empty.' : `${unread} cells did not match the rest of their column and are read as empty.`);
  const cols = columns.map(({ name, type }) => ({ name, type }));
  if (useSections) cols.unshift({ name: seen.has('section') ? 'Section heading' : 'Section', type: 'text' });
  const name = sheetName || 'Sheet';
  const out = [{ name, columns: cols, rows: outRows, notes }];
  const long = unpivotMonths(name, cols, outRows);
  if (long) out.push(long);
  return out;
}

// Months across the top ("Jan", "Feb"... or "2026-01"...) become one row per
// line and month, so they can be charted over time.
export function unpivotMonths(name, columns, rows) {
  const monthCols = columns.map((c, i) => ({ c, i, m: readMonth(c.name) })).filter((x) => x.m && (x.c.type === 'money' || x.c.type === 'number'));
  if (monthCols.length < 3) return null;
  const keep = columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'text' || x.c.type === 'date');
  const anyYear = monthCols.some((x) => x.m.year);
  // A year missing from a heading follows the one before it, rolling over after December.
  let year = monthCols.find((x) => x.m.year)?.m.year || null;
  let last = 0;
  const periods = monthCols.map((x) => {
    if (x.m.year) year = x.m.year;
    else if (year && x.m.month < last) year++;
    last = x.m.month;
    return anyYear && year ? `${year}-${String(x.m.month).padStart(2, '0')}-01` : `${String(x.m.month).padStart(2, '0')} ${MONTH_NAMES[x.m.month - 1]}`;
  });
  const valueType = columns.some((c) => c.type === 'money') ? 'money' : 'number';
  const out = [];
  for (const r of rows) {
    monthCols.forEach((x, k) => {
      if (r[x.i] === null) return;
      out.push([...keep.map((y) => r[y.i]), periods[k], r[x.i]]);
    });
  }
  if (!out.length) return null;
  return {
    name: `${name}, by month`,
    columns: [...keep.map((y) => y.c), { name: 'Month', type: anyYear ? 'date' : 'text' }, { name: 'Value', type: valueType }],
    rows: out,
    notes: [`The month columns of ${name} as one row per line and month.`],
  };
}

// Every table in a read file (sheets of a workbook, or one CSV).
export function buildTables(file) {
  const out = [];
  for (const s of file.sheets || []) {
    const name = s.name || String(file.name || 'Sheet').replace(/\.[a-z0-9]+$/i, '');
    out.push(...sheetTables(name, s.rows));
  }
  const names = new Set();
  for (const t of out) { let n = t.name; let i = 2; while (names.has(n)) n = `${t.name} (${i++})`; names.add(n); t.name = n; }
  return out;
}

// ---- what a table holds ----

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sumOf(type, nums) {
  if (type === 'money') return nums.reduce((t, n) => t + cents(n), 0) / 100;
  return round(nums.reduce((t, n) => t + n, 0));
}

export function profileColumn(table, i) {
  const c = table.columns[i];
  const vals = table.rows.map((r) => r[i]).filter((v) => v !== null && v !== '');
  const p = { name: c.name, type: c.type, filled: vals.length, empty: table.rows.length - vals.length };
  if (c.type === 'money' || c.type === 'number') {
    Object.assign(p, { sum: sumOf(c.type, vals), min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null });
    p.avg = vals.length ? (c.type === 'money' ? Math.round(cents(p.sum) / vals.length) / 100 : round(p.sum / vals.length, 4)) : null;
    p.median = median(vals);
    if (c.type === 'money' && p.median !== null) p.median = round(p.median, 2);
  } else if (c.type === 'date') {
    const s = [...vals].sort();
    Object.assign(p, { from: s[0] || null, to: s[s.length - 1] || null });
  }
  const counts = new Map();
  for (const v of vals) { const k = String(v); counts.set(k, (counts.get(k) || 0) + 1); }
  p.distinct = counts.size;
  if (c.type === 'text') p.top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([value, count]) => ({ value, count }));
  return p;
}

export function profile(table) {
  return { name: table.name, rows: table.rows.length, columns: table.columns.map((_, i) => profileColumn(table, i)), notes: table.notes || [] };
}

// A text column that groups rows: a handful of values, each used more than once.
const isCategory = (p, rows) => p.type === 'text' && p.distinct >= 2 && p.distinct <= 60 && (p.distinct < rows * 0.6 || rows <= 30) && p.filled >= rows * 0.5;
const CATEGORY_HINT = /categor|type|account|class|program|fund|grant|vendor|payee|name|department|dept|site|project|line|status|source|region|county|service|item|section/i;
const FREE_TEXT = /memo|description|note|comment|detail|address|email|phone/i;
const catScore = (p) => (CATEGORY_HINT.test(p.name) ? 2 : 0) - (FREE_TEXT.test(p.name) ? 3 : 0) - (/^Column \d+$/.test(p.name) ? 4 : 0);

// The measure a person most likely means: money first, named like an amount, largest total.
export function mainMeasure(prof) {
  const cands = prof.columns.filter((p) => (p.type === 'money' || p.type === 'number') && !NOT_MEASURE.test(p.name) && p.filled >= prof.rows * 0.3);
  if (!cands.length) return null;
  const score = (p) => (p.type === 'money' ? 4 : 0) + (/^(amount|amt|total|spent|actual|value)$/i.test(p.name) ? 3 : 0) + (/amount|spent|actual|expense|cost/i.test(p.name) ? 2 : 0)
    + (/debit|withdraw|payment|paid/i.test(p.name) ? 1 : 0) + (/budget|planned/i.test(p.name) ? -1 : 0) + (/balance|running/i.test(p.name) ? -8 : 0) + (/variance|remaining|left/i.test(p.name) ? -2 : 0);
  return [...cands].sort((a, b) => score(b) - score(a) || Math.abs(b.sum) - Math.abs(a.sum))[0];
}

function timeBucket(from, to) {
  const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000;
  if (days <= 10) return 'day';
  if (days < 28) return 'week';
  if (days <= 365 * 4) return 'month';
  if (days <= 365 * 12) return 'quarter';
  return 'year';
}

// The charts a person sees on opening a table: each { title, type, spec }.
// The caller runs each spec through runQuery.
export function autoCharts(table, prof = profile(table)) {
  const charts = [];
  const rows = prof.rows;
  if (!rows) return charts;
  const measure = mainMeasure(prof);
  const m = measure ? [{ fn: 'sum', column: measure.name }] : [{ fn: 'count' }];
  const what = measure ? measure.name : 'Rows';
  const dates = prof.columns.filter((p) => p.type === 'date' && p.from && p.to && p.from !== p.to && p.filled >= rows * 0.5);
  if (dates.length) {
    const d = dates.find((p) => /date|day|posted|paid|when|month/i.test(p.name)) || dates[0];
    const bucket = timeBucket(d.from, d.to);
    charts.push({ title: `${what} by ${bucket}`, type: 'bar', spec: { group_by: [{ column: d.name, bucket }], measures: m, limit: MAX_RESULT_ROWS } });
  }
  const textMonth = prof.columns.find((p) => p.name === 'Month' && p.type === 'text');
  if (textMonth && !dates.length) charts.push({ title: `${what} by month`, type: 'bar', spec: { group_by: [{ column: 'Month' }], measures: m, sort: { by: 'Month', dir: 'asc' }, limit: 12 } });

  // Budget against actual, when the sheet has both.
  const nums = prof.columns.filter((p) => p.type === 'money' || p.type === 'number');
  const budget = nums.find((p) => /budget|planned|approved|award/i.test(p.name));
  const actual = nums.find((p) => p !== budget && /actual|spent|expended|expense|ytd|to date/i.test(p.name));
  const cats = prof.columns.filter((p) => isCategory(p, rows) || (p.type === 'text' && budget && actual && p.distinct >= 2 && p.distinct <= 60))
    .filter((p) => !FREE_TEXT.test(p.name) || p.distinct <= 12)
    .sort((a, b) => catScore(b) - catScore(a) || a.distinct - b.distinct);
  let used = null;
  if (budget && actual && cats.length) {
    used = cats[0].name;
    charts.push({ title: `${budget.name} and ${actual.name} by ${cats[0].name}`, type: 'grouped', spec: { group_by: [{ column: cats[0].name }], measures: [{ fn: 'sum', column: budget.name }, { fn: 'sum', column: actual.name }], limit: 15 } });
  }
  const named = cats.filter((x) => x.name !== 'Month' && x.name !== used);
  const picks = named.some((x) => !/^Column \d+$/.test(x.name)) ? named.filter((x) => !/^Column \d+$/.test(x.name)) : named;
  for (const c of picks.slice(0, charts.length >= 2 ? 1 : 2)) {
    charts.push({ title: `${what} by ${c.name}`, type: 'hbar', fold: true, spec: { group_by: [{ column: c.name }], measures: m, limit: MAX_RESULT_ROWS } });
  }
  return charts.slice(0, 4);
}

// Plain sentences about a table, every figure from the profile.
export function facts(prof) {
  const out = [`${prof.rows.toLocaleString('en-US')} row${prof.rows === 1 ? '' : 's'}, ${prof.columns.length} column${prof.columns.length === 1 ? '' : 's'}.`];
  const d = prof.columns.find((p) => p.type === 'date' && p.from);
  if (d) out.push(`${d.name} runs from ${d.from} to ${d.to}.`);
  const m = mainMeasure(prof);
  if (m) out.push(`${m.name} adds up to ${fmt(m.sum, m.type)}, from ${fmt(m.min, m.type)} to ${fmt(m.max, m.type)}.`);
  return out;
}

export function fmt(n, type = 'number') {
  if (n === null || n === undefined) return '';
  if (type === 'money') {
    const v = round(n, 2);
    return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// ---- queries ----

export class QueryError extends Error {
  constructor(message) { super(message); this.name = 'QueryError'; }
}

export function findColumn(table, name) {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) throw new QueryError('A column name is missing.');
  let i = table.columns.findIndex((c) => c.name.toLowerCase() === want);
  if (i < 0) i = table.columns.findIndex((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === want.replace(/[^a-z0-9]/g, ''));
  if (i < 0) throw new QueryError(`No column "${String(name).slice(0, 80)}" in ${table.name}. The columns are: ${table.columns.map((c) => c.name).join(', ')}.`);
  return i;
}

function isoWeek(d) {
  const t = new Date(`${d}T12:00:00Z`);
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow);
  return t.toISOString().slice(0, 10);
}

export function bucketOf(v, bucket) {
  if (v === null || !isIsoDay(String(v))) return null;
  const y = v.slice(0, 4), m = +v.slice(5, 7);
  if (bucket === 'day') return v;
  if (bucket === 'week') return isoWeek(v);
  if (bucket === 'month') return v.slice(0, 7);
  if (bucket === 'quarter') return `${y} Q${Math.ceil(m / 3)}`;
  if (bucket === 'year') return y;
  return v;
}

function compareValue(type, v) {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'money' || type === 'number') { const n = readNumber(v); return n ? n.n : null; }
  if (type === 'date') return readDate(v) || String(v).trim();
  return String(v).trim().toLowerCase();
}

function makeFilter(table, f) {
  const i = findColumn(table, f.column);
  const type = table.columns[i].type;
  const op = OPS.includes(f.op) ? f.op : 'eq';
  const a = compareValue(type, f.value);
  const b = compareValue(type, f.value2);
  const list = (Array.isArray(f.values) ? f.values : []).map((v) => compareValue(type, v));
  const needs = ['gt', 'gte', 'lt', 'lte', 'between'];
  if (needs.includes(op) && a === null) throw new QueryError(`The filter on ${table.columns[i].name} needs a value.`);
  if (op === 'between' && b === null) throw new QueryError(`The filter on ${table.columns[i].name} needs two values.`);
  const text = type === 'text';
  const desc = { eq: 'is', ne: 'is not', contains: 'contains', not_contains: 'does not contain', gt: 'is over', gte: 'is at least', lt: 'is under', lte: 'is at most', between: 'is between', in: 'is one of', empty: 'is empty', not_empty: 'is filled' }[op];
  const shown = op === 'between' ? `${f.value} and ${f.value2}` : op === 'in' ? list.join(', ') : ['empty', 'not_empty'].includes(op) ? '' : String(f.value ?? '');
  // A date filter given as a month or a year covers the whole of it.
  const datePrefix = type === 'date' && ['eq', 'ne'].includes(op) && /^\d{4}(-\d{2})?$/.test(String(f.value ?? '').trim()) ? String(f.value).trim() : null;
  const test = (raw) => {
    const v = raw === null || raw === undefined ? null : (text ? String(raw).trim().toLowerCase() : raw);
    switch (op) {
      case 'empty': return v === null || v === '';
      case 'not_empty': return !(v === null || v === '');
      case 'eq': return datePrefix ? v !== null && String(v).startsWith(datePrefix) : v === a;
      case 'ne': return datePrefix ? !(v !== null && String(v).startsWith(datePrefix)) : v !== a;
      case 'contains': return v !== null && String(v).toLowerCase().includes(String(f.value ?? '').trim().toLowerCase());
      case 'not_contains': return v === null || !String(v).toLowerCase().includes(String(f.value ?? '').trim().toLowerCase());
      case 'in': return list.includes(v);
      case 'gt': return v !== null && v > a;
      case 'gte': return v !== null && v >= a;
      case 'lt': return v !== null && v < a;
      case 'lte': return v !== null && v <= a;
      case 'between': return v !== null && v >= a && v <= b;
      default: return true;
    }
  };
  return { i, test, text: `${table.columns[i].name} ${desc}${shown ? ` ${shown}` : ''}` };
}

function measureOf(table, m) {
  const fn = MEASURES.includes(m?.fn) ? m.fn : null;
  if (!fn) throw new QueryError(`Unknown measure "${String(m?.fn).slice(0, 30)}". Use one of: ${MEASURES.join(', ')}.`);
  if (fn === 'count' && !m.column) return { fn, i: -1, type: 'number', name: m.as || 'Rows' };
  const i = findColumn(table, m.column);
  const col = table.columns[i];
  if (['sum', 'avg', 'median'].includes(fn) && col.type !== 'money' && col.type !== 'number') throw new QueryError(`${col.name} is not a number column, so it cannot be ${fn === 'sum' ? 'added up' : 'averaged'}.`);
  const label = { sum: 'Total', avg: 'Average', count: 'Count of', count_distinct: 'Different', min: 'Lowest', max: 'Highest', median: 'Median' }[fn];
  const type = fn === 'count' || fn === 'count_distinct' ? 'number' : col.type;
  return { fn, i, type, name: String(m.as || `${label} ${col.name}`).slice(0, 80) };
}

function aggregate(mz, rows) {
  if (mz.fn === 'count') return mz.i < 0 ? rows.length : rows.filter((r) => r[mz.i] !== null && r[mz.i] !== '').length;
  const vals = rows.map((r) => r[mz.i]).filter((v) => v !== null && v !== '');
  if (mz.fn === 'count_distinct') return new Set(vals.map(String)).size;
  if (!vals.length) return null;
  const money = mz.type === 'money';
  if (mz.fn === 'sum') return money ? vals.reduce((t, n) => t + cents(n), 0) / 100 : round(vals.reduce((t, n) => t + n, 0));
  if (mz.fn === 'avg') return money ? Math.round(vals.reduce((t, n) => t + cents(n), 0) / vals.length) / 100 : round(vals.reduce((t, n) => t + n, 0) / vals.length, 4);
  if (mz.fn === 'median') return money ? round(median(vals), 2) : median(vals);
  if (mz.fn === 'min') return vals.reduce((a, b) => (b < a ? b : a));
  if (mz.fn === 'max') return vals.reduce((a, b) => (b > a ? b : a));
  return null;
}

// spec: { filters: [{ column, op, value, value2, values }],
//         group_by: [{ column, bucket }], measures: [{ fn, column, as }],
//         share: bool (each group's part of the first measure, as a percent),
//         columns: [names] (rows as they are, when nothing is grouped),
//         sort: { by, dir }, limit }
// Returns { columns: [{ name, type }], rows, matched, groups, truncated, how }.
export function runQuery(table, spec = {}) {
  const filters = (Array.isArray(spec.filters) ? spec.filters : []).slice(0, 12).map((f) => makeFilter(table, f));
  const matchedRows = table.rows.filter((r) => filters.every((f) => f.test(r[f.i])));
  const limit = Math.max(1, Math.min(MAX_RESULT_ROWS, Number.isInteger(spec.limit) ? spec.limit : 50));
  const groups = (Array.isArray(spec.group_by) ? spec.group_by : []).slice(0, 3).map((g) => {
    const i = findColumn(table, g.column);
    const col = table.columns[i];
    const bucket = col.type === 'date' && BUCKETS.includes(g.bucket) ? g.bucket : (col.type === 'date' ? 'day' : null);
    const name = bucket && bucket !== 'day' ? `${col.name} (${bucket})` : col.name;
    return { i, bucket, name, type: bucket && bucket !== 'day' ? 'text' : col.type, col };
  });
  let measures = (Array.isArray(spec.measures) ? spec.measures : []).slice(0, 6).map((m) => measureOf(table, m));
  const where = filters.length ? `, where ${filters.map((f) => f.text).join(' and ')}` : '';
  let columns; let rows; let how;

  if (!groups.length && !measures.length) {
    // The rows themselves.
    const pick = (Array.isArray(spec.columns) && spec.columns.length ? spec.columns : table.columns.map((c) => c.name)).slice(0, 20).map((n) => findColumn(table, n));
    columns = pick.map((i) => ({ name: table.columns[i].name, type: table.columns[i].type }));
    rows = matchedRows.map((r) => pick.map((i) => r[i]));
    how = `The rows of ${table.name}${where}`;
  } else {
    if (!measures.length) measures = [measureOf(table, { fn: 'count' })];
    const buckets = new Map();
    for (const r of matchedRows) {
      const key = groups.map((g) => {
        const v = r[g.i];
        if (v === null || v === '') return '(blank)';
        if (g.bucket) return bucketOf(v, g.bucket) ?? '(blank)';
        return g.type === 'text' ? String(v).trim() : v;
      });
      const k = JSON.stringify(groups.map((g, n) => (g.type === 'text' ? String(key[n]).toLowerCase() : key[n])));
      if (!buckets.has(k)) buckets.set(k, { key, rows: [] });
      buckets.get(k).rows.push(r);
    }
    columns = [...groups.map((g) => ({ name: g.name, type: g.type })), ...measures.map((m) => ({ name: m.name, type: m.type }))];
    rows = [...buckets.values()].map((b) => [...b.key, ...measures.map((m) => aggregate(m, b.rows))]);
    if (spec.share && measures.length) {
      const k = groups.length;
      const totalCents = rows.reduce((t, r) => t + cents(r[k] || 0), 0);
      columns.push({ name: `Share of ${measures[0].name}`, type: 'percent' });
      for (const r of rows) r.push(totalCents ? round((cents(r[k] || 0) / totalCents) * 100, 1) : null);
    }
    const mtext = measures.map((m) => (m.fn === 'count' && m.i < 0 ? 'the number of rows' : `the ${{ sum: 'total', avg: 'average', count: 'count', count_distinct: 'number of different values', min: 'lowest', max: 'highest', median: 'median' }[m.fn]} of ${table.columns[m.i].name}`)).join(', ');
    how = `${mtext[0].toUpperCase()}${mtext.slice(1)}${groups.length ? ` for each ${groups.map((g) => (g.bucket && g.bucket !== 'day' ? `${g.bucket} of ${g.col.name}` : g.col.name)).join(' and ')}` : ''} in ${table.name}${where}`;
  }
  // Sorting: what was asked, else time in order, else the largest first.
  const sortBy = spec.sort?.by ? columns.findIndex((c) => c.name.toLowerCase() === String(spec.sort.by).toLowerCase()) : -1;
  const timeFirst = groups.length && (groups[0].bucket || groups[0].type === 'date');
  const idx = sortBy >= 0 ? sortBy : (groups.length ? (timeFirst ? 0 : groups.length) : -1);
  const dir = spec.sort?.dir === 'asc' || spec.sort?.dir === 'desc' ? spec.sort.dir : (sortBy < 0 && timeFirst ? 'asc' : (sortBy >= 0 ? 'asc' : 'desc'));
  if (idx >= 0) {
    const sign = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const x = a[idx], y = b[idx];
      if (x === y) return 0;
      if (x === null || x === '(blank)') return 1;
      if (y === null || y === '(blank)') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * sign;
    });
  }
  const total = rows.length;
  const truncated = total > limit;
  if (truncated) rows = rows.slice(0, limit);
  if (spec.sort?.by && sortBy >= 0) how += `, ${dir === 'asc' ? 'smallest' : 'largest'} ${columns[sortBy].name} first`;
  if (truncated) how += `, the first ${limit} of ${total}`;
  return { table: table.name, columns, rows, matched: matchedRows.length, groups: total, truncated, how: `${how}.` };
}

// A grouped result folded to its largest `keep` groups and "Other", for a chart.
export function fold(result, keep = 10) {
  const k = result.columns.findIndex((c) => c.type === 'money' || c.type === 'number');
  if (k < 1 || result.rows.length <= keep + 1) return result;
  const head = result.rows.slice(0, keep);
  const rest = result.rows.slice(keep);
  const other = result.columns.map((c, i) => {
    if (i < k) return i === 0 ? `Other (${rest.length})` : '';
    if (c.type === 'money') return rest.reduce((t, r) => t + cents(r[i] || 0), 0) / 100;
    if (c.type === 'number') return round(rest.reduce((t, r) => t + (r[i] || 0), 0));
    return null;
  });
  return { ...result, rows: [...head, other], folded: rest.length };
}

// ---- arithmetic on computed figures ----

// + - * / and parentheses on plain numbers. No names, no functions.
export function calculate(expression) {
  const src = String(expression ?? '').replace(/[$,\s]/g, '').replace(/[−–]/g, '-');
  if (!src || src.length > 300 || !/^[-+*/().\d%]+$/.test(src)) throw new QueryError('Use only numbers, + - * / and parentheses.');
  let i = 0;
  const peek = () => src[i];
  function num() {
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) throw new QueryError('That calculation could not be read.');
    i += m[0].length;
    let n = Number(m[0]);
    if (peek() === '%') { i++; n /= 100; }
    return n;
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') throw new QueryError('A parenthesis is not closed.'); i++; return v; }
    return num();
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = factor();
      if (op === '/' && r === 0) throw new QueryError('That divides by zero.');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  const v = expr();
  if (i !== src.length || !Number.isFinite(v)) throw new QueryError('That calculation could not be read.');
  return round(v, 6);
}

// ---- figures in an answer ----

// Every figure written in a piece of text: { raw, value, decimals, scale, pct }.
// Dates, years and small counts are not figures.
export function figuresIn(text) {
  const src = String(text || '')
    .replace(/\b\d{4}-\d{2}(-\d{2})?\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/\b(Q[1-4]|FY\s?\d{2,4})\b/gi, ' ');
  const out = [];
  const re = /(-|−)?(?:(\$)\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|percent\b|k\b|K\b|thousand\b|M\b|million\b|mn\b|B\b|billion\b)?/g;
  let m;
  while ((m = re.exec(src))) {
    const before = src[m.index - 1] || '';
    if (/[A-Za-z_]/.test(before)) continue;
    const whole = m[3].replace(/,/g, '');
    const decimals = m[4] ? m[4].length - 1 : 0;
    const value = Number(`${whole}${m[4] || ''}`);
    const unit = (m[5] || '').toLowerCase();
    const scale = ['k', 'thousand'].includes(unit) ? 1e3 : ['m', 'million', 'mn'].includes(unit) ? 1e6 : ['b', 'billion'].includes(unit) ? 1e9 : 1;
    const pct = unit === '%' || unit === 'percent';
    const dollar = Boolean(m[2]);
    if (!dollar && !pct && scale === 1 && !m[4] && !m[3].includes(',') && value < 100) continue;
    if (!dollar && !pct && scale === 1 && !m[4] && value >= 1900 && value <= 2100) continue;
    out.push({ raw: m[0].trim(), value, decimals, scale, pct });
  }
  return out;
}

// Every number a computation produced or the person's data states, for the check.
export function knownNumbers({ results = [], extra = [] } = {}) {
  const out = [];
  const add = (v) => { if (typeof v === 'number' && Number.isFinite(v)) out.push(v); };
  for (const r of results) {
    if (typeof r === 'number') { add(r); continue; }
    add(r?.matched); add(r?.groups);
    for (const row of r?.rows || []) for (const v of row) {
      if (typeof v === 'number') add(v);
      else if (typeof v === 'string') for (const f of figuresIn(v)) add(f.value * f.scale);
    }
  }
  for (const v of extra) add(v);
  return out;
}

// The figures in `text` no known number accounts for (rounded as written,
// in thousands or millions, as a percent or a share).
export function uncheckedFigures(text, known) {
  const vals = known.map((v) => Math.abs(v));
  const fits = (f) => {
    const target = f.value;
    const tol = 0.5 * 10 ** -f.decimals + 1e-9;
    return vals.some((v) => {
      const cands = [v / f.scale];
      if (f.pct) cands.push(v * 100);
      return cands.some((c) => Math.abs(c - target) <= tol);
    });
  };
  return figuresIn(text).filter((f) => !fits(f)).map((f) => f.raw);
}

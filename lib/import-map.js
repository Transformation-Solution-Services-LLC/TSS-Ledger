// Column mapping for spreadsheet imports. The sheet's own column names are
// read, each field the app takes is matched to a column by name (the person
// can change any match before importing), and every row becomes an object
// keyed by the app's field ids. No DOM and no store: tests import it.

import { parseCsv, normalizeHeader } from './csv.js';

export const MAX_ROWS = 5000;

// { headers: ['First Name', ...], rows: [['Dana', ...], ...] }, every row as
// long as the header.
export function readSheet(text) {
  const [header = [], ...rows] = parseCsv(text);
  const headers = header.map((h) => String(h).trim());
  return { headers, rows: rows.map((r) => headers.map((_, i) => String(r[i] ?? '').trim())) };
}

// The first match for each field: its own id, then its aliases, compared as
// normalized headers ("First Name" = "first_name"). Each column is used once.
// fields: [{ id, aliases }]. Returns { fieldId: columnIndex }.
export function guessMapping(headers, fields) {
  const norm = headers.map(normalizeHeader);
  const taken = new Set();
  const mapping = {};
  for (const f of fields) {
    const names = [f.id, ...(f.aliases || [])].map(normalizeHeader);
    const i = norm.findIndex((h, idx) => h && !taken.has(idx) && names.includes(h));
    if (i >= 0) { mapping[f.id] = i; taken.add(i); }
  }
  return mapping;
}

// The mapping a person sent, kept only where it names a real field and a real
// column. Unset (null or not an object) means "guess".
export function cleanMapping(given, headers, fields) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return guessMapping(headers, fields);
  const ids = new Set(fields.map((f) => f.id));
  const out = {};
  for (const [id, v] of Object.entries(given)) {
    if (v === null || v === '' || v === undefined) continue;
    const i = Number(v);
    if (ids.has(id) && Number.isInteger(i) && i >= 0 && i < headers.length) out[id] = i;
  }
  return out;
}

// Each row as { fieldId: value } through the mapping. Unmapped fields are absent.
export function mappedRows(sheet, mapping) {
  const entries = Object.entries(mapping);
  return sheet.rows.map((r) => Object.fromEntries(entries.map(([id, i]) => [id, r[i] ?? ''])));
}

// Up to three different values from each column, to show beside the mapping.
export function samples(sheet) {
  return sheet.headers.map((_, i) => [...new Set(sheet.rows.map((r) => r[i]).filter(Boolean))].slice(0, 3));
}

// What the preview route answers: the columns, the fields, the first guess.
export function previewOf(sheet, fields) {
  return {
    headers: sheet.headers,
    rows: sheet.rows.length,
    samples: samples(sheet),
    fields: fields.map(({ id, label, required, hint }) => ({ id, label, required: Boolean(required), hint: hint || '' })),
    mapping: guessMapping(sheet.headers, fields),
  };
}

// Lower-case, single spaces, no punctuation: "Ortiz,  Dana." = "ortiz dana".
export const nameKey = (...parts) => parts.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// Digits only, the last ten: "(541) 555-0100" = "5415550100".
export const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// A date as people type it, as YYYY-MM-DD: 2026-03-31, 2026/3/31, 3/31/2026,
// 3/31/26 (US order, as Excel and Google Sheets export), or "March 31, 2026".
// Anything else is returned as given, so the field check names the problem.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function readDay(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const ok = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : s;
  };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) { let y = +m[3]; if (m[3].length === 2) y += y > 50 ? 1900 : 2000; return ok(y, +m[1], +m[2]); }
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) return ok(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return s;
}

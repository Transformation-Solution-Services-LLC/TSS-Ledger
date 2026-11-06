// An uploaded file, read into what Ledger can work with: a spreadsheet's
// sheets as rows of cells, a document's text. Nothing else of the file is
// kept: the bytes are read here and dropped.
//
// Spreadsheets: CSV and tab-separated text read as they are; Excel (.xlsx)
// through exceljs, every worksheet, each cell as its shown value (a formula
// as its result, a date as YYYY-MM-DD). Documents: PDF through unpdf, Word
// (.docx) through mammoth, text as it is. The same readers as Library and
// Watson.

import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { parseCsv } from '../lib/csv.js';
import { PublicError } from '../lib/public-error.js';

export const MAX_FILES = 25;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_SHEET_ROWS = 20000;
export const MAX_TEXT = 200000;

const bad = (message) => new PublicError(400, 'bad_file', message);

// The kind of file, by its name first (browsers send odd types for CSV).
export function kindOf(name, type = '') {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (['csv'].includes(ext)) return 'csv';
  if (['tsv', 'tab'].includes(ext)) return 'tsv';
  if (['xlsx', 'xlsm'].includes(ext)) return 'xlsx';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['txt', 'text', 'md'].includes(ext)) return 'text';
  if (ext === 'xls') return 'xls';
  const t = String(type || '').toLowerCase();
  if (t.includes('csv')) return 'csv';
  if (t.includes('pdf')) return 'pdf';
  if (t.includes('spreadsheetml')) return 'xlsx';
  if (t.includes('wordprocessingml')) return 'docx';
  if (t.startsWith('text/')) return 'text';
  return '';
}

const tidy = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// One Excel cell as the text a person sees.
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : isoDay(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('');
    if ('text' in v) return String(v.text ?? '');
    if ('error' in v) return '';
    return '';
  }
  return String(v);
}

const trimRows = (rows) => {
  const out = rows.map((r) => r.map((c) => String(c ?? '').trim()));
  while (out.length && out[out.length - 1].every((c) => !c)) out.pop();
  const width = out.reduce((w, r) => { let n = r.length; while (n && !r[n - 1]) n--; return Math.max(w, n); }, 0);
  return out.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
};

async function readXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (_) { throw bad('That Excel file could not be read. Save it again as .xlsx or CSV.'); }
  const sheets = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > MAX_SHEET_ROWS + 1) return;
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => { cells[c - 1] = cellText(cell.value); });
      rows[n - 1] = cells;
    });
    const filled = trimRows(Array.from({ length: rows.length }, (_, i) => rows[i] || []));
    if (filled.some((r) => r.some(Boolean))) sheets.push({ name: ws.name, rows: filled });
  });
  return sheets;
}

function readDelimited(text, sep) {
  const src = sep === '\t' ? String(text).split(/\r?\n/).map((l) => l.split('\t')) : parseCsv(text, { keepBlank: true });
  return trimRows(src.slice(0, MAX_SHEET_ROWS + 1));
}

// { name, kind, sheets: [{ name, rows }] } for a spreadsheet,
// { name, kind, text, pages } for a document.
export async function readFile({ name, type = '', data }) {
  const fileName = String(name || 'file').slice(0, 200);
  const kind = kindOf(fileName, type);
  if (kind === 'xls') throw bad(`${fileName}: save older Excel files (.xls) as .xlsx or CSV first.`);
  if (!kind) throw bad(`${fileName}: upload spreadsheets (Excel, CSV) or documents (PDF, Word, text).`);
  let buf;
  try { buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64'); } catch (_) { buf = null; }
  if (!buf || !buf.length) throw bad(`${fileName} is empty.`);
  if (buf.length > MAX_FILE_BYTES) throw bad(`${fileName} is larger than 10 MB.`);

  if (kind === 'xlsx') {
    const sheets = await readXlsx(buf);
    if (!sheets.length) throw bad(`${fileName} has no filled sheets.`);
    return { name: fileName, kind: 'sheet', sheets };
  }
  if (kind === 'csv' || kind === 'tsv') {
    const rows = readDelimited(buf.toString('utf8').replace(/^﻿/, ''), kind === 'tsv' ? '\t' : ',');
    if (!rows.length) throw bad(`${fileName} is empty.`);
    return { name: fileName, kind: 'sheet', sheets: [{ name: '', rows }] };
  }
  let text = '';
  let pages = null;
  if (kind === 'pdf') {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const out = await extractText(pdf, { mergePages: false });
      const list = Array.isArray(out.text) ? out.text : [String(out.text || '')];
      pages = list.length;
      text = list.map((t, i) => `[page ${i + 1}]\n${tidy(t)}`).join('\n\n');
    } catch (_) { throw bad(`${fileName}: that PDF could not be read.`); }
  } else if (kind === 'docx') {
    try { text = (await mammoth.extractRawText({ buffer: buf })).value || ''; } catch (_) { throw bad(`${fileName}: that Word document could not be read.`); }
  } else {
    text = buf.toString('utf8');
  }
  text = tidy(text).slice(0, MAX_TEXT);
  if (text.replace(/\[page \d+\]/g, '').trim().length < 20) throw bad(`${fileName} has almost no readable text. If it is a scan, upload a text version.`);
  return { name: fileName, kind: 'document', text, pages };
}

// Every file, read; refuses the whole upload when any one cannot be read, so
// nothing is half understood.
export async function readFiles(files) {
  if (!Array.isArray(files) || !files.length) throw bad('Choose at least one file.');
  if (files.length > MAX_FILES) throw bad(`Upload at most ${MAX_FILES} files at a time.`);
  let total = 0;
  for (const f of files) total += Math.floor(String(f?.data || '').length * 0.75);
  if (total > MAX_TOTAL_BYTES) throw bad('Upload at most 40 MB at a time.');
  const out = [];
  const names = new Set();
  for (const f of files) {
    const r = await readFile(f || {});
    let n = r.name; let i = 2;
    while (names.has(n)) n = `${r.name} (${i++})`;
    names.add(n);
    out.push({ ...r, name: n });
  }
  return out;
}

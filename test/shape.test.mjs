// Reading a pile of files through a proposed shape: Ledger reads every
// figure itself, and says what does not fit.

import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { labelFiles, digest, buildPlan, checkedAward, planText } from '../lib/shape.js';
import { readFile, readFiles, kindOf, cellText } from '../services/extract.js';
import { messyPile, messyShape } from './fixtures/pile.mjs';

test('every sheet and document gets an id, and the digest shows them with their rows', () => {
  const files = messyPile();
  assert.deepEqual(files[0].sheets.map((s) => s.id), ['S1']);
  assert.deepEqual(files[1].sheets.map((s) => s.id), ['S2', 'S3']);
  assert.equal(files[2].id, 'D1');
  const d = digest(files);
  assert.match(d, /\[S1\] file "QuickBooks export.csv": 9 rows, 6 columns/);
  assert.match(d, /\[S2\] file "Budgets.xlsx", sheet "Youth Diversion"/);
  assert.match(d, /row 4: 01\/31\/2026 \| Staffing Co/);
  assert.match(d, /\[D1\] document "Award letter.txt"/);
  const big = labelFiles([{ name: 'big.csv', kind: 'sheet', sheets: [{ name: '', rows: Array.from({ length: 5000 }, (_, i) => [`2026-01-01`, String(i), 'x'.repeat(40)]) }] }]);
  const short = digest(big, { limit: 20000 });
  assert.ok(short.length <= 20000);
  assert.match(short, /rows not shown/);
});

test('Ledger reads the figures through the shape: sign, totals, income and other funds left out', () => {
  const plan = buildPlan(messyShape(), messyPile(), { today: '2026-06-30' });
  assert.deepEqual(plan.problems, []);
  const yd = plan.funds.find((f) => f.ref === 'F1');
  assert.equal(yd.award, 24000);
  assert.equal(yd.award_checked, true);
  assert.equal(yd.start_on, '2026-01-01');
  assert.deepEqual(plan.entries.map((e) => [e.fund_ref, e.date, e.amount]), [['F1', '2026-01-31', 3000], ['F1', '2026-02-14', 450], ['F2', '2026-03-01', 1200]]);
  assert.deepEqual(plan.entries.map((e) => e.line_name), ['Personnel', 'Supplies', ''], 'account "6000 Personnel" finds the budget line by its code');
  assert.deepEqual(plan.budget.map((b) => [b.name, b.code, b.amount]), [['Personnel', '6000', 18000], ['Supplies', '6400', 3000]]);
  const reasons = plan.skipped.map((s) => `${s.at.split('row ').pop()}: ${s.reason}`);
  assert.deepEqual(reasons, ['4: A total or heading row', '6: A total or heading row', '8: "General" is not one of these grants', '9: A total or heading row']);
  const t = plan.totals.find((x) => x.ref === 'F1');
  assert.deepEqual([t.entries, t.spent, t.budget_lines, t.budget, t.on_lines], [2, 3450, 2, 21000, 2]);
  assert.equal(plan.sheets.find((s) => s.sheet === 'S3').use, 'ignore');
  assert.match(planText(plan), /F1 "Youth Diversion": 2 budget lines totaling \$21000.00; 2 spending entries totaling \$3450.00/);
});

test('an award is kept only when its quote is in the document and holds that amount', () => {
  const files = messyPile();
  assert.equal(checkedAward(messyShape().funds[0], files), 24000);
  assert.equal(checkedAward(messyShape({ award: '$25,000' }).funds[0], files), null, 'a different figure');
  assert.equal(checkedAward(messyShape({ quote: 'a grant of $24,000 for the whole year' }).funds[0], files), null, 'a quote not in the document');
  const plan = buildPlan(messyShape({ award: '$25,000' }), files, {});
  assert.equal(plan.funds[0].award, 0);
  assert.match(plan.problems.join(' '), /award for "Youth Diversion" \(\$25,000\) is not stated/);
});

test('a shape that does not fit the files says where', () => {
  const s = messyShape();
  s.sheets[0].columns.amount = 'Total';
  s.sheets[1].fund = 'F9';
  s.sheets.pop();
  s.funds[0].existing_id = '00000000-0000-0000-0000-000000000000';
  const plan = buildPlan(s, messyPile(), {});
  const p = plan.problems.join('\n');
  assert.match(p, /no column "Total" in row 3/);
  assert.match(p, /spending needs an amount column/);
  assert.match(p, /goes to a grant \(F9\)/);
  assert.match(p, /sheet "Notes" is not described/);
  assert.match(p, /points at a grant Ledger does not have/);
});

test('an existing grant keeps its record, and spending lands on its budget lines', () => {
  const s = messyShape();
  const own = { id: 'f-yd', name: 'Youth Diversion (Meyer)', kind: 'grant', funder: 'Meyer', code: 'YD', award: 24000, start_on: '2026-01-01', end_on: '2026-12-31' };
  s.funds[0].existing_id = 'f-yd';
  const plan = buildPlan(s, messyPile(), { funds: [own], lines: [{ id: 'l1', fund_id: 'f-yd', name: 'Personnel', code: '6000' }], today: '2026-06-30' });
  assert.equal(plan.funds[0].existing, true);
  assert.equal(plan.funds[0].name, 'Youth Diversion (Meyer)');
  assert.deepEqual(plan.entries.filter((e) => e.fund_ref === 'F1').map((e) => e.line_name), ['Personnel', 'Supplies']);
});

test('spreadsheets and documents are read from their bytes', async () => {
  assert.equal(kindOf('a.CSV'), 'csv');
  assert.equal(kindOf('b.xlsx'), 'xlsx');
  assert.equal(kindOf('c'), '');
  for (const n of ['notes.md', 'NOTES.MD', 'notes.markdown']) assert.equal(kindOf(n, 'application/octet-stream'), 'text', n);
  assert.equal(kindOf('notes', 'text/x-markdown'), 'text');
  assert.equal((await readFile({ name: 'award.md', type: '', data: Buffer.from('# Award\n\nThe grant is $50,000.') })).text, '# Award\n\nThe grant is $50,000.');
  assert.equal(cellText(new Date(Date.UTC(2026, 2, 31))), '2026-03-31');
  assert.equal(cellText({ formula: 'A1+A2', result: 0.1 + 0.2 }), '0.3');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Spending');
  ws.addRow(['Date', 'Payee', 'Amount']);
  ws.addRow([new Date(Date.UTC(2026, 0, 31)), 'Staffing Co', 3000]);
  ws.addRow([new Date(Date.UTC(2026, 1, 2)), { richText: [{ text: 'Office ' }, { text: 'Depot' }] }, { formula: '400+50', result: 450 }]);
  wb.addWorksheet('Empty');
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  const read = await readFile({ name: 'Books.xlsx', data: xlsx.toString('base64') });
  assert.equal(read.kind, 'sheet');
  assert.deepEqual(read.sheets.map((s) => s.name), ['Spending'], 'an empty sheet is left out');
  assert.deepEqual(read.sheets[0].rows, [['Date', 'Payee', 'Amount'], ['2026-01-31', 'Staffing Co', '3000'], ['2026-02-02', 'Office Depot', '450']]);
  const csv = await readFile({ name: 'x.csv', data: Buffer.from('﻿a,b\n1,"2,000"\n').toString('base64') });
  assert.deepEqual(csv.sheets[0].rows, [['a', 'b'], ['1', '2,000']]);
  const doc = await readFile({ name: 'letter.txt', data: Buffer.from('We award you $5,000 for the year.').toString('base64') });
  assert.equal(doc.kind, 'document');
  await assert.rejects(readFile({ name: 'old.xls', data: 'AAAA' }), /save older Excel files/);
  await assert.rejects(readFile({ name: 'a.exe', data: 'AAAA' }), /upload spreadsheets/);
  await assert.rejects(readFile({ name: 'bad.xlsx', data: Buffer.from('not a zip').toString('base64') }), /could not be read/);
  const two = await readFiles([{ name: 'x.csv', data: Buffer.from('a\n1').toString('base64') }, { name: 'x.csv', data: Buffer.from('a\n2').toString('base64') }]);
  assert.deepEqual(two.map((f) => f.name), ['x.csv', 'x.csv (2)']);
  await assert.rejects(readFiles([]), /at least one file/);
});

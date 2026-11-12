// Spreadsheets into tables, charts and computed answers (lib/dataset.js),
// against sheets as people really export them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from '../services/extract.js';
import * as D from '../lib/dataset.js';
import { QB_DETAIL, BANK, MESSY, budgetWorkbook, b64 } from './fixtures/sheets.mjs';

const tablesOf = async (name, data) => D.buildTables(await readFile({ name, data }));

test('a QuickBooks report: title rows skipped, section headings kept as a column, total rows left out', async () => {
  const [t] = await tablesOf('qb.csv', b64(QB_DETAIL));
  assert.deepEqual(t.columns.map((c) => `${c.name}:${c.type}`), ['Section:text', 'Date:date', 'Transaction Type:text', 'Num:number', 'Name:text', 'Memo/Description:text', 'Amount:money']);
  assert.equal(t.rows.length, 7, 'seven transactions; the report footer is not one');
  assert.deepEqual(t.rows[4], ['6400 Supplies', '2026-03-02', 'Credit Card Credit', null, 'Office Depot', 'Returned binders', -50], 'a refund in parentheses is negative');
  assert.match(t.notes.join(' '), /4 total rows left out/);
  const total = D.runQuery(t, { measures: [{ fn: 'sum', column: 'Amount' }] });
  assert.equal(total.rows[0][0], 9858.85, 'the same total as the report, with nothing counted twice');
  const bySection = D.runQuery(t, { group_by: [{ column: 'Section' }], measures: [{ fn: 'sum', column: 'Amount' }] });
  assert.deepEqual(bySection.rows, [['6000 Personnel', 9250.5], ['6400 Supplies', 520.25], ['6800 Travel', 88.1]]);
  assert.equal(bySection.how, 'The total of Amount for each Section in qb.');
});

test('a bank export: dates as 1/3/26, debit and credit apart, the running balance never summed for a chart', async () => {
  const [t] = await tablesOf('bank.csv', b64(BANK));
  assert.equal(t.rows[0][0], '2026-01-03');
  const charts = D.autoCharts(t);
  assert.equal(charts[0].title, 'Debit by month');
  assert.ok(!charts.some((c) => /Balance/.test(c.title)));
  const m = D.runQuery(t, charts[0].spec);
  assert.deepEqual(m.rows, [['2026-01', 1712.4], ['2026-02', 2298.1], ['2026-03', 2100]]);
});

test('a messy sheet: blank and repeated headers named, a stray cell read as empty and said so', async () => {
  const [t] = await tablesOf('messy.csv', b64(MESSY));
  assert.deepEqual(t.columns.map((c) => c.name), ['Site', 'Column 2', 'Visits', 'Visits (2)', 'Cost']);
  assert.equal(t.rows.length, 5, 'the notes row under the table is not data');
  assert.match(t.notes.join(' '), /1 cell did not match the rest of its column/);
  const avg = D.runQuery(t, { measures: [{ fn: 'avg', column: 'Visits' }, { fn: 'count', column: 'Visits' }] });
  assert.deepEqual(avg.rows[0], [16.25, 4], 'n/a is left out of the average, not counted as zero');
});

test('a workbook: every tab, budget against actual charted, months across the top made into rows', async () => {
  const tables = await tablesOf('budget.xlsx', (await budgetWorkbook()).toString('base64'));
  assert.deepEqual(tables.map((t) => [t.name, t.rows.length]), [['Budget vs Actual', 4], ['Monthly plan', 2], ['Monthly plan, by month', 12], ['Participants', 6]]);
  const [bva, , long, people] = tables;
  assert.equal(bva.rows[0][3], 8749.5, 'a formula reads as its result');
  const c = D.autoCharts(bva);
  assert.equal(c[0].type, 'grouped');
  assert.deepEqual(D.runQuery(bva, c[0].spec).rows[0], ['Personnel', 18000, 9250.5]);
  assert.deepEqual(long.columns.map((x) => `${x.name}:${x.type}`), ['Line:text', 'Month:date', 'Value:money']);
  assert.deepEqual(D.runQuery(long, { group_by: [{ column: 'Month', bucket: 'quarter' }], measures: [{ fn: 'sum', column: 'Value' }] }).rows, [['2026 Q1', 10500], ['2026 Q2', 10500]]);
  assert.equal(people.rows[0][0], '2026-01-12', 'Excel dates read as days');
  assert.deepEqual(D.runQuery(people, { filters: [{ column: 'County', op: 'eq', value: 'marion' }], measures: [{ fn: 'count' }, { fn: 'sum', column: 'Sessions' }] }).rows[0], [3, 22], 'text filters ignore case');
});

test('sums are taken in whole cents; filters, months, shares, sorting and limits', () => {
  const t = { name: 'T', columns: [{ name: 'Date', type: 'date' }, { name: 'Who', type: 'text' }, { name: 'Amount', type: 'money' }], rows: [] };
  for (let i = 0; i < 1000; i++) t.rows.push([`2026-0${(i % 3) + 1}-15`, i % 4 ? 'A' : 'B', 0.1]);
  assert.equal(D.runQuery(t, { measures: [{ fn: 'sum', column: 'Amount' }] }).rows[0][0], 100);
  const feb = D.runQuery(t, { filters: [{ column: 'Date', op: 'eq', value: '2026-02' }], measures: [{ fn: 'count' }] });
  assert.equal(feb.rows[0][0], 333, 'a month given as YYYY-MM covers the month');
  const share = D.runQuery(t, { group_by: [{ column: 'Who' }], measures: [{ fn: 'sum', column: 'Amount' }], share: true });
  assert.deepEqual(share.rows, [['A', 75, 75], ['B', 25, 25]]);
  assert.equal(share.columns[2].type, 'percent');
  const top = D.runQuery(t, { group_by: [{ column: 'Date', bucket: 'month' }], measures: [{ fn: 'sum', column: 'Amount' }], sort: { by: 'Total Amount', dir: 'desc' }, limit: 1 });
  assert.equal(top.rows.length, 1);
  assert.equal(top.truncated, true);
  assert.match(top.how, /the first 1 of 3/);
  assert.throws(() => D.runQuery(t, { measures: [{ fn: 'sum', column: 'Who' }] }), /not a number column/);
  assert.throws(() => D.runQuery(t, { group_by: [{ column: 'Nope' }] }), /No column "Nope" in T\. The columns are: Date, Who, Amount/);
  const between = D.runQuery(t, { filters: [{ column: 'Date', op: 'between', value: '2026-01-01', value2: '2026-02-28' }], measures: [{ fn: 'count' }] });
  assert.equal(between.rows[0][0], 667);
});

test('calculate does arithmetic and nothing else', () => {
  assert.equal(D.calculate('(9858.85 - 9250.5) / 9858.85 * 100'), 6.170598);
  assert.equal(D.calculate('$1,200 * 2'), 2400);
  assert.throws(() => D.calculate('process.exit()'), /Use only numbers/);
  assert.throws(() => D.calculate('1/0'), /divides by zero/);
});

test('every figure in an answer must come from a computation', () => {
  const known = D.knownNumbers({ results: [{ rows: [['Personnel', 9250.5], ['Supplies', 520.25]], matched: 7, groups: 2 }, 6.170598] });
  assert.deepEqual(D.uncheckedFigures('Personnel took $9,250.50 (about $9.3K), supplies $520. That is 6.2% more. 7 entries in 2026, on 2026-03-31.', known), []);
  assert.deepEqual(D.uncheckedFigures('Travel came to $1,400 and grew 12%.', known), ['$1,400', '12%']);
  assert.deepEqual(D.figuresIn('3 vendors in Q1 2026, rows 2 to 9').map((f) => f.raw), [], 'small counts, quarters and years are not figures');
});

test('a long tail folds into Other for a chart', () => {
  const r = { columns: [{ name: 'Who', type: 'text' }, { name: 'Total', type: 'money' }], rows: Array.from({ length: 15 }, (_, i) => [`P${i}`, 10.1]) };
  const f = D.fold(r, 10);
  assert.equal(f.rows.length, 11);
  assert.deepEqual(f.rows[10], ['Other (5)', 50.5]);
});

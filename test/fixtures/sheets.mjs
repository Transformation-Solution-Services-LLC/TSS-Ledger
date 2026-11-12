// Spreadsheets as people really export them, for Analyze (test/dataset and
// test/analysis): title rows, section headings, total rows, blank rows,
// money as text, refunds in parentheses, months across the top.

import ExcelJS from 'exceljs';

export const QB_DETAIL = [
  'Transformation Example Org,,,,,,',
  'Transaction Detail by Account,,,,,,',
  '"January - March, 2026",,,,,,',
  ',,,,,,',
  ',Date,Transaction Type,Num,Name,Memo/Description,Amount',
  '6000 Personnel,,,,,,',
  ',01/31/2026,Payroll Check,1001,Staffing Co,January payroll,"$3,000.00"',
  ',02/28/2026,Payroll Check,1002,Staffing Co,February payroll,"$3,000.00"',
  ',03/31/2026,Payroll Check,1003,Staffing Co,March payroll,"$3,250.50"',
  'Total for 6000 Personnel,,,,,,"$9,250.50"',
  '6400 Supplies,,,,,,',
  ',02/14/2026,Expense,,Office Depot,Workbooks,450.00',
  ',03/02/2026,Credit Card Credit,,Office Depot,Returned binders,(50.00)',
  ',03/20/2026,Expense,,Amazon,Snacks for circles,120.25',
  'Total for 6400 Supplies,,,,,,520.25',
  '6800 Travel,,,,,,',
  ',03/05/2026,Expense,,Shell,Mileage to Salem,88.10',
  'Total for 6800 Travel,,,,,,88.10',
  'TOTAL,,,,,,"$9,858.85"',
  ',,,,,,',
  '"Accrual Basis Thursday, April 2, 2026 10:14 AM GMT-07:00",,,,,,',
].join('\n');

export const BANK = [
  'Date,Description,Debit,Credit,Balance',
  '1/3/26,DEPOSIT MEYER TRUST,,"12,000.00","15,000.00"',
  '1/5/26,PGE UTILITY,212.40,,"14,787.60"',
  '1/9/26,CHECK 2231,1500.00,,"13,287.60"',
  '2/1/26,RENT FEB,"2,100.00",,"11,187.60"',
  '2/3/26,PGE UTILITY,198.10,,"10,989.50"',
  '3/1/26,RENT MAR,"2,100.00",,"8,889.50"',
].join('\n');

// Blank and repeated headers, "n/a" in a number column, a stray note row.
export const MESSY = [
  'Site visits FY26 (draft, do not share)',
  'Site,,Visits,Visits,Cost',
  'Salem,North,12,3,$400',
  'Eugene,,n/a,4,$1250',
  'Portland,East,30,2,"$2,000.10"',
  'Portland,West,8,,$75',
  'Bend,,15,1,',
  'Notes: two Portland visits were virtual',
].join('\n');

export async function budgetWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget vs Actual');
  ws.addRow(['Youth Diversion: budget against actual']);
  ws.addRow([]);
  ws.addRow(['Line', 'Budget', 'Actual', 'Variance']);
  ws.addRow(['Personnel', 18000, 9250.5, { formula: 'B4-C4', result: 8749.5 }]);
  ws.addRow(['Supplies', 3000, 520.25, { formula: 'B5-C5', result: 2479.75 }]);
  ws.addRow(['Travel', 1200, 88.1, { formula: 'B6-C6', result: 1111.9 }]);
  ws.addRow(['Evaluation', 2000, 0, { formula: 'B7-C7', result: 2000 }]);
  ws.addRow([]);
  ws.addRow(['Total', 24200, 9858.85, 14341.15]);
  const m = wb.addWorksheet('Monthly plan');
  m.addRow(['Line', 'Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26', 'Jun-26', 'FY Total']);
  m.addRow(['Personnel', 3000, 3000, 3000, 3000, 3000, 3000, 18000]);
  m.addRow(['Supplies', 500, 500, 500, 500, 500, 500, 3000]);
  m.addRow(['Total', 3500, 3500, 3500, 3500, 3500, 3500, 21000]);
  const p = wb.addWorksheet('Participants');
  p.addRow(['Enrolled', 'County', 'Program', 'Sessions']);
  const day = (s) => new Date(`${s}T00:00:00Z`);
  [['2026-01-12', 'Marion', 'Circles', 6], ['2026-01-20', 'Lane', 'Circles', 4], ['2026-02-03', 'Marion', 'Reentry', 9], ['2026-02-17', 'Multnomah', 'Circles', 2], ['2026-03-09', 'Marion', 'Reentry', 7], ['2026-03-30', 'Lane', 'Youth', 5]]
    .forEach(([d, ...r]) => p.addRow([day(d), ...r]));
  p.getColumn(1).numFmt = 'mm/dd/yyyy';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const b64 = (s) => Buffer.from(s).toString('base64');

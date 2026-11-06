// A messy pile and the shape a reader would propose for it (test/shape and test/intakes).

import { labelFiles } from '../../lib/shape.js';

const cols = (o) => ({ date: '', amount: '', debit: '', credit: '', fund: '', line: '', code: '', payee: '', memo: '', reference: '', ...o });

export function messyPile() {
  return labelFiles([
    { name: 'QuickBooks export.csv', kind: 'sheet', sheets: [{ name: '', rows: [
      ['Transaction Detail by Account', '', '', '', '', ''],
      ['', '', '', '', '', ''],
      ['Date', 'Name', 'Memo/Description', 'Account', 'Class', 'Amount'],
      ['01/31/2026', 'Staffing Co', 'January payroll', '6000 Personnel', 'YD', '-3,000.00'],
      ['02/14/2026', 'Office Depot', 'Workbooks', 'Supplies', 'YD', '-450.00'],
      ['02/20/2026', 'Meyer Memorial Trust', 'Grant payment received', 'Income', 'YD', '12,000.00'],
      ['03/01/2026', 'Ana Reyes', 'Circle facilitation', 'Stipends', 'Reentry', '-1,200.00'],
      ['03/02/2026', 'Coffee Shop', 'Board meeting', 'Meals', 'General', '-40.00'],
      ['Total for YD', '', '', '', '', '-3,450.00'],
    ] }] },
    { name: 'Budgets.xlsx', kind: 'sheet', sheets: [
      { name: 'Youth Diversion', rows: [['Line', 'Acct', 'Budget'], ['Personnel', '6000', '18,000'], ['Supplies', '6400', '$3,000'], ['Total', '', '21000']] },
      { name: 'Notes', rows: [['Call Meyer in May about the report']] },
    ] },
    { name: 'Award letter.txt', kind: 'document', text: 'Dear TJC,\nMeyer Memorial Trust is pleased to award Youth Diversion a grant of $24,000 for January 1, 2026 through December 31, 2026.' },
  ]);
}

export function messyShape({ award = '$24,000', quote = 'award Youth Diversion a grant of $24,000' } = {}) {
  return {
    summary: 'A QuickBooks export with two grants and a budget.',
    funds: [
      { ref: 'F1', existing_id: '', name: 'Youth Diversion', kind: 'grant', funder: 'Meyer Memorial Trust', code: 'YD', award, award_source: { document: 'D1', quote }, start_on: '2026-01-01', end_on: '2026-12-31' },
      { ref: 'F2', existing_id: '', name: 'Reentry Circles', kind: 'grant', funder: '', code: 'Reentry', award: '', award_source: { document: '', quote: '' }, start_on: '', end_on: '' },
    ],
    sheets: [
      { sheet: 'S1', use: 'spending', why: 'Transactions', header_row: 3, last_row: 0, columns: cols({ date: 'Date', amount: 'Amount', fund: 'Class', line: 'Account', payee: 'Name', memo: 'Memo/Description' }), fund: '', fund_values: [{ value: 'YD', fund: 'F1' }, { value: 'Reentry', fund: 'F2' }, { value: 'General', fund: '-' }], amount_sign: 'flip', skip_when: ['grant payment received'] },
      { sheet: 'S2', use: 'budget', why: 'Youth Diversion budget', header_row: 1, last_row: 0, columns: cols({ line: 'Line', code: 'Acct', amount: 'Budget' }), fund: 'F1', fund_values: [], amount_sign: 'as_is', skip_when: [] },
      { sheet: 'S3', use: 'ignore', why: 'A note', header_row: 1, last_row: 0, columns: cols(), fund: '', fund_values: [], amount_sign: 'as_is', skip_when: [] },
    ],
    questions: [],
  };
}


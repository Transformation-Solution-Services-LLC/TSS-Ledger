// A QuickBooks Online sandbox company, as the accounting API answers it
// (shapes from Intuit's API reference, minor version 75), and a stand-in for
// Intuit's OAuth and accounting endpoints that records every call.

export const REALM = '9341453172';

export function company() {
  return {
    Class: [
      { Id: '100', Name: 'YD', FullyQualifiedName: 'YD', Active: true },
      { Id: '200', Name: 'Reentry Circles', FullyQualifiedName: 'Grants:Reentry Circles', SubClass: true, Active: true },
      { Id: '300', Name: 'Admin', FullyQualifiedName: 'Admin', Active: true },
    ],
    Account: [
      { Id: '60', Name: 'Personnel', AcctNum: '6000', FullyQualifiedName: 'Personnel', AccountType: 'Expense', Classification: 'Expense' },
      { Id: '64', Name: 'Supplies', AcctNum: '6400', FullyQualifiedName: 'Office:Supplies', AccountType: 'Expense', Classification: 'Expense' },
      { Id: '65', Name: 'Facilitator stipends', AcctNum: '', FullyQualifiedName: 'Facilitator stipends', AccountType: 'Expense', Classification: 'Expense' },
      { Id: '35', Name: 'Checking', AccountType: 'Bank', Classification: 'Asset' },
      { Id: '40', Name: 'Grant revenue', AccountType: 'Income', Classification: 'Revenue' },
    ],
    Purchase: [
      {
        Id: '501', SyncToken: '0', TxnDate: '2026-02-14', PaymentType: 'Check', DocNumber: '1043', EntityRef: { value: '7', name: 'Staffing Co', type: 'Vendor' }, PrivateNote: 'February payroll',
        Line: [{ Id: '1', Amount: 3000, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '60', name: 'Personnel' }, ClassRef: { value: '100', name: 'YD' } } }],
      },
      {
        Id: '502', SyncToken: '1', TxnDate: '2026-03-15', PaymentType: 'CreditCard', EntityRef: { value: '8', name: 'Office Depot' },
        Line: [
          { Id: '1', Amount: 450, Description: 'Workbooks', DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '64', name: 'Office:Supplies' }, ClassRef: { value: '100', name: 'YD' } } },
          { Id: '2', Amount: 80, Description: 'Paper', DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '64', name: 'Office:Supplies' }, ClassRef: { value: '300', name: 'Admin' } } },
          { Id: '3', Amount: 12, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '64', name: 'Office:Supplies' } } },
          { DetailType: 'SubTotalLineDetail', Amount: 542 },
        ],
      },
      {
        Id: '503', SyncToken: '0', TxnDate: '2026-05-02', PaymentType: 'CreditCard', Credit: true, EntityRef: { value: '8', name: 'Office Depot' },
        Line: [{ Id: '1', Amount: 50, Description: 'Return', DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '64' }, ClassRef: { value: '100' } } }],
      },
    ],
    Bill: [
      {
        Id: '601', SyncToken: '0', TxnDate: '2026-04-20', DocNumber: 'INV-88', VendorRef: { value: '9', name: 'Ana Reyes' },
        Line: [{ Id: '1', Amount: 1200, Description: 'Circle facilitation', DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '65', name: 'Facilitator stipends' }, ClassRef: { value: '200', name: 'Grants:Reentry Circles' } } }],
      },
    ],
    VendorCredit: [
      {
        Id: '701', SyncToken: '0', TxnDate: '2026-04-25', VendorRef: { value: '9', name: 'Ana Reyes' },
        Line: [{ Id: '1', Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '65' }, ClassRef: { value: '200' } } }],
      },
    ],
    JournalEntry: [
      {
        Id: '801', SyncToken: '0', TxnDate: '2026-03-31', DocNumber: 'JE-3', PrivateNote: 'Allocate March salaries',
        Line: [
          { Id: '0', Amount: 500, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '60', name: 'Personnel' }, ClassRef: { value: '100', name: 'YD' } } },
          { Id: '1', Amount: 500, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '35', name: 'Checking' } } },
        ],
      },
    ],
    Deposit: [{ Id: '901', SyncToken: '0', TxnDate: '2026-01-10', TotalAmt: 24000, Line: [{ Id: '1', Amount: 24000, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '40' }, ClassRef: { value: '100' } } }] }],
    Budget: [
      {
        Id: '1', Name: 'FY2026', StartDate: '2026-01-01', EndDate: '2026-12-31', BudgetType: 'ProfitAndLoss', Active: true,
        BudgetDetail: [
          { BudgetDate: '2026-01-01', Amount: 9000, AccountRef: { value: '60' }, ClassRef: { value: '100' } },
          { BudgetDate: '2026-07-01', Amount: 9000, AccountRef: { value: '60' }, ClassRef: { value: '100' } },
          { BudgetDate: '2026-01-01', Amount: 2000, AccountRef: { value: '64' }, ClassRef: { value: '100' } },
          { BudgetDate: '2026-01-01', Amount: 24000, AccountRef: { value: '40' }, ClassRef: { value: '100' } },
          { BudgetDate: '2026-01-01', Amount: 777, AccountRef: { value: '64' }, ClassRef: { value: '300' } },
          { BudgetDate: '2026-01-01', Amount: 1500, AccountRef: { value: '65' }, ClassRef: { value: '100' } },
        ],
      },
      { Id: '2', Name: 'FY2024', StartDate: '2024-01-01', EndDate: '2024-12-31', Active: true, BudgetDetail: [{ Amount: 99999, AccountRef: { value: '60' }, ClassRef: { value: '100' } }] },
    ],
  };
}

export const PROFIT_AND_LOSS = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: '2026-01-01', EndPeriod: '2026-06-30', Currency: 'USD' },
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
  Rows: {
    Row: [
      { type: 'Section', group: 'Income', Header: { ColData: [{ value: 'Income' }, { value: '' }] }, Summary: { ColData: [{ value: 'Total Income' }, { value: '24000.00' }] } },
      { type: 'Section', group: 'GrossProfit', Summary: { ColData: [{ value: 'Gross Profit' }, { value: '24000.00' }] } },
      { type: 'Section', group: 'Expenses', Summary: { ColData: [{ value: 'Total Expenses' }, { value: '5092.00' }] } },
      { type: 'Section', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '18908.00' }] } },
    ],
  },
};

// Intuit, stood in. Every call is kept in `calls`.
export function fakeIntuit({ clientId = 'qb-client', clientSecret = 'qb-secret', data = company() } = {}) {
  const t = {
    data, calls: [], issued: 0, access: null, refresh: null, revoked: [], failRefresh: null,
    codes: new Set(['good-code']),
  };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const issue = () => {
    t.issued++;
    t.access = `at-${t.issued}`;
    t.refresh = `rt-${t.issued}`;
    return { token_type: 'bearer', access_token: t.access, refresh_token: t.refresh, expires_in: 3600, x_refresh_token_expires_in: 8726400 };
  };
  t.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    t.calls.push({ method, host: u.host, path: u.pathname, query: u.searchParams.get('query') || '' });
    if (u.host === 'oauth.platform.intuit.com' && u.pathname === '/oauth2/v1/tokens/bearer') {
      const auth = String(init.headers?.authorization || '');
      if (auth !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`) return json(401, { error: 'invalid_client' });
      const form = new URLSearchParams(String(init.body || ''));
      if (form.get('grant_type') === 'authorization_code') {
        if (!t.codes.has(form.get('code'))) return json(400, { error: 'invalid_grant' });
        t.codes.delete(form.get('code'));
        return json(200, issue());
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (t.failRefresh) return json(400, { error: t.failRefresh });
        if (form.get('refresh_token') !== t.refresh) return json(400, { error: 'invalid_grant' });
        return json(200, issue());
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (u.host === 'developer.api.intuit.com' && u.pathname === '/v2/oauth2/tokens/revoke') {
      t.revoked.push(JSON.parse(String(init.body || '{}')).token);
      return new Response('', { status: 200 });
    }
    if (u.host === 'sandbox-quickbooks.api.intuit.com' || u.host === 'quickbooks.api.intuit.com') {
      if (method !== 'GET') return json(405, { Fault: { Error: [{ Message: 'read only test' }] } });
      if (String(init.headers?.authorization || '') !== `Bearer ${t.access}`) return json(401, { fault: { error: [{ message: 'AuthenticationFailed' }] } });
      const base = `/v3/company/${REALM}`;
      if (u.pathname === `${base}/companyinfo/${REALM}`) return json(200, { CompanyInfo: { CompanyName: 'Reentry Partners Sandbox', Id: '1' } });
      if (u.pathname === `${base}/reports/ProfitAndLoss`) return json(200, PROFIT_AND_LOSS);
      if (u.pathname === `${base}/query`) {
        const q = u.searchParams.get('query') || '';
        const entity = /FROM (\w+)/.exec(q)?.[1];
        const start = Number(/STARTPOSITION (\d+)/.exec(q)?.[1] || 1);
        const from = /TxnDate >= '([\d-]+)'/.exec(q)?.[1];
        const to = /TxnDate <= '([\d-]+)'/.exec(q)?.[1];
        let rows = t.data[entity] || [];
        if (from) rows = rows.filter((r) => r.TxnDate >= from && r.TxnDate <= to);
        const page = start === 1 ? rows : [];
        return json(200, { QueryResponse: page.length ? { [entity]: page, startPosition: start, maxResults: page.length } : {}, time: '2026-06-30T10:00:00.000-07:00' });
      }
      return json(404, { Fault: {} });
    }
    throw new Error(`unexpected call ${method} ${u}`);
  };
  return t;
}

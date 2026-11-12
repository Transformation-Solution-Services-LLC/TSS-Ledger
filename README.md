# Ledger

What each grant and fund has, has spent, and has left, in the TSS product
suite. Sherlock finds grants, Watson writes the proposals and reports,
Rollodex keeps the funders; Ledger tracks the money once a grant is won.

- **Grants and funds**: grants (restricted by the funder's agreement), other
  restricted gifts and unrestricted funds, each with its funder, award,
  period, a code (the QuickBooks class, if any) and a budget by line item.
  Restricted and unrestricted money are always counted apart.
- **Spending**: what was spent from each fund, on which budget line, paid to
  whom. Entered by hand, or imported from a spreadsheet. An entry is never
  edited or deleted; one made in error is voided with a reason and stays on
  the record.
- **Figures** (all in `lib/finance.js`, in whole cents): spent, remaining,
  share of the budget spent against share of the grant period gone, burn
  rate per month, where spending lands by the end date at that rate, how many
  months the money lasts, and variance per budget line (over, 90% or more).

Staff sign in through Cockpit only (`docs/cockpit.md`). Cockpit's `use`
permission lets a person read everything and record spending; `manage` sets
up grants and budgets, imports, exports, voids any entry and reads the
activity log.

## Analyze

Upload a spreadsheet and Ledger charts it at once; ask a question and Ledger
answers from the data, showing how each figure was worked out. Open to
everyone who uses Ledger (`use`).

- **Reading** (`lib/dataset.js`): Excel (every tab) and CSV. The header row is
  found under any title rows; blank rows, total rows and report footers are
  left out; QuickBooks section headings ("6000 Personnel") become a Section
  column; each column is typed (date, money, number, text) and read as that
  type ("$1,250.00", "(50.00)", "1/3/26", Excel dates). Months across the top
  ("Jan-26", "Feb-26"...) also get a long copy, one row per line and month.
  The page says what was left out.
- **Charts**: picked from the columns: the main amount over time, budget
  against actual when both are there, the largest groups (a long tail folds
  into Other). Each chart has its numbers in a table under it. Colors are
  stepped for light and dark (`--series-N` in `styles.css`).
- **Questions** (`services/ask.js`): Claude reads what each table holds, then
  asks Ledger to compute: `run_query` filters, groups and totals (money in
  whole cents), `calculate` does arithmetic on computed figures. Every figure
  in the answer is checked against what was computed; one nothing computed
  sends the answer back, and one still left is shown as not computed by
  Ledger. The answer lists each step under "How this was worked out".
  A question runs in the background, so leaving the page does not stop it.
- **Chats** are saved per person, renamed and deleted by their owner, and
  compacted past 500,000 tokens (`lib/compact.js`). A spreadsheet dropped in
  a chat joins it as data; a document goes to the chat's own Library folder
  (`lib/chat-files.js`, with `LIBRARY_URL` and `LIBRARY_SERVICE_TOKEN`), or
  without Library stays with the chat as text.
- **Ledger's records** (spending, budget lines, grants) are a dataset too,
  read fresh each time.
- **Privacy**: a spreadsheet and a chat belong to the person who added them;
  another person's id answers 404. The organization export carries them.
- **Other sources**: a dataset has a `source` (`upload` now). A connector
  such as QuickBooks adds datasets through the same store calls
  (`createDataset`, `updateDataset` with new `tables`) and they chart and
  answer the same way.

## Importing

**A pile of files** (the first tab of Import) takes every spreadsheet and
document a manager has at once: Excel workbooks with many tabs, CSV,
QuickBooks or bank exports, budgets, award letters as PDF, Word or text.

1. Ledger reads the files (`services/extract.js`); nothing but their cells
   and text is kept.
2. Claude Opus 5.5 proposes the shape (`services/sense.js`): which sheet is
   spending, a budget or neither, the header row, which column is which,
   which grant each row belongs to, the grants themselves. It asks at most
   three multiple-choice questions, only where a wrong guess would put money
   on the wrong grant or count it twice.
3. Ledger reads every figure itself through that shape (`lib/shape.js`) and
   shows the person the grants, each file, the first entries and every row
   left out. An award is kept only when its quote is in the document.
4. The person answers and accepts. Then other models check the same path
   against the files: any mistake is fixed by the drafter and the count
   starts over. Done when three different models clear the same draft
   (Claude Sonnet 5.5, Opus 5, Fable 5.1, with Haiku 5.5 as the spare; the
   drafter never checks itself), or after ten checks, when the person is
   told the checks did not settle and may import anyway.
5. Import saves new grants, budget lines and spending with the CSV
   importer's keys, so the same rows are never added twice.

Each Claude call counts against the organization's monthly AI limit in
Cockpit (`lib/usage.js`). Without `ANTHROPIC_API_KEY` the tab says it is off.

**Spending** and **A grant's budget** take one CSV in
three steps: Ledger guesses which column fills which field, the person
changes any match, and a check lists every row before anything is saved.

- **Spending.** QuickBooks' Transaction Detail by Account report, exported
  and saved as CSV, reads as it is: Date, Num, Name, Memo/Description,
  Account, Class, Amount (or Debit and Credit, as a bank export has). The
  fund is the Class (or a grant column), matched by the fund's code or
  name, or the fund chosen for the whole sheet. The budget line is the
  account or category, matched by the line's code ("6000 Personnel") or
  name ("Expenses:Personnel"). Each row is keyed by what it says, so the same
  sheet imported twice adds nothing the second time, and two identical rows
  in one sheet stay two entries.
- **A grant's budget.** One row per line with its amount (and a code, if the
  spending sheet uses account numbers). A line already on the budget takes
  the sheet's amount. Total rows are skipped: Ledger adds the lines itself.

## QuickBooks Online (read only)

A Ledger manager opens **QuickBooks** in the side column and connects the
organization's company once, through Intuit's own sign-in. From then on
Ledger reads it on connect, on **Sync now**, and every six hours
(`lib/quickbooks.js`, `lib/quickbooks-sync.js`, `lib/quickbooks-routes.js`).

- **Read only.** Intuit offers one accounting scope and no read-only one, so
  Ledger keeps the promise itself: its client can only send GET to the
  accounting API. The only other calls are OAuth's own (trade the sign-in
  code, refresh, revoke on disconnect). `test/quickbooks.test.mjs` checks
  every call.
- **Into the same records as the spreadsheet import.** A QuickBooks class is
  a grant or fund (by the fund's code, else its name); an account is a budget
  line (by code or name). Expenses, checks, card charges and bills are
  spending; vendor credits and card credits are refunds; journal entry lines
  on expense accounts count too. Deposits and income show only as this
  year's profit and loss totals. A class with no grant is listed with **Add
  as a grant**.
- **Nothing twice, nothing lost.** Each line is keyed by its company, id and
  QuickBooks edit count. A line changed or moved in QuickBooks comes in again
  and the old entry is voided ("Updated from QuickBooks"); one deleted there
  is voided ("Removed in QuickBooks"). A row already imported from a
  QuickBooks spreadsheet (same fund, day, amount, payee) is not added again.
- **Budgets** come from QuickBooks only when a manager ticks the setting:
  active budgets covering today, expense accounts only, per class.
- **Tokens** are sealed with AES-256-GCM before they reach the database,
  refreshed before they run out (Intuit hands out a new refresh token each
  time), and revoked at Intuit and deleted on **Disconnect**. Spending already
  brought in stays. The sign-in is tied to the browser that started it.

Settings on `tss-ledger`: `QUICKBOOKS_CLIENT_ID` and
`QUICKBOOKS_CLIENT_SECRET` from the Intuit developer app (blank: the page
says it is not set up). The app's redirect URI is
`https://<ledger address>/api/quickbooks/callback`. `QUICKBOOKS_ENVIRONMENT=sandbox`
for an Intuit test company. `/api/health/live` asks Intuit whether it takes
the keys.

## Who reads it

- **Cockpit**: totals and counts for its cards, and Needs you (lines over
  budget, grants spending ahead, grants ending with money left).
- **Watson**: a grant's budget and actuals for the Budget card and funder
  reports, so every dollar in the narrative matches Ledger.
- **Rook-E**: every budget line's budget and actual for the Budget variance
  agent.

None of them get a payee, a memo or a single entry.

## Run it

```
npm ci
npm test
TEST_DATABASE_URL=postgres://... npm test   # also runs the store contract on Postgres 16
DEV_SIGNIN=on npm start                     # http://localhost:8797, developer sign-in
```

Settings are in `.env.example`. In the suite it is deployed from
TSS-FullStack's `render.yaml` as `tss-ledger`, with its own database.

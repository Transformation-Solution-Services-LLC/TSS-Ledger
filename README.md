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

QuickBooks Online through a live connection is left for later; the CSV
export covers the same data with no new credential.

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

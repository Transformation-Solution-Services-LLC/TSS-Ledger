# CLAUDE.md: Ledger (repository TSS-Ledger)

The finance app in the TSS product suite: grant budgets by line item,
restricted and unrestricted funds, spending, burn rate and variance. See
README.md.

## Layout

- `server.js` API, auth, validation and static frontend. One Render service.
- `lib/store.js` picks the store: `store-postgres.js` (production) or `store-memory.js` (dev, tests). One contract; `test/store.test.mjs` runs it against both.
- `lib/finance.js` every figure the app shows and shares: fund summaries, burn rate, pace, line variance, totals, Cockpit's rollup and Needs you, the sentences Watson cites. Pure functions over the store's rows, in whole cents.
- `lib/import-map.js`, `lib/csv.js` CSV in and out, column matching.
- `lib/intakes.js`, `lib/shape.js`, `services/sense.js`, `services/extract.js` a pile of files made sense of: read, a shape proposed by Claude, read through by Ledger, checked until three different models clear it, imported.
- `lib/dataset.js`, `lib/analysis.js`, `services/ask.js`, `public/data.js`, `public/chart.js` Analyze: a spreadsheet read into typed tables, charted, and questions answered by Claude from figures Ledger computes (`runQuery`, `calculate`); every figure in an answer is checked. `lib/compact.js` and `lib/chat-files.js` are the shared chat files.
- `lib/usage.js` the organization's monthly AI limit in Cockpit (same as Library).
- `lib/rollodex.js` the Rollodex client: link a grant's funder.
- `lib/quickbooks.js` Intuit OAuth, sealed tokens, the GET-only accounting client; `lib/quickbooks-sync.js` QuickBooks into funds, lines and entries; `lib/quickbooks-routes.js` the manager's routes and the six-hour schedule.
- `lib/cockpit.js` launch-ticket verification; `lib/cockpit-link.js` access changes and the audit trail; `lib/auth.js` sessions and the service token. Same files as Vault and Rollodex.
- `lib/error-tracking.js` sends 5xx errors and crashes to a Sentry-format tracker, scrubbed. Off without `ERROR_TRACKING_DSN`.
- `public/` vanilla ES modules, no build step. `public/util.js` holds the DOM-free helpers tests import.

## Dev / test

```
npm ci
npm test
TEST_DATABASE_URL=postgres://... npm test
DEV_SIGNIN=on npm start                     # http://localhost:8797
```

## Conventions

- **Sign-in comes from Cockpit only.** No password, no local accounts. Audience `ledger`; keep the refusals strict.
- **Everything belongs to one organization.** Every store call names `org_id`; every route answers 404 for another organization's ids, and the store refuses a reference (fund, line) from another organization.
- **Nothing is deleted.** A fund is archived, a budget line is removed (kept, hidden), a spend entry is voided with a reason and stays on the record, counted for nothing.
- **Money is a number of dollars** in the contract, `numeric(14,2)` in Postgres. Every sum is taken in whole cents (`lib/finance.js`). Restricted and unrestricted money are never added together.
- **Figures are computed by Ledger, never by a model.** Watson and Rook-E quote what `/api/service/*` answers. In a pile of files a model proposes only the shape; `lib/shape.js` reads every amount, and an award needs its quote in the document.
- **An answer quotes only computed figures.** In Analyze, Claude asks `lib/dataset.js` for every total; `uncheckedFigures` sends back an answer with a figure nothing computed. Spreadsheets and data chats are their owner's alone.
- **Three different models clear the same draft** before a pile imports without a warning (`services/sense.js`). A fix restarts the count; the drafter never checks itself; the page never names a model.
- **QuickBooks is read only.** The accounting client sends GET and nothing else; the only POSTs are OAuth's (token, refresh, revoke). Tokens are sealed before the store sees them and never leave in a response, log or export. A change in QuickBooks voids the old entry and adds the new one; nothing is edited or deleted. `test/quickbooks.test.mjs` checks every call.
- **Other apps get figures, never entries.** Cockpit, Watson and Rook-E never receive a payee, a memo or a single entry. Each service read is logged with the app.
- **Permissions:** `use` reads and records spending; `manage` changes grants and budgets, imports, exports, voids any entry, reads the activity log. Cockpit grants them.
- **Dates are local calendar days** (`YYYY-MM-DD`), never converted through UTC. `today()` uses `TZ_DISPLAY`.
- **Both stores keep the same contract.** Change one, change the other, and extend `test/store.test.mjs`.
- **Schema changes are additive** (`CREATE ... IF NOT EXISTS`, new nullable columns). No destructive migrations on start.
- **Never forward an upstream error body.** Use `PublicError`.
- **The error tracker gets ids, never people.** Keep `test/error-tracking.test.mjs` passing.
- **Organization export is Cockpit's alone.** `GET /api/export/org` answers only `EXPORT_TOKEN`, logged in the activity log.
- **CI needs no secrets.** Postgres runs as a CI service; Cockpit is a stand-in; Claude is stubbed.
- **The look is the shared TSS app shell**: navy page, dark by default with light as the switch, the app symbol upper left (no robot), Selawik served from `public/fonts` (Segoe UI where present) and the shared `public/tss-look.css`, Cockpit's theme tokens between `/* tss-theme:start */` and `/* tss-theme:end */`. `test/ui.test.mjs` enforces it.

## Writing conventions

- No developer text on screen: no model names, environment variable or key names, version numbers or "prototype" labels. When something is not set up, a manager sees one plain sentence; everyone else sees nothing.
- Say it once. A heading needs no subtitle that repeats it, and the side column carries no sentence about the reader's permissions.

- Never use an em dash. Use a comma, a colon, parentheses, or a second sentence.
- Drop the word "that" wherever the sentence stays grammatical without it.
- The app is "Ledger", never "TSS-Ledger" in the interface. TSS appears only as the wordmark.
- Always "Transformation Solution Services, LLC", never "Transformative".

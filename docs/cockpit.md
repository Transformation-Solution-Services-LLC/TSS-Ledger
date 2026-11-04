# Ledger in Cockpit

Cockpit (assembled with every app in TSS-FullStack) is the one sign-in for
TSS apps. With `COCKPIT_URL` set, Ledger trusts it the same way Library,
Rollodex, Vault, Sherlock and Watson do. Code: `lib/cockpit.js` and
`lib/auth.js`; tests: `test/server.test.mjs`.

## Signing in

1. A person signs in to Cockpit (the organization's Google, Microsoft or
   Okta sign-in).
2. They open Ledger from Cockpit. Cockpit hands Ledger a launch ticket in
   the address (`#tss_launch=...`): signed by Cockpit, good for two minutes,
   once, addressed to `ledger`, naming the person, their organization and
   their Ledger permissions.
3. The page sends the ticket to `POST /api/auth/cockpit`. Ledger checks the
   signature against `<COCKPIT_URL>/.well-known/jwks.json`, the issuer, the
   audience, the time and that the ticket was never used, then starts a
   session for the tab.

Rules:

- `use` lets a person in: read every grant, budget and entry, and record
  spending. `manage` adds and changes grants and budget lines, imports,
  exports, voids any entry and reads the activity log. Without either the
  person is refused.
- Every record carries the organization from the ticket. Another
  organization's ids answer 404.
- Ledger may be framed by Cockpit (and only Cockpit); it also opens in its
  own tab.

## What Cockpit reads

All with `Authorization: Bearer <LEDGER_SERVICE_TOKEN>` and `X-TSS-Org`.

- `GET /api/cockpit/rollup?from=YYYY-MM-DD&to=YYYY-MM-DD`: open grants,
  restricted budget and what is left of it, spending in the period (all and
  restricted), grants off pace, budget lines over. By month: spending. Never
  a payee, a memo or an entry.
- `GET /api/cockpit/needs-you`: budget lines over budget, grants spending
  ahead of the calendar, grants ending within 60 days with more than 15% left,
  grants past their end date still open. Each opens the grant in Ledger.
- `GET /api/export/org` with `EXPORT_TOKEN` instead (never the service
  token): everything the organization has, as `tss.org-export/v1`.

## What Watson and Rook-E read

With the same service token and `X-TSS-Org`, plus `X-TSS-App` naming the app.
Each read goes in the activity log with the app's name. Nothing writes.

- `GET /api/service/grants?q=<name, funder or code>`: open grants and funds
  with budget, spent, remaining, burn rate, pace, projection, each budget
  line's budget and spent, and `facts`: the same figures as sentences, for a
  writer to cite. Watson's Budget card and funder reports use it.
- `GET /api/service/grants/:id`: one of them.
- `GET /api/service/budget-lines`: one row per budget line of every open
  fund (fund, line, budget, actual), the shape of a budget-versus-actual
  sheet. Rook-E's Budget variance agent turns it into a report.

## What Ledger sends to Rollodex

"Link the funder in Rollodex" on a grant sends the funder's name to
Rollodex's `POST /api/service/funders` with `ROLLODEX_SERVICE_TOKEN`. Rollodex
finds the funder by name or adds it as a Grantor, and Ledger keeps its
contact id to open it. Nothing else goes.

## Settings

| Variable | What |
|---|---|
| `COCKPIT_URL` | Cockpit's public address. Turns on Cockpit sign-in |
| `LEDGER_SERVICE_TOKEN` | Shared with Cockpit, Watson and Rook-E. Blank turns their reads off |
| `EXPORT_TOKEN` | Cockpit's "Export everything" only |
| `ROLLODEX_URL`, `ROLLODEX_SERVICE_TOKEN` | The funder link. Blank turns it off |
| `TZ_DISPLAY` | The organization's calendar, for "today" and grant periods |
| `TRUST_PROXY` | `1` on Render |

TSS-FullStack's `render.yaml` sets all of these for the hosted service.

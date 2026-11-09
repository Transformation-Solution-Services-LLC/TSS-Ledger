// Ledger: what each grant and fund has, has spent, and has left.
//
// One Express service serving the API and the frontend, the same shape as
// Library, Rollodex and Vault. It holds:
//
//   Funds          grants (restricted by the funder's agreement), other
//                  restricted funds and unrestricted funds, each with an
//                  award, a period and a budget by line item.
//   Spend          what was spent from each fund, entered by hand or
//                  imported from a spreadsheet (a QuickBooks or bank export
//                  saved as CSV), each on a budget line.
//   Figures        spent, remaining, burn rate, pace against the calendar
//                  and variance per line, all in lib/finance.js.
//
// Staff with "use" read everything and record spend. Staff with "manage" set
// up funds and budgets, import, export, void any entry and read the activity
// log. Nothing is deleted: a fund is archived, a budget line is removed
// (kept, hidden), a spend entry entered in error is voided and stays on the
// record.
//
// People sign in through TSS Cockpit (lib/cockpit.js). Every record belongs to
// one Cockpit organization. With the service token, Cockpit reads totals and
// Watson and Rook-E read each grant's figures; none of them ever gets a
// payee, a memo or a single entry.

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireUser, requireManager, requireService, requireExport, sessionFor, devSignInEnabled, serviceTokenMatches } from './lib/auth.js';
import { runLiveChecks, checkClaude, checkComposio, checkTssApp } from './lib/live-check.js';
import { createTicketVerifier, cockpitUrl, frameHeaders } from './lib/cockpit.js';
import { createCockpitLink } from './lib/cockpit-link.js';
import { publicErrorBody, logSafeError, normalizePublicError, requestContext, PublicError } from './lib/public-error.js';
import { errorReporter, installCrashHandlers } from './lib/error-tracking.js';
import { openStore } from './lib/store.js';
import { toCsv } from './lib/csv.js';
import { readSheet, cleanMapping, mappedRows, previewOf, nameKey, readDay, readMoney, MAX_ROWS } from './lib/import-map.js';

export { readMoney };
import * as rollodexApi from './lib/rollodex.js';
import { intakeRoutes } from './lib/intakes.js';
import { createUsageClient } from './lib/usage.js';
import * as senseApi from './services/sense.js';
import {
  FUND_KINDS, FUND_STATUSES, isDay, today, round2, toCents, usd,
  fundSummary, summarizeFunds, totals, rollup, needsYou, serviceView,
} from './lib/finance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => ID.test(String(v || ''));
// This release, for the phone's app shell cache: the deployed commit on Render, else when this process started.
const RELEASE = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || `start-${Date.now()}`;
// Who may come in at all: either of the app's permissions from Cockpit.
export const CAN_ENTER = (perms) => perms.includes('use') || perms.includes('manage');
export const APP_NAME = 'Ledger';
const EXPORT_ACTIVITY_LIMIT = 100000;
const MAX_AMOUNT = 1e11;

export function createApp({
  store,
  verifyTicket = createTicketVerifier({ audience: 'ledger' }),
  // Access changes from Cockpit and the audit trail Cockpit reads (lib/cockpit-link.js).
  cockpitLink = createCockpitLink({ audience: 'ledger', canEnter: CAN_ENTER }),
  clock = () => today(),
  rollodex = rollodexApi,
  // A pile of files made sense of (lib/intakes.js, services/sense.js).
  sense = senseApi,
  senseDeps = {},
  usage = createUsageClient(),
} = {}) {
  if (!store) throw new Error('createApp needs a store');
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  app.use(frameHeaders);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Financial records: never kept in a shared cache.
    if (_req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // A year of transactions as CSV stays well under 8 MB. A pile of files
  // (base64, up to 40 MB of files) has its own, larger limit.
  const smallJson = express.json({ limit: '8mb' });
  const pileJson = express.json({ limit: '56mb' });
  app.use((req, res, next) => (req.method === 'POST' && req.path === '/api/intakes' ? pileJson : smallJson)(req, res, next));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  app.locals.cockpitLink = cockpitLink;
  cockpitLink.routes(app, { wrap });
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const audit = (req, action, target, detail = '') => {
    cockpitLink.record({ org: req.user.org_id, actorId: req.user.id, actor: req.user.name, email: req.user.email, action, target, detail, ip: req.ip });
    return store.log(req.user.org_id, { actor: req.user.name, action, target, detail }).catch((e) => logSafeError(console, e, 'audit_failed'));
  };
  const bad = (code, message) => new PublicError(400, code, message);
  const notFound = (what) => new PublicError(404, 'not_found', `No such ${what}`);
  const forbidden = (message) => new PublicError(403, 'not_permitted', message);

  // ---- field checks ----

  const dayField = (v, label, { required = false } = {}) => {
    const s = str(v, 10);
    if (!s) { if (required) throw bad('date_required', `Give the ${label}`); return null; }
    if (!isDay(s)) throw bad('bad_date', `${label[0].toUpperCase()}${label.slice(1)} must be a date like 2026-03-31`);
    return s;
  };
  const oneOf = (v, list, label, fallback) => {
    const s = str(v, 40).toLowerCase();
    if (!s) return fallback;
    if (!list.includes(s)) throw bad('bad_value', `${label} must be one of: ${list.join(', ')}`);
    return s;
  };
  const moneyField = (v, label, { required = false, positive = false } = {}) => {
    if ((v === undefined || v === null || v === '') && !required) return 0;
    const n = readMoney(v);
    if (n === null) throw bad('bad_amount', `${label} must be an amount like 1250.00`);
    if (positive && n < 0) throw bad('bad_amount', `${label} cannot be below zero`);
    if (Math.abs(n) >= MAX_AMOUNT) throw bad('bad_amount', `${label} is too large`);
    return n;
  };

  function fundFields(b, existing = null) {
    const out = {};
    const has = (k) => b[k] !== undefined;
    if (!existing || has('name')) out.name = str(b.name, 160);
    if (!existing || has('kind')) out.kind = oneOf(b.kind, FUND_KINDS, 'Kind', 'grant');
    if (!existing || has('funder')) out.funder = str(b.funder, 160);
    if (!existing || has('code')) out.code = str(b.code, 40);
    if (!existing || has('award')) out.award = moneyField(b.award, 'The award', { positive: true });
    if (!existing || has('start_on')) out.start_on = dayField(b.start_on, 'start date');
    if (!existing || has('end_on')) out.end_on = dayField(b.end_on, 'end date');
    if (!existing || has('status')) out.status = oneOf(b.status, FUND_STATUSES, 'Status', 'active');
    if (!existing || has('notes')) out.notes = str(b.notes, 5000);
    const merged = { ...(existing || {}), ...out };
    if (!merged.name) throw bad('no_name', 'Name the fund');
    if (merged.start_on && merged.end_on && merged.end_on < merged.start_on) throw bad('bad_period', 'The end date is before the start date');
    return out;
  }

  // ---- sign-in: through Cockpit only ----

  const signedIn = (person) => ({
    token: sessionFor(person), name: person.name, org: person.org,
    can_manage: person.permissions.includes('manage'),
  });

  app.post('/api/auth/cockpit', wrap(async (req, res) => {
    const person = await verifyTicket(str((req.body || {}).ticket, 8000));
    if (!person.permissions.includes('use') && !person.permissions.includes('manage')) {
      throw new PublicError(403, 'not_permitted', `Your role in Cockpit does not include ${APP_NAME}. Ask your administrator.`);
    }
    if (!person.permissions.includes('use')) person.permissions = [...person.permissions, 'use'];
    await cockpitLink.record({ org: person.org.id, actorId: person.sub, actor: person.name, email: person.email, action: 'signin', detail: person.permissions.join(', '), ip: req.ip });
    res.json(signedIn(person));
  }));

  app.post('/api/auth/dev', (_req, res) => {
    if (!devSignInEnabled()) return res.status(404).json({ error: 'No such endpoint', code: 'not_found' });
    res.json(signedIn({ sub: 'dev', name: 'Developer', org: { id: 'dev', name: 'Development' }, permissions: ['use', 'manage'] }));
  });

  // Every outside service, each asked for real (lib/live-check.js): status
  // words only, remembered a few minutes so this page cannot run up calls.
  app.get('/api/health/live', wrap(async (_req, res) => {
    const env = process.env;
    res.setHeader('Cache-Control', 'no-store');
    res.json(await runLiveChecks({
      claude: checkClaude({ key: env.ANTHROPIC_API_KEY, model: senseApi.drafter() }),
      ...Object.fromEntries(senseApi.reviewers().filter((m) => /^claude-/.test(m)).map((m) => [`reviewer:${m}`, checkClaude({ key: env.ANTHROPIC_API_KEY, model: m })])),
    }));
  }));

  // Another TSS app checking the service token it holds for Ledger.
  app.get('/api/service/ping', (req, res) => {
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token || !serviceTokenMatches(token)) return res.status(401).json({ error: 'Service token required', code: 'authentication_required' });
    return res.json({ ok: true });
  });

  app.get('/api/health', wrap(async (_req, res) => {
    let db = true;
    try { await store.ping(); } catch (_) { db = false; }
    res.status(db ? 200 : 503).json({ ok: db, app: APP_NAME, store: store.kind, db, cockpit_url: cockpitUrl(), dev_signin: devSignInEnabled(), rollodex: rollodex.rollodexConfigured(), reads_files: sense.configured() });
  }));

  app.get('/api/me', requireUser, (req, res) => {
    res.json({
      id: req.user.id, name: req.user.name, org: { id: req.user.org_id, name: req.user.org_name }, can_manage: req.user.can_manage,
      options: { kinds: FUND_KINDS, statuses: FUND_STATUSES },
      rollodex: rollodex.rollodexConfigured() ? rollodex.rollodexUrl() : '',
      reads_files: sense.configured(),
      today: clock(),
      release: RELEASE,
    });
  });

  // ---- loading, scoped to the caller's organization ----

  async function loadFund(req, id = req.params.id) {
    const f = isId(id) ? await store.getFund(req.user.org_id, id) : null;
    if (!f) throw notFound('fund');
    return f;
  }
  async function loadLine(req, id = req.params.id) {
    const l = isId(id) ? await store.getLine(req.user.org_id, id) : null;
    if (!l || l.removed_at) throw notFound('budget line');
    return l;
  }
  async function everything(org, { archived = false } = {}) {
    const [live, gone, lines, entries] = await Promise.all([
      store.listFunds(org), archived ? store.listFunds(org, { archived: true }) : [], store.listLines(org), store.listEntries(org, { voided: false }),
    ]);
    return { funds: [...live, ...gone], live, lines, entries };
  }
  const mine = (req, x) => x.created_by_id && x.created_by_id === req.user.id;
  const brief = ({ lines, monthly, ...s }) => s;

  // ---- home: the totals, every open fund, what needs a look ----

  app.get('/api/home', requireUser, wrap(async (req, res) => {
    const org = req.user.org_id;
    const asOf = clock();
    const { live, lines, entries } = await everything(org);
    const summaries = summarizeFunds(live, lines, entries, asOf);
    const names = new Map(live.map((f) => [f.id, f.name]));
    res.json({
      as_of: asOf,
      totals: totals(summaries),
      funds: summaries.filter((s) => s.status === 'active').map(brief),
      needs: needsYou({ funds: live, lines, entries }, asOf).items,
      recent: entries.slice(0, 8).map((e) => ({ ...e, fund_name: names.get(e.fund_id) || '' })),
    });
  }));

  // ---- funds ----

  app.get('/api/funds', requireUser, wrap(async (req, res) => {
    const org = req.user.org_id;
    const archived = String(req.query.archived || '') === '1';
    const funds = await store.listFunds(org, { q: str(req.query.q, 200), archived });
    const [lines, entries] = await Promise.all([store.listLines(org), store.listEntries(org, { voided: false })]);
    res.json({ funds: summarizeFunds(funds, lines, entries, clock()).map(brief), as_of: clock() });
  }));

  app.post('/api/funds', requireManager, wrap(async (req, res) => {
    const f = await store.createFund(req.user.org_id, { id: crypto.randomUUID(), ...fundFields(req.body || {}), created_by: req.user.name });
    audit(req, 'fund.add', f.name, f.kind);
    res.status(201).json(f);
  }));

  app.get('/api/funds/:id', requireUser, wrap(async (req, res) => {
    const f = await loadFund(req);
    const org = req.user.org_id;
    const [lines, entries] = await Promise.all([store.listLines(org, { fund_id: f.id }), store.listEntries(org, { fund_id: f.id })]);
    const lineNames = new Map(lines.map((l) => [l.id, l.name]));
    res.json({
      ...fundSummary(f, lines, entries, clock()),
      notes: f.notes,
      entries: entries.map((e) => ({ ...e, line_name: e.line_id ? lineNames.get(e.line_id) || '' : '', can_void: !e.voided_at && (req.user.can_manage || mine(req, e)) })),
      rollodex_url: f.rollodex_contact_id && rollodex.rollodexUrl() ? `${rollodex.rollodexUrl()}/#/contacts/${encodeURIComponent(f.rollodex_contact_id)}` : '',
    });
  }));

  app.patch('/api/funds/:id', requireManager, wrap(async (req, res) => {
    const existing = await loadFund(req);
    const f = await store.updateFund(req.user.org_id, existing.id, { ...fundFields(req.body || {}, existing), updated_by: req.user.name });
    audit(req, 'fund.update', f.name);
    res.json(f);
  }));

  // Archived, never deleted: its budget and spending stay on the record.
  for (const [verb, value] of [['archive', () => new Date().toISOString()], ['unarchive', () => null]]) {
    app.post(`/api/funds/:id/${verb}`, requireManager, wrap(async (req, res) => {
      const existing = await loadFund(req);
      const f = await store.updateFund(req.user.org_id, existing.id, { archived_at: value(), updated_by: req.user.name });
      audit(req, `fund.${verb}`, f.name);
      res.json(f);
    }));
  }

  // The grant's funder, found or added in Rollodex, so each opens the other.
  app.post('/api/funds/:id/rollodex', requireManager, wrap(async (req, res) => {
    const f = await loadFund(req);
    const name = str(f.funder, 120);
    if (name.length < 2) throw bad('no_funder', 'Name the funder first');
    const { contact_id, created } = await rollodex.linkFunder(req.user.org_id, req.user.name, name);
    const out = await store.updateFund(req.user.org_id, f.id, { rollodex_contact_id: contact_id, updated_by: req.user.name });
    audit(req, 'fund.rollodex', f.name, created ? 'funder added in Rollodex' : 'funder found in Rollodex');
    res.json({ ...out, created });
  }));

  // ---- budget lines: managers ----

  function lineFields(b, existing = null) {
    const out = {};
    if (!existing || b.name !== undefined) out.name = str(b.name, 160);
    if (!existing || b.code !== undefined) out.code = str(b.code, 40);
    if (!existing || b.amount !== undefined) out.amount = moneyField(b.amount, 'The line\'s budget', { required: !existing, positive: true });
    if (!{ ...(existing || {}), ...out }.name) throw bad('no_name', 'Name the budget line');
    return out;
  }

  app.post('/api/funds/:id/lines', requireManager, wrap(async (req, res) => {
    const f = await loadFund(req);
    const l = await store.createLine(req.user.org_id, { id: crypto.randomUUID(), fund_id: f.id, ...lineFields(req.body || {}) });
    audit(req, 'line.add', f.name, `${l.name}, ${usd(l.amount)}`);
    res.status(201).json(l);
  }));

  app.patch('/api/lines/:id', requireManager, wrap(async (req, res) => {
    const existing = await loadLine(req);
    const l = await store.updateLine(req.user.org_id, existing.id, lineFields(req.body || {}, existing));
    audit(req, 'line.update', l.name, existing.amount !== l.amount ? `${usd(existing.amount)} to ${usd(l.amount)}` : '');
    res.json(l);
  }));

  // Removed, not deleted: spending recorded on it stays, as "not on a budget line".
  app.post('/api/lines/:id/remove', requireManager, wrap(async (req, res) => {
    const existing = await loadLine(req);
    const l = await store.updateLine(req.user.org_id, existing.id, { removed_at: new Date().toISOString() });
    audit(req, 'line.remove', l.name);
    res.json(l);
  }));

  // ---- spend entries: anyone with "use" records one ----

  app.get('/api/entries', requireUser, wrap(async (req, res) => {
    const org = req.user.org_id;
    const q = req.query;
    const fund_id = q.fund_id ? (await loadFund(req, q.fund_id)).id : null;
    const entries = await store.listEntries(org, { fund_id, from: dayField(q.from, 'from'), to: dayField(q.to, 'to'), q: str(q.q, 200), limit: 500 });
    const [funds, archived, lines] = await Promise.all([store.listFunds(org), store.listFunds(org, { archived: true }), store.listLines(org, { removed: true })]);
    const fundNames = new Map([...funds, ...archived].map((f) => [f.id, f.name]));
    const lineNames = new Map(lines.map((l) => [l.id, l.name]));
    res.json({
      entries: entries.map((e) => ({ ...e, fund_name: fundNames.get(e.fund_id) || '', line_name: e.line_id ? lineNames.get(e.line_id) || '' : '', can_void: !e.voided_at && (req.user.can_manage || mine(req, e)) })),
    });
  }));

  app.post('/api/funds/:id/entries', requireUser, wrap(async (req, res) => {
    const f = await loadFund(req);
    const b = req.body || {};
    const rec = {
      id: crypto.randomUUID(), fund_id: f.id,
      line_id: b.line_id ? (await loadLine(req, b.line_id)).id : null,
      date: dayField(b.date, 'date', { required: true }),
      amount: moneyField(b.amount, 'The amount', { required: true }),
      payee: str(b.payee, 200), memo: str(b.memo, 1000), reference: str(b.reference, 100),
      source: 'manual', created_by: req.user.name, created_by_id: req.user.id,
    };
    if (!rec.amount) throw bad('no_amount', 'Give the amount spent');
    if (rec.date > clock()) throw bad('future_date', 'Spending cannot be dated in the future');
    const e = await store.createEntry(req.user.org_id, rec);
    if (!e) throw bad('bad_line', 'That budget line belongs to another fund');
    audit(req, 'entry.add', f.name, usd(e.amount));
    res.status(201).json(e);
  }));

  // An entry is never edited or deleted. One entered in error is voided: it
  // stays on the record, marked, with who voided it and why, and counts for nothing.
  app.post('/api/entries/:id/void', requireUser, wrap(async (req, res) => {
    const e = isId(req.params.id) ? await store.getEntry(req.user.org_id, req.params.id) : null;
    if (!e) throw notFound('entry');
    if (!req.user.can_manage && !mine(req, e)) throw forbidden('Only the person who entered it or a Ledger manager can void an entry.');
    const reason = str((req.body || {}).reason, 500);
    if (!reason) throw bad('no_reason', 'Say why the entry is voided');
    const out = await store.voidEntry(req.user.org_id, e.id, { by: req.user.name, reason });
    audit(req, 'entry.void', usd(e.amount), reason);
    res.json(out);
  }));

  // ---- for Cockpit's server only: totals, never a payee or an entry ----

  app.get('/api/cockpit/rollup', requireService, wrap(async (req, res) => {
    const asOf = clock();
    const year = asOf.slice(0, 4);
    const from = dayField(req.query.from, 'from') || `${year}-01-01`;
    const to = dayField(req.query.to, 'to') || `${year}-12-31`;
    if (to < from) throw bad('bad_period', 'The period ends before it starts');
    const { live, lines, entries } = await everything(req.user.org_id);
    res.json(rollup({ from, to, funds: live, lines, entries }, asOf));
  }));

  // Cockpit's "Needs you" list (lib/finance.js needsYou): the same for
  // everyone who works in Ledger; Cockpit asks only for them.
  app.get('/api/cockpit/needs-you', requireService, wrap(async (req, res) => {
    const { live, lines, entries } = await everything(req.user.org_id);
    res.json(needsYou({ funds: live, lines, entries }, clock()));
  }));

  // ---- for Cockpit's server only: the organization's whole record ----

  app.get('/api/export/org', requireExport, wrap(async (req, res) => {
    const org = req.user.org_id;
    const [live, archived, lines, entries, activity] = await Promise.all([
      store.listFunds(org), store.listFunds(org, { archived: true }), store.listLines(org, { removed: true }), store.listEntries(org), store.activity(org, EXPORT_ACTIVITY_LIMIT),
    ]);
    const funds = [...live, ...archived];
    audit(req, 'export.org', 'everything', `${funds.length} funds, ${lines.length} budget lines, ${entries.length} entries`);
    res.json({
      schema: 'tss.org-export/v1', app: 'ledger', org_id: org, exported_at: new Date().toISOString(),
      tables: { funds, budget_lines: lines, entries, activity }, files: [],
    });
  }));

  // ---- for another TSS app's server: each grant's figures ----
  // Watson's Budget card and funder reports, and Rook-E's Budget variance
  // agent, read here. Every figure is computed by Ledger; the apps quote it.
  // Budget lines with their budget and spent, never an entry, a payee or a
  // memo. Each read is logged with the app asking. Nothing is written.

  const serviceFunds = async (req) => {
    const org = req.user.org_id;
    const asOf = clock();
    const q = str(req.query.q, 160);
    const funds = await store.listFunds(org, { q });
    const [lines, entries] = await Promise.all([store.listLines(org), store.listEntries(org, { voided: false })]);
    const kind = req.query.kind ? oneOf(req.query.kind, FUND_KINDS, 'Kind', '') : '';
    const list = summarizeFunds(funds, lines, entries, asOf).filter((s) => (!kind || s.kind === kind) && (String(req.query.all || '') === '1' || s.status === 'active'));
    return { asOf, list };
  };

  app.get('/api/service/grants', requireService, wrap(async (req, res) => {
    const { asOf, list } = await serviceFunds(req);
    audit(req, 'service.grants', `${list.length} fund${list.length === 1 ? '' : 's'}`, `for ${req.user.name}`);
    res.json({ as_of: asOf, grants: list.map((s) => serviceView(s, asOf)) });
  }));

  app.get('/api/service/grants/:id', requireService, wrap(async (req, res) => {
    const f = await loadFund(req);
    const org = req.user.org_id;
    const asOf = clock();
    const [lines, entries] = await Promise.all([store.listLines(org, { fund_id: f.id }), store.listEntries(org, { fund_id: f.id, voided: false })]);
    audit(req, 'service.grant', f.name, `for ${req.user.name}`);
    res.json({ as_of: asOf, grant: serviceView(fundSummary(f, lines, entries, asOf), asOf) });
  }));

  // Every budget line of every open fund, one row each: the shape of a
  // budget-versus-actual sheet, for Rook-E's Budget variance agent.
  app.get('/api/service/budget-lines', requireService, wrap(async (req, res) => {
    const { asOf, list } = await serviceFunds(req);
    const rows = [];
    for (const s of list) for (const l of s.lines) rows.push({ fund_id: s.id, fund: s.name, kind: s.kind, restricted: s.restricted, line: l.name, budget: l.budget, actual: l.spent });
    audit(req, 'service.budget_lines', `${rows.length} lines`, `for ${req.user.name}`);
    res.json({ as_of: asOf, period: `Through ${asOf}`, lines: rows });
  }));

  // ---- export and import (CSV), managers only ----

  const ENTRY_COLUMNS = ['date', 'fund', 'line', 'amount', 'payee', 'memo', 'reference', 'source', 'entered_by', 'voided', 'void_reason'];

  app.get('/api/export/entries.csv', requireManager, wrap(async (req, res) => {
    const org = req.user.org_id;
    const fund_id = req.query.fund_id ? (await loadFund(req, req.query.fund_id)).id : null;
    const [entries, funds, archived, lines] = await Promise.all([store.listEntries(org, { fund_id }), store.listFunds(org), store.listFunds(org, { archived: true }), store.listLines(org, { removed: true })]);
    const fundNames = new Map([...funds, ...archived].map((f) => [f.id, f.name]));
    const lineNames = new Map(lines.map((l) => [l.id, l.name]));
    const rows = entries.map((e) => ({
      ...e, fund: fundNames.get(e.fund_id) || '', line: e.line_id ? lineNames.get(e.line_id) || '' : '', amount: e.amount.toFixed(2),
      entered_by: e.created_by, voided: e.voided_at ? 'yes' : '',
    }));
    audit(req, 'export.entries', `${rows.length} entries`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ledger-spending.csv"');
    res.send(toCsv(ENTRY_COLUMNS, rows));
  }));

  // Spending from a spreadsheet, in three steps (preview, check, import), the
  // same as the other TSS importers. QuickBooks' Transaction Detail report
  // saved as CSV reads as it is: Date, Num, Name, Memo/Description, Account,
  // Class, Amount (or Debit and Credit). The fund comes from a column (a
  // QuickBooks class, a grant name or code) or from the fund chosen for the
  // whole sheet; the budget line from the account or category, matched by
  // the line's code or name. Each row is keyed by what it says, so the same
  // sheet imported twice adds nothing the second time.
  const SPEND_FIELDS = [
    { id: 'date', label: 'Date', required: true, aliases: ['transaction_date', 'txn_date', 'posted', 'posting_date', 'date_paid', 'paid_on'] },
    { id: 'amount', label: 'Amount', hint: 'Or map Debit and Credit instead', aliases: ['total', 'amount_usd', 'net_amount', 'spent', 'cost', 'expense'] },
    { id: 'debit', label: 'Debit', aliases: ['debits', 'withdrawal', 'withdrawals', 'money_out', 'paid_out'] },
    { id: 'credit', label: 'Credit (a refund)', aliases: ['credits', 'deposit', 'deposits', 'money_in', 'refund'] },
    { id: 'fund', label: 'Fund or grant', hint: 'Name or code. Blank rows go to the fund chosen below', aliases: ['grant', 'class', 'fund_name', 'grant_name', 'restriction', 'program', 'project', 'location'] },
    { id: 'line', label: 'Budget line', hint: 'Name or code of a line on the fund\'s budget', aliases: ['line_item', 'budget_line', 'account', 'category', 'expense_account', 'gl_account', 'split', 'account_name', 'expense_category'] },
    { id: 'payee', label: 'Paid to', aliases: ['name', 'vendor', 'payee_name', 'vendor_name', 'paid_to', 'supplier', 'merchant'] },
    { id: 'memo', label: 'Memo', aliases: ['memo_description', 'description', 'details', 'notes', 'note', 'purpose'] },
    { id: 'reference', label: 'Reference', hint: 'Check or invoice number', aliases: ['num', 'no', 'number', 'ref', 'ref_no', 'check', 'check_no', 'check_number', 'invoice', 'invoice_no', 'transaction_id', 'id'] },
  ];
  const BUDGET_FIELDS = [
    { id: 'line', label: 'Budget line', required: true, aliases: ['line_item', 'item', 'category', 'account', 'expense', 'description', 'name', 'budget_line'] },
    { id: 'amount', label: 'Budget', required: true, aliases: ['budget', 'budgeted', 'amount_budgeted', 'approved', 'approved_budget', 'total', 'request', 'requested', 'grant_budget'] },
    { id: 'code', label: 'Code', hint: 'An account number, if the spending sheet uses one', aliases: ['account_number', 'account_no', 'gl', 'gl_code', 'number', 'no'] },
  ];

  for (const [kind, fields] of [['spend', SPEND_FIELDS], ['budget', BUDGET_FIELDS]]) {
    app.post(`/api/import/${kind}/preview`, requireManager, wrap(async (req, res) => {
      const sheet = readSheet(str((req.body || {}).csv, 6_000_000));
      if (!sheet.headers.length) throw bad('empty_csv', 'The file is empty');
      res.json(previewOf(sheet, fields));
    }));
  }

  const sheetRows = (b, fields) => {
    const sheet = readSheet(str(b.csv, 6_000_000));
    if (!sheet.rows.length) throw bad('empty_csv', 'The file has no rows under its header');
    if (sheet.rows.length > MAX_ROWS) throw bad('too_many_rows', `Import at most ${MAX_ROWS.toLocaleString('en-US')} rows at a time`);
    return mappedRows(sheet, cleanMapping(b.mapping, sheet.headers, fields));
  };
  // A line named in a sheet: its code, its name, or an account such as
  // "6010 Salaries" or "Expenses:Salaries" that ends with the name or starts with the code.
  const findLine = (lines, given) => {
    const g = nameKey(given);
    if (!g) return null;
    return lines.find((l) => l.code && nameKey(l.code) === g) || lines.find((l) => nameKey(l.name) === g)
      || lines.find((l) => l.code && g.startsWith(`${nameKey(l.code)} `)) || lines.find((l) => g.endsWith(` ${nameKey(l.name)}`)) || null;
  };

  app.post('/api/import/spend', requireManager, wrap(async (req, res) => {
    const b = req.body || {};
    const dry = Boolean(b.dry_run);
    const rows = sheetRows(b, SPEND_FIELDS);
    const org = req.user.org_id;
    const fallback = b.fund_id ? await loadFund(req, b.fund_id) : null;
    const funds = await store.listFunds(org);
    const lines = await store.listLines(org);
    const keys = await store.importKeys(org);
    const findFund = (given) => {
      const g = nameKey(given);
      if (!g) return fallback;
      return funds.find((f) => f.code && nameKey(f.code) === g) || funds.find((f) => nameKey(f.name) === g) || null;
    };
    const seen = new Map();
    const result = { dry_run: dry, added: 0, unchanged: 0, total: 0, skipped: [], plan: [] };
    const plan = (p) => { if (result.plan.length < 200) result.plan.push(p); };
    let totalC = 0;
    for (const [i, r] of rows.entries()) {
      const line = i + 2;
      try {
        const date = readDay(r.date);
        if (!date) throw bad('no_date', 'No date');
        if (!isDay(date)) throw bad('bad_date', `The date "${str(r.date, 30)}" could not be read`);
        if (date > clock()) throw bad('future_date', 'Dated in the future');
        let amount = r.amount !== undefined && str(r.amount, 40) !== '' ? readMoney(r.amount) : null;
        if (amount === null && (r.debit !== undefined || r.credit !== undefined)) {
          const d = readMoney(r.debit) || 0; const c = readMoney(r.credit) || 0;
          if (readMoney(r.debit) === null && readMoney(r.credit) === null) throw bad('no_amount', 'No amount');
          amount = round2(d - c);
        }
        if (amount === null) throw bad('no_amount', r.amount ? `The amount "${str(r.amount, 30)}" could not be read` : 'No amount');
        if (!amount) throw bad('zero', 'The amount is zero');
        const fund = findFund(r.fund);
        if (!fund) throw bad('no_fund', r.fund ? `No fund named or coded "${str(r.fund, 60)}"` : 'No fund: map the fund column or choose a fund for the sheet');
        const own = lines.filter((l) => l.fund_id === fund.id);
        const onLine = r.line ? findLine(own, r.line) : null;
        const fields = { date, amount, payee: str(r.payee, 200), memo: str(r.memo, 1000), reference: str(r.reference, 100) };
        const base = [fund.id, date, toCents(amount), nameKey(fields.payee), nameKey(fields.reference), nameKey(fields.memo)].join('|');
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        const import_key = crypto.createHash('sha256').update(`${base}#${n}`).digest('hex').slice(0, 40);
        const label = `${fund.name}, ${usd(amount)}${fields.payee ? `, ${fields.payee}` : ''}`;
        if (keys.has(import_key)) { result.unchanged++; plan({ line, action: 'same', name: label }); continue; }
        const detail = onLine ? onLine.name : r.line ? `"${str(r.line, 60)}" is not on the budget` : 'Not on a budget line';
        if (!dry) {
          const e = await store.createEntry(org, { id: crypto.randomUUID(), fund_id: fund.id, line_id: onLine?.id || null, ...fields, source: 'csv', import_key, created_by: req.user.name, created_by_id: req.user.id });
          if (e === false) { result.unchanged++; plan({ line, action: 'same', name: label }); continue; }
        }
        keys.add(import_key);
        totalC += toCents(amount);
        result.added++;
        plan({ line, action: 'add', name: label, detail });
      } catch (e) {
        const reason = e instanceof PublicError ? e.message : 'Could not read this row';
        result.skipped.push({ line, reason });
        plan({ line, action: 'skip', reason });
      }
    }
    result.total = totalC / 100;
    if (!dry) audit(req, 'import.spend', `${result.added} entries, ${usd(result.total)}`, [result.unchanged && `${result.unchanged} already there`, result.skipped.length && `${result.skipped.length} skipped`].filter(Boolean).join(', '));
    res.json(result);
  }));

  // A fund's budget from a spreadsheet: one row per line. A line already on
  // the budget (same code or name) takes the sheet's amount; a new one is added.
  app.post('/api/import/budget', requireManager, wrap(async (req, res) => {
    const b = req.body || {};
    const dry = Boolean(b.dry_run);
    if (!b.fund_id) throw bad('no_fund', 'Choose the fund this budget is for');
    const fund = await loadFund(req, b.fund_id);
    const rows = sheetRows(b, BUDGET_FIELDS);
    const org = req.user.org_id;
    const lines = await store.listLines(org, { fund_id: fund.id });
    const result = { dry_run: dry, added: 0, updated: 0, unchanged: 0, total: 0, skipped: [], plan: [] };
    const plan = (p) => { if (result.plan.length < 200) result.plan.push(p); };
    let totalC = 0;
    for (const [i, r] of rows.entries()) {
      const line = i + 2;
      try {
        const name = str(r.line, 160);
        if (!name) throw bad('no_name', 'No line name');
        if (/^\s*(grand\s+)?(sub)?totals?\b/i.test(name)) throw bad('total_row', 'A total row: Ledger adds the lines itself');
        const amount = readMoney(r.amount);
        if (amount === null) throw bad('no_amount', r.amount ? `The amount "${str(r.amount, 30)}" could not be read` : 'No amount');
        if (amount < 0) throw bad('bad_amount', 'A budget line cannot be below zero');
        const code = str(r.code, 40);
        const match = (code && lines.find((l) => l.code && nameKey(l.code) === nameKey(code))) || lines.find((l) => nameKey(l.name) === nameKey(name));
        totalC += toCents(amount);
        if (match) {
          const patch = {};
          if (toCents(match.amount) !== toCents(amount)) patch.amount = amount;
          if (code && code !== match.code) patch.code = code;
          if (!Object.keys(patch).length) { result.unchanged++; plan({ line, action: 'same', name }); continue; }
          if (!dry) await store.updateLine(org, match.id, patch);
          result.updated++;
          plan({ line, action: 'update', name, detail: patch.amount !== undefined ? `${usd(match.amount)} to ${usd(amount)}` : 'code' });
          Object.assign(match, patch);
        } else {
          const l = dry ? { id: `new-${line}`, name, code, amount } : await store.createLine(org, { id: crypto.randomUUID(), fund_id: fund.id, name, code, amount });
          lines.push(l);
          result.added++;
          plan({ line, action: 'add', name, detail: usd(amount) });
        }
      } catch (e) {
        const reason = e instanceof PublicError ? e.message : 'Could not read this row';
        result.skipped.push({ line, reason });
        plan({ line, action: 'skip', reason });
      }
    }
    result.total = totalC / 100;
    if (!dry) audit(req, 'import.budget', fund.name, `${result.added} added, ${result.updated} updated, ${usd(result.total)}`);
    res.json(result);
  }));

  intakeRoutes(app, { store, wrap, requireManager, audit, clock, usage, sense, senseDeps, isId });

  app.get('/api/activity', requireManager, wrap(async (req, res) => {
    res.json({ activity: await store.activity(req.user.org_id, Math.min(Number(req.query.limit) || 100, 500)) });
  }));

  // ---- frontend and errors ----

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint', code: 'not_found' }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.too.large') err = new PublicError(413, 'too_large', 'That upload is too large. Import at most a few thousand rows at a time.');
    if (err?.type === 'entity.parse.failed') err = new PublicError(400, 'bad_json', 'The request body was not valid JSON.');
    const normalized = normalizePublicError(err);
    logSafeError(console, normalized, 'request_failed', requestContext(req));
    res.status(err && err.status >= 400 && err.status < 600 ? err.status : normalized.status).json(publicErrorBody(normalized));
  });

  return app;
}

const PORT = Number(process.env.PORT) || 8797;
if (process.env.NODE_ENV !== 'test' && process.argv[1] === fileURLToPath(import.meta.url)) {
  installCrashHandlers(errorReporter('tss-ledger'));
  const store = await openStore();
  const cockpitLink = await createCockpitLink({ audience: 'ledger', canEnter: CAN_ENTER, pool: store.kind === 'postgres' ? store.pool : null }).init();
  const server = createApp({ store, cockpitLink }).listen(PORT, () => console.log(`ledger listening on ${PORT} (${store.kind} store)`));
  const stop = () => server.close(() => store.close().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

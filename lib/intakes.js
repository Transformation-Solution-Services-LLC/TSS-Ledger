// A pile of files, made sense of: the routes (managers only).
//
//   POST /api/intakes                 the files (base64). Ledger reads them,
//                                     then a model proposes their shape in
//                                     the background (status "reading").
//   GET  /api/intakes/:id             where it stands, with Ledger's reading
//                                     of the files through the shape.
//   POST /api/intakes/:id/accept      the person's answers: the shape is then
//                                     checked by other models ("checking")
//                                     until three different ones clear it
//                                     ("ready") or the rounds run out
//                                     ("unsettled").
//   POST /api/intakes/:id/import      saves what Ledger read ("imported").
//   POST /api/intakes/:id/retry       starts a stage again after a failure.
//
// The work runs in this process. One that was running when the service
// restarted is shown as stopped and can be started again.

import crypto from 'node:crypto';
import { PublicError, logSafeError } from './public-error.js';
import { buildPlan, findLine, labelFiles } from './shape.js';
import { nameKey } from './import-map.js';
import { toCents, usd } from './finance.js';
import { withUsage } from './usage.js';
import { readFiles } from '../services/extract.js';
import * as senseApi from '../services/sense.js';

const STALE_MS = 15 * 60 * 1000;
const RUNNING = new Set(['reading', 'checking', 'importing']);

export function intakeRoutes(app, { store, wrap, requireManager, audit, clock, usage, sense = senseApi, senseDeps = {}, isId }) {
  const jobs = new Map();
  const bad = (code, message) => new PublicError(400, code, message);

  async function own(req) {
    const id = req.params.id;
    const i = isId(id) ? await store.getIntake(req.user.org_id, id) : null;
    if (!i) throw new PublicError(404, 'not_found', 'No such upload');
    // Work that was running when the service restarted.
    if (RUNNING.has(i.status) && !jobs.has(i.id) && Date.now() - Date.parse(i.updated_at) > STALE_MS) {
      return store.updateIntake(req.user.org_id, i.id, { status: 'stopped', message: 'This stopped before it finished. Start it again.' });
    }
    return i;
  }

  async function mayStart(req) {
    if (!sense.configured()) throw new PublicError(503, 'llm_unconfigured', 'Reading files is off until AI is set up.');
    const s = usage ? await usage.check(req.user.org_id) : null;
    if (s && !s.allowed) throw new PublicError(429, 'usage_blocked', s.message || 'Your organization has used its AI budget for this month.');
  }

  async function orgRecords(org) {
    const [funds, lines] = await Promise.all([store.listFunds(org), store.listLines(org)]);
    return { funds, lines };
  }

  // Runs one stage in the background; a failure is kept on the intake.
  function run(req, intake, stage, fn) {
    const org = req.user.org_id;
    const ctx = { client: usage, org, userId: req.user.id, feature: 'ledger_files' };
    const job = withUsage(ctx, async () => {
      try {
        await fn();
      } catch (e) {
        logSafeError(console, e, 'intake_failed', { stage });
        const message = e instanceof PublicError ? e.message : 'Something went wrong reading these files. Start it again.';
        await store.updateIntake(org, intake.id, { status: 'failed', message, result: { failed_stage: stage } }).catch(() => {});
      } finally {
        jobs.delete(intake.id);
      }
    });
    jobs.set(intake.id, job);
    return job;
  }

  async function draftStage(req, intake) {
    const org = req.user.org_id;
    const { funds, lines } = await orgRecords(org);
    const { shape } = await sense.draftShape({ files: intake.files, funds, lines }, senseDeps);
    await store.updateIntake(org, intake.id, { status: 'asking', shape, questions: shape.questions, message: '' });
  }

  async function checkStage(req, intake) {
    const org = req.user.org_id;
    const { funds, lines } = await orgRecords(org);
    const base = { files: intake.files, funds, lines, today: clock(), questions: intake.questions, answers: intake.answers, note: intake.note };
    let shape = intake.shape;
    const followsAdvice = intake.questions.every((q) => intake.answers[q.id] === undefined || intake.answers[q.id] === q.recommended);
    const rounds = [];
    if (!followsAdvice || intake.note) {
      shape = (await sense.draftShape({ ...base, previous: shape }, senseDeps)).shape;
      rounds.push({ n: 0, at: new Date().toISOString(), answers_applied: true });
      await store.updateIntake(org, intake.id, { shape, rounds });
    }
    const out = await sense.checkUntilClear({ ...base, shape }, senseDeps, async (round, s, cleared) => {
      rounds.push(round);
      await store.updateIntake(org, intake.id, { shape: s, rounds, cleared });
    });
    const ran = out.rounds.filter((r) => !r.failed).length;
    await store.updateIntake(org, intake.id, {
      status: out.settled ? 'ready' : 'unsettled', shape: out.shape, rounds, cleared: out.cleared,
      message: out.settled ? '' : unsettledMessage(out, ran),
    });
  }

  function unsettledMessage(out, ran) {
    const last = [...out.rounds].reverse().find((r) => !r.failed && !r.clear);
    if (!ran) return 'The checks could not run just now. You can import what Ledger read, or start the checks again later.';
    if (out.rounds.length >= sense.MAX_ROUNDS && last) return `After ${out.rounds.length} checks the checkers still disagreed. Look at the open points below before importing.`;
    return `${out.cleared} of ${sense.CLEARS_NEEDED} checks cleared it; the others could not run. You can import, or start the checks again later.`;
  }

  // ---- the view the page shows ----

  async function view(req, i) {
    const out = {
      id: i.id, status: i.status, created_at: i.created_at, updated_at: i.updated_at, created_by: i.created_by,
      files: i.files.map((f) => ({ name: f.name, kind: f.kind, sheets: f.kind === 'sheet' ? f.sheets.length : 0, pages: f.pages || null })),
      summary: i.shape?.summary || '', questions: i.questions, answers: i.answers, note: i.note,
      checks: {
        needed: sense.CLEARS_NEEDED, cleared: i.cleared,
        rounds: i.rounds.filter((r) => r.n > 0).map((r) => ({ n: r.n, clear: Boolean(r.clear), counted: r.counted !== false, revised: Boolean(r.revised), failed: Boolean(r.failed), mistakes: (r.mistakes || []).map(({ where, what }) => ({ where, what })) })),
        answers_applied: i.rounds.some((r) => r.answers_applied),
      },
      message: i.message, result: i.result, plan: null,
    };
    if (i.shape) {
      const { funds, lines } = await orgRecords(req.user.org_id);
      const p = buildPlan(i.shape, i.files, { funds, lines, today: clock() });
      out.plan = {
        funds: p.funds.map((f) => ({ ...f, ...p.totals.find((t) => t.ref === f.ref) })),
        sheets: p.sheets,
        skipped: p.skipped.slice(0, 100), skipped_count: p.skipped.length,
        problems: p.problems,
        entries: p.entries.length,
        sample: p.entries.slice(0, 15).map(({ fund_ref, date, amount, payee, memo, line_name, at }) => ({ fund: p.funds.find((f) => f.ref === fund_ref)?.name || '', date, amount, payee, memo, line: line_name, at })),
      };
    }
    return out;
  }

  // ---- routes ----

  app.get('/api/intakes', requireManager, wrap(async (req, res) => {
    const list = await store.listIntakes(req.user.org_id, { limit: 10 });
    res.json({ on: sense.configured(), intakes: list.map((i) => ({ id: i.id, status: i.status, created_at: i.created_at, created_by: i.created_by, file_names: i.file_names, summary: i.shape?.summary || '' })) });
  }));

  app.post('/api/intakes', requireManager, wrap(async (req, res) => {
    await mayStart(req);
    const files = labelFiles(await readFiles((req.body || {}).files));
    const intake = await store.createIntake(req.user.org_id, { id: crypto.randomUUID(), files, created_by: req.user.name, created_by_id: req.user.id });
    audit(req, 'import.files', `${files.length} file${files.length === 1 ? '' : 's'}`, files.map((f) => f.name).join(', ').slice(0, 300));
    run(req, intake, 'draft', () => draftStage(req, intake));
    res.status(202).json(await view(req, intake));
  }));

  app.get('/api/intakes/:id', requireManager, wrap(async (req, res) => {
    res.json(await view(req, await own(req)));
  }));

  app.post('/api/intakes/:id/accept', requireManager, wrap(async (req, res) => {
    const i = await own(req);
    if (i.status !== 'asking') throw new PublicError(409, 'not_asking', 'This upload is not waiting for answers.');
    await mayStart(req);
    const b = req.body || {};
    const given = b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? b.answers : {};
    const answers = {};
    for (const q of i.questions) {
      const v = Number(given[q.id]);
      answers[q.id] = Number.isInteger(v) && v >= 0 && v < q.options.length ? v : q.recommended;
    }
    const note = String(b.note ?? '').trim().slice(0, 2000);
    const next = await store.updateIntake(req.user.org_id, i.id, { status: 'checking', answers, note, rounds: [], cleared: 0, message: '' });
    run(req, next, 'check', () => checkStage(req, next));
    res.json(await view(req, next));
  }));

  app.post('/api/intakes/:id/retry', requireManager, wrap(async (req, res) => {
    const i = await own(req);
    if (!['failed', 'stopped', 'unsettled'].includes(i.status)) throw new PublicError(409, 'not_stopped', 'This upload is not stopped.');
    await mayStart(req);
    const stage = i.shape && i.status !== 'failed' ? 'check' : i.shape && i.result?.failed_stage === 'check' ? 'check' : 'draft';
    const next = await store.updateIntake(req.user.org_id, i.id, { status: stage === 'check' ? 'checking' : 'reading', message: '', result: null, ...(stage === 'check' ? { rounds: [], cleared: 0 } : {}) });
    run(req, next, stage, () => (stage === 'check' ? checkStage(req, next) : draftStage(req, next)));
    res.json(await view(req, next));
  }));

  app.post('/api/intakes/:id/import', requireManager, wrap(async (req, res) => {
    const i = await own(req);
    if (!['ready', 'unsettled'].includes(i.status)) throw new PublicError(409, 'not_ready', i.status === 'imported' ? 'This upload is already imported.' : 'This upload is not ready to import.');
    if (i.status === 'unsettled' && !(req.body || {}).anyway) throw bad('not_cleared', 'The checks did not all clear this. Confirm to import anyway.');
    const org = req.user.org_id;
    await store.updateIntake(org, i.id, { status: 'importing' });
    try {
      const result = await importPlan(req, i);
      await store.updateIntake(org, i.id, { status: 'imported', result, message: '' });
      audit(req, 'import.files', `${result.entries_added} entries, ${usd(result.total)}`, [
        result.funds_added && `${result.funds_added} grants added`, result.lines_added && `${result.lines_added} budget lines added`,
        result.lines_updated && `${result.lines_updated} updated`, result.unchanged && `${result.unchanged} already there`,
        i.status === 'unsettled' && 'imported before every check cleared',
      ].filter(Boolean).join(', '));
    } catch (e) {
      await store.updateIntake(org, i.id, { status: i.status });
      throw e;
    }
    res.json(await view(req, await store.getIntake(org, i.id)));
  }));

  // What Ledger read, saved: new grants, budget lines (a line already on the
  // budget takes the new amount), and spending with the same import keys as
  // the CSV importer, so nothing already imported is added again.
  async function importPlan(req, intake) {
    const org = req.user.org_id;
    const { funds, lines } = await orgRecords(org);
    const plan = buildPlan(intake.shape, intake.files, { funds, lines, today: clock() });
    const result = { funds_added: 0, lines_added: 0, lines_updated: 0, entries_added: 0, unchanged: 0, total: 0, skipped: plan.skipped.length };
    const fundOf = new Map();
    for (const f of plan.funds) {
      if (f.existing) { fundOf.set(f.ref, funds.find((x) => x.id === f.id)); continue; }
      const same = funds.find((x) => nameKey(x.name) === nameKey(f.name));
      if (same) { fundOf.set(f.ref, same); continue; }
      const made = await store.createFund(org, {
        id: crypto.randomUUID(), name: f.name, kind: f.kind, funder: f.funder, code: f.code, award: f.award || 0,
        start_on: f.start_on, end_on: f.end_on, status: 'active', notes: `Imported from ${intake.files.map((x) => x.name).join(', ')}`.slice(0, 5000), created_by: req.user.name,
      });
      funds.push(made);
      fundOf.set(f.ref, made);
      result.funds_added++;
    }
    for (const b of plan.budget) {
      const fund = fundOf.get(b.fund_ref);
      const own = lines.filter((l) => l.fund_id === fund.id);
      const match = (b.code && own.find((l) => l.code && nameKey(l.code) === nameKey(b.code))) || own.find((l) => nameKey(l.name) === nameKey(b.name));
      if (match) {
        const patch = {};
        if (toCents(match.amount) !== toCents(b.amount)) patch.amount = b.amount;
        if (b.code && b.code !== match.code) patch.code = b.code;
        if (Object.keys(patch).length) { Object.assign(match, await store.updateLine(org, match.id, patch)); result.lines_updated++; }
      } else {
        lines.push(await store.createLine(org, { id: crypto.randomUUID(), fund_id: fund.id, name: b.name, code: b.code, amount: b.amount }));
        result.lines_added++;
      }
    }
    const seen = new Map();
    let totalC = 0;
    for (const e of plan.entries) {
      const fund = fundOf.get(e.fund_ref);
      const onLine = e.line ? findLine(lines.filter((l) => l.fund_id === fund.id), e.line) : null;
      const base = [fund.id, e.date, toCents(e.amount), nameKey(e.payee), nameKey(e.reference), nameKey(e.memo)].join('|');
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const import_key = crypto.createHash('sha256').update(`${base}#${n}`).digest('hex').slice(0, 40);
      const made = await store.createEntry(org, {
        id: crypto.randomUUID(), fund_id: fund.id, line_id: onLine?.id || null, date: e.date, amount: e.amount,
        payee: e.payee, memo: e.memo, reference: e.reference, source: 'csv', import_key, created_by: req.user.name, created_by_id: req.user.id,
      });
      if (made === false) { result.unchanged++; continue; }
      if (!made) continue;
      result.entries_added++;
      totalC += toCents(e.amount);
    }
    result.total = totalC / 100;
    return result;
  }

  return { jobs };
}

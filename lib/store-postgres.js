// Postgres store: production. Same contract as lib/store-memory.js.
//
// Every query names the organization, so one database serves every
// organization in Cockpit without mixing them. Money is numeric(14,2), read
// back as a number of dollars. The schema is created on start and only ever
// added to; an advisory lock keeps two instances starting at once from
// racing each other.

import pg from 'pg';
import { FUND_FIELDS, LINE_FIELDS, INTAKE_FIELDS, INTAKE_DEFAULTS, QUICKBOOKS_FIELDS, QUICKBOOKS_DEFAULTS } from './store-memory.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_funds (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'grant',
  funder text NOT NULL DEFAULT '',
  code text NOT NULL DEFAULT '',
  award numeric(14,2) NOT NULL DEFAULT 0,
  start_on date,
  end_on date,
  status text NOT NULL DEFAULT 'active',
  notes text NOT NULL DEFAULT '',
  rollodex_contact_id text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ledger_funds_org ON ledger_funds (org_id, lower(name));

CREATE TABLE IF NOT EXISTS ledger_lines (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  fund_id uuid NOT NULL REFERENCES ledger_funds (id),
  name text NOT NULL,
  code text NOT NULL DEFAULT '',
  amount numeric(14,2) NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_lines_fund ON ledger_lines (org_id, fund_id, position);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  fund_id uuid NOT NULL REFERENCES ledger_funds (id),
  line_id uuid REFERENCES ledger_lines (id),
  date date NOT NULL,
  amount numeric(14,2) NOT NULL,
  payee text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual',
  import_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT '',
  created_by_id text NOT NULL DEFAULT '',
  voided_at timestamptz,
  voided_by text NOT NULL DEFAULT '',
  void_reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ledger_entries_org ON ledger_entries (org_id, date DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_fund ON ledger_entries (org_id, fund_id, date DESC);
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS external_ref text;
CREATE INDEX IF NOT EXISTS ledger_entries_external ON ledger_entries (org_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_import_key ON ledger_entries (org_id, import_key) WHERE import_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_activity (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT '',
  action text NOT NULL,
  target text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ledger_activity_org ON ledger_activity (org_id, at DESC);

CREATE TABLE IF NOT EXISTS ledger_intakes (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  status text NOT NULL DEFAULT 'reading',
  files jsonb NOT NULL DEFAULT '[]',
  shape jsonb,
  questions jsonb NOT NULL DEFAULT '[]',
  answers jsonb NOT NULL DEFAULT '{}',
  note text NOT NULL DEFAULT '',
  rounds jsonb NOT NULL DEFAULT '[]',
  cleared integer NOT NULL DEFAULT 0,
  message text NOT NULL DEFAULT '',
  result jsonb,
  created_by text NOT NULL DEFAULT '',
  created_by_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_intakes_org ON ledger_intakes (org_id, created_at DESC);

-- One QuickBooks connection per organization. The tokens are sealed by
-- lib/quickbooks.js before they reach this table.
CREATE TABLE IF NOT EXISTS ledger_quickbooks (
  org_id text PRIMARY KEY,
  realm_id text NOT NULL DEFAULT '',
  company_name text NOT NULL DEFAULT '',
  environment text NOT NULL DEFAULT 'production',
  status text NOT NULL DEFAULT 'connected',
  access_token text NOT NULL DEFAULT '',
  refresh_token text NOT NULL DEFAULT '',
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  connected_by text NOT NULL DEFAULT '',
  connected_by_id text NOT NULL DEFAULT '',
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_sync jsonb,
  settings jsonb NOT NULL DEFAULT '{}',
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

const iso = (d) => (d instanceof Date ? d.toISOString() : d);
// A date column comes back as a Date at local midnight; the contract wants YYYY-MM-DD.
const day = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d);

const DATE_COLS = new Set(['date', 'start_on', 'end_on']);
const TIME_COLS = new Set(['created_at', 'updated_at', 'archived_at', 'removed_at', 'voided_at', 'access_expires_at', 'refresh_expires_at', 'connected_at', 'last_sync_at']);
const MONEY_COLS = new Set(['award', 'amount']);
function row(r) {
  if (!r) return null;
  const out = { ...r };
  for (const k of Object.keys(out)) {
    if (DATE_COLS.has(k)) out[k] = day(out[k]);
    else if (TIME_COLS.has(k)) out[k] = iso(out[k]);
    else if (MONEY_COLS.has(k)) out[k] = Number(out[k]);
  }
  return out;
}

export class PostgresStore {
  constructor(connectionString, { ssl } = {}) {
    this.kind = 'postgres';
    this.pool = new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX) || 10, ssl });
  }

  async init() {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(7464)');
      try { await c.query(SCHEMA); } finally { await c.query('SELECT pg_advisory_unlock(7464)'); }
    } finally { c.release(); }
    return this;
  }

  async close() { await this.pool.end(); }
  async ping() { await this.pool.query('SELECT 1'); return true; }

  q(text, params) { return this.pool.query(text, params); }

  // ---- funds ----

  async listFunds(org, { q = '', archived = false } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM ledger_funds
        WHERE org_id = $1 AND (archived_at IS NOT NULL) = $2
          AND ($3 = '' OR concat_ws(' ', name, funder, code, notes) ILIKE '%' || $3 || '%')
        ORDER BY lower(name), id`,
      [org, Boolean(archived), String(q || '').trim()]);
    return rows.map(row);
  }

  async getFund(org, id) {
    const { rows } = await this.q('SELECT * FROM ledger_funds WHERE org_id = $1 AND id = $2', [org, id]);
    return row(rows[0]);
  }

  async createFund(org, rec) {
    const { rows } = await this.q(
      `INSERT INTO ledger_funds (id, org_id, name, kind, funder, code, award, start_on, end_on, status, notes, rollodex_contact_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING *`,
      [rec.id, org, rec.name, rec.kind || 'grant', rec.funder || '', rec.code || '', rec.award || 0, rec.start_on || null, rec.end_on || null,
        rec.status || 'active', rec.notes || '', rec.rollodex_contact_id || null, rec.created_by || '']);
    return row(rows[0]);
  }

  async updateFund(org, id, patch) {
    const sets = [];
    const params = [org, id];
    for (const k of FUND_FIELDS) {
      if (patch[k] === undefined) continue;
      params.push(patch[k]);
      sets.push(`${k} = $${params.length}`);
    }
    sets.push('updated_at = now()');
    const { rows } = await this.q(`UPDATE ledger_funds SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`, params);
    return row(rows[0]);
  }

  // ---- budget lines ----

  async listLines(org, { fund_id = null, removed = false } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM ledger_lines WHERE org_id = $1 AND ($2::uuid IS NULL OR fund_id = $2) AND ($3::boolean OR removed_at IS NULL)
        ORDER BY fund_id, position, id`, [org, fund_id, Boolean(removed)]);
    return rows.map(row);
  }

  async getLine(org, id) {
    const { rows } = await this.q('SELECT * FROM ledger_lines WHERE org_id = $1 AND id = $2', [org, id]);
    return row(rows[0]);
  }

  async createLine(org, rec) {
    if (!(await this.getFund(org, rec.fund_id))) return null;
    const { rows } = await this.q(
      `INSERT INTO ledger_lines (id, org_id, fund_id, name, code, amount, position)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::integer, (SELECT count(*) FROM ledger_lines WHERE org_id = $2 AND fund_id = $3)::integer)) RETURNING *`,
      [rec.id, org, rec.fund_id, rec.name, rec.code || '', rec.amount || 0, rec.position ?? null]);
    return row(rows[0]);
  }

  async updateLine(org, id, patch) {
    const sets = [];
    const params = [org, id];
    for (const k of LINE_FIELDS) {
      if (patch[k] === undefined) continue;
      params.push(patch[k]);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) return this.getLine(org, id);
    const { rows } = await this.q(`UPDATE ledger_lines SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`, params);
    return row(rows[0]);
  }

  // ---- spend entries ----

  async listEntries(org, { fund_id = null, from = null, to = null, q = '', voided = true, limit = null } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM ledger_entries
        WHERE org_id = $1 AND ($2::uuid IS NULL OR fund_id = $2) AND ($3::date IS NULL OR date >= $3) AND ($4::date IS NULL OR date <= $4)
          AND ($5::boolean OR voided_at IS NULL) AND ($6 = '' OR concat_ws(' ', payee, memo, reference) ILIKE '%' || $6 || '%')
        ORDER BY date DESC, created_at DESC, id DESC
        LIMIT $7`, [org, fund_id, from, to, Boolean(voided), String(q || '').trim(), limit || null]);
    return rows.map(row);
  }

  async getEntry(org, id) {
    const { rows } = await this.q('SELECT * FROM ledger_entries WHERE org_id = $1 AND id = $2', [org, id]);
    return row(rows[0]);
  }

  async createEntry(org, rec) {
    if (!(await this.getFund(org, rec.fund_id))) return null;
    if (rec.line_id) {
      const l = await this.getLine(org, rec.line_id);
      if (!l || l.fund_id !== rec.fund_id) return null;
    }
    const { rows } = await this.q(
      `INSERT INTO ledger_entries (id, org_id, fund_id, line_id, date, amount, payee, memo, reference, source, import_key, created_by, created_by_id, external_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (org_id, import_key) WHERE import_key IS NOT NULL DO NOTHING RETURNING *`,
      [rec.id, org, rec.fund_id, rec.line_id || null, rec.date, rec.amount, rec.payee || '', rec.memo || '', rec.reference || '', rec.source || 'manual',
        rec.import_key || null, rec.created_by || '', rec.created_by_id || '', rec.external_ref || null]);
    return rows[0] ? row(rows[0]) : false;
  }

  async importKeys(org) {
    const { rows } = await this.q('SELECT import_key FROM ledger_entries WHERE org_id = $1 AND import_key IS NOT NULL', [org]);
    return new Set(rows.map((r) => r.import_key));
  }

  async voidEntry(org, id, { by, reason }) {
    await this.q(
      'UPDATE ledger_entries SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE org_id = $1 AND id = $2 AND voided_at IS NULL',
      [org, id, by || '', reason || '']);
    return this.getEntry(org, id);
  }

  // ---- intakes ----

  async createIntake(org, rec) {
    const r = { ...INTAKE_DEFAULTS, ...rec };
    const j = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
    const { rows } = await this.q(
      `INSERT INTO ledger_intakes (id, org_id, status, files, shape, questions, answers, note, rounds, cleared, message, result, created_by, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [r.id, org, r.status, j(r.files), j(r.shape), j(r.questions), j(r.answers), r.note || '', j(r.rounds), r.cleared || 0, r.message || '', j(r.result), r.created_by || '', r.created_by_id || '']);
    return row(rows[0]);
  }

  async getIntake(org, id) {
    const { rows } = await this.q('SELECT * FROM ledger_intakes WHERE org_id = $1 AND id = $2', [org, id]);
    return row(rows[0]);
  }

  async updateIntake(org, id, patch) {
    const sets = [];
    const vals = [org, id];
    for (const k of INTAKE_FIELDS) {
      if (patch[k] === undefined) continue;
      const plain = ['status', 'note', 'cleared', 'message'].includes(k);
      vals.push(plain ? patch[k] : (patch[k] === null ? null : JSON.stringify(patch[k])));
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return this.getIntake(org, id);
    const { rows } = await this.q(`UPDATE ledger_intakes SET ${sets.join(', ')}, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`, vals);
    return row(rows[0]);
  }

  async listIntakes(org, { limit = 20 } = {}) {
    const { rows } = await this.q(
      `SELECT id, org_id, status, shape, questions, answers, note, rounds, cleared, message, result, created_by, created_by_id, created_at, updated_at,
              COALESCE((SELECT jsonb_agg(f->>'name') FROM jsonb_array_elements(files) f), '[]'::jsonb) AS file_names
         FROM ledger_intakes WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [org, limit]);
    return rows.map(row);
  }

  // ---- the QuickBooks connection: one per organization ----

  async getQuickbooks(org) {
    const { rows } = await this.q('SELECT * FROM ledger_quickbooks WHERE org_id = $1', [org]);
    return row(rows[0]);
  }

  async saveQuickbooks(org, patch) {
    const JSON_COLS = new Set(['last_sync', 'settings', 'snapshot']);
    const val = (k, v) => (JSON_COLS.has(k) ? (v === null ? null : JSON.stringify(v)) : v);
    const given = QUICKBOOKS_FIELDS.filter((k) => patch[k] !== undefined);
    const params = [org, ...QUICKBOOKS_FIELDS.map((k) => val(k, patch[k] !== undefined ? patch[k] : QUICKBOOKS_DEFAULTS[k]))];
    const updates = [...given.map((k) => `${k} = EXCLUDED.${k}`), 'updated_at = now()'];
    const { rows } = await this.q(
      `INSERT INTO ledger_quickbooks (org_id, ${QUICKBOOKS_FIELDS.join(', ')}) VALUES ($1, ${QUICKBOOKS_FIELDS.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (org_id) DO UPDATE SET ${updates.join(', ')} RETURNING *`, params);
    return row(rows[0]);
  }

  async removeQuickbooks(org) {
    const r = await this.q('DELETE FROM ledger_quickbooks WHERE org_id = $1', [org]);
    return r.rowCount > 0;
  }

  async quickbooksDue(before) {
    const { rows } = await this.q(
      "SELECT org_id FROM ledger_quickbooks WHERE status = 'connected' AND (last_sync_at IS NULL OR last_sync_at < $1) ORDER BY org_id", [before]);
    return rows.map((r) => r.org_id);
  }

  // ---- activity ----

  async log(org, { actor, action, target = '', detail = '' }) {
    await this.q('INSERT INTO ledger_activity (org_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)',
      [org, actor || '', action, target, String(detail).slice(0, 500)]);
  }

  async activity(org, limit = 100) {
    const { rows } = await this.q('SELECT id, org_id, at, actor, action, target, detail FROM ledger_activity WHERE org_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [org, limit]);
    return rows.map((r) => ({ ...r, id: Number(r.id), at: iso(r.at) }));
  }
}

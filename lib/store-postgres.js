// Postgres store: production. Same contract as lib/store-memory.js.
//
// Every query names the organization, so one database serves every
// organization in Cockpit without mixing them. Money is numeric(14,2), read
// back as a number of dollars. The schema is created on start and only ever
// added to; an advisory lock keeps two instances starting at once from
// racing each other.

import pg from 'pg';
import { FUND_FIELDS, LINE_FIELDS } from './store-memory.js';

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
`;

const iso = (d) => (d instanceof Date ? d.toISOString() : d);
// A date column comes back as a Date at local midnight; the contract wants YYYY-MM-DD.
const day = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d);

const DATE_COLS = new Set(['date', 'start_on', 'end_on']);
const TIME_COLS = new Set(['created_at', 'updated_at', 'archived_at', 'removed_at', 'voided_at']);
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
      `INSERT INTO ledger_entries (id, org_id, fund_id, line_id, date, amount, payee, memo, reference, source, import_key, created_by, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (org_id, import_key) WHERE import_key IS NOT NULL DO NOTHING RETURNING *`,
      [rec.id, org, rec.fund_id, rec.line_id || null, rec.date, rec.amount, rec.payee || '', rec.memo || '', rec.reference || '', rec.source || 'manual',
        rec.import_key || null, rec.created_by || '', rec.created_by_id || '']);
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

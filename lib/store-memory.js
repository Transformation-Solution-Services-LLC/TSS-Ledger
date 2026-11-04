// In-memory store: development and tests. Everything is lost on restart, so
// production refuses it (lib/store.js). Same contract as lib/store-postgres.js;
// test/store.test.mjs runs one suite against both.
//
// Every method takes the organization first and answers only for it. Records
// are plain objects; dates are YYYY-MM-DD strings, timestamps ISO strings,
// money a number of dollars with cents. Nothing is deleted: a fund is
// archived, a budget line is removed (kept, hidden), a spend entry is voided
// (kept, marked, and left out of every figure).

const clone = (v) => structuredClone(v);
const now = () => new Date().toISOString();
const money = (n) => Math.round(Number(n || 0) * 100) / 100;

export const FUND_FIELDS = ['name', 'kind', 'funder', 'code', 'award', 'start_on', 'end_on', 'status', 'notes', 'rollodex_contact_id', 'archived_at', 'updated_by'];
export const LINE_FIELDS = ['name', 'code', 'amount', 'position', 'removed_at'];

export function fundMatches(f, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  return [f.name, f.funder, f.code, f.notes].join(' ').toLowerCase().includes(needle);
}

export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.funds = new Map();
    this.lines = new Map();
    this.entries = new Map();
    this.log_ = [];
  }

  async init() { return this; }
  async close() {}
  async ping() { return true; }

  own(map, org, id) {
    const r = map.get(id);
    return r && r.org_id === org ? r : null;
  }

  // ---- funds ----

  async listFunds(org, { q = '', archived = false } = {}) {
    return [...this.funds.values()]
      .filter((f) => f.org_id === org && Boolean(f.archived_at) === Boolean(archived) && fundMatches(f, q))
      .map(clone)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  }

  async getFund(org, id) {
    const f = this.own(this.funds, org, id);
    return f ? clone(f) : null;
  }

  async createFund(org, rec) {
    const f = {
      kind: 'grant', funder: '', code: '', award: 0, start_on: null, end_on: null, status: 'active', notes: '', rollodex_contact_id: null, archived_at: null,
      ...clone(rec), org_id: org, created_at: now(), updated_at: now(),
    };
    f.award = money(f.award);
    f.updated_by = f.updated_by || f.created_by || '';
    this.funds.set(f.id, f);
    return clone(f);
  }

  async updateFund(org, id, patch) {
    const f = this.own(this.funds, org, id);
    if (!f) return null;
    for (const k of FUND_FIELDS) if (patch[k] !== undefined) f[k] = k === 'award' ? money(patch[k]) : clone(patch[k]);
    f.updated_at = now();
    return clone(f);
  }

  // ---- budget lines ----

  // Every line of the organization (or of one fund), removed ones only when asked.
  async listLines(org, { fund_id = null, removed = false } = {}) {
    return [...this.lines.values()]
      .filter((l) => l.org_id === org && (!fund_id || l.fund_id === fund_id) && (removed || !l.removed_at))
      .map(clone)
      .sort((a, b) => a.fund_id.localeCompare(b.fund_id) || a.position - b.position || a.id.localeCompare(b.id));
  }

  async getLine(org, id) {
    const l = this.own(this.lines, org, id);
    return l ? clone(l) : null;
  }

  async createLine(org, rec) {
    if (!this.own(this.funds, org, rec.fund_id)) return null;
    const position = rec.position ?? [...this.lines.values()].filter((l) => l.fund_id === rec.fund_id).length;
    const l = { code: '', removed_at: null, ...clone(rec), amount: money(rec.amount), position, org_id: org, created_at: now() };
    this.lines.set(l.id, l);
    return clone(l);
  }

  async updateLine(org, id, patch) {
    const l = this.own(this.lines, org, id);
    if (!l) return null;
    for (const k of LINE_FIELDS) if (patch[k] !== undefined) l[k] = k === 'amount' ? money(patch[k]) : clone(patch[k]);
    return clone(l);
  }

  // ---- spend entries ----

  async listEntries(org, { fund_id = null, from = null, to = null, q = '', voided = true, limit = null } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    const list = [...this.entries.values()]
      .filter((e) => e.org_id === org && (!fund_id || e.fund_id === fund_id) && (!from || e.date >= from) && (!to || e.date <= to)
        && (voided || !e.voided_at) && (!needle || [e.payee, e.memo, e.reference].join(' ').toLowerCase().includes(needle)))
      .map(clone)
      .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return limit ? list.slice(0, limit) : list;
  }

  async getEntry(org, id) {
    const e = this.own(this.entries, org, id);
    return e ? clone(e) : null;
  }

  // null: the fund or line is not this organization's. false: the import key
  // is already on an entry (the same row imported again).
  async createEntry(org, rec) {
    if (!this.own(this.funds, org, rec.fund_id)) return null;
    if (rec.line_id) {
      const l = this.own(this.lines, org, rec.line_id);
      if (!l || l.fund_id !== rec.fund_id) return null;
    }
    if (rec.import_key && [...this.entries.values()].some((e) => e.org_id === org && e.import_key === rec.import_key)) return false;
    const e = {
      line_id: null, payee: '', memo: '', reference: '', source: 'manual', import_key: null, created_by: '', created_by_id: '',
      voided_at: null, voided_by: '', void_reason: '', ...clone(rec), amount: money(rec.amount), org_id: org, created_at: now(),
    };
    this.entries.set(e.id, e);
    return clone(e);
  }

  async importKeys(org) {
    return new Set([...this.entries.values()].filter((e) => e.org_id === org && e.import_key).map((e) => e.import_key));
  }

  // A spend entry is never edited or deleted. One entered by mistake is voided.
  async voidEntry(org, id, { by, reason }) {
    const e = this.own(this.entries, org, id);
    if (!e) return null;
    if (!e.voided_at) Object.assign(e, { voided_at: now(), voided_by: by || '', void_reason: reason || '' });
    return clone(e);
  }

  // ---- activity ----

  async log(org, { actor, action, target = '', detail = '' }) {
    this.log_.push({ id: this.log_.length + 1, org_id: org, at: now(), actor, action, target, detail: String(detail).slice(0, 500) });
  }

  async activity(org, limit = 100) {
    return this.log_.filter((e) => e.org_id === org).slice(-limit).reverse().map(clone);
  }
}

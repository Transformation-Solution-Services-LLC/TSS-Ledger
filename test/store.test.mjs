// One contract, two stores. The in-memory store always runs; the Postgres
// store runs when TEST_DATABASE_URL points at a database (CI starts one).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MemoryStore } from '../lib/store-memory.js';
import { PostgresStore } from '../lib/store-postgres.js';

const stores = [['memory', async () => new MemoryStore().init()]];
if (process.env.TEST_DATABASE_URL) {
  stores.push(['postgres', async () => {
    const s = await new PostgresStore(process.env.TEST_DATABASE_URL).init();
    await s.q('TRUNCATE ledger_quickbooks, ledger_data_chats, ledger_datasets, ledger_intakes, ledger_activity, ledger_entries, ledger_lines, ledger_funds');
    return s;
  }]);
}

const id = () => crypto.randomUUID();

for (const [name, open] of stores) {
  test(`${name}: funds stay inside their organization, search, archive and keep their fields`, async () => {
    const store = await open();
    try {
      const g = await store.createFund('org-a', { id: id(), name: 'Youth Diversion', kind: 'grant', funder: 'Meyer Memorial Trust', code: 'YD26', award: 50000.5, start_on: '2026-01-01', end_on: '2026-12-31', created_by: 'Ray' });
      await store.createFund('org-a', { id: id(), name: 'General operating', kind: 'unrestricted' });
      await store.createFund('org-b', { id: id(), name: 'Theirs' });
      assert.equal(g.award, 50000.5);
      assert.equal(typeof g.award, 'number');
      assert.equal(g.start_on, '2026-01-01');
      assert.equal(g.end_on, '2026-12-31');
      assert.equal(g.status, 'active');
      assert.equal(g.updated_by, 'Ray');
      assert.equal(g.rollodex_contact_id, null);
      assert.equal(g.archived_at, null);
      assert.deepEqual((await store.listFunds('org-a')).map((f) => f.name), ['General operating', 'Youth Diversion']);
      assert.deepEqual((await store.listFunds('org-a', { q: 'meyer' })).map((f) => f.name), ['Youth Diversion'], 'search covers the funder');
      assert.deepEqual((await store.listFunds('org-a', { q: 'yd26' })).map((f) => f.name), ['Youth Diversion'], 'and the code');
      assert.equal(await store.getFund('org-b', g.id), null, 'another organization cannot read it');
      assert.equal(await store.updateFund('org-b', g.id, { name: 'x' }), null, 'or change it');

      const u = await store.updateFund('org-a', g.id, { award: '60000', rollodex_contact_id: 'c-1', archived_at: new Date().toISOString(), updated_by: 'Kim' });
      assert.equal(u.award, 60000);
      assert.equal(u.rollodex_contact_id, 'c-1');
      assert.deepEqual((await store.listFunds('org-a')).map((f) => f.name), ['General operating']);
      assert.deepEqual((await store.listFunds('org-a', { archived: true })).map((f) => f.name), ['Youth Diversion']);
    } finally { await store.close(); }
  });

  test(`${name}: budget lines belong to one fund, keep their order, and are removed, not deleted`, async () => {
    const store = await open();
    try {
      const f = await store.createFund('org-a', { id: id(), name: 'Grant' });
      const other = await store.createFund('org-b', { id: id(), name: 'Theirs' });
      const a = await store.createLine('org-a', { id: id(), fund_id: f.id, name: 'Personnel', code: '6000', amount: 30000 });
      const b = await store.createLine('org-a', { id: id(), fund_id: f.id, name: 'Supplies', amount: 1200.25 });
      assert.equal(await store.createLine('org-a', { id: id(), fund_id: other.id, name: 'x', amount: 1 }), null, 'not on another organization\'s fund');
      assert.equal(a.position, 0);
      assert.equal(b.position, 1);
      assert.equal(b.amount, 1200.25);
      assert.deepEqual((await store.listLines('org-a', { fund_id: f.id })).map((l) => l.name), ['Personnel', 'Supplies']);
      assert.equal((await store.updateLine('org-a', a.id, { amount: 31000 })).amount, 31000);
      assert.equal(await store.updateLine('org-b', a.id, { amount: 1 }), null);
      await store.updateLine('org-a', b.id, { removed_at: new Date().toISOString() });
      assert.deepEqual((await store.listLines('org-a')).map((l) => l.name), ['Personnel']);
      assert.deepEqual((await store.listLines('org-a', { removed: true })).map((l) => l.name), ['Personnel', 'Supplies']);
    } finally { await store.close(); }
  });

  test(`${name}: spend entries check their fund and line, refuse a repeated import key, and are voided, not deleted`, async () => {
    const store = await open();
    try {
      const f = await store.createFund('org-a', { id: id(), name: 'Grant' });
      const g = await store.createFund('org-a', { id: id(), name: 'Other grant' });
      const l = await store.createLine('org-a', { id: id(), fund_id: f.id, name: 'Personnel', amount: 1000 });
      const e1 = await store.createEntry('org-a', { id: id(), fund_id: f.id, line_id: l.id, date: '2026-03-02', amount: 120.1, payee: 'Staffing Co', memo: 'March', reference: '1001', created_by: 'Ray', created_by_id: 'u-ray' });
      await store.createEntry('org-a', { id: id(), fund_id: f.id, date: '2026-04-15', amount: -20, payee: 'Refund', source: 'csv', import_key: 'k1' });
      assert.equal(e1.amount, 120.1);
      assert.equal(e1.date, '2026-03-02');
      assert.equal(e1.source, 'manual');
      assert.equal(e1.voided_at, null);
      assert.equal(await store.createEntry('org-a', { id: id(), fund_id: f.id, date: '2026-04-15', amount: -20, import_key: 'k1' }), false, 'the same import key twice is refused');
      assert.equal(await store.createEntry('org-a', { id: id(), fund_id: g.id, line_id: l.id, date: '2026-04-15', amount: 5 }), null, 'a line of another fund is refused');
      assert.equal(await store.createEntry('org-b', { id: id(), fund_id: f.id, date: '2026-04-15', amount: 5 }), null, 'another organization cannot write to it');
      assert.deepEqual([...(await store.importKeys('org-a'))], ['k1']);
      assert.equal((await store.importKeys('org-b')).size, 0);

      assert.deepEqual((await store.listEntries('org-a')).map((e) => e.date), ['2026-04-15', '2026-03-02'], 'newest first');
      assert.deepEqual((await store.listEntries('org-a', { from: '2026-04-01' })).map((e) => e.amount), [-20]);
      assert.deepEqual((await store.listEntries('org-a', { q: 'staffing' })).map((e) => e.amount), [120.1]);
      assert.equal((await store.listEntries('org-b')).length, 0);

      const v = await store.voidEntry('org-a', e1.id, { by: 'Kim', reason: 'Duplicate' });
      assert.equal(v.voided_by, 'Kim');
      assert.equal(v.void_reason, 'Duplicate');
      assert.ok(v.voided_at);
      const again = await store.voidEntry('org-a', e1.id, { by: 'Ray', reason: 'x' });
      assert.equal(again.voided_by, 'Kim', 'voided once');
      assert.equal(await store.voidEntry('org-b', e1.id, { by: 'x', reason: 'x' }), null);
      assert.deepEqual((await store.listEntries('org-a', { voided: false })).map((e) => e.amount), [-20]);
      assert.equal((await store.listEntries('org-a')).length, 2, 'a voided entry stays on the record');
    } finally { await store.close(); }
  });

  test(`${name}: the activity log is per organization, newest first`, async () => {
    const store = await open();
    try {
      await store.log('org-a', { actor: 'Ray', action: 'fund.add', target: 'Grant' });
      await new Promise((r) => setTimeout(r, 5));
      await store.log('org-a', { actor: 'Ray', action: 'entry.add', target: 'Grant', detail: '$5' });
      await store.log('org-b', { actor: 'Bea', action: 'fund.add' });
      assert.deepEqual((await store.activity('org-a')).map((a) => a.action), ['entry.add', 'fund.add']);
      assert.equal((await store.activity('org-b')).length, 1);
    } finally { await store.close(); }
  });
  test(`${name}: an intake keeps what was read, its shape and its rounds, inside its organization`, async () => {
    const store = await open();
    try {
      const files = [{ name: 'qb.csv', kind: 'sheet', sheets: [{ id: 'S1', name: '', rows: [['Date', 'Amount'], ['2026-01-02', '5.00']] }] }, { name: 'award.pdf', kind: 'document', id: 'D1', text: 'Award of $5,000', pages: 1 }];
      const a = await store.createIntake('org-a', { id: id(), files, created_by: 'Ray', created_by_id: 'u-ray' });
      assert.equal(a.status, 'reading');
      assert.deepEqual(a.files, files);
      assert.equal(a.shape, null);
      assert.deepEqual([a.questions, a.answers, a.rounds, a.cleared, a.result], [[], {}, [], 0, null]);
      assert.equal(await store.getIntake('org-b', a.id), null, 'another organization cannot read it');
      assert.equal(await store.updateIntake('org-b', a.id, { status: 'x' }), null, 'or change it');
      const shape = { summary: 'One sheet.', funds: [], sheets: [], questions: [] };
      const u = await store.updateIntake('org-a', a.id, { status: 'asking', shape, questions: [{ id: 'Q1', ask: 'Which?', options: ['A', 'B'], recommended: 0 }], answers: { Q1: 1 }, note: 'ok', rounds: [{ n: 1, clear: true }], cleared: 1, message: 'm', result: { added: 2 } });
      assert.equal(u.status, 'asking');
      assert.deepEqual(u.shape, shape);
      assert.deepEqual(u.answers, { Q1: 1 });
      assert.deepEqual(u.rounds, [{ n: 1, clear: true }]);
      assert.equal(u.cleared, 1);
      assert.deepEqual(u.result, { added: 2 });
      assert.deepEqual(u.files, files, 'files untouched');
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.createIntake('org-a', { id: id(), files: [] });
      await store.createIntake('org-b', { id: id(), files });
      const list = await store.listIntakes('org-a');
      assert.deepEqual(list.map((x) => x.id), [b.id, a.id], 'newest first');
      assert.equal(list[1].files, undefined, 'the list leaves the files out');
      assert.deepEqual(list[1].file_names, ['qb.csv', 'award.pdf']);
    } finally { await store.close(); }
  });

  test(`${name}: a dataset keeps its tables, lists without rows, and belongs to its organization and owner`, async () => {
    const store = await open();
    try {
      const tables = [{ name: 'qb', columns: [{ name: 'Date', type: 'date' }, { name: 'Amount', type: 'money' }], rows: [['2026-01-02', 5.25], ['2026-01-03', null]], notes: ['One total row left out.'] }];
      const a = await store.createDataset('org-a', { id: id(), owner_id: 'u-dana', owner_name: 'Dana', name: 'qb', files: ['qb.csv'], tables });
      assert.equal(a.source, 'upload');
      assert.deepEqual(a.tables, tables);
      assert.deepEqual(a.files, ['qb.csv']);
      assert.equal(await store.getDataset('org-b', a.id), null, 'another organization cannot read it');
      assert.equal(await store.updateDataset('org-b', a.id, { name: 'x' }), null, 'or change it');
      assert.equal(await store.deleteDataset('org-b', a.id), false, 'or delete it');
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.createDataset('org-a', { id: id(), owner_id: 'u-ray', name: 'theirs', source: 'quickbooks', source_ref: 'realm-1', tables: [] });
      await store.createDataset('org-b', { id: id(), owner_id: 'u-dana', name: 'other org', tables });
      assert.deepEqual((await store.listDatasets('org-a')).map((d) => d.id), [b.id, a.id], 'newest first');
      const mine = await store.listDatasets('org-a', { owner_id: 'u-dana' });
      assert.deepEqual(mine.map((d) => d.id), [a.id]);
      assert.deepEqual(mine[0].tables, [{ name: 'qb', columns: tables[0].columns, row_count: 2 }], 'the list gives each table without its rows');
      assert.deepEqual((await store.listDatasets('org-a', { source: 'quickbooks' })).map((d) => d.source_ref), ['realm-1']);
      assert.equal((await store.updateDataset('org-a', a.id, { name: 'Q1' })).name, 'Q1');
      const c = await store.createChat('org-a', { id: id(), owner_id: 'u-dana', dataset_ids: [a.id, 'ledger'] });
      assert.equal(await store.deleteDataset('org-a', a.id), true);
      assert.equal(await store.getDataset('org-a', a.id), null);
      assert.deepEqual((await store.getChat('org-a', c.id)).dataset_ids, ['ledger'], 'a deleted dataset leaves its chats');
    } finally { await store.close(); }
  });

  test(`${name}: a data chat keeps its messages, lists by owner and dataset, and is deleted whole`, async () => {
    const store = await open();
    try {
      const c = await store.createChat('org-a', { id: id(), owner_id: 'u-dana', owner_name: 'Dana', dataset_ids: ['ledger'] });
      assert.deepEqual([c.title, c.status, c.messages, c.compaction, c.docs], ['New chat', 'idle', [], null, []]);
      const messages = [{ role: 'user', text: 'How much?' }, { role: 'assistant', text: '$5.25', steps: [{ n: 1, kind: 'calc', value: 5.25 }] }];
      const u = await store.updateChat('org-a', c.id, { title: 'How much?', messages, status: 'thinking', compaction: { summary: 's', through: 1 }, docs: [{ name: 'a.md', text: 'x' }] });
      assert.deepEqual([u.title, u.status, u.messages, u.compaction, u.docs], ['How much?', 'thinking', messages, { summary: 's', through: 1 }, [{ name: 'a.md', text: 'x' }]]);
      assert.equal(await store.getChat('org-b', c.id), null);
      assert.equal(await store.updateChat('org-b', c.id, { title: 'x' }), null);
      assert.equal(await store.deleteChat('org-b', c.id), false);
      await new Promise((r) => setTimeout(r, 5));
      const d = await store.createChat('org-a', { id: id(), owner_id: 'u-ray', dataset_ids: [] });
      const list = await store.listChats('org-a', { owner_id: 'u-dana' });
      assert.deepEqual(list.map((x) => [x.id, x.message_count, x.doc_names]), [[c.id, 2, ['a.md']]]);
      assert.equal(list[0].messages, undefined, 'the list leaves the messages out');
      assert.deepEqual((await store.listChats('org-a', { dataset_id: 'ledger' })).map((x) => x.id), [c.id]);
      assert.deepEqual((await store.listChats('org-a')).map((x) => x.id), [d.id, c.id], 'latest first');
      assert.equal(await store.deleteChat('org-a', c.id), true);
      assert.equal(await store.getChat('org-a', c.id), null);
    } finally { await store.close(); }
  });
}

for (const [name, open] of stores) {
  test(`${name}: one QuickBooks connection per organization, saved, merged, due and removed; entries keep their QuickBooks reference`, async () => {
    const store = await open();
    try {
      assert.equal(await store.getQuickbooks('org-a'), null);
      const c = await store.saveQuickbooks('org-a', { realm_id: '123', company_name: 'Co', access_token: 'v1.sealed', refresh_token: 'v1.sealed2', access_expires_at: '2026-06-30T10:00:00.000Z', connected_by: 'Kim' });
      assert.deepEqual([c.org_id, c.realm_id, c.status, c.environment, c.last_sync_at, c.last_sync, c.snapshot], ['org-a', '123', 'connected', 'production', null, null, null]);
      assert.deepEqual(c.settings, {});
      assert.equal(c.access_expires_at, '2026-06-30T10:00:00.000Z');
      const u = await store.saveQuickbooks('org-a', { last_sync_at: '2026-06-30T11:00:00.000Z', last_sync: { added: 2, classes: [{ name: 'YD' }] }, settings: { budgets: true } });
      assert.equal(u.company_name, 'Co', 'a save merges, it does not wipe');
      assert.equal(u.access_token, 'v1.sealed');
      assert.deepEqual(u.last_sync, { added: 2, classes: [{ name: 'YD' }] });
      assert.deepEqual(u.settings, { budgets: true });
      await store.saveQuickbooks('org-b', { realm_id: '456' });
      assert.equal((await store.getQuickbooks('org-b')).realm_id, '456', 'each organization has its own');
      assert.deepEqual(await store.quickbooksDue('2026-06-30T12:00:00.000Z'), ['org-a', 'org-b']);
      assert.deepEqual(await store.quickbooksDue('2026-06-30T10:30:00.000Z'), ['org-b'], 'org-a synced after the cut-off');
      await store.saveQuickbooks('org-b', { status: 'reconnect' });
      assert.deepEqual(await store.quickbooksDue('2026-07-30T00:00:00.000Z'), ['org-a'], 'one waiting to be connected again is not due');
      assert.equal(await store.removeQuickbooks('org-a'), true);
      assert.equal(await store.getQuickbooks('org-a'), null);
      assert.equal(await store.removeQuickbooks('org-a'), false);
      assert.equal((await store.getQuickbooks('org-b')).realm_id, '456');

      const f = await store.createFund('org-a', { id: id(), name: 'Youth' });
      const e = await store.createEntry('org-a', { id: id(), fund_id: f.id, date: '2026-03-01', amount: 10, source: 'quickbooks', import_key: 'k1', external_ref: 'qbo:123:purchase:1:1' });
      assert.equal(e.external_ref, 'qbo:123:purchase:1:1');
      const plain = await store.createEntry('org-a', { id: id(), fund_id: f.id, date: '2026-03-01', amount: 10 });
      assert.equal(plain.external_ref, null);
    } finally { await store.close(); }
  });
}

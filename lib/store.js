// Picks the store. Postgres whenever DATABASE_URL is set; production refuses
// to start without it, because the in-memory store forgets everything on
// restart and cannot be shared by more than one instance.

import { MemoryStore } from './store-memory.js';
import { PostgresStore } from './store-postgres.js';

export async function openStore(env = process.env) {
  const url = String(env.DATABASE_URL || '').trim();
  if (url) {
    // Render's internal connection string needs no TLS; an external one does.
    const ssl = ['1', 'true', 'on', 'require'].includes(String(env.DATABASE_SSL || '').toLowerCase()) ? { rejectUnauthorized: false } : undefined;
    return new PostgresStore(url, { ssl }).init();
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production: Ledger keeps its records in Postgres.');
  }
  console.warn('No DATABASE_URL: using the in-memory store. Everything is lost on restart.');
  return new MemoryStore().init();
}

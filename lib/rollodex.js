// The Rollodex client: links a grant to its funder in Rollodex.
//
// "Link to Rollodex" on a grant sends the funder's name to Rollodex's
// POST /api/service/funders, the same route Sherlock's "Save funder to
// Rollodex" uses: Rollodex finds the funder among the organization's
// contacts by name, or adds it as a Grantor, and answers its contact id.
// Ledger keeps the id so the grant opens its funder in Rollodex. Only the
// funder's name goes, never an amount or an entry.
//
// Ledger calls with Rollodex's ROLLODEX_SERVICE_TOKEN and names the
// organization. Without ROLLODEX_URL the link is off.

import { PublicError } from './public-error.js';

const base = () => String(process.env.ROLLODEX_URL || '').trim().replace(/\/+$/, '');
export const rollodexUrl = () => (/^https?:\/\//.test(base()) ? base() : '');
export const rollodexConfigured = () => Boolean(rollodexUrl() && String(process.env.ROLLODEX_SERVICE_TOKEN || '').trim());

export async function linkFunder(org, who, name, { fetchImpl = fetch } = {}) {
  if (!rollodexConfigured()) throw new PublicError(503, 'rollodex_unconfigured', 'Rollodex is not connected to Ledger');
  let r;
  try {
    r = await fetchImpl(`${rollodexUrl()}/api/service/funders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(process.env.ROLLODEX_SERVICE_TOKEN).trim()}`,
        'X-TSS-App': 'ledger', 'X-TSS-Org': org, 'X-TSS-User': String(who || '').slice(0, 120),
      },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
  } catch (_) {
    throw new PublicError(502, 'rollodex_unreachable', 'Rollodex could not be reached');
  }
  if (r.status === 401) throw new PublicError(502, 'rollodex_refused', 'Rollodex did not accept Ledger\'s connection');
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j || typeof j.contact_id !== 'string') throw new PublicError(502, 'rollodex_failed', 'Rollodex did not answer');
  return { contact_id: j.contact_id.slice(0, 100), created: Boolean(j.created) };
}

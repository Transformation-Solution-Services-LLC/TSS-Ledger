// The QuickBooks connection's routes, managers only (the callback excepted,
// which Intuit's sign-in page sends the manager's browser to).
//
//   GET    /api/quickbooks              what is connected, the last sync, the classes
//   POST   /api/quickbooks/connect      the Intuit sign-in address, and a cookie tying it to this browser
//   GET    /api/quickbooks/callback     Intuit sends the manager back here
//   POST   /api/quickbooks/sync         read QuickBooks now
//   PATCH  /api/quickbooks/settings     { budgets: true } takes budgets from QuickBooks
//   POST   /api/quickbooks/disconnect   revokes the tokens at Intuit and deletes them here
//
// The sign-in is tied to the browser that asked (a random cookie whose hash
// is in the signed state), so nobody can send a manager a link that connects
// someone else's company to an organization, or the other way round.

import crypto from 'node:crypto';
import { sign, verifyToken } from './auth.js';
import { PublicError, logSafeError } from './public-error.js';
import {
  quickbooksConfig, authorizeUrl, exchangeCode, refreshTokens, revokeToken, qboClient, seal, unseal, API_BASE, QuickbooksError,
} from './quickbooks.js';
import { syncQuickbooks } from './quickbooks-sync.js';

const COOKIE = 'ledger_qbo';
const STATE_TTL_MS = 15 * 60 * 1000;
export const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('base64url');

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

const reconnect = () => new PublicError(409, 'quickbooks_reconnect', 'QuickBooks asks to be connected again.');
function publicOf(e) {
  if (e instanceof PublicError) return e;
  if (e instanceof QuickbooksError) {
    // Ids only: the code, the status and Intuit's transaction id.
    console.warn('quickbooks call failed', { code: e.code, status: e.status, intuit_tid: e.intuit_tid || null });
    if (e.code === 'unauthorized' || e.code === 'invalid_grant') return reconnect();
    if (e.code === 'denied') return new PublicError(403, 'quickbooks_denied', 'QuickBooks would not share this company\'s records. Connect again as a QuickBooks administrator.');
    if (e.code === 'rate_limited') return new PublicError(429, 'quickbooks_busy', 'QuickBooks asked Ledger to slow down. Try again in a minute.');
    if (e.code === 'too_many') return new PublicError(422, 'quickbooks_too_many', 'This company has more transactions than Ledger reads at once.');
    if (e.code === 'invalid_client') return new PublicError(503, 'quickbooks_setup', 'QuickBooks refused Ledger\'s app keys.');
  }
  return new PublicError(502, 'quickbooks_unreachable', 'QuickBooks did not answer. Try again in a few minutes.');
}

export function quickbooksRoutes(app, { store, wrap, requireManager, audit, clock, env = () => process.env, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const config = () => quickbooksConfig(env());
  const running = new Map(); // org -> Promise
  const asActor = (org, who = {}) => ({ user: { org_id: org, id: who.id || '', name: who.name || 'QuickBooks', email: '' }, ip: who.ip || '' });

  // A client for the organization's company, refreshing its tokens as needed.
  async function clientFor(org) {
    const cfg = config();
    if (cfg.status !== 'ready') throw new PublicError(503, 'quickbooks_off', 'Connecting QuickBooks is not set up yet.');
    let conn = await store.getQuickbooks(org);
    if (!conn) throw new PublicError(409, 'quickbooks_not_connected', 'QuickBooks is not connected.');
    if (conn.status !== 'connected') throw reconnect();
    let access = unseal(conn.access_token, cfg.key);
    const drop = async () => { await store.saveQuickbooks(org, { status: 'reconnect', access_token: '', refresh_token: '' }); return reconnect(); };
    let renewing = null;
    const renew = () => (renewing ||= (async () => {
      const refresh = unseal(conn.refresh_token, cfg.key);
      if (!refresh) throw await drop();
      let t;
      try { t = await refreshTokens(cfg, refresh, fetchImpl); } catch (e) {
        if (e.code === 'invalid_grant') throw await drop();
        throw publicOf(e);
      }
      conn = await store.saveQuickbooks(org, {
        access_token: seal(t.access_token, cfg.key), refresh_token: seal(t.refresh_token, cfg.key),
        access_expires_at: t.access_expires_at, refresh_expires_at: t.refresh_expires_at,
      });
      access = t.access_token;
    })().finally(() => { renewing = null; }));
    const accessToken = async () => {
      if (!access || !conn.access_expires_at || Date.parse(conn.access_expires_at) - Date.now() < 120000) await renew();
      return access;
    };
    return { conn, client: qboClient({ apiBase: API_BASE[conn.environment] || cfg.apiBase, realmId: conn.realm_id, accessToken, renew, fetchImpl }) };
  }

  // One sync per organization at a time; a second ask shares the first.
  function syncOrg(org, who) {
    if (running.has(org)) return running.get(org);
    const p = (async () => {
      const at = new Date().toISOString();
      try {
        const { conn, client } = await clientFor(org);
        const { result, snapshot } = await syncQuickbooks({ store, org, conn, client, asOf: clock(), budgets: Boolean(conn.settings?.budgets) });
        await store.saveQuickbooks(org, { last_sync_at: at, last_sync: result, ...(snapshot ? { snapshot } : {}) });
        audit(asActor(org, who), 'quickbooks.sync', `${result.added} added`,
          [result.replaced && `${result.replaced} updated`, result.removed && `${result.removed} removed in QuickBooks`, result.from_sheet && `${result.from_sheet} already imported from a spreadsheet`,
            result.budgets && `budget lines ${result.budgets.added} added, ${result.budgets.updated} updated`].filter(Boolean).join(', '));
        return result;
      } catch (e) {
        const pe = publicOf(e);
        if (!(e instanceof PublicError) && !(e instanceof QuickbooksError)) logSafeError(console, e, 'quickbooks_sync_failed');
        if (pe.code !== 'quickbooks_not_connected' && pe.code !== 'quickbooks_off') {
          const prev = await store.getQuickbooks(org).catch(() => null);
          if (prev) await store.saveQuickbooks(org, { last_sync_at: at, last_sync: { ...(prev.last_sync && !prev.last_sync.error ? prev.last_sync : {}), error: pe.message, error_at: at } }).catch(() => {});
        }
        throw pe;
      }
    })().finally(() => running.delete(org));
    running.set(org, p);
    return p;
  }

  const view = (cfg, c) => ({
    setup: cfg.status === 'ready',
    connected: Boolean(c && c.status === 'connected'),
    reconnect: Boolean(c && c.status !== 'connected'),
    company_name: c?.company_name || '',
    sandbox: c?.environment === 'sandbox',
    connected_by: c?.connected_by || '',
    connected_at: c?.connected_at || null,
    last_sync_at: c?.last_sync_at || null,
    last_sync: c?.last_sync || null,
    snapshot: c?.snapshot || null,
    settings: { budgets: Boolean(c?.settings?.budgets) },
    syncing: Boolean(c && running.has(c.org_id)),
  });

  app.get('/api/quickbooks', requireManager, wrap(async (req, res) => {
    res.json(view(config(), await store.getQuickbooks(req.user.org_id)));
  }));

  app.post('/api/quickbooks/connect', requireManager, wrap(async (req, res) => {
    const cfg = config();
    if (cfg.status !== 'ready') throw new PublicError(503, 'quickbooks_off', 'Connecting QuickBooks is not set up yet.');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const state = sign({ k: 'qbo', o: req.user.org_id, u: req.user.id, nm: req.user.name, n: hash(nonce), exp: Date.now() + STATE_TTL_MS });
    res.cookie(COOKIE, nonce, { httpOnly: true, secure: req.secure || env().NODE_ENV === 'production', sameSite: 'lax', path: '/api/quickbooks', maxAge: STATE_TTL_MS });
    res.json({ url: authorizeUrl(cfg, { state, redirectUri: cfg.redirectUri(req) }) });
  }));

  app.get('/api/quickbooks/callback', wrap(async (req, res) => {
    const back = (result) => {
      res.clearCookie(COOKIE, { path: '/api/quickbooks' });
      res.redirect(303, `/#/quickbooks?result=${encodeURIComponent(result)}`);
    };
    const cfg = config();
    if (cfg.status !== 'ready') return back('off');
    const q = req.query;
    const st = verifyToken(String(q.state || '').slice(0, 4000));
    const nonce = cookieValue(req, COOKIE);
    if (!st || st.k !== 'qbo' || typeof st.o !== 'string' || !nonce || hash(nonce) !== st.n) return back('expired');
    if (q.error) return back('declined');
    const code = String(q.code || '').slice(0, 2000);
    const realm = String(q.realmId || '').slice(0, 40);
    if (!code || !/^\d{1,40}$/.test(realm)) return back('failed');
    const org = st.o;
    let tokens;
    try { tokens = await exchangeCode(cfg, { code, redirectUri: cfg.redirectUri(req) }, fetchImpl); } catch (_) { return back('failed'); }
    let company = '';
    try {
      company = String((await qboClient({ apiBase: cfg.apiBase, realmId: realm, accessToken: async () => tokens.access_token, fetchImpl }).companyInfo()).CompanyName || '').slice(0, 200);
    } catch (_) { /* the name is a nicety; the sync still runs */ }
    const prev = await store.getQuickbooks(org);
    const same = prev && prev.realm_id === realm;
    await store.saveQuickbooks(org, {
      realm_id: realm, company_name: company, environment: cfg.environment, status: 'connected',
      access_token: seal(tokens.access_token, cfg.key), refresh_token: seal(tokens.refresh_token, cfg.key),
      access_expires_at: tokens.access_expires_at, refresh_expires_at: tokens.refresh_expires_at,
      connected_by: String(st.nm || '').slice(0, 160), connected_by_id: String(st.u || ''), connected_at: new Date().toISOString(),
      ...(same ? {} : { last_sync_at: null, last_sync: null, snapshot: null, settings: {} }),
    });
    audit(asActor(org, { id: st.u, name: st.nm, ip: req.ip }), 'quickbooks.connect', company || 'QuickBooks', cfg.environment === 'sandbox' ? 'sandbox company' : '');
    syncOrg(org, { id: st.u, name: st.nm }).catch(() => {});
    back('connected');
  }));

  app.post('/api/quickbooks/sync', requireManager, wrap(async (req, res) => {
    const result = await syncOrg(req.user.org_id, { id: req.user.id, name: req.user.name, ip: req.ip });
    res.json({ ...view(config(), await store.getQuickbooks(req.user.org_id)), result });
  }));

  app.patch('/api/quickbooks/settings', requireManager, wrap(async (req, res) => {
    const c = await store.getQuickbooks(req.user.org_id);
    if (!c) throw new PublicError(409, 'quickbooks_not_connected', 'QuickBooks is not connected.');
    const budgets = Boolean((req.body || {}).budgets);
    const out = await store.saveQuickbooks(req.user.org_id, { settings: { ...(c.settings || {}), budgets } });
    audit(req, 'quickbooks.settings', budgets ? 'budgets from QuickBooks' : 'budgets kept in Ledger');
    res.json(view(config(), out));
  }));

  app.post('/api/quickbooks/disconnect', requireManager, wrap(async (req, res) => {
    const org = req.user.org_id;
    const c = await store.getQuickbooks(org);
    if (c) {
      const cfg = config();
      const token = cfg.key ? unseal(c.refresh_token, cfg.key) || unseal(c.access_token, cfg.key) : null;
      if (cfg.status === 'ready' && token) await revokeToken(cfg, token, fetchImpl);
      await store.removeQuickbooks(org);
      audit(req, 'quickbooks.disconnect', c.company_name || 'QuickBooks', 'spending already brought in stays');
    }
    res.json(view(config(), null));
  }));

  // Every connected organization, read again when its last sync is SYNC_EVERY_MS old.
  async function syncDue(now = Date.now()) {
    if (config().status !== 'ready') return [];
    const orgs = await store.quickbooksDue(new Date(now - SYNC_EVERY_MS).toISOString());
    const done = [];
    for (const org of orgs) {
      try { await syncOrg(org); done.push(org); } catch (_) { /* kept on the connection as last_sync.error */ }
    }
    return done;
  }

  return { syncOrg, syncDue, clientFor };
}

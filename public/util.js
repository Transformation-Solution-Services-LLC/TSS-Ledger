// Page helpers with no DOM, so tests can import them: escaping, dates, money.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '');
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const KIND = { grant: 'Grant', restricted: 'Restricted gift', unrestricted: 'Unrestricted' };
export const STATUS = { active: 'Open', closed: 'Closed' };
export const PACE = {
  on_track: ['On pace', 'good'], fast: ['Spending ahead', 'warn'], slow: ['Spending behind', 'accent'], over: ['Over budget', 'bad'],
  no_dates: ['No grant period', ''], no_budget: ['No budget yet', ''],
};

// "$12,500" or "$12,500.50"; a negative amount as "-$300".
export function money(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '';
  const v = Math.round(Number(n) * 100) / 100;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
export const pct = (x) => (x === null || x === undefined ? '' : `${Math.round(x * 100)}%`);
export const monthLabel = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short' });

// The screen Cockpit asked to open with a launch ticket (#tss_launch=...&tss_to=...).
// Only a plain hash route is accepted; anything else opens the overview.
export function launchRoute(hash) {
  const m = /(?:^#|&)tss_to=([^&]+)/.exec(String(hash || ''));
  if (!m) return '';
  let to = '';
  try { to = decodeURIComponent(m[1]); } catch (_) { return ''; }
  return /^#\/[A-Za-z0-9/_?=&.-]{0,300}$/.test(to) ? to : '';
}

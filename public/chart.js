// Charts for Analyze, drawn as SVG from a computed result (lib/dataset.js
// runQuery): the first columns are the groups, the number columns after them
// the series. No DOM here, so tests import it; the page sets the string as
// HTML. Colors come from the --series-N tokens in styles.css, stepped for
// light and dark. Every mark carries its value in a <title> for hover, and
// every chart has its numbers in a table under it.

import { esc } from './util.js';

const MAX_SERIES = 6;

export function formatValue(v, type, { short = false } = {}) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'percent') return `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  if (type !== 'money' && type !== 'number') return String(v);
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const cur = type === 'money' ? '$' : '';
  if (short && abs >= 1e9) return `${sign}${cur}${trim(abs / 1e9)}B`;
  if (short && abs >= 1e6) return `${sign}${cur}${trim(abs / 1e6)}M`;
  if (short && abs >= 1e4) return `${sign}${cur}${trim(abs / 1e3)}K`;
  if (type === 'money') return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Math.round(abs * 100) / 100) ? 0 : 2, maximumFractionDigits: 2 })}`;
  return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
const trim = (x) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''));

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-01" as "Jan 2026", "2026-01-15" as "Jan 15, 2026".
export function formatLabel(v) {
  const s = String(v ?? '');
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${MON[+m[2] - 1]} ${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  m = /^\d{2} ([A-Z][a-z]+)$/.exec(s);
  if (m) return m[1];
  return s;
}
const shortLabel = (v) => {
  const s = String(v ?? '');
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${MON[+m[2] - 1]} '${m[1].slice(2)}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${MON[+m[2] - 1]} ${+m[3]}`;
  m = /^\d{2} ([A-Z][a-z]{2})/.exec(s);
  if (m) return m[1];
  return s.length > 14 ? `${s.slice(0, 13)}…` : s;
};

// The groups and the series of a result.
export function seriesOf(result) {
  const cols = result.columns || [];
  const first = cols.findIndex((c, i) => i > 0 && (c.type === 'money' || c.type === 'number'));
  if (first < 1) return null;
  const series = cols.map((c, i) => ({ ...c, i })).filter((c) => c.i >= first && (c.type === 'money' || c.type === 'number')).slice(0, MAX_SERIES);
  const labels = (result.rows || []).map((r) => r.slice(0, first).map((v) => formatLabel(v)).filter((x) => x !== '').join(', ') || '(blank)');
  return { labels, series, first, groupName: cols.slice(0, first).map((c) => c.name).join(', ') };
}

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= step0) || mag * 10;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function legend(series) {
  if (series.length < 2) return '';
  return `<ul class="viz-legend">${series.map((s, k) => `<li><span class="viz-key s${k + 1}"></span>${esc(s.name)}</li>`).join('')}</ul>`;
}

function vertical(type, { labels, series }, rows, W = 640) {
  const H = W < 500 ? 220 : 260, L = 64, R = 12, T = 14, B = 42;
  const vals = rows.flatMap((r) => series.map((s) => Number(r[s.i]) || 0));
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const n = rows.length;
  const band = (W - L - R) / Math.max(1, n);
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor((W - L) / 56))));
  const parts = [];
  for (const t of ticks) parts.push(`<line class="viz-grid${t === 0 ? ' zero' : ''}" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="viz-tick" x="${L - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(formatValue(t, series[0].type, { short: true }))}</text>`);
  labels.forEach((l, k) => {
    if (k % every) return;
    parts.push(`<text class="viz-tick" x="${(L + band * (k + 0.5)).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${esc(shortLabel(rows[k][0] ?? l))}</text>`);
  });
  if (type === 'line') {
    series.forEach((s, j) => {
      const pts = rows.map((r, k) => [L + band * (k + 0.5), y(Number(r[s.i]) || 0)]);
      parts.push(`<polyline class="viz-line s${j + 1}" points="${pts.map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' ')}"/>`);
      pts.forEach((p, k) => parts.push(`<circle class="viz-dot s${j + 1}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${n > 40 ? 2.5 : 4}"><title>${esc(`${labels[k]}: ${formatValue(rows[k][s.i], s.type)}${series.length > 1 ? ` (${s.name})` : ''}`)}</title></circle>`));
    });
  } else {
    const gap = Math.min(2, band * 0.1);
    const inner = Math.max(1, band * (n > 24 ? 0.86 : 0.7));
    const w = Math.max(1, (inner - gap * (series.length - 1)) / series.length);
    rows.forEach((r, k) => series.forEach((s, j) => {
      const v = Number(r[s.i]) || 0;
      const x = L + band * k + (band - inner) / 2 + j * (w + gap);
      const y0 = y(Math.max(0, v)), y1 = y(Math.min(0, v));
      parts.push(`<rect class="viz-bar s${j + 1}" x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, y1 - y0).toFixed(1)}" rx="${w > 8 ? 3 : 1}"><title>${esc(`${labels[k]}: ${formatValue(r[s.i], s.type)}${series.length > 1 ? ` (${s.name})` : ''}`)}</title></rect>`);
    }));
  }
  return `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

function horizontal({ labels, series }, rows, W = 640) {
  const row = series.length > 1 ? 14 * series.length + 12 : 26;
  const L = Math.min(170, Math.round(W * 0.34)), R = Math.min(86, Math.round(W * 0.2)), T = 6;
  const room = Math.max(8, Math.floor(L / 7.5));
  const H = T + row * rows.length + 22;
  const vals = rows.flatMap((r) => series.map((s) => Number(r[s.i]) || 0));
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 3);
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const x = (v) => L + (W - L - R) * ((v - lo) / (hi - lo || 1));
  const parts = [];
  for (const t of ticks) parts.push(`<line class="viz-grid${t === 0 ? ' zero' : ''}" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${T}" y2="${H - 20}"/><text class="viz-tick" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(formatValue(t, series[0].type, { short: true }))}</text>`);
  rows.forEach((r, k) => {
    const top = T + row * k;
    const label = labels[k].length > room ? `${labels[k].slice(0, room - 1)}…` : labels[k];
    parts.push(`<text class="viz-label" x="${L - 8}" y="${(top + row / 2 + 4).toFixed(1)}" text-anchor="end">${esc(label)}<title>${esc(labels[k])}</title></text>`);
    const h = series.length > 1 ? 12 : 16;
    series.forEach((s, j) => {
      const v = Number(r[s.i]) || 0;
      const x0 = x(Math.min(0, v)), x1 = x(Math.max(0, v));
      const yy = top + (row - (h + 2) * series.length + 2) / 2 + j * (h + 2);
      parts.push(`<rect class="viz-bar s${j + 1}" x="${x0.toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${h}" rx="3"><title>${esc(`${labels[k]}: ${formatValue(r[s.i], s.type)}${series.length > 1 ? ` (${s.name})` : ''}`)}</title></rect>`);
      parts.push(`<text class="viz-value" x="${(x1 + 6).toFixed(1)}" y="${(yy + h - 3).toFixed(1)}">${esc(formatValue(r[s.i], s.type, { short: true }))}</text>`);
    });
  });
  return `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

// A result as a table of its own.
export function resultTable(result, { max = 200 } = {}) {
  const cols = result.columns || [];
  const rows = (result.rows || []).slice(0, max);
  const num = (c) => ['money', 'number', 'percent'].includes(c.type);
  return `<div class="viz-table"><table class="list"><thead><tr>${cols.map((c) => `<th class="${num(c) ? 'num' : ''}">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c, i) => `<td class="${num(c) ? 'num' : ''}">${esc(num(c) ? formatValue(r[i], c.type) : c.type === 'date' ? formatLabel(r[i]) : (r[i] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${result.truncated || (result.rows || []).length > max ? `<p class="muted small-text">The first ${rows.length} of ${result.groups ?? result.rows.length}.</p>` : ''}`;
}

// { type: bar | hbar | line | grouped, title, result } as HTML: the title,
// the chart, its legend and its numbers.
// width: the space the chart has, in pixels, so its text stays readable on a phone.
export function chartHtml({ type, title, result }, { width = 640 } = {}) {
  const W = Math.round(Math.min(900, Math.max(300, width)));
  const s = seriesOf(result);
  if (!s || !result.rows?.length) return '';
  let kind = type;
  if (kind === 'grouped') kind = s.labels.length > 8 || s.labels.some((l) => l.length > 10) ? 'hbar' : 'bar';
  if (kind === 'bar' && s.labels.length > 60) kind = 'line';
  const rows = result.rows;
  const svg = kind === 'hbar' ? horizontal(s, rows, W) : vertical(kind === 'line' ? 'line' : 'bar', s, rows, W);
  return `<figure class="viz-card card"><figcaption>${esc(title || '')}</figcaption>${svg}${legend(s.series)}
    <details class="viz-numbers"><summary>The numbers</summary>${resultTable(result)}</details></figure>`;
}

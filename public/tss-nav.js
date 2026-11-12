// The TSS top strip: Back on the left, the light/dark switch and Cockpit on
// the right. The same file in every TSS app; change it in one, copy it to all.
// The switch needs tss-theme.js in the page's <head>.
//
// The apps panel: the person's apps down the right side, each its picture and
// name, as in Cockpit's right panel. Cockpit hands over the list when it opens
// an app (?tss_apps=sherlock,watson&tss_app=library); the app keeps it in its
// own storage. A tile opens Cockpit's #/open/<id>, which signs the person in
// to that app. Pictures come from Cockpit (/brand/icons/<id>.png), so the
// page's img-src must allow Cockpit's origin. On a narrow screen the panel
// opens from the Apps button in the strip.
//
// Back goes to the screen before this one inside the app. With nothing before
// it, Back goes to the app's home, and from the home to Cockpit. Cockpit opens
// Cockpit's home in the same tab.
//
//   const nav = tssNav({ mount, home: '#/', cockpitUrl });          // hash routes: screens tracked on their own
//   const nav = tssNav({ mount, isHome, goHome, cockpitUrl });       // screens without addresses:
//   nav.visit('sources', () => show('sources'));                     //   name each screen as it opens
//   tssNav({ ..., before: () => closeOverlay() })                   // Back closes what is open over the screen first (true = done)
//   nav.setCockpitUrl(url);                                          // once the server says where Cockpit is
//   nav.setLabels({ back: 'Atrás', backToCockpit: 'Volver a Cockpit', dark: 'Oscuro', light: 'Claro', apps: 'Apps', yourApps: 'Tus apps' }); // the page's language

const BACK_ICON = 'M15 5l-7 7 7 7';
const MOON_ICON = 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z';
const SUN_ICON = 'M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z';
const APPS_ICON = 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z';
const KEY = 'tss.nav.stack';
const APPS_KEY = 'tss.nav.apps';

// The apps the panel knows, by Cockpit's id. Cockpit's own pages (Professor,
// Coming soon) open there; the others open signed in through #/open/<id>.
export const RAIL_APPS = {
  sherlock: 'Sherlock', watson: 'Watson', library: 'Library',
  rollodex: 'Rollodex', vault: 'Vault', ledger: 'Ledger', gatsby: 'Gatsby',
  'tjc-app': 'TJC App', professor: 'Professor', eva: 'Eva', grandmother: 'Grandmother',
};
const COCKPIT_PAGES = new Set(['professor', 'eva', 'grandmother']);
const NO_ICON = new Set(['tjc-app']);

// The list Cockpit handed over in the address, or the one kept from last time.
// The address parts are taken out once read.
export function readRailApps(href, stored) {
  let apps = null; let self = null; let clean = null;
  try {
    const u = new URL(href);
    if (u.searchParams.has('tss_apps')) {
      apps = u.searchParams.get('tss_apps').split(',').filter((id) => Object.hasOwn(RAIL_APPS, id)).slice(0, 30);
      self = u.searchParams.get('tss_app');
      self = self && Object.hasOwn(RAIL_APPS, self) ? self : null;
      u.searchParams.delete('tss_apps'); u.searchParams.delete('tss_app');
      clean = u.toString();
    }
  } catch { /* an odd address: nothing handed over */ }
  if (!apps) {
    try {
      const s = JSON.parse(stored || 'null');
      if (s && Array.isArray(s.apps)) {
        apps = s.apps.filter((id) => typeof id === 'string' && Object.hasOwn(RAIL_APPS, id));
        self = typeof s.self === 'string' && Object.hasOwn(RAIL_APPS, s.self) ? s.self : null;
      }
    } catch { /* nothing kept */ }
  }
  return { apps: apps ?? [], self, clean };
}

// Where a tile goes: Cockpit's page for it.
export function railHref(cockpit, id) {
  const u = new URL(cockpit);
  u.pathname = '/';
  u.search = '';
  u.hash = COCKPIT_PAGES.has(id) ? `#/${id}` : `#/open/${encodeURIComponent(id)}`;
  return u.toString();
}

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
}

function icon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

// The screen part of an address, without Cockpit's one-time sign-in parts.
export function screenKey(hash) {
  const h = String(hash || '').replace(/^#/, '')
    .replace(/&?tss_(launch|to|theme)=[^&]*/g, '').replace(/^&/, '').replace(/&$/, '');
  return h === '' || h === '/' ? '/' : h;
}

// A browser-tab-wide list of the screens visited, newest last. A fresh visit
// to the app starts a new list; Reload and the browser's own Back keep it.
function loadStack() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const fresh = !nav || nav.type === 'navigate';
    const sameApp = document.referrer && new URL(document.referrer).origin === location.origin;
    if (fresh && !sameApp) return [];
    const s = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    return Array.isArray(s) ? s.filter((x) => typeof x === 'string').slice(-50) : [];
  } catch { return []; }
}
function saveStack(s) { try { sessionStorage.setItem(KEY, JSON.stringify(s.slice(-50))); } catch { /* storage blocked: Back still works this visit */ } }

export function tssNav({ mount, home, isHome, goHome, before, cockpitUrl = null, labels = {} } = {}) {
  const framed = (() => { try { return window.top !== window.self; } catch { return true; } })();
  const hashMode = home !== undefined;
  const homes = hashMode ? [].concat(home).map(screenKey) : [];
  let cockpit = cockpitUrl;
  let stack = hashMode ? loadStack() : [];   // hash mode: keys; view mode: { key, open }

  const words = { back: 'Back', backToCockpit: 'Back to Cockpit', dark: 'Dark mode', light: 'Light mode', apps: 'Apps', yourApps: 'Your apps', ...labels };
  const backText = el('span', {}, [words.back]);
  const back = el('button', { type: 'button', class: 'tss-nav-back' }, [icon(BACK_ICON), backText]);
  const toCockpit = el('a', { class: 'tss-nav-cockpit', href: '/' }, ['Cockpit']);
  // Light/dark: one press switches; the choice follows the person to Cockpit
  // and from there to every app (tss-theme.js).
  const themes = typeof window !== 'undefined' ? window.tssTheme : null;
  const themeText = el('span', {}, []);
  const theme = el('button', { type: 'button', class: 'tss-nav-theme' }, []);
  const paintTheme = () => {
    const dark = themes?.get() === 'dark';
    theme.setAttribute('aria-pressed', String(dark));
    theme.title = dark ? words.light : words.dark;
    theme.setAttribute('aria-label', theme.title);
    themeText.textContent = dark ? words.light : words.dark;
    theme.replaceChildren(icon(dark ? SUN_ICON : MOON_ICON), themeText);
  };
  theme.hidden = !themes;
  theme.addEventListener('click', () => themes?.toggle());
  const appsText = el('span', {}, ['Apps']);
  const appsBtn = el('button', { type: 'button', class: 'tss-nav-apps', 'aria-expanded': 'false', 'aria-controls': 'tss-rail' }, [icon(APPS_ICON), appsText]);
  const bar = el('div', { class: 'tss-nav', role: 'navigation', 'aria-label': 'Back and Cockpit' }, [back, el('span', { class: 'tss-nav-gap' }), appsBtn, theme, toCockpit]);
  bar.hidden = framed;   // inside Cockpit's own window, Cockpit is already around it
  if (mount) mount.prepend(bar);

  // The apps panel down the right side.
  let stored = null;
  try { stored = localStorage.getItem(APPS_KEY); } catch { /* storage blocked */ }
  const handed = readRailApps(location.href, stored);
  if (handed.clean) {
    try { history.replaceState(history.state, '', handed.clean); } catch { /* the address keeps them */ }
    try { localStorage.setItem(APPS_KEY, JSON.stringify({ apps: handed.apps, self: handed.self })); } catch { /* this visit only */ }
  }
  const rail = el('aside', { id: 'tss-rail', class: 'tss-rail', 'aria-label': 'Your apps' }, []);
  rail.hidden = true;
  const closeRail = () => { rail.classList.remove('tss-rail-open'); appsBtn.setAttribute('aria-expanded', 'false'); };
  appsBtn.addEventListener('click', () => {
    const open = !rail.classList.contains('tss-rail-open');
    rail.classList.toggle('tss-rail-open', open);
    appsBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRail(); });
  document.addEventListener('click', (e) => { if (!rail.contains(e.target) && !appsBtn.contains(e.target)) closeRail(); });
  if (!framed && document.body) document.body.append(rail);
  function paintRail() {
    const show = !framed && Boolean(cockpit) && handed.apps.length > 0;
    rail.hidden = !show;
    appsBtn.hidden = !show;
    document.documentElement.classList.toggle('tss-has-rail', show);
    if (!show) return;
    const tiles = handed.apps.map((id) => {
      const name = RAIL_APPS[id];
      const pic = NO_ICON.has(id)
        ? el('span', { class: 'tss-rail-pic tss-rail-mono', 'aria-hidden': 'true' }, ['TJC'])
        : el('img', { class: 'tss-rail-pic', src: `${new URL(cockpit).origin}/brand/icons/${id}.png`, alt: '', width: '40', height: '40', draggable: 'false' });
      const here = id === handed.self;
      const kids = [pic, el('span', { class: 'tss-rail-name' }, [name])];
      // The app open now is marked, not a link.
      return here
        ? el('span', { class: 'tss-rail-tile tss-rail-here', 'aria-current': 'page' }, kids)
        : el('a', { class: 'tss-rail-tile', href: carry(railHref(cockpit, id)) }, kids);
    });
    rail.replaceChildren(el('div', { class: 'tss-rail-title' }, [words.yourApps]), ...tiles);
  }

  const atHome = () => { try { return hashMode ? homes.includes(screenKey(location.hash)) : Boolean(isHome?.()); } catch { return false; } };
  const carry = (url) => (themes ? themes.carry(url) : url);
  const openCockpit = () => { if (cockpit) location.assign(carry(cockpit)); };

  function refresh() {
    toCockpit.hidden = framed || !cockpit;
    if (cockpit) toCockpit.href = carry(cockpit);
    theme.hidden = framed || !themes;   // inside Cockpit, Cockpit's own switch sets it
    paintTheme();
    const depth = stack.length > 1;
    const leaves = !depth && atHome();
    back.hidden = framed || (leaves && !cockpit);   // nowhere to go back to
    back.title = leaves ? words.backToCockpit : words.back;
    backText.textContent = words.back;
    appsText.textContent = words.apps;
    rail.setAttribute('aria-label', words.yourApps);
    paintRail();
  }

  // Hash routes: every address change is a screen.
  if (hashMode) {
    const seen = () => {
      const k = screenKey(location.hash);
      if (stack.length > 1 && stack[stack.length - 2] === k) stack.pop();
      else if (stack[stack.length - 1] !== k) stack.push(k);
      saveStack(stack);
      refresh();
    };
    window.addEventListener('hashchange', seen);
    seen();
  }

  back.addEventListener('click', () => {
    if (before?.()) return;   // the app closed something open over the screen
    if (stack.length > 1) {
      if (hashMode) return history.back();
      stack.pop();
      const prev = stack[stack.length - 1];
      refresh();
      return prev.open();
    }
    if (!atHome()) {
      if (hashMode) { location.hash = homes[0] === '/' ? '#/' : `#${homes[0]}`; return; }
      return goHome?.();
    }
    openCockpit();
  });

  themes?.onChange(() => refresh());
  refresh();
  return {
    el: bar,
    // For an app with its own header: place these where they belong.
    back,
    theme,
    cockpit: toCockpit,
    rail,
    apps: appsBtn,
    // Screens without addresses: call as each one opens. Opening the screen
    // already on top (Back reopening it, a refresh) changes nothing.
    visit(key, open) {
      if (hashMode) return;
      const top = stack[stack.length - 1];
      if (top && top.key === key) { top.open = open; return refresh(); }
      const at = stack.findIndex((s) => s.key === key);
      if (at >= 0 && at === stack.length - 2) stack.pop();
      else stack.push({ key, open });
      if (stack.length > 50) stack.shift();
      refresh();
    },
    // Start over, as after signing in: the screen now open is the first.
    reset() { stack = hashMode ? [screenKey(location.hash)] : stack.slice(-1); if (hashMode) saveStack(stack); refresh(); },
    setCockpitUrl(url) { cockpit = url || null; refresh(); },
    // Other languages: { back, backToCockpit, dark, light }. Cockpit is a name and stays.
    setLabels(l) { Object.assign(words, l || {}); refresh(); },
    refresh,
  };
}

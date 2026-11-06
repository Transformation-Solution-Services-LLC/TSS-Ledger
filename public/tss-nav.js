// The TSS top strip: Back on the left, Cockpit on the right. The same file in
// every TSS app; change it in one, copy it to all.
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
//   nav.setLabels({ back: 'Atrás', backToCockpit: 'Volver a Cockpit' }); // the page's language, when not English

const BACK_ICON = 'M15 5l-7 7 7 7';
const KEY = 'tss.nav.stack';

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
    .replace(/&?tss_(launch|to)=[^&]*/g, '').replace(/^&/, '').replace(/&$/, '');
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

  const words = { back: 'Back', backToCockpit: 'Back to Cockpit', ...labels };
  const backText = el('span', {}, [words.back]);
  const back = el('button', { type: 'button', class: 'tss-nav-back' }, [icon(BACK_ICON), backText]);
  const toCockpit = el('a', { class: 'tss-nav-cockpit', href: '/' }, ['Cockpit']);
  const bar = el('div', { class: 'tss-nav', role: 'navigation', 'aria-label': 'Back and Cockpit' }, [back, el('span', { class: 'tss-nav-gap' }), toCockpit]);
  bar.hidden = framed;   // inside Cockpit's own window, Cockpit is already around it
  if (mount) mount.prepend(bar);

  const atHome = () => { try { return hashMode ? homes.includes(screenKey(location.hash)) : Boolean(isHome?.()); } catch { return false; } };
  const openCockpit = () => { if (cockpit) location.assign(cockpit); };

  function refresh() {
    toCockpit.hidden = framed || !cockpit;
    if (cockpit) toCockpit.href = cockpit;
    const depth = stack.length > 1;
    const leaves = !depth && atHome();
    back.hidden = framed || (leaves && !cockpit);   // nowhere to go back to
    back.title = leaves ? words.backToCockpit : words.back;
    backText.textContent = words.back;
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

  refresh();
  return {
    el: bar,
    // For an app with its own header: place these two where they belong.
    back,
    cockpit: toCockpit,
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
    // Other languages: { back, backToCockpit }. Cockpit is a name and stays.
    setLabels(l) { Object.assign(words, l || {}); refresh(); },
    refresh,
  };
}

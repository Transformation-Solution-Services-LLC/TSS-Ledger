// The TSS light/dark setting. The same file in every TSS app; change it in
// one, copy it to all. Load it in <head>, before the styles, as a plain script:
//   <script src="tss-theme.js"></script>  (or /tss-theme.js)
//
// Dark unless the person chose light; the device's own setting is never used.
// The choice follows the person across apps: Cockpit keeps it on their
// account and hands it over in the address when it opens an app
// (?tss_theme=dark); the app's Cockpit button hands it back the same way.
// Each app also keeps the last choice in its own browser storage, so it shows
// at once. Styles key off <html data-theme="dark">. A <source data-tss-dark>
// inside a <picture> (the light wordmark) shows only in dark.
(function () {
  var KEY = 'tss.theme';
  var PARAM = 'tss_theme';
  var root = document.documentElement;
  var listeners = [];
  function parse(v) { return v === 'dark' || v === 'light' ? v : null; }

  var handed = null;
  try {
    var u = new URL(location.href);
    handed = parse(u.searchParams.get(PARAM));
    if (u.searchParams.has(PARAM)) {
      u.searchParams.delete(PARAM);
      history.replaceState(history.state, '', u.toString());
    }
  } catch (e) { /* an odd address: nothing handed over */ }

  var mode = handed;
  try {
    if (mode) localStorage.setItem(KEY, mode);
    else mode = parse(localStorage.getItem(KEY));
  } catch (e) { /* storage blocked: dark, or what was handed over */ }
  mode = mode || 'dark';

  function paint() {
    root.setAttribute('data-theme', mode);
    var s = document.querySelectorAll('source[data-tss-dark]');
    for (var i = 0; i < s.length; i++) s[i].media = mode === 'dark' ? 'all' : 'not all';
  }
  paint();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);

  function set(next, keep) {
    next = parse(next);
    if (!next || next === mode) return;
    mode = next;
    if (keep !== false) { try { localStorage.setItem(KEY, mode); } catch (e) { /* this visit only */ } }
    paint();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](mode); } catch (e) { /* one listener failing stops none */ } }
  }

  // Another tab of the same app switched.
  window.addEventListener('storage', function (e) { if (e.key === KEY) set(e.newValue, false); });

  window.tssTheme = {
    get: function () { return mode; },
    set: set,
    toggle: function () { set(mode === 'dark' ? 'light' : 'dark'); },
    // An address in another TSS app (Cockpit), carrying the choice there.
    carry: function (url) {
      try { var a = new URL(url, location.href); a.searchParams.set(PARAM, mode); return a.toString(); } catch (e) { return url; }
    },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    paint: paint,
  };
})();

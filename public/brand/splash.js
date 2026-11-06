// The opening scene: plays each time a person arrives from Cockpit or another
// app, never on a reload or a page change inside this app. At most 2.8 seconds.
(function () {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && (nav.type === 'reload' || nav.type === 'back_forward')) return;
    if (document.referrer && new URL(document.referrer).origin === location.origin) return;
  } catch (e) {}
  var root = document.documentElement;
  root.classList.add('wally-splash-on');
  setTimeout(function () { root.classList.remove('wally-splash-on'); }, 2800);
})();

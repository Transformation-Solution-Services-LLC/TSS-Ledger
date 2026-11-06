// The opening screen: this app's Wally scene, full screen, once per browser
// tab, gone in under 3 seconds. Runs before the page draws so it never
// flashes. Skipped when the reader asks for reduced motion.
(function () {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (sessionStorage.getItem('tss:wally-splash')) return;
    sessionStorage.setItem('tss:wally-splash', '1');
  } catch (e) { /* storage refused: show it, it is short */ }
  var root = document.documentElement;
  root.classList.add('wally-splash-on');
  setTimeout(function () { root.classList.remove('wally-splash-on'); }, 2800);
})();

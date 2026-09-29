/**
 * Xylium pattern module — SCROLL
 * Requires: xylium-core.js
 *
 * Emits:
 *   scroll   throttled vertical scroll position
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;

  // ---------- 7. Scroll ----------
  var lastScrollSample = 0;
  document.addEventListener('scroll', function () {
    var now = performance.now();
    if (now - lastScrollSample < 100) return;
    lastScrollSample = now;
    pushEvent({ type: 'scroll', y: window.scrollY });
  }, { passive: true });
});

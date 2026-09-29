/* ============================================================================
 * xylium-custom.js — Custom pattern
 * ----------------------------------------------------------------------------
 * Description: Counts tab away/return switches and away-duration during a session.
 * Reviewed: 2026-09-29T10:43:09.385Z — no user-data capture detected
 *           by validate-custom-pattern.js (static AST checks).
 * ==========================================================================*/
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  // Counts how many times the user switches away from and back to this tab,
  // and how long each away-period lasted. Frequent short switches can
  // indicate the user is checking something else (e.g. a messaging app for
  // a one-time code) mid-session — a behavioral signal, not content.
  var switchCount = 0;
  var awayStartedAt = null;

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      awayStartedAt = performance.now();
      return;
    }

    // Tab became visible again.
    if (awayStartedAt === null) return;
    var awayMs = Math.round(performance.now() - awayStartedAt);
    awayStartedAt = null;
    switchCount += 1;

    core.pushEvent({
      type: 'tab_switch_return',
      switchCount: switchCount,
      awayMs: awayMs,
    });
  });
});

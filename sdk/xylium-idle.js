/* ============================================================================
 * xylium-idle.js — Idle detection
 * ----------------------------------------------------------------------------
 * Emits `idle_start` when no activity has been seen for idleThresholdMs, and
 * `idle_end` (with the idle duration) when activity resumes.
 *
 * The core owns the event queue and calls the activity-resume hooks whenever a
 * real event lands during an idle window, so this module registers `endIdle`
 * via core.onActivityResume rather than watching the queue itself. This module
 * owns the polling interval that flips the session into the idle state.
 *
 * Load order does not matter: this file self-registers with the core.
 * ==========================================================================*/
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  var config = core.config;
  var state = core.state;

  // ---------- 13. Idle detection ----------
  function endIdle() {
    if (!state.isIdle) return;
    var idleDurationMs = Math.round(performance.now() - state.idleSince);
    state.isIdle = false;
    core.pushCriticalEvent({ type: 'idle_end', idleDurationMs: idleDurationMs });
  }

  // Core invokes this the moment activity resumes during an idle window.
  core.onActivityResume(endIdle);

  setInterval(function () {
    if (!state.consentGiven || state.isIdle) return;
    var now = performance.now();
    if (now - state.lastActivityTime >= config.idleThresholdMs) {
      state.isIdle = true;
      state.idleSince = state.lastActivityTime;
      core.pushCriticalEvent({ type: 'idle_start' });
    }
  }, config.idleCheckIntervalMs);
});

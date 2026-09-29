/* ============================================================================
 * xylium-geo.js — Geolocation + timezone/geo consistency
 * ----------------------------------------------------------------------------
 * Consent-gated. When enabled (data-capture-geo="true") and the user has
 * granted geolocation permission, emits a coarse `geo` fix plus a
 * `tz_geo_consistency` check comparing the browser's UTC offset against the
 * solar offset implied by longitude.
 *
 * Registers on the consent queue at order 20 so it fires in the same position
 * as the original single-file SDK, and exposes the public requestGeo() API.
 *
 * Load order does not matter: this file self-registers with the core.
 * ==========================================================================*/
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  var config = core.config;
  var state = core.state;
  var round = core.round;

  // ---------- 14. Geolocation ----------
  var TZ_GEO_MISMATCH_HOURS = 3.5;

  function maybeCaptureGeo() {
    if (!config.captureGeo || !state.consentGiven) return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      core.pushCriticalEvent({
        type: 'geo',
        lat: Math.round(pos.coords.latitude * 100) / 100,
        lon: Math.round(pos.coords.longitude * 100) / 100,
      });

      // ---------- 14a. Timezone vs geo consistency ----------
      // Coarse client-side check: solar offset (lon / 15h) vs the browser's
      // actual UTC offset. Real zones deviate from solar time by up to ~3h
      // (China, Spain, western India), so only larger gaps are flagged. The
      // backend should do a precise tz-boundary lookup and an IP-geo check.
      var solarOffsetH = pos.coords.longitude / 15;
      var actualOffsetH = -new Date().getTimezoneOffset() / 60;
      var delta = Math.abs(actualOffsetH - solarOffsetH);
      if (delta > 12) delta = 24 - delta;
      var tzName = null;
      try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* ignore */ }
      core.pushCriticalEvent({
        type: 'tz_geo_consistency',
        tzName: tzName,
        tzOffsetHours: actualOffsetH,
        solarOffsetHours: round(solarOffsetH, 1),
        deltaHours: round(delta, 1),
        isMismatch: delta > TZ_GEO_MISMATCH_HOURS,
      });
    }, function () {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }

  // Consent-gated one-shot; order 20 preserves the original emission sequence.
  core.onConsent(20, maybeCaptureGeo);

  // Public API: allow the host app to (re-)request a geo fix on demand.
  core.defineApi('requestGeo', function () { maybeCaptureGeo(); });
});

/* ============================================================================
 * xylium-geo.js — Geolocation + timezone/geo consistency + distance from home
 * ----------------------------------------------------------------------------
 * Consent-gated. When enabled (data-capture-geo="true") and the user has
 * granted geolocation permission, emits:
 *   geo                 coarse fix (lat/lon, 2 dp ≈ 1 km)          [original]
 *   tz_geo_consistency  browser UTC offset vs solar offset          [original]
 *   geo_features        geo_lat, geo_lon, geo_distance_from_home_km [new]
 *
 * "Home" resolution, in priority order:
 *   1. XyliumBF.setHomeLocation(lat, lon) — the host app passes the user's
 *      registered / historical home (from your backend) after identify().
 *      This is the authoritative source.
 *   2. The first GPS fix ever seen on this device (persisted in localStorage).
 *      On that very first fix there is no prior home, so the distance is null.
 * The stored home is cleared when consent is revoked.
 *
 * Registers on the consent queue at order 20 so it fires in the same position
 * as the original single-file SDK, and exposes requestGeo() / setHomeLocation().
 *
 * Load order does not matter: this file self-registers with the core.
 * ==========================================================================*/
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  var config = core.config;
  var state = core.state;
  var round = core.round;
  var readStore = core.readStore;
  var writeStore = core.writeStore;
  var removeStore = core.removeStore;

  var HOME_KEY = 'xylium_geo_home_' + config.tenantId;
  var lastFix = null; // { lat, lon } full precision, in memory only

  function round2(n) { return Math.round(n * 100) / 100; }

  function isValidCoord(lat, lon) {
    return typeof lat === 'number' && typeof lon === 'number' &&
      isFinite(lat) && isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  // Great-circle distance (haversine), km.
  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371.0088;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Emits the flat feature event the risk model consumes.
  function emitGeoFeatures(fix) {
    var home = readStore(HOME_KEY);
    var hasHome = home && isValidCoord(home.lat, home.lon);
    var homeSource = hasHome ? home.source : null;

    if (!hasHome) {
      // First fix on this device becomes the provisional home. Stored at the
      // same coarse 2 dp precision we send on the wire.
      writeStore(HOME_KEY, { lat: round2(fix.lat), lon: round2(fix.lon), source: 'first_seen', setAt: Date.now() });
      homeSource = 'first_seen_now';
    }

    core.pushCriticalEvent({
      type: 'geo_features',
      geo_lat: round2(fix.lat),
      geo_lon: round2(fix.lon),
      geo_distance_from_home_km: hasHome ? round(haversineKm(home.lat, home.lon, fix.lat, fix.lon), 1) : null,
      geo_home_source: homeSource,          // 'api' | 'first_seen' | 'first_seen_now'
      geo_accuracy_m: fix.accuracy != null ? Math.round(fix.accuracy) : null,
    });
  }

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

      // ---------- 14e. geo_lat / geo_lon / distance from home ----------
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      emitGeoFeatures(lastFix);
    }, function () {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }

  // Host app supplies the user's known home (e.g. from the backend profile
  // after identify()). Overrides any device-level "first seen" home and, if a
  // fix was already taken, re-emits geo_features with the corrected distance.
  function setHomeLocation(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!isValidCoord(lat, lon)) { console.warn('[XyliumBF v2] setHomeLocation: invalid coordinates'); return; }
    writeStore(HOME_KEY, { lat: round2(lat), lon: round2(lon), source: 'api', setAt: Date.now() });
    if (lastFix && state.consentGiven) emitGeoFeatures(lastFix);
  }

  // Consent-gated one-shot; order 20 preserves the original emission sequence.
  core.onConsent(20, maybeCaptureGeo);

  // Public API.
  core.defineApi('requestGeo', function () { maybeCaptureGeo(); });
  core.defineApi('setHomeLocation', setHomeLocation);

  core.onRevoke(function () {
    removeStore(HOME_KEY);
    lastFix = null;
  });
});

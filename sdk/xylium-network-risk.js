/* ============================================================================
 * xylium-network-risk.js — IP intelligence: VPN / proxy / datacenter / country
 * ----------------------------------------------------------------------------
 * Emits one `network_risk` event per page load with:
 *   is_vpn, is_proxy, is_datacenter, geo_is_new_country
 *   (+ ip_country, ip_tz_mismatch, network_risk_source for context)
 *
 * WHY THIS NEEDS THE BACKEND
 *   Browser JavaScript cannot see the client's public IP or classify it.
 *   VPN / proxy / datacenter detection is an IP-reputation lookup (MaxMind
 *   GeoIP2 Anonymous-IP, IPinfo privacy, IPQualityScore, etc.) that must run
 *   server-side against the request's source IP. This module asks your
 *   backend for that verdict and puts it on the behavioural event stream so
 *   it lands alongside every other signal for the session.
 *
 * BACKEND CONTRACT
 *   GET  <ipIntelEndpoint>?tenantId=…&appId=…&sessionId=…
 *   - ipIntelEndpoint = data-ip-intel-endpoint on the core <script> tag,
 *     or <data-api-endpoint>/ip-intel when not set.
 *   - Respond with JSON (snake_case or camelCase both accepted):
 *       {
 *         "country": "IN",            // ISO-3166 alpha-2 of the request IP
 *         "is_vpn": false,
 *         "is_proxy": false,
 *         "is_datacenter": false,     // hosting / cloud ASN
 *         "timezone": "Asia/Kolkata", // optional: IP-geo IANA timezone
 *         "is_new_country": null      // optional: server's per-USER verdict
 *       }
 *   - Read the IP from the socket / trusted X-Forwarded-For only.
 *
 * geo_is_new_country
 *   If the server returns is_new_country (based on the user's login history),
 *   that wins. Otherwise it is computed per device from the countries seen
 *   before on this browser (localStorage). On the first-ever visit there is
 *   no history, so it is null rather than a misleading true.
 *
 * Registers on the consent queue at order 25 (right after geo at 20).
 * Seen-countries history is cleared when consent is revoked.
 * Load order does not matter: this file self-registers with the core.
 * ==========================================================================*/
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  var config = core.config;
  var state = core.state;
  var readStore = core.readStore;
  var writeStore = core.writeStore;
  var removeStore = core.removeStore;

  var COUNTRIES_KEY = 'xylium_countries_' + config.tenantId;
  var MAX_COUNTRIES = 20;
  var TIMEOUT_MS = 5000;
  var emitted = false;

  function resolveEndpoint() {
    if (config.ipIntelEndpoint) return config.ipIntelEndpoint;
    if (config.apiEndpoint) return config.apiEndpoint.replace(/\/$/, '') + '/ip-intel';
    return null;
  }

  function pick(obj, snake, camel) {
    if (!obj) return undefined;
    return obj[snake] !== undefined ? obj[snake] : obj[camel];
  }

  function toBoolOrNull(v) {
    return typeof v === 'boolean' ? v : null;
  }

  function browserTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  }

  // Per-device country history → is this country new for this browser?
  function evaluateCountry(country) {
    if (!country) return null;
    var seen = readStore(COUNTRIES_KEY);
    var hadHistory = Array.isArray(seen) && seen.length > 0;
    if (!Array.isArray(seen)) seen = [];
    var isNew = hadHistory ? seen.indexOf(country) === -1 : null;
    if (seen.indexOf(country) === -1) {
      seen.push(country);
      if (seen.length > MAX_COUNTRIES) seen = seen.slice(-MAX_COUNTRIES);
      writeStore(COUNTRIES_KEY, seen);
    }
    return isNew;
  }

  function emit(intel, source) {
    if (emitted || !state.consentGiven) return;
    emitted = true;

    var country = pick(intel, 'country', 'country');
    country = typeof country === 'string' && country ? country.toUpperCase().slice(0, 2) : null;

    var serverIsNew = toBoolOrNull(pick(intel, 'is_new_country', 'isNewCountry'));
    var deviceIsNew = evaluateCountry(country);

    // VPN tell: IP-geo timezone differs from the browser's timezone.
    var ipTz = pick(intel, 'timezone', 'timezone');
    var browserTz = browserTimeZone();
    var tzMismatch = ipTz && browserTz ? ipTz !== browserTz : null;

    core.pushCriticalEvent({
      type: 'network_risk',
      is_vpn: toBoolOrNull(pick(intel, 'is_vpn', 'isVpn')),
      is_proxy: toBoolOrNull(pick(intel, 'is_proxy', 'isProxy')),
      is_datacenter: toBoolOrNull(pick(intel, 'is_datacenter', 'isDatacenter')),
      geo_is_new_country: serverIsNew !== null ? serverIsNew : deviceIsNew,
      geo_is_new_country_source: serverIsNew !== null ? 'server' : (deviceIsNew !== null ? 'device_history' : null),
      ip_country: country,
      ip_tz_mismatch: tzMismatch,
      network_risk_source: source, // 'backend' | 'unavailable' | 'error' | 'timeout'
    });
  }

  function captureNetworkRisk() {
    if (!state.consentGiven) return;
    var endpoint = resolveEndpoint();
    if (!endpoint || typeof fetch !== 'function') { emit(null, 'unavailable'); return; }

    var url = endpoint +
      (endpoint.indexOf('?') === -1 ? '?' : '&') +
      'tenantId=' + encodeURIComponent(config.tenantId) +
      '&appId=' + encodeURIComponent(config.appId) +
      '&sessionId=' + encodeURIComponent(state.sessionId);

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
      emit(null, 'timeout');
    }, TIMEOUT_MS);

    fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (intel) { clearTimeout(timer); emit(intel, 'backend'); })
      .catch(function (err) {
        clearTimeout(timer);
        console.warn('[XyliumBF v2] ip-intel lookup failed', err);
        emit(null, 'error');
      });
  }

  core.onConsent(25, captureNetworkRisk);

  // Public API: re-run the lookup (e.g. after a network change in an SPA).
  core.defineApi('requestNetworkRisk', function () { emitted = false; captureNetworkRisk(); });

  core.onRevoke(function () { removeStore(COUNTRIES_KEY); });
});

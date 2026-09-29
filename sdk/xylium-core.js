/**
 * Xylium Behavioral Fingerprinting SDK — v2.1 (modular)
 *
 * ┌─ xylium-core.js  ── THIS FILE — the "main landing" file ────────────┐
 * │  Holds the things every pattern module needs:                       │
 * │    • config (tenantId / appId / apiEndpoint / captureGeo)           │
 * │      read from THIS script tag's data-* attributes                  │
 * │    • the session id (getSessionId)                                  │
 * │    • the backend API pointer + transport (/collect, batching,       │
 * │      flush, beacon on unload)                                       │
 * │    • shared state, shared helpers, the event queue                  │
 * │    • the public window.XyliumBF API                                 │
 * │    • a module registry so each pattern lives in its own file        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Load THIS file first, with the data-* attributes on its <script> tag,
 * then load the pattern files (any order). A pattern file registers itself
 * with:  XyliumBF.use(function (core) { ... });
 *
 * Pattern files (each = one behavioural signal group):
 *   xylium-mouse.js       mouse move / click / trajectory / overshoot / entropy
 *   xylium-keyboard.js    keystroke timing / n-grams / corrections / typing summary
 *   xylium-touch.js       touch pressure / swipe / tap accuracy / multi-touch
 *   xylium-scroll.js      scroll rhythm
 *   xylium-form.js        focus order / field time / clear+retype / autofill /
 *                         password toggle / submit-abandon-return
 *   xylium-clipboard.js   copy / paste
 *   xylium-navigation.js  visibility / resize / back button / entry / referrer /
 *                         window blur-focus mid-login / time-of-day context
 *   xylium-device.js      device + battery + connection + plugins + canvas /
 *                         webgl / font / audio fingerprints + language /
 *                         privacy signals + network timing + RTT variance
 *   xylium-idle.js        idle start / end
 *   xylium-geo.js         geolocation + timezone-vs-geo consistency
 *   xylium-bot.js         automation / headless / CDP / media-query / integrity
 *   xylium-identity.js    persistent device id + failed-attempt window + login result
 *
 * SERVER-SIDE ONLY (cannot be measured in JS — add in the backend):
 *   JA3/JA4 TLS fingerprint, TCP/IP (p0f-style) OS fingerprint, true HTTP/2
 *   vs HTTP/3 negotiation, ASN / hosting-provider category, accounts-per-
 *   device/IP, device-switch frequency, login-hour / day-of-week deviation
 *   from baseline, delta from historical typing speed. This SDK sends the raw
 *   inputs for all of these.
 */
(function () {
  'use strict';

  if (window.XyliumBF && window.XyliumBF.__core) {
    // Core already loaded once; don't double-initialise.
    return;
  }

  // ---------- 1. Config ----------
  // data-* attributes live on THIS script tag. If the script is loaded async
  // (so document.currentScript is null) fall back to finding the tag by its
  // data-tenant-id attribute.
  var currentScript = document.currentScript ||
    document.querySelector('script[data-tenant-id][src*="xylium-core"]') ||
    document.querySelector('script[data-tenant-id]');

  function attr(name, dflt) {
    return currentScript && currentScript.getAttribute(name) != null
      ? currentScript.getAttribute(name)
      : dflt;
  }

  var config = {
    tenantId: attr('data-tenant-id', 'unknown'),
    appId: attr('data-app-id', 'unknown'),
    apiEndpoint: attr('data-api-endpoint', null),
    captureGeo: attr('data-capture-geo', 'false') === 'true',
    requireConsent: true,
    samplingRate: 1.0,
    batchSize: 100,
    flushIntervalMs: 10000,
    heartbeatMs: 30000,
    idleThresholdMs: 5000,
    idleCheckIntervalMs: 2000,
  };

  // ---------- 2. Session identity ----------
  function makeSessionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }

  // Reuse sessionId across page refreshes within the same tab.
  // sessionStorage is cleared on tab close — a new tab always gets a fresh
  // session, but F5 / reload keeps the same sessionId so the backend updates
  // one session document instead of creating a duplicate on every refresh.
  function getOrCreateSessionId() {
    var STORAGE_KEY = 'xylium_sid_' + config.tenantId;
    try {
      var existing = sessionStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      var fresh = makeSessionId();
      sessionStorage.setItem(STORAGE_KEY, fresh);
      return fresh;
    } catch (e) {
      return makeSessionId();
    }
  }

  function deviceFingerprint() {
    var raw = [
      screen.width + 'x' + screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.platform,
      navigator.language,
      navigator.hardwareConcurrency || 'na',
    ].join('|');
    var hash = 5381;
    for (var i = 0; i < raw.length; i++) {
      hash = (hash << 5) + hash + raw.charCodeAt(i);
      hash = hash & hash;
    }
    return 'fp_' + Math.abs(hash);
  }

  // ---------- 2b. Shared helpers ----------
  // cyrb53: fast 53-bit string hash. Much lower collision rate than djb2 on
  // long inputs such as canvas data URLs.
  function hashString(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0);
    var h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  function round(n, dp) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    var m = Math.pow(10, dp || 0);
    return Math.round(n * m) / m;
  }

  function summarize(arr) {
    if (!arr || !arr.length) return null;
    var sum = 0, min = Infinity, max = -Infinity, i;
    for (i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
    var mean = sum / arr.length;
    var sq = 0;
    for (i = 0; i < arr.length; i++) sq += (arr[i] - mean) * (arr[i] - mean);
    var std = Math.sqrt(sq / arr.length);
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return {
      n: arr.length,
      mean: round(mean, 2),
      std: round(std, 2),
      min: round(min, 2),
      max: round(max, 2),
      median: round(sorted[Math.floor(sorted.length / 2)], 2),
      cv: mean ? round(std / mean, 3) : null,
    };
  }

  // Heavy, non-urgent work (fingerprinting) runs when the main thread is idle
  // so it never delays the login form becoming interactive.
  function whenIdle(fn) {
    var run = function () {
      try { fn(); } catch (e) { console.warn('[XyliumBF v2] capture failed', e); }
    };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 200);
  }

  function readStore(key) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function removeStore(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  // ---------- 11 (shared). Device type / OS family ----------
  // Lives in core because several modules (device, bot) need it.
  function detectDeviceType() {
    var uaData = navigator.userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') {
      if (uaData.mobile) return /iPad|Tablet/i.test(navigator.userAgent) ? 'tablet' : 'mobile';
      return 'pc';
    }
    var ua = navigator.userAgent || '';
    if (/iPad|Android(?!.*Mobile)|Tablet/i.test(ua)) return 'tablet';
    if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
    if (/Windows|Macintosh|Linux|X11/i.test(ua)) return 'pc';
    return 'other';
  }

  function detectOsFamily() {
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    var probe = platform + ' ' + ua;
    if (/win/i.test(probe)) return 'windows';
    if (/android/i.test(probe)) return 'android';
    if (/iphone|ipad|ipod|ios/i.test(probe)) return 'ios';
    if (/mac/i.test(probe)) return 'mac';
    if (/linux/i.test(probe)) return 'linux';
    return 'other';
  }

  // Collectors that must emit before the final beacon on pagehide / hidden.
  var preFlushHooks = [];
  function runPreFlushHooks(reason) {
    for (var i = 0; i < preFlushHooks.length; i++) {
      try { preFlushHooks[i](reason); } catch (e) { /* never block the flush */ }
    }
  }
  function addPreFlushHook(fn) { preFlushHooks.push(fn); }

  var state = {
    sessionId: getOrCreateSessionId(),
    userId: null,
    consentGiven: !config.requireConsent,
    buffer: [],
    startTime: performance.now(),
    lastActivityTime: performance.now(),
    isIdle: false,
    idleSince: null,
    keyDownTimes: Object.create(null),
    lastKeyUpTimeByField: Object.create(null),
    autofillSeen: Object.create(null),
    deviceSnapshotSent: false,
    correctionStateByField: Object.create(null),
    // v2.1
    formInteracted: false,
    formSubmitted: false,
    typingStatsByField: Object.create(null),
    fingerprintParts: Object.create(null),
    compositeSent: false,
    consentCapturesRan: false,
  };

  // Cross-module flags. Kept in an object so modules can read/write by
  // reference (mouse sets firstMouseMoveDone, keyboard sets firstKeypressDone,
  // each reads the other's).
  var signals = {
    firstMouseMoveDone: false,
    firstKeypressDone: false,
  };

  var pageLoadTime = performance.timing ? performance.timing.navigationStart : Date.now();

  console.log('[XyliumBF v2.1] init', { tenantId: config.tenantId, appId: config.appId, sessionId: state.sessionId });

  // ---------- 3. Key normalization / field identity (shared) ----------
  var NAMED_KEYS = [
    'Backspace', 'Tab', 'Enter', 'Shift', 'Control', 'Alt', 'Meta',
    'CapsLock', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Home', 'End',
  ];

  function normalizeKey(key) {
    if (key.length === 1) return 'char';
    if (NAMED_KEYS.indexOf(key) !== -1) return key;
    return 'other';
  }

  function fieldIdFor(target) {
    if (!target || typeof target.getAttribute !== 'function') return null;
    return target.id || target.name || target.getAttribute('data-bf-field') || null;
  }

  function classifyField(target) {
    if (!target || typeof target.getAttribute !== 'function') return null;
    var explicit = target.getAttribute('data-bf-field');
    if (explicit) return explicit;
    if (target.type === 'password') return 'password';
    var probe = (target.id || '') + ' ' + (target.name || '') + ' ' + (target.autocomplete || '');
    if (/user|email|login/i.test(probe)) return 'username';
    return fieldIdFor(target);
  }

  // ---------- 13 (shared). Activity-resume hooks ----------
  // pushEvent calls these when a real event lands during an idle window, so the
  // idle module can emit idle_end without owning the event queue.
  var activityResumeHooks = [];
  function onActivityResume(fn) { activityResumeHooks.push(fn); }
  function runActivityResume() {
    for (var i = 0; i < activityResumeHooks.length; i++) {
      try { activityResumeHooks[i](); } catch (e) { /* ignore */ }
    }
  }

  // ---------- 4. Event queue ----------
  function pushEvent(evt) {
    if (!state.consentGiven) return;
    if (Math.random() > config.samplingRate) return;
    evt.t = Math.round(performance.now() - state.startTime);
    evt.sessionId = state.sessionId;
    evt.userId = state.userId;
    state.buffer.push(evt);
    state.lastActivityTime = performance.now();
    if (state.isIdle) runActivityResume();
    if (state.buffer.length >= config.batchSize) flush();
  }

  function pushCriticalEvent(evt) {
    if (!state.consentGiven) return;
    evt.t = Math.round(performance.now() - state.startTime);
    evt.sessionId = state.sessionId;
    evt.userId = state.userId;
    state.buffer.push(evt);
    state.lastActivityTime = performance.now();
    if (state.buffer.length >= config.batchSize) flush();
  }

  // ---------- 14d. Consent-gated one-shot captures ----------
  // Modules register their consent-gated captures with an `order` so the
  // emission sequence stays identical to the original single-file SDK.
  var consentCaptures = []; // { order, fn }
  function onConsent(order, fn) {
    consentCaptures.push({ order: order, fn: fn });
    // If consent was already granted (e.g. a module loaded late, or
    // requireConsent=false), run this capture immediately.
    if (state.consentGiven && state.consentCapturesRan) {
      try { fn(); } catch (e) { console.warn('[XyliumBF v2] consent capture failed', e); }
    }
  }
  function runConsentedCaptures() {
    if (state.consentCapturesRan) return;
    state.consentCapturesRan = true;
    consentCaptures
      .slice()
      .sort(function (a, b) { return a.order - b.order; })
      .forEach(function (c) {
        try { c.fn(); } catch (e) { console.warn('[XyliumBF v2] consent capture failed', e); }
      });
  }

  // Revoke cleanup hooks (modules that persist identifiers register here).
  var revokeHooks = [];
  function onRevoke(fn) { revokeHooks.push(fn); }
  function runRevokeHooks() {
    for (var i = 0; i < revokeHooks.length; i++) {
      try { revokeHooks[i](); } catch (e) { /* ignore */ }
    }
  }

  // ---------- 15. Transport ----------
  function flush(useBeacon) {
    if (state.buffer.length === 0) return;
    var payload = JSON.stringify({
      tenantId: config.tenantId,
      appId: config.appId,
      deviceFingerprint: deviceFingerprint(),
      events: state.buffer,
    });
    state.buffer = [];
    if (!config.apiEndpoint) {
      console.log('[XyliumBF v2] flush (no apiEndpoint set, logging only):', JSON.parse(payload));
      return;
    }
    var url = config.apiEndpoint.replace(/\/$/, '') + '/collect';
    if (useBeacon && navigator.sendBeacon) { navigator.sendBeacon(url, payload); return; }
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true })
      .catch(function (err) { console.warn('[XyliumBF v2] send failed, dropping batch', err); });
  }

  setInterval(function () { flush(false); }, config.flushIntervalMs);
  setInterval(function () { flush(false); }, config.heartbeatMs);
  window.addEventListener('pagehide', function () { runPreFlushHooks('pagehide'); flush(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { runPreFlushHooks('hidden'); flush(true); }
  });

  // ---------- The `core` object handed to every pattern module ----------
  var core = {
    config: config,
    state: state,
    signals: signals,
    pageLoadTime: pageLoadTime,

    // identity
    makeSessionId: makeSessionId,
    deviceFingerprint: deviceFingerprint,

    // event queue
    pushEvent: pushEvent,
    pushCriticalEvent: pushCriticalEvent,
    flush: flush,

    // helpers
    round: round,
    summarize: summarize,
    hashString: hashString,
    whenIdle: whenIdle,
    readStore: readStore,
    writeStore: writeStore,
    removeStore: removeStore,
    normalizeKey: normalizeKey,
    fieldIdFor: fieldIdFor,
    classifyField: classifyField,
    detectDeviceType: detectDeviceType,
    detectOsFamily: detectOsFamily,

    // registration
    onConsent: onConsent,          // (order, fn)  — consent-gated one-shot capture
    onRevoke: onRevoke,            // (fn)         — cleanup when consent is revoked
    onActivityResume: onActivityResume, // (fn)    — called when activity ends an idle window
    addPreFlushHook: addPreFlushHook,   // (fn)    — emit just before final beacon
    defineApi: defineApi,          // (name, fn)   — add a method to window.XyliumBF
  };

  // ---------- 16. Public API ----------
  function defineApi(name, fn) { api[name] = fn; }

  var api = {
    __core: core,

    // Register a pattern module. Safe to call before OR after core loads.
    use: function (factory) {
      try { factory(core); }
      catch (e) { console.warn('[XyliumBF v2] module init failed', e); }
    },

    identify: function (userId) {
      state.userId = userId;
      pushEvent({ type: 'identify', userId: userId });
      console.log('[XyliumBF v2] identified user:', userId);
    },
    track: function (name, props) { pushEvent({ type: 'custom', name: name, props: props || {} }); },
    grantConsent: function () {
      state.consentGiven = true;
      state.lastActivityTime = performance.now();
      console.log('[XyliumBF v2] consent granted, capture active');
      runConsentedCaptures();
    },
    revokeConsent: function () {
      state.consentGiven = false;
      state.buffer = [];
      // Remove persisted identifiers so revoking consent really forgets the device.
      runRevokeHooks();
      console.log('[XyliumBF v2] consent revoked, capture stopped');
    },
    // Overridden by modules once they load (stubs so early calls don't throw).
    reportLoginResult: function () { console.warn('[XyliumBF v2] identity module not loaded'); },
    markFormSubmitted: function () { console.warn('[XyliumBF v2] form module not loaded'); },
    requestGeo: function () { console.warn('[XyliumBF v2] geo module not loaded'); },

    getSessionId: function () { return state.sessionId; },
    _debugFlushNow: function () { flush(false); },
  };

  // Drain any modules that loaded BEFORE core (queue pattern), then swap the
  // queue for one that runs modules immediately as they arrive.
  var pending = window.XyliumBFModules;
  window.XyliumBF = api;
  window.XyliumBFModules = { push: api.use };
  if (pending && pending.length) {
    for (var i = 0; i < pending.length; i++) api.use(pending[i]);
  }

  // If consent was pre-granted (requireConsent=false), run captures once the
  // page has finished loading so every module has had a chance to register.
  if (state.consentGiven) {
    if (document.readyState === 'complete') runConsentedCaptures();
    else window.addEventListener('load', runConsentedCaptures);
  }
})();

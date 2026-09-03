/**
 * Xylium Behavioral Fingerprinting SDK — v2
 * Drop-in via:
 *   <script src="xylium-bf-v2.js"
 *           data-tenant-id="tenant_abc123"
 *           data-app-id="app_xyz789"
 *           data-api-endpoint="https://your-ingestion-gateway.example.com"
 *           data-capture-geo="false">
 *   </script>
 *
 * ============================================================================
 * WHAT THIS ADDS OVER v1 (xylium-bf.js)
 * ============================================================================
 * v1 captured raw mouse/keyboard/scroll/focus/visibility/resize/paste events.
 * v2 adds everything needed to compute the FEATURE_WEIGHTS your backend scores
 * on, without changing the wire format the ingestion gateway (NestJS/Express)
 * already expects: { tenantId, appId, deviceFingerprint, events[] }.
 *
 * Mapping from FEATURE_WEIGHTS -> what supplies it:
 *
 *   avg_typing_speed, avg_key_hold_time, avg_flight_time
 *     <- new "keytiming" events (holdTimeMs, flightTimeMs per keystroke,
 *        content-free — only timing, same privacy rule as v1's key
 *        normalization). Backend averages these per session.
 *
 *   avg_mouse_speed, mouse_acceleration, mouse_distance
 *     <- existing "mousemove" events (x, y, t). Kept as raw samples on
 *        purpose (not pre-computed client-side) so the backend's feature
 *        code is the single source of truth for the math — the SDK stays
 *        "dumb" per the original design doc.
 *
 *   click_count, scroll_speed
 *     <- existing "click"/"mousedown"/"mouseup" and "scroll" events; backend
 *        counts/derives rate from timestamps.
 *
 *   total_duration, idle_time
 *     <- new "idle_start"/"idle_end" events (with idle gap in ms) plus the
 *        existing per-event `t` (ms since init). Backend derives total_duration
 *        from first/last event time and idle_time by summing idle gaps.
 *
 *   screen_width, screen_height, viewport_width, viewport_height,
 *   device_memory, hardware_concurrency, screen_area, viewport_area,
 *   viewport_to_screen_ratio, viewport_aspect_ratio
 *     <- new "device_snapshot" event, captured once. Only raw width/height/
 *        memory/cores are sent; areas and ratios are trivial derivations the
 *        backend computes, again to avoid duplicating logic in two places.
 *
 *   device_type_mobile/tablet/pc/other, os_family_windows/mac/linux/
 *   android/ios/other
 *     <- also in "device_snapshot", as `deviceType` and `osFamily` strings.
 *        Backend one-hot encodes these into the category features.
 *
 *   username_autofilled, password_autofilled, username_fill_time_ms,
 *   password_fill_time_ms
 *     <- new "autofill" events, detected via the standard CSS
 *        :-webkit-autofill animation trick (Chrome/Edge/Safari — the
 *        majority of traffic; there is no reliable equivalent in Firefox,
 *        so this is best-effort, not guaranteed cross-browser).
 *
 *   geo_lat, geo_lon
 *     <- OPTIONAL "geo" event via the browser Geolocation API. Off by
 *        default (data-capture-geo="false"); only fires after consent AND
 *        the browser's own permission prompt, and coordinates are rounded
 *        to ~1km precision before leaving the browser.
 *
 *   geo_distance_from_home_km, is_vpn, is_proxy, is_datacenter
 *     <- NOT captured by this SDK. These require IP intelligence (e.g. an
 *        IP geolocation / VPN-detection lookup) which can only be done
 *        server-side from the request's source IP — the ingestion gateway
 *        already records `clientIp` on every batch, so compute these in the
 *        FastAPI feature service from that, not in the browser. A page can
 *        always claim any IP-derived signal via a proxy anyway, so this is
 *        a deliberate boundary, not a gap.
 *
 * Stubbed for now (not in this file, same as v1): fetching real /sdk/config,
 * SPA route-change re-init. Marked "TODO(prod)" below.
 */
(function () {
  'use strict';

  // ---------- 1. Read config from the <script> tag ----------
  var currentScript = document.currentScript;
  var config = {
    tenantId: currentScript ? currentScript.getAttribute('data-tenant-id') : 'unknown',
    appId: currentScript ? currentScript.getAttribute('data-app-id') : 'unknown',
    apiEndpoint: currentScript ? currentScript.getAttribute('data-api-endpoint') : null,
    captureGeo: currentScript ? currentScript.getAttribute('data-capture-geo') === 'true' : false,
    requireConsent: true, // TODO(prod): pull from GET /sdk/config
    samplingRate: 1.0, // TODO(prod): pull from GET /sdk/config
    batchSize: 100,
    flushIntervalMs: 10000,
    heartbeatMs: 30000,
    idleThresholdMs: 5000, // gap with no activity before we call it "idle"
    idleCheckIntervalMs: 2000,
  };

  // ---------- 2. Session identity ----------
  function makeSessionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }

  function deviceFingerprint() {
    // Weak signal only — djb2-style hash, NOT a heavyweight fingerprint lib
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
      hash = hash & hash; // 32-bit
    }
    return 'fp_' + Math.abs(hash);
  }

  var state = {
    sessionId: makeSessionId(),
    userId: null,
    consentGiven: !config.requireConsent,
    buffer: [],
    startTime: performance.now(),
    lastActivityTime: performance.now(),
    isIdle: false,
    idleSince: null,
    keyDownTimes: Object.create(null), // `${field}|${code}` -> keydown timestamp
    lastKeyUpTimeByField: Object.create(null), // field -> last keyup timestamp
    autofillSeen: Object.create(null), // field -> true, so we only report once each
    deviceSnapshotSent: false,
  };

  console.log('[XyliumBF v2] init', { tenantId: config.tenantId, appId: config.appId, sessionId: state.sessionId });

  // ---------- 3. Key normalization (privacy-critical, same rule as v1) ----------
  var NAMED_KEYS = [
    'Backspace', 'Tab', 'Enter', 'Shift', 'Control', 'Alt', 'Meta',
    'CapsLock', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Home', 'End',
  ];

  function normalizeKey(key) {
    if (key.length === 1) return 'char'; // single printable char -> never store the real char
    if (NAMED_KEYS.indexOf(key) !== -1) return key; // named keys pass through
    return 'other';
  }

  function fieldIdFor(target) {
    if (!target || typeof target.getAttribute !== 'function') return null;
    return target.id || target.name || target.getAttribute('data-bf-field') || null;
  }

  // Best-effort classification so username_autofilled/password_autofilled
  // land on sensible field names even if the integrator didn't tag fields
  // with data-bf-field. Explicit data-bf-field always wins.
  function classifyField(target) {
    if (!target || typeof target.getAttribute !== 'function') return null;
    var explicit = target.getAttribute('data-bf-field');
    if (explicit) return explicit;
    if (target.type === 'password') return 'password';
    var probe = (target.id || '') + ' ' + (target.name || '') + ' ' + (target.autocomplete || '');
    if (/user|email|login/i.test(probe)) return 'username';
    return fieldIdFor(target);
  }

  // ---------- 4. Event queue ----------
  function pushEvent(evt) {
    if (!state.consentGiven) return; // hard gate — nothing captured pre-consent
    if (Math.random() > config.samplingRate) return; // sampling
    evt.t = Math.round(performance.now() - state.startTime); // ms since init
    evt.sessionId = state.sessionId;
    evt.userId = state.userId;
    state.buffer.push(evt);
    state.lastActivityTime = performance.now();
    if (state.isIdle) endIdle();
    if (state.buffer.length >= config.batchSize) flush();
  }

  // Snapshot / structural events (device info, autofill, idle) matter even
  // if sampled traffic would otherwise drop them, so they bypass sampling —
  // but still require consent, same as everything else.
  function pushCriticalEvent(evt) {
    if (!state.consentGiven) return;
    evt.t = Math.round(performance.now() - state.startTime);
    evt.sessionId = state.sessionId;
    evt.userId = state.userId;
    state.buffer.push(evt);
    state.lastActivityTime = performance.now();
    if (state.buffer.length >= config.batchSize) flush();
  }

  // ---------- 5. Capture: mouse ----------
  var lastMouseSample = 0;
  document.addEventListener(
    'mousemove',
    function (e) {
      var now = performance.now();
      if (now - lastMouseSample < 50) return; // throttle to 50ms
      lastMouseSample = now;
      pushEvent({ type: 'mousemove', x: e.clientX, y: e.clientY });
    },
    { passive: true }
  );

  ['mousedown', 'mouseup', 'click'].forEach(function (evtName) {
    document.addEventListener(
      evtName,
      function (e) {
        pushEvent({ type: evtName, x: e.clientX, y: e.clientY, field: fieldIdFor(e.target) });
      },
      { passive: true }
    );
  });

  // ---------- 6. Capture: keyboard (privacy-normalized + timing) ----------
  document.addEventListener(
    'keydown',
    function (e) {
      var field = fieldIdFor(e.target);
      pushEvent({ type: 'keydown', key: normalizeKey(e.key), field: field });

      // Track hold-time start. Keyed by field+code so overlapping/held keys
      // on different fields don't clash.
      var mapKey = field + '|' + e.code;
      if (!(mapKey in state.keyDownTimes)) {
        state.keyDownTimes[mapKey] = performance.now();
      }
    },
    { passive: true }
  );

  document.addEventListener(
    'keyup',
    function (e) {
      var field = fieldIdFor(e.target);
      pushEvent({ type: 'keyup', key: normalizeKey(e.key), field: field });

      var mapKey = field + '|' + e.code;
      var now = performance.now();
      var downAt = state.keyDownTimes[mapKey];
      if (downAt !== undefined) {
        var holdTimeMs = Math.round(now - downAt);
        delete state.keyDownTimes[mapKey];

        var lastUp = state.lastKeyUpTimeByField[field];
        var flightTimeMs = lastUp !== undefined ? Math.round(downAt - lastUp) : null;

        pushEvent({ type: 'keytiming', field: field, holdTimeMs: holdTimeMs, flightTimeMs: flightTimeMs });
      }
      state.lastKeyUpTimeByField[field] = now;
    },
    { passive: true }
  );

  // ---------- 7. Capture: scroll ----------
  var lastScrollSample = 0;
  document.addEventListener(
    'scroll',
    function () {
      var now = performance.now();
      if (now - lastScrollSample < 100) return; // throttle to 100ms
      lastScrollSample = now;
      pushEvent({ type: 'scroll', y: window.scrollY });
    },
    { passive: true }
  );

  // ---------- 8. Capture: focus / blur ----------
  ['focus', 'blur'].forEach(function (evtName) {
    document.addEventListener(
      evtName,
      function (e) {
        var field = fieldIdFor(e.target);
        if (!field) return; // ignore focus on non-form elements
        pushEvent({ type: evtName, field: field });
      },
      true
    ); // focus/blur need capture phase — they don't bubble
  });

  // ---------- 9. Capture: visibility + resize ----------
  document.addEventListener('visibilitychange', function () {
    pushEvent({ type: 'visibilitychange', state: document.visibilityState });
  });

  window.addEventListener('resize', function () {
    pushEvent({ type: 'resize', w: window.innerWidth, h: window.innerHeight });
  });

  // ---------- 10. Capture: paste / copy on form fields ----------
  ['paste', 'copy'].forEach(function (evtName) {
    document.addEventListener(evtName, function (e) {
      pushEvent({ type: evtName, field: fieldIdFor(e.target) });
    });
  });

  // ---------- 11. Device / environment snapshot (once) ----------
  function detectDeviceType() {
    var uaData = navigator.userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') {
      if (uaData.mobile) {
        // userAgentData doesn't distinguish tablet vs mobile reliably;
        // fall back to a coarse UA check for tablet.
        return /iPad|Tablet/i.test(navigator.userAgent) ? 'tablet' : 'mobile';
      }
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
    if (/android/i.test(probe)) return 'android'; // check before "linux" (Android UAs contain "Linux")
    if (/iphone|ipad|ipod|ios/i.test(probe)) return 'ios';
    if (/mac/i.test(probe)) return 'mac';
    if (/linux/i.test(probe)) return 'linux';
    return 'other';
  }

  function sendDeviceSnapshot() {
    if (state.deviceSnapshotSent) return;
    state.deviceSnapshotSent = true;
    pushCriticalEvent({
      type: 'device_snapshot',
      screenWidth: screen.width,
      screenHeight: screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      deviceMemory: navigator.deviceMemory || null,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceType: detectDeviceType(),
      osFamily: detectOsFamily(),
    });
  }

  // ---------- 12. Autofill detection (Chrome/Edge/Safari via CSS trick) ----------
  // Standard technique: browsers apply a distinct internal style to
  // autofilled inputs; an @keyframes bound to that pseudo-class fires an
  // animationstart event we can listen for, with no visible effect on the
  // page. Firefox has no equivalent — this is best-effort, not guaranteed.
  function installAutofillWatcher() {
    var style = document.createElement('style');
    style.textContent =
      '@keyframes xyliumBFAutofillStart { from {} to {} }\n' +
      'input:-webkit-autofill { animation-name: xyliumBFAutofillStart; animation-duration: 0.001s; }';
    document.head.appendChild(style);

    document.addEventListener(
      'animationstart',
      function (e) {
        if (e.animationName !== 'xyliumBFAutofillStart') return;
        var target = e.target;
        if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
        var field = classifyField(target);
        if (!field || state.autofillSeen[field]) return; // report once per field
        state.autofillSeen[field] = true;
        pushCriticalEvent({
          type: 'autofill',
          field: field,
          fillTimeMs: Math.round(performance.now() - state.startTime),
        });
      },
      true
    );
  }

  // ---------- 13. Idle detection ----------
  function endIdle() {
    if (!state.isIdle) return;
    var idleDurationMs = Math.round(performance.now() - state.idleSince);
    state.isIdle = false;
    pushCriticalEvent({ type: 'idle_end', idleDurationMs: idleDurationMs });
  }

  setInterval(function () {
    if (!state.consentGiven || state.isIdle) return;
    var now = performance.now();
    if (now - state.lastActivityTime >= config.idleThresholdMs) {
      state.isIdle = true;
      state.idleSince = state.lastActivityTime;
      pushCriticalEvent({ type: 'idle_start' });
    }
  }, config.idleCheckIntervalMs);

  // ---------- 14. Optional: geolocation (off by default, needs consent) ----------
  function maybeCaptureGeo() {
    if (!config.captureGeo || !state.consentGiven) return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        // Round to ~2 decimal places (~1km) before it ever leaves the browser.
        pushCriticalEvent({
          type: 'geo',
          lat: Math.round(pos.coords.latitude * 100) / 100,
          lon: Math.round(pos.coords.longitude * 100) / 100,
        });
      },
      function () {
        /* permission denied or unavailable — fail silently, this is optional */
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
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

    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, payload);
      return;
    }

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(function (err) {
      // Fail silently — never break the host page. TODO(prod): retry w/ backoff, max 3, then drop.
      console.warn('[XyliumBF v2] send failed, dropping batch', err);
    });
  }

  setInterval(function () {
    flush(false);
  }, config.flushIntervalMs); // periodic flush
  setInterval(function () {
    flush(false);
  }, config.heartbeatMs); // heartbeat backstop
  window.addEventListener('pagehide', function () {
    flush(true);
  }); // final flush on unload
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });

  // ---------- 16. Public API ----------
  window.XyliumBF = {
    identify: function (userId) {
      state.userId = userId;
      pushEvent({ type: 'identify', userId: userId });
      console.log('[XyliumBF v2] identified user:', userId);
    },
    track: function (name, props) {
      pushEvent({ type: 'custom', name: name, props: props || {} });
    },
    grantConsent: function () {
      state.consentGiven = true;
      state.lastActivityTime = performance.now();
      console.log('[XyliumBF v2] consent granted, capture active');
      sendDeviceSnapshot();
      maybeCaptureGeo();
    },
    revokeConsent: function () {
      state.consentGiven = false;
      state.buffer = [];
      console.log('[XyliumBF v2] consent revoked, capture stopped');
    },
    // Explicit opt-in trigger if you'd rather ask for geo on a user action
    // (e.g. a "use my location" button) instead of automatically on consent.
    requestGeo: function () {
      maybeCaptureGeo();
    },
    getSessionId: function () {
      return state.sessionId;
    },
    _debugFlushNow: function () {
      flush(false);
    },
  };

  installAutofillWatcher();
  if (state.consentGiven) {
    sendDeviceSnapshot();
    maybeCaptureGeo();
  }
})();

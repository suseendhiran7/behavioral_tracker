/**
 * Xylium Behavioral Fingerprinting SDK — v2.1
 *
 * v2.1 adds: touch gestures (swipe / tap accuracy / jitter / multi-touch),
 * field clear+retype, password-visibility toggle, form abandon/return,
 * first-field-interaction timing, referrer classification, window blur/focus
 * mid-login, canvas / WebGL / font / audio fingerprints, language list,
 * DNT/GPC, tz-vs-geo check, HTTP protocol + DNS/TLS timing, RTT variance,
 * automation / headless / CDP detection, CSS media-query anomalies,
 * event isTrusted + timestamp-precision stats, typing summaries for baseline
 * drift, persistent device first-seen flag, and failed-attempt window.
 * It also fixes mouse trajectory / overshoot, which previously only sampled
 * while the button was held and so never fired on ordinary clicks.
 *
 * SERVER-SIDE ONLY (cannot be measured in JS — must be added in the backend):
 *   JA3/JA4 TLS fingerprint, TCP/IP (p0f-style) OS fingerprint, true HTTP/2
 *   vs HTTP/3 negotiation behaviour, ASN / hosting-provider category of the
 *   IP, accounts-per-device/IP, device-switch frequency, login-hour and
 *   day-of-week deviation from the user's own baseline, delta from the
 *   user's historical typing speed. This SDK sends the raw inputs for all of
 *   these (persistentDeviceId, compositeHash, time_context, typing_summary,
 *   network_timing, rtt_variance, login_result).
 */
(function () {
  'use strict';

  // ---------- 1. Config ----------
  var currentScript = document.currentScript;
  var config = {
    tenantId: currentScript ? currentScript.getAttribute('data-tenant-id') : 'unknown',
    appId: currentScript ? currentScript.getAttribute('data-app-id') : 'unknown',
    apiEndpoint: currentScript ? currentScript.getAttribute('data-api-endpoint') : null,
    captureGeo: currentScript ? currentScript.getAttribute('data-capture-geo') === 'true' : false,
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

  // Collectors that must emit before the final beacon on pagehide / hidden.
  // Declared here (not in section 15) so earlier sections can register hooks.
  var preFlushHooks = [];
  function runPreFlushHooks(reason) {
    for (var i = 0; i < preFlushHooks.length; i++) {
      try { preFlushHooks[i](reason); } catch (e) { /* never block the flush */ }
    }
  }

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

  console.log('[XyliumBF v2.1] init', { tenantId: config.tenantId, appId: config.appId, sessionId: state.sessionId });

  // ---------- 3. Key normalization ----------
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

  // ---------- 4. Event queue ----------
  function pushEvent(evt) {
    if (!state.consentGiven) return;
    if (Math.random() > config.samplingRate) return;
    evt.t = Math.round(performance.now() - state.startTime);
    evt.sessionId = state.sessionId;
    evt.userId = state.userId;
    state.buffer.push(evt);
    state.lastActivityTime = performance.now();
    if (state.isIdle) endIdle();
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

  // ---------- 5. Capture: mouse ----------
  var lastMouseSample = 0;

  // 5a vars
  var firstMouseMoveDone = false;
  var firstKeypressDone = false;
  var pageLoadTime = performance.timing ? performance.timing.navigationStart : Date.now();

  document.addEventListener('mousemove', function (e) {
    var now = performance.now();

    // ---------- 5a. Time-to-first-mouse-move — BEFORE throttle ----------
    if (!firstMouseMoveDone) {
      firstMouseMoveDone = true;
      var nowWallClock = Date.now();
      var firstDx = e.movementX || 0;
      var firstDy = e.movementY || 0;
      var firstSpeedPx = Math.round(Math.sqrt(firstDx * firstDx + firstDy * firstDy));
      pushCriticalEvent({
        type: 'first_mouse_move',
        timeFromLoadMs: Math.round(nowWallClock - pageLoadTime),
        timeFromInitMs: Math.round(now - state.startTime),
        firstDx: firstDx,
        firstDy: firstDy,
        firstSpeedPx: firstSpeedPx,
        beforeFirstKeypress: !firstKeypressDone,
      });
    }

    // ---------- 5b. approach-path sample collection (feeds 5b + 5f) ----------
    var lastApproach = approachBuffer[approachBuffer.length - 1];
    if (lastApproach && now - lastApproach.t > APPROACH_RESET_MS) approachBuffer = [];
    approachBuffer.push({ x: e.clientX, y: e.clientY, t: now });
    if (approachBuffer.length > MAX_APPROACH_SAMPLES) approachBuffer.shift();

    // ---------- 5e. entropy sample collection ----------
    entropyBuffer.push({ x: e.clientX, y: e.clientY });
    if (entropyBuffer.length >= ENTROPY_WINDOW_SIZE) {
      emitEntropyEvent();
    }

    // regular throttled mousemove
    if (now - lastMouseSample < 50) return;
    lastMouseSample = now;
    pushEvent({ type: 'mousemove', x: e.clientX, y: e.clientY });
  }, { passive: true });

  ['mousedown', 'mouseup', 'click'].forEach(function (evtName) {
    document.addEventListener(evtName, function (e) {
      pushEvent({ type: evtName, x: e.clientX, y: e.clientY, field: fieldIdFor(e.target) });
    }, { passive: true });
  });

  // ---------- 5b. Mouse trajectory curvature / straightness index ----------
  // v2.1 fix: v2 only sampled while the button was held, so a normal click
  // produced two points and never emitted. We now keep a rolling buffer of the
  // cursor path leading up to each press (the "approach"), which is where
  // curvature and overshoot actually happen. Wire format is unchanged apart
  // from the added `phase` and `field` keys.
  var approachBuffer = [];
  var MAX_APPROACH_SAMPLES = 200;
  var APPROACH_RESET_MS = 1500;  // a pause this long starts a new movement
  var MIN_APPROACH_PX = 20;      // ignore micro-movements
  var OVERSHOOT_MIN_PX = 3;

  document.addEventListener('mousedown', function (e) {
    var now = performance.now();
    var path = approachBuffer;
    approachBuffer = [];
    var lastPt = path[path.length - 1];
    if (lastPt && now - lastPt.t > APPROACH_RESET_MS) path = []; // cursor was parked
    path.push({ x: e.clientX, y: e.clientY, t: now });
    if (path.length < 3) return;

    var start = path[0];
    var end = path[path.length - 1];
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var straightLinePx = Math.sqrt(dx * dx + dy * dy);
    if (straightLinePx < MIN_APPROACH_PX) return;

    var actualPathPx = 0;
    var i;
    for (i = 1; i < path.length; i++) {
      var segDx = path[i].x - path[i - 1].x;
      var segDy = path[i].y - path[i - 1].y;
      actualPathPx += Math.sqrt(segDx * segDx + segDy * segDy);
    }

    var maxDeviationPx = 0;
    for (i = 1; i < path.length - 1; i++) {
      var deviation = Math.abs(dy * path[i].x - dx * path[i].y + end.x * start.y - end.y * start.x) / straightLinePx;
      if (deviation > maxDeviationPx) maxDeviationPx = deviation;
    }

    pushEvent({
      type: 'mouse_trajectory',
      phase: 'approach',
      straightnessIndex: actualPathPx > 0 ? round(straightLinePx / actualPathPx, 3) : null,
      actualPathPx: Math.round(actualPathPx),
      straightLinePx: Math.round(straightLinePx),
      maxDeviationPx: Math.round(maxDeviationPx),
      sampleCount: path.length,
      durationMs: Math.round(end.t - start.t),
      field: fieldIdFor(e.target) || null,
    });

    // ---------- 5f. Overshoot and correction ----------
    // Project every sample onto the start->click direction. A positive
    // projection means the cursor travelled *past* the target before coming
    // back. Humans do this routinely; scripted movement almost never does.
    var ux = dx / straightLinePx;
    var uy = dy / straightLinePx;
    var maxBeyond = 0;
    var maxBeyondT = null;
    for (i = 0; i < path.length; i++) {
      var proj = (path[i].x - end.x) * ux + (path[i].y - end.y) * uy;
      if (proj > maxBeyond) { maxBeyond = proj; maxBeyondT = path[i].t; }
    }
    var didOvershoot = maxBeyond > OVERSHOOT_MIN_PX;

    var approachAngleDeg = null;
    for (i = path.length - 2; i >= 0; i--) {
      if (path[i].x !== end.x || path[i].y !== end.y) {
        approachAngleDeg = Math.round(Math.atan2(end.y - path[i].y, end.x - path[i].x) * (180 / Math.PI));
        break;
      }
    }

    // Count how many of the final segments are slower than the previous one
    // (humans decelerate into a target — Fitts' law).
    var decelerationSamples = 0;
    var prevSpeed = Infinity;
    var finalSpeed = null;
    for (i = Math.max(1, path.length - 10); i < path.length; i++) {
      var dt = path[i].t - path[i - 1].t;
      if (dt <= 0) continue;
      var sx = path[i].x - path[i - 1].x;
      var sy = path[i].y - path[i - 1].y;
      var speed = Math.sqrt(sx * sx + sy * sy) / dt;
      if (speed < prevSpeed) decelerationSamples++;
      prevSpeed = speed;
      finalSpeed = speed;
    }

    pushEvent({
      type: 'overshoot',
      didOvershoot: didOvershoot,
      overshootPx: didOvershoot ? Math.round(maxBeyond) : 0,
      correctionMs: didOvershoot ? Math.round(end.t - maxBeyondT) : 0,
      approachAngleDeg: approachAngleDeg,
      decelerationSamples: decelerationSamples,
      finalSpeedPxPerMs: round(finalSpeed, 3),
    });
  }, { passive: true });

  // ---------- 5c. Hover duration before clicks ----------
  var hoverStartByTarget = new WeakMap();

  document.addEventListener('mouseover', function (e) {
    hoverStartByTarget.set(e.target, { t: performance.now() });
  }, { passive: true });

  document.addEventListener('click', function (e) {
    var target = e.target;
    var hoverStart = hoverStartByTarget.get(target);
    var now = performance.now();
    var hoverDurationMs = hoverStart ? Math.round(now - hoverStart.t) : null;
    var tag = target.tagName || '';
    var TRACKED_TAGS = ['BUTTON', 'INPUT', 'A', 'LABEL', 'SELECT', 'TEXTAREA'];
    if (TRACKED_TAGS.indexOf(tag) === -1) return;
    pushEvent({
      type: 'hover_before_click',
      hoverDurationMs: hoverDurationMs,
      tag: tag,
      field: fieldIdFor(target) || null,
      isZeroHover: hoverDurationMs === null || hoverDurationMs < 10,
    });
  }, { passive: true });

  // ---------- 5d. Double-click vs single-click ----------
  var DOUBLE_CLICK_THRESHOLD_MS = 500;
  var lastClickData = null;
  var doubleClickTimer = null;

  document.addEventListener('click', function (e) {
    var now = performance.now();
    var x = e.clientX;
    var y = e.clientY;
    var field = fieldIdFor(e.target) || null;

    if (lastClickData !== null) {
      var gapMs = Math.round(now - lastClickData.t);
      if (gapMs <= DOUBLE_CLICK_THRESHOLD_MS) {
        var driftDx = x - lastClickData.x;
        var driftDy = y - lastClickData.y;
        var driftPx = Math.round(Math.sqrt(driftDx * driftDx + driftDy * driftDy));
        if (doubleClickTimer !== null) { clearTimeout(doubleClickTimer); doubleClickTimer = null; }
        pushEvent({ type: 'double_click', gapMs: gapMs, driftPx: driftPx, field: field });
        lastClickData = null;
        return;
      }
    }

    lastClickData = { x: x, y: y, t: now, field: field };
    if (doubleClickTimer !== null) clearTimeout(doubleClickTimer);
    doubleClickTimer = setTimeout(function () {
      if (lastClickData !== null) {
        pushEvent({ type: 'single_click_confirmed', field: lastClickData.field });
        lastClickData = null;
      }
      doubleClickTimer = null;
    }, DOUBLE_CLICK_THRESHOLD_MS + 50);
  }, { passive: true });

  // ---------- 5e. Mouse movement entropy ----------
  var ENTROPY_WINDOW_SIZE = 50;
  var ENTROPY_ANGLE_BUCKETS = 8;
  var entropyBuffer = [];

  function emitEntropyEvent() {
    var angleBuckets = new Array(ENTROPY_ANGLE_BUCKETS).fill(0);
    var angleChanges = [];
    var prevAngle = null;

    for (var i = 1; i < entropyBuffer.length; i++) {
      var dx = entropyBuffer[i].x - entropyBuffer[i - 1].x;
      var dy = entropyBuffer[i].y - entropyBuffer[i - 1].y;
      if (dx === 0 && dy === 0) continue;
      var angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
      if (prevAngle !== null) {
        var delta = Math.abs(angleDeg - prevAngle);
        if (delta > 180) delta = 360 - delta;
        angleChanges.push(delta);
        var bucket = Math.min(Math.floor(delta / (180 / ENTROPY_ANGLE_BUCKETS)), ENTROPY_ANGLE_BUCKETS - 1);
        angleBuckets[bucket]++;
      }
      prevAngle = angleDeg;
    }

    if (angleChanges.length < 2) { entropyBuffer = []; return; }

    var sum = angleChanges.reduce(function (a, b) { return a + b; }, 0);
    var avg = sum / angleChanges.length;
    var variance = angleChanges.reduce(function (a, b) { return a + (b - avg) * (b - avg); }, 0) / angleChanges.length;
    var std = Math.sqrt(variance);

    var entropy = 0;
    for (var b = 0; b < angleBuckets.length; b++) {
      if (angleBuckets[b] === 0) continue;
      var p = angleBuckets[b] / angleChanges.length;
      entropy -= p * Math.log2(p);
    }

    pushEvent({
      type: 'mouse_entropy',
      entropy: Math.round(entropy * 1000) / 1000,
      avgAngleChangeDeg: Math.round(avg * 100) / 100,
      stdAngleChangeDeg: Math.round(std * 100) / 100,
      sampleCount: entropyBuffer.length,
    });

    entropyBuffer = [];
  }

  // ---------- 6. Capture: keyboard ----------
  // Track first keypress for 5a
  document.addEventListener('keydown', function (e) {
    if (!firstKeypressDone) firstKeypressDone = true;
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    var field = fieldIdFor(e.target);
    pushEvent({ type: 'keydown', key: normalizeKey(e.key), field: field });
    var mapKey = field + '|' + e.code;
    if (!(mapKey in state.keyDownTimes)) {
      state.keyDownTimes[mapKey] = performance.now();
    }
  }, { passive: true });

  document.addEventListener('keyup', function (e) {
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
      recordTypingStat(field, holdTimeMs, flightTimeMs, e.key, classifyField(e.target));

      // ---------- 6c. Backspace / Delete correction rhythm ----------
      if (e.key === 'Backspace' || e.key === 'Delete') {
        var CORRECTION_HOLD_THRESHOLD_MS = 400;
        var CORRECTION_BURST_GAP_MS = 1000;

        if (!state.correctionStateByField[field]) {
          state.correctionStateByField[field] = { lastCorrectionUpAt: null, burstIndex: 0 };
        }
        var cs = state.correctionStateByField[field];
        var gapFromLastMs = null;

        if (cs.lastCorrectionUpAt !== null) {
          var corrGap = Math.round(now - cs.lastCorrectionUpAt);
          if (corrGap > CORRECTION_BURST_GAP_MS) {
            cs.burstIndex = 0;
          } else {
            gapFromLastMs = corrGap;
          }
        }

        pushEvent({
          type: 'correction_key',
          field: field,
          key: e.key,
          holdTimeMs: holdTimeMs,
          isHeld: holdTimeMs > CORRECTION_HOLD_THRESHOLD_MS,
          gapFromLastMs: gapFromLastMs,
          burstIndex: cs.burstIndex,
        });

        cs.lastCorrectionUpAt = now;
        cs.burstIndex += 1;
      }
    }

    state.lastKeyUpTimeByField[field] = now;
  }, { passive: true });

  // ---------- 6b. Digraph / trigraph timing ----------
  var ngramWindowByField = Object.create(null);
  var NGRAM_WINDOW = 3;
  var NGRAM_RESET_MS = 2000;

  document.addEventListener('keyup', function (e) {
    if (e.key.length !== 1) return;
    var field = fieldIdFor(e.target);
    if (!field) return;
    var now = performance.now();

    if (!ngramWindowByField[field]) ngramWindowByField[field] = [];
    var win = ngramWindowByField[field];

    if (win.length > 0 && (now - win[win.length - 1].upAt) > NGRAM_RESET_MS) win.length = 0;

    win.push({ upAt: now });
    if (win.length > NGRAM_WINDOW) win.shift();

    if (win.length >= 2) {
      pushEvent({
        type: 'keytiming_ngram',
        field: field,
        n: 2,
        intervalMs: [Math.round(win[win.length - 1].upAt - win[win.length - 2].upAt)],
      });
    }

    if (win.length >= 3) {
      pushEvent({
        type: 'keytiming_ngram',
        field: field,
        n: 3,
        intervalMs: [
          Math.round(win[win.length - 2].upAt - win[win.length - 3].upAt),
          Math.round(win[win.length - 1].upAt - win[win.length - 2].upAt),
        ],
      });
    }
  }, { passive: true });

  // ---------- 6d. Right-click vs keyboard shortcut ratio ----------
  document.addEventListener('contextmenu', function (e) {
    pushEvent({ type: 'rightclick', field: fieldIdFor(e.target) || null, x: e.clientX, y: e.clientY });
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    var key = e.key.toLowerCase();
    var TRACKED = { c: 'ctrl+c', v: 'ctrl+v', x: 'ctrl+x', a: 'ctrl+a', z: 'ctrl+z' };
    var shortcut = TRACKED[key];
    if (!shortcut) return;
    pushEvent({ type: 'keyboard_shortcut', shortcut: shortcut, field: fieldIdFor(e.target) || null });
  }, { passive: true });

  // ---------- 6e. Touch pressure ----------
  document.addEventListener('touchstart', function (e) {
    if (!e.touches || e.touches.length === 0) return;
    var touch = e.touches[0];
    var force = typeof touch.force === 'number' ? touch.force : null;
    if (force === null) return;
    pushEvent({
      type: 'touch_pressure',
      field: fieldIdFor(e.target) || null,
      force: Math.round(force * 1000) / 1000,
      radiusX: touch.radiusX ? Math.round(touch.radiusX) : null,
      radiusY: touch.radiusY ? Math.round(touch.radiusY) : null,
      isTrusted: e.isTrusted,
    });
  }, { passive: true });

  // ---------- 6g. Touch gestures: swipe, tap accuracy, jitter, multi-touch ----------
  // One gesture = first finger down .. last finger up.
  //   swipe       { direction, distancePx, durationMs, avgVelocity, peakVelocity,
  //                 endVelocity, decelRatio }            velocities in px/ms
  //   touch_tap   { offsetXPx, offsetYPx, offsetNorm, jitterPx, radiusX/Y }
  //               offsetNorm: 0 = dead centre of the target, 1 = its edge
  //   multi_touch { maxTouches, gesture: pinch|multi_finger_pan|multi_finger_tap, pinchScale }
  var TAP_MAX_MOVE_PX = 10;
  var SWIPE_MIN_PX = 30;
  var MAX_TOUCH_SAMPLES = 120;
  var TAP_TARGET_SELECTOR = 'button, a, input, select, textarea, label, [role="button"], [data-bf-field]';
  var touchTrack = null;

  function pinchDistance(touches) {
    var ddx = touches[0].clientX - touches[1].clientX;
    var ddy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }

  function findTouch(list, id) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  }

  document.addEventListener('touchstart', function (e) {
    if (!state.consentGiven || !e.touches || !e.touches.length) return;
    var now = performance.now();
    if (!touchTrack) {
      var t0 = e.touches[0];
      touchTrack = {
        id: t0.identifier,
        startT: now,
        samples: [{ x: t0.clientX, y: t0.clientY, t: now }],
        target: e.target,
        maxTouches: 1,
        radiusX: t0.radiusX ? Math.round(t0.radiusX) : null,
        radiusY: t0.radiusY ? Math.round(t0.radiusY) : null,
        pinchStart: null,
        pinchLast: null,
        trusted: e.isTrusted,
      };
    }
    touchTrack.maxTouches = Math.max(touchTrack.maxTouches, e.touches.length);
    if (e.touches.length >= 2 && touchTrack.pinchStart === null) touchTrack.pinchStart = pinchDistance(e.touches);
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!touchTrack) return;
    var t = findTouch(e.touches, touchTrack.id);
    if (t && touchTrack.samples.length < MAX_TOUCH_SAMPLES) {
      touchTrack.samples.push({ x: t.clientX, y: t.clientY, t: performance.now() });
    }
    if (e.touches.length >= 2 && touchTrack.pinchStart !== null) touchTrack.pinchLast = pinchDistance(e.touches);
  }, { passive: true });

  function finishTouchGesture(e) {
    if (!touchTrack) return;
    if (e.touches && e.touches.length > 0) return; // wait for the last finger
    var tr = touchTrack;
    touchTrack = null;
    if (e.type === 'touchcancel') return;

    var now = performance.now();
    var endTouch = findTouch(e.changedTouches, tr.id);
    if (endTouch) tr.samples.push({ x: endTouch.clientX, y: endTouch.clientY, t: now });
    var s = tr.samples;
    var first = s[0];
    var last = s[s.length - 1];
    var netDx = last.x - first.x;
    var netDy = last.y - first.y;
    var netPx = Math.sqrt(netDx * netDx + netDy * netDy);
    var durationMs = Math.round(now - tr.startT);
    var i;

    if (tr.maxTouches > 1) {
      var scale = tr.pinchStart && tr.pinchLast ? tr.pinchLast / tr.pinchStart : null;
      var gesture = scale !== null && Math.abs(scale - 1) > 0.15 ? 'pinch'
        : (netPx >= SWIPE_MIN_PX ? 'multi_finger_pan' : 'multi_finger_tap');
      pushEvent({ type: 'multi_touch', maxTouches: tr.maxTouches, gesture: gesture, pinchScale: round(scale, 3), durationMs: durationMs });
      return;
    }

    if (netPx >= SWIPE_MIN_PX) {
      var velocities = [];
      for (i = 1; i < s.length; i++) {
        var dt = s[i].t - s[i - 1].t;
        if (dt <= 0) continue;
        var vx = s[i].x - s[i - 1].x;
        var vy = s[i].y - s[i - 1].y;
        velocities.push(Math.sqrt(vx * vx + vy * vy) / dt);
      }
      var peak = velocities.length ? Math.max.apply(null, velocities) : null;
      var tail = velocities.slice(-3);
      var endV = tail.length ? tail.reduce(function (a, b) { return a + b; }, 0) / tail.length : null;
      var direction = Math.abs(netDx) > Math.abs(netDy) ? (netDx > 0 ? 'right' : 'left') : (netDy > 0 ? 'down' : 'up');
      pushEvent({
        type: 'swipe',
        direction: direction,
        distancePx: Math.round(netPx),
        durationMs: durationMs,
        avgVelocity: durationMs > 0 ? round(netPx / durationMs, 3) : null,
        peakVelocity: round(peak, 3),
        endVelocity: round(endV, 3),
        decelRatio: peak ? round(endV / peak, 3) : null,  // ~0 = natural fling slow-down, ~1 = constant speed
        sampleCount: s.length,
        isTrusted: e.isTrusted,
      });
      return;
    }

    var maxMove = 0;
    for (i = 1; i < s.length; i++) {
      var mdx = s[i].x - first.x;
      var mdy = s[i].y - first.y;
      maxMove = Math.max(maxMove, Math.sqrt(mdx * mdx + mdy * mdy));
    }
    if (maxMove > TAP_MAX_MOVE_PX) return; // a short drag, not a tap

    // Tremor: spread of the contact point while the finger is "still".
    var jitterPx = null;
    if (s.length >= 3) {
      var xs = s.map(function (p) { return p.x; });
      var ys = s.map(function (p) { return p.y; });
      var sxs = summarize(xs);
      var sys = summarize(ys);
      jitterPx = round(Math.sqrt(sxs.std * sxs.std + sys.std * sys.std), 2);
    }

    var offsetXPx = null, offsetYPx = null, offsetNorm = null, targetTag = null;
    var node = tr.target && tr.target.closest ? tr.target.closest(TAP_TARGET_SELECTOR) : null;
    if (node && node.getBoundingClientRect) {
      var r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        offsetXPx = Math.round(first.x - (r.left + r.width / 2));
        offsetYPx = Math.round(first.y - (r.top + r.height / 2));
        var nx = offsetXPx / (r.width / 2);
        var ny = offsetYPx / (r.height / 2);
        offsetNorm = round(Math.sqrt(nx * nx + ny * ny), 3);
        targetTag = node.tagName;
      }
    }

    pushEvent({
      type: 'touch_tap',
      field: fieldIdFor(node || tr.target) || null,
      tag: targetTag,
      durationMs: durationMs,
      offsetXPx: offsetXPx,
      offsetYPx: offsetYPx,
      offsetNorm: offsetNorm,
      jitterPx: jitterPx,
      jitterSampleCount: s.length,
      radiusX: tr.radiusX,
      radiusY: tr.radiusY,
      isTrusted: e.isTrusted,
    });
  }

  document.addEventListener('touchend', finishTouchGesture, { passive: true });
  document.addEventListener('touchcancel', finishTouchGesture, { passive: true });

  // ---------- 6f. Shift key vs Caps Lock ----------
  var shiftDownAt = null;

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Shift') { if (shiftDownAt === null) shiftDownAt = performance.now(); return; }
    if (e.key.length !== 1) return;
    var isUpperCase = e.key >= 'A' && e.key <= 'Z';
    if (!isUpperCase) return;
    var field = fieldIdFor(e.target) || null;
    var capsLockOn = e.getModifierState ? e.getModifierState('CapsLock') : false;
    var shiftHeld = e.shiftKey;
    if (shiftHeld && !capsLockOn) {
      pushEvent({ type: 'shift_pattern', method: 'shift_held', field: field, shiftHoldMs: shiftDownAt !== null ? Math.round(performance.now() - shiftDownAt) : null });
    } else if (capsLockOn && !shiftHeld) {
      pushEvent({ type: 'shift_pattern', method: 'capslock', field: field, shiftHoldMs: null });
    }
  }, { passive: true });

  document.addEventListener('keyup', function (e) {
    if (e.key === 'Shift') shiftDownAt = null;
  }, { passive: true });

  // ---------- 7. Scroll ----------
  var lastScrollSample = 0;
  document.addEventListener('scroll', function () {
    var now = performance.now();
    if (now - lastScrollSample < 100) return;
    lastScrollSample = now;
    pushEvent({ type: 'scroll', y: window.scrollY });
  }, { passive: true });

  // ---------- 8. Focus / blur ----------
  ['focus', 'blur'].forEach(function (evtName) {
    document.addEventListener(evtName, function (e) {
      var field = fieldIdFor(e.target);
      if (!field) return;
      pushEvent({ type: evtName, field: field });
    }, true);
  });

  // ---------- 8b. Form interaction signals ----------
  var fieldFocusSequence = [];
  var fieldFocusStartTimes = Object.create(null);
  var fieldTimeAccumulator = Object.create(null);
  var currentFocusedField = null;

  function onFieldFocus(field) {
    if (!field) return;
    fieldFocusSequence.push(field);
    fieldFocusStartTimes[field] = performance.now();
    currentFocusedField = field;
    if (!fieldTimeAccumulator[field]) {
      fieldTimeAccumulator[field] = { totalMs: 0, focusCount: 0 };
    }
    fieldTimeAccumulator[field].focusCount += 1;
  }

  function onFieldBlur(field) {
    if (!field) return;
    var startTime = fieldFocusStartTimes[field];
    if (startTime !== undefined) {
      var spentMs = Math.round(performance.now() - startTime);
      if (fieldTimeAccumulator[field]) {
        fieldTimeAccumulator[field].totalMs += spentMs;
      }
      delete fieldFocusStartTimes[field];
    }
    currentFocusedField = null;
    var acc = fieldTimeAccumulator[field];
    if (acc) {
      pushEvent({
        type: 'field_time_spent',
        field: field,
        focusCount: acc.focusCount,
        totalTimeMs: acc.totalMs,
        avgTimePerFocusMs: acc.focusCount > 0 ? Math.round(acc.totalMs / acc.focusCount) : 0,
      });
    }
  }

  function emitFocusOrder() {
    if (fieldFocusSequence.length < 2) return;
    var seen = [];
    var jumpCount = 0;
    var isLinear = true;
    for (var i = 0; i < fieldFocusSequence.length; i++) {
      var f = fieldFocusSequence[i];
      if (seen.indexOf(f) !== -1) {
        jumpCount++;
        isLinear = false;
      } else {
        seen.push(f);
      }
    }
    pushEvent({
      type: 'field_focus_order',
      sequence: fieldFocusSequence.slice(),
      totalFields: seen.length,
      isLinear: isLinear,
      jumpCount: jumpCount,
    });
  }

  document.addEventListener('focus', function (e) {
    var field = fieldIdFor(e.target);
    if (!field) return;
    onFieldFocus(field);
    emitFocusOrder();
  }, true);

  document.addEventListener('blur', function (e) {
    var field = fieldIdFor(e.target);
    if (!field) return;
    onFieldBlur(field);
  }, true);

  // ---------- 8c. Time from page load to first field interaction ----------
  var firstFieldInteractionDone = false;

  function isEditableField(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/i.test(el.type || '');
  }

  function markFirstFieldInteraction(target, via) {
    if (firstFieldInteractionDone || !state.consentGiven || !isEditableField(target)) return;
    var field = fieldIdFor(target);
    if (!field) return;
    firstFieldInteractionDone = true;
    state.formInteracted = true;
    pushCriticalEvent({
      type: 'first_field_interaction',
      field: field,
      fieldKind: classifyField(target),
      via: via,
      timeFromLoadMs: Math.round(Date.now() - pageLoadTime),
      timeFromInitMs: Math.round(performance.now() - state.startTime),
      mouseMovedFirst: firstMouseMoveDone,
      isTrusted: true,
    });
  }

  document.addEventListener('focus', function (e) { markFirstFieldInteraction(e.target, 'focus'); }, true);

  // ---------- 8d. Field corrections: cleared and retyped ----------
  // Tracks value *length* only — field contents are never read or sent.
  //   field_cleared      value went from >= 2 chars to empty
  //   field_retyped      first input after a clear
  //   field_bulk_insert  >3 chars appeared in one input event without a paste
  //                      (autofill, password manager, or script injection)
  var FIELD_CLEAR_MIN_LEN = 2;
  var BULK_INSERT_MIN_CHARS = 4;
  var fieldValueState = Object.create(null);

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!isEditableField(t) || typeof t.value !== 'string') return;
    var field = fieldIdFor(t);
    if (!field) return;
    markFirstFieldInteraction(t, 'input');
    state.formInteracted = true;
    if (state.formSubmitted) state.formSubmitted = false; // user is editing again after a submit

    var len = t.value.length;
    var fs = fieldValueState[field];
    if (!fs) fs = fieldValueState[field] = { lastLen: 0, clearedAt: null, clearCount: 0, retypeCount: 0 };
    var now = performance.now();
    var inputType = e.inputType || null;

    if (len === 0 && fs.lastLen >= FIELD_CLEAR_MIN_LEN) {
      fs.clearCount += 1;
      fs.clearedAt = now;
      pushEvent({ type: 'field_cleared', field: field, clearedLength: fs.lastLen, method: inputType, clearCount: fs.clearCount, isTrusted: e.isTrusted });
    } else if (fs.clearedAt !== null && fs.lastLen === 0 && len > 0) {
      fs.retypeCount += 1;
      pushEvent({ type: 'field_retyped', field: field, retypeCount: fs.retypeCount, msSinceClear: Math.round(now - fs.clearedAt), inputType: inputType });
      fs.clearedAt = null;
    }

    if (len - fs.lastLen >= BULK_INSERT_MIN_CHARS && inputType !== 'insertFromPaste' && inputType !== 'insertFromDrop') {
      pushEvent({ type: 'field_bulk_insert', field: field, fieldKind: classifyField(t), charsAdded: len - fs.lastLen, inputType: inputType, isTrusted: e.isTrusted });
    }
    fs.lastLen = len;
  }, true);

  // ---------- 8e. Password visibility toggle (eye icon) ----------
  // Eye icons work by flipping input.type between "password" and "text", so a
  // MutationObserver on the type attribute catches every implementation.
  var passwordToggleCount = 0;

  function installPasswordToggleWatcher() {
    if (typeof MutationObserver !== 'function' || !document.documentElement) return;
    var observer = new MutationObserver(function (mutations) {
      if (!state.consentGiven) return;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var el = m.target;
        if (m.attributeName !== 'type' || !el || el.tagName !== 'INPUT') continue;
        var oldType = (m.oldValue || '').toLowerCase();
        var newType = (el.type || '').toLowerCase();
        var visible;
        if (oldType === 'password' && newType !== 'password') visible = true;
        else if (newType === 'password' && oldType && oldType !== 'password') visible = false;
        else continue;
        passwordToggleCount += 1;
        pushEvent({
          type: 'password_visibility_toggle',
          field: fieldIdFor(el) || 'password',
          visible: visible,
          toggleCount: passwordToggleCount,
          hasValue: !!el.value,
          timeFromLoadMs: Math.round(Date.now() - pageLoadTime),
        });
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['type'], attributeOldValue: true, subtree: true });
  }

  // ---------- 8f. Per-field typing summary (for baseline drift) ----------
  // Emitted on blur. The backend compares charsPerMinute / hold / flight to
  // the user's own historical averages (delta-from-baseline is server-side).
  var TYPING_MAX_SAMPLES = 200;
  var TYPING_PAUSE_MS = 3000; // flights longer than this are pauses, not rhythm

  function recordTypingStat(field, holdMs, flightMs, key, fieldKind) {
    if (!field) return;
    var ts = state.typingStatsByField[field];
    if (!ts) {
      ts = state.typingStatsByField[field] = {
        fieldKind: fieldKind, holds: [], flights: [], keyCount: 0, charCount: 0, correctionCount: 0,
        firstAt: performance.now() - holdMs, lastAt: null,
      };
    }
    ts.keyCount += 1;
    if (key && key.length === 1) ts.charCount += 1;
    if (key === 'Backspace' || key === 'Delete') ts.correctionCount += 1;
    ts.lastAt = performance.now();
    if (ts.holds.length < TYPING_MAX_SAMPLES) ts.holds.push(holdMs);
    if (flightMs !== null && flightMs < TYPING_PAUSE_MS && ts.flights.length < TYPING_MAX_SAMPLES) ts.flights.push(flightMs);
  }

  function emitTypingSummary(field) {
    var ts = state.typingStatsByField[field];
    delete state.typingStatsByField[field];
    if (!ts || ts.charCount < 3) return;
    var activeMs = ts.lastAt - ts.firstAt;
    var hold = summarize(ts.holds);
    var flight = summarize(ts.flights);
    pushEvent({
      type: 'typing_summary',
      field: field,
      fieldKind: ts.fieldKind,
      keyCount: ts.keyCount,
      charCount: ts.charCount,
      correctionCount: ts.correctionCount,
      correctionRate: round(ts.correctionCount / ts.keyCount, 3),
      charsPerMinute: activeMs > 0 ? Math.round(ts.charCount / (activeMs / 60000)) : null,
      avgHoldMs: hold ? hold.mean : null,
      stdHoldMs: hold ? hold.std : null,
      avgFlightMs: flight ? flight.mean : null,
      stdFlightMs: flight ? flight.std : null,
      medianFlightMs: flight ? flight.median : null,
    });
  }

  document.addEventListener('blur', function (e) {
    var field = fieldIdFor(e.target);
    if (field) emitTypingSummary(field);
  }, true);

  preFlushHooks.push(function () {
    Object.keys(state.typingStatsByField).forEach(emitTypingSummary);
  });

  // ---------- 8g. Form submit, abandonment and return ----------
  // Abandon = the page is unloaded after the user touched a field but before
  // a submit. The count persists in localStorage (30 min TTL) so the next
  // visit can emit form_return with how many times they walked away.
  // SPA logins that never fire a native submit should call
  // XyliumBF.markFormSubmitted() or XyliumBF.reportLoginResult().
  var ABANDON_KEY = 'xylium_abandon_' + config.tenantId;
  var ABANDON_TTL_MS = 30 * 60 * 1000;
  var abandonRecorded = false;

  function markFormSubmitted(source) {
    if (state.formSubmitted || !state.consentGiven) return;
    state.formSubmitted = true;
    removeStore(ABANDON_KEY);
    pushCriticalEvent({
      type: 'form_submit',
      source: source || 'api',
      hadInteraction: state.formInteracted,
      timeFromLoadMs: Math.round(Date.now() - pageLoadTime),
    });
  }

  document.addEventListener('submit', function () { markFormSubmitted('submit_event'); }, true);

  function recordAbandonIfNeeded() {
    if (abandonRecorded || !state.consentGiven || !state.formInteracted || state.formSubmitted) return;
    abandonRecorded = true;
    var prev = readStore(ABANDON_KEY);
    var prevCount = prev && Date.now() - prev.at < ABANDON_TTL_MS ? prev.count : 0;
    var rec = { count: prevCount + 1, at: Date.now(), sessionId: state.sessionId };
    writeStore(ABANDON_KEY, rec);
    pushCriticalEvent({
      type: 'form_abandon',
      abandonCount: rec.count,
      fieldsTouched: Object.keys(fieldTimeAccumulator).length,
      lastField: currentFocusedField,
      timeOnPageMs: Math.round(Date.now() - pageLoadTime),
    });
  }

  preFlushHooks.push(function (reason) { if (reason === 'pagehide') recordAbandonIfNeeded(); });

  function checkFormReturn() {
    var rec = readStore(ABANDON_KEY);
    if (!rec || !rec.at) return;
    var awayMs = Date.now() - rec.at;
    if (awayMs > ABANDON_TTL_MS) { removeStore(ABANDON_KEY); return; }
    pushCriticalEvent({
      type: 'form_return',
      abandonCount: rec.count,
      awayMs: awayMs,
      sameSession: rec.sessionId === state.sessionId,
    });
  }

  // ---------- 9. Visibility + resize ----------
  document.addEventListener('visibilitychange', function () {
    pushEvent({ type: 'visibilitychange', state: document.visibilityState });
  });
  window.addEventListener('resize', function () {
    pushEvent({ type: 'resize', w: window.innerWidth, h: window.innerHeight });
  });

  // ---------- 9b. Browser back-button usage ----------
  var backCount = 0;
  var pageArrivalTime = performance.now();
  var lastPopDirection = null;
  var wentBackAt = null;

  window.addEventListener('popstate', function (e) {
    var now = performance.now();
    var timeOnPageMs = Math.round(now - pageArrivalTime);
    var isPanicBack = timeOnPageMs < 2000;
    var returnedAfterBack = false;

    if (wentBackAt !== null && lastPopDirection === 'back') {
      returnedAfterBack = true;
      lastPopDirection = 'forward';
    } else {
      backCount += 1;
      lastPopDirection = 'back';
      wentBackAt = now;
    }

    pushEvent({
      type: 'back_navigation',
      backCount: backCount,
      timeOnPageMs: timeOnPageMs,
      isPanicBack: isPanicBack,
      returnedAfterBack: returnedAfterBack,
    });

    pageArrivalTime = now;
  });

  // ---------- 9c. Time of day (normalized to user's local timezone) ----------
  // Called from grantConsent() so consent is always given before pushing
  function captureTimeContext() {
    var now = new Date();
    var localHour      = now.getHours();
    var localMinute    = now.getMinutes();
    var localDayOfWeek = now.getDay();
    var isWeekend      = localDayOfWeek === 0 || localDayOfWeek === 6;
    var DAY_NAMES      = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    function getTimeSlot(hour) {
      if (hour >= 0  && hour < 5)  return 'late_night';
      if (hour >= 5  && hour < 8)  return 'early_morning';
      if (hour >= 8  && hour < 12) return 'morning';
      if (hour >= 12 && hour < 14) return 'midday';
      if (hour >= 14 && hour < 17) return 'afternoon';
      if (hour >= 17 && hour < 21) return 'evening';
      return 'night';
    }

    var tzOffsetMinutes = -now.getTimezoneOffset();
    var tzName = 'unknown';
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}

    pushCriticalEvent({
      type: 'time_context',
      localHour:       localHour,
      localMinute:     localMinute,
      localDayOfWeek:  localDayOfWeek,
      localDayName:    DAY_NAMES[localDayOfWeek],
      timeSlot:        getTimeSlot(localHour),
      isWeekend:       isWeekend,
      tzName:          tzName,
      tzOffsetMinutes: tzOffsetMinutes,
      utcHour:         now.getUTCHours(),
    });
  }

  // ---------- 9d. Page entry method ----------
  // Called from grantConsent() so consent is always given before pushing
  function capturePageEntryMethod() {
    var navType = null;
    if (window.performance && window.performance.getEntriesByType) {
      var navEntries = window.performance.getEntriesByType('navigation');
      if (navEntries.length > 0) navType = navEntries[0].type;
    } else if (window.performance && window.performance.navigation) {
      var typeMap = { 0: 'navigate', 1: 'reload', 2: 'back_forward' };
      navType = typeMap[window.performance.navigation.type] || 'other';
    }
    if (!navType) return;
    pushCriticalEvent({
      type: 'page_entry_method',
      navType: navType,
      isBackForward: navType === 'back_forward',
    });
  }

  // ---------- 9e. Referrer chain ----------
  // Only the referrer *hostname* is sent, never the full URL. Note that
  // native mail apps and many redirectors strip the referrer, so "direct"
  // includes some email clicks; utm_medium helps disambiguate.
  var SEARCH_HOST_RE = /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex|ecosia|startpage)\.[a-z.]+$|^search\.brave\.com$/;
  var WEBMAIL_HOST_RE = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.aol\.com|mail\.proton\.me|mail\.zoho\.[a-z]+|icloud\.com)$/;
  var SOCIAL_HOST_RE = /(^|\.)(facebook\.com|fb\.me|instagram\.com|linkedin\.com|lnkd\.in|twitter\.com|x\.com|t\.co|reddit\.com|whatsapp\.com|wa\.me|t\.me|telegram\.org|youtube\.com)$/;
  var SHORTENER_HOST_RE = /^(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly|shorturl\.at|rb\.gy|tiny\.cc|s\.id)$/;

  function captureReferrerContext() {
    var refHost = null;
    var sameOrigin = false;
    try {
      if (document.referrer) {
        var ru = new URL(document.referrer);
        refHost = ru.hostname.toLowerCase();
        sameOrigin = ru.origin === location.origin;
      }
    } catch (e) { /* malformed referrer */ }

    var utmSource = null, utmMedium = null;
    try {
      var qs = new URLSearchParams(location.search);
      utmSource = qs.get('utm_source') ? qs.get('utm_source').slice(0, 64) : null;
      utmMedium = qs.get('utm_medium') ? qs.get('utm_medium').slice(0, 64) : null;
    } catch (e) { /* ignore */ }

    var category;
    if (!refHost) category = utmMedium && /e-?mail|newsletter/i.test(utmMedium) ? 'email' : 'direct';
    else if (sameOrigin) category = 'internal';
    else if (WEBMAIL_HOST_RE.test(refHost) || (utmMedium && /e-?mail|newsletter/i.test(utmMedium))) category = 'email';
    else if (SEARCH_HOST_RE.test(refHost)) category = 'search';
    else if (SOCIAL_HOST_RE.test(refHost)) category = 'social';
    else if (SHORTENER_HOST_RE.test(refHost)) category = 'shortener';
    else category = 'external';

    var reasons = [];
    if (refHost && !sameOrigin) {
      if (SHORTENER_HOST_RE.test(refHost)) reasons.push('url_shortener');
      if (/(^|\.)xn--/.test(refHost)) reasons.push('punycode_host');
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(refHost) || refHost.charAt(0) === '[') reasons.push('ip_literal_host');
      // Look-alike: referrer embeds our brand label but is a different domain
      // (e.g. acme-login.net referring to acme.com). Heuristic only.
      var labels = location.hostname.toLowerCase().split('.');
      var brand = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
      if (brand && brand.length >= 4 && refHost.indexOf(brand) !== -1 &&
          refHost !== location.hostname && refHost.slice(-(brand.length + 1 + labels[labels.length - 1].length)) !== brand + '.' + labels[labels.length - 1]) {
        reasons.push('lookalike_domain');
      }
    }

    var redirectCount = null;
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) redirectCount = nav.redirectCount;
    } catch (e) { /* ignore */ }

    pushCriticalEvent({
      type: 'referrer_context',
      category: category,
      referrerHost: refHost,
      sameOrigin: sameOrigin,
      utmSource: utmSource,
      utmMedium: utmMedium,
      redirectCount: redirectCount,
      historyLength: window.history ? window.history.length : null,
      isSuspicious: reasons.length > 0,
      suspiciousReasons: reasons,
    });
  }

  // ---------- 9f. Tab / window focus-blur mid-login ----------
  // window blur fires on app/tab switch. It also fires when focus moves into
  // an iframe (e.g. a captcha), so activeIsIframe lets the backend filter those.
  var windowBlurAt = null;
  var midLoginSwitchCount = 0;
  var hiddenAt = null;

  function isMidLogin() { return state.formInteracted && !state.formSubmitted; }

  window.addEventListener('blur', function () {
    if (!state.consentGiven) return;
    windowBlurAt = performance.now();
    var active = document.activeElement;
    if (isMidLogin()) midLoginSwitchCount += 1;
    pushEvent({
      type: 'window_blur',
      midLogin: isMidLogin(),
      activeField: fieldIdFor(active) || null,
      activeIsIframe: !!(active && active.tagName === 'IFRAME'),
      midLoginSwitchCount: midLoginSwitchCount,
    });
  });

  window.addEventListener('focus', function () {
    if (!state.consentGiven || windowBlurAt === null) return;
    var awayMs = Math.round(performance.now() - windowBlurAt);
    windowBlurAt = null;
    pushEvent({ type: 'window_focus', awayMs: awayMs, midLogin: isMidLogin(), returnedToField: fieldIdFor(document.activeElement) || null });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { hiddenAt = performance.now(); return; }
    if (hiddenAt === null) return;
    pushEvent({ type: 'visibility_away', hiddenMs: Math.round(performance.now() - hiddenAt), midLogin: isMidLogin() });
    hiddenAt = null;
  });

  // ---------- 10. Paste / copy ----------
  document.addEventListener('copy', function (e) {
    var field = fieldIdFor(e.target);
    if (!field) return;
    pushEvent({ type: 'copy', field: field });
  });

  document.addEventListener('paste', function (e) {
    var field = classifyField(e.target);
    if (!field) return;
    var pastedText = '';
    if (e.clipboardData && e.clipboardData.getData) pastedText = e.clipboardData.getData('text/plain') || '';
    pushEvent({
      type: 'paste',
      field: field,
      isPasswordField: e.target.type === 'password',
      pastedLength: pastedText.length,
      pastedNonPrintable: /[\x00-\x1F]/.test(pastedText),
      pastedHasWhitespace: /\s/.test(pastedText),
      pastedFromKeyboard: !e.isTrusted, // NOTE: misnamed in v2 — true actually means "synthetic event". Kept for wire compatibility; use isTrusted.
      isTrusted: e.isTrusted,
    });
  });

  // ---------- 11. Device snapshot ----------
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

  // ---------- 11c. Battery status ----------
  // navigator.getBattery() is only available on secure contexts in some
  // browsers (and removed entirely in others, e.g. Firefox/Safari), so this
  // must be feature-detected and is best-effort only.
  function captureBatterySnapshot() {
    if (!state.consentGiven) return;
    if (typeof navigator.getBattery !== 'function') return;
    navigator.getBattery().then(function (battery) {
      if (!state.consentGiven) return; // consent may have been revoked while the promise was pending
      pushCriticalEvent({
        type: 'battery_snapshot',
        charging: battery.charging,
        level: Math.round(battery.level * 100),
        chargingTime: isFinite(battery.chargingTime) ? battery.chargingTime : null,
        dischargingTime: isFinite(battery.dischargingTime) ? battery.dischargingTime : null,
      });
    }).catch(function () { /* battery API blocked or unavailable — ignore */ });
  }

  // ---------- 11d. Network / connection info ----------
  // navigator.connection is non-standard (Chromium-only today) so this is
  // also best-effort and simply omitted where unsupported.
  function captureConnectionSnapshot() {
    if (!state.consentGiven) return;
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return;
    pushCriticalEvent({
      type: 'connection_snapshot',
      effectiveType: conn.effectiveType || null,
      downlinkMbps: typeof conn.downlink === 'number' ? conn.downlink : null,
      rttMs: typeof conn.rtt === 'number' ? conn.rtt : null,
      saveData: !!conn.saveData,
    });
    if (typeof conn.addEventListener === 'function') {
      conn.addEventListener('change', function () {
        if (!state.consentGiven) return;
        pushEvent({
          type: 'connection_change',
          effectiveType: conn.effectiveType || null,
          downlinkMbps: typeof conn.downlink === 'number' ? conn.downlink : null,
          rttMs: typeof conn.rtt === 'number' ? conn.rtt : null,
          saveData: !!conn.saveData,
        });
      });
    }
  }


    // ---------- 11b. Plugin / MIME type list ----------
  // Captures the browser's installed plugins and supported MIME types.
  // This is a classic fingerprinting signal — real browsers have a rich,
  // consistent plugin list (PDF viewer, etc). Headless browsers and bots
  // often have an empty or suspiciously minimal plugin list.
  //
  // Modern Chrome/Edge/Firefox deliberately return a reduced, generic plugin
  // list for privacy — so we don't rely on this alone, but it's still useful:
  //   - navigator.plugins.length === 0 is a strong headless/bot signal
  //   - The exact plugin names+order act as a stable per-browser fingerprint
  //   - Automation tools (Puppeteer/Selenium) often show telltale gaps
  //
  // Wire format:
  //   { type: 'plugin_snapshot',
  //     pluginCount,        -- navigator.plugins.length
  //     mimeTypeCount,      -- navigator.mimeTypes.length
  //     pluginNames,        -- array of plugin names (capped, sorted)
  //     mimeTypes,          -- array of mime type strings (capped, sorted)
  //     hasPdfViewer,       -- true if a PDF-related plugin/mimetype exists
  //     pluginsHash }       -- simple hash of the full list for fast comparison

  function capturePluginSnapshot() {
    var pluginNames = [];
    var mimeTypes = [];

    try {
      if (navigator.plugins && navigator.plugins.length) {
        for (var i = 0; i < navigator.plugins.length; i++) {
          pluginNames.push(navigator.plugins[i].name);
        }
      }
    } catch (e) { /* some browsers block enumeration entirely */ }

    try {
      if (navigator.mimeTypes && navigator.mimeTypes.length) {
        for (var j = 0; j < navigator.mimeTypes.length; j++) {
          mimeTypes.push(navigator.mimeTypes[j].type);
        }
      }
    } catch (e) { /* ignore */ }

    pluginNames.sort();
    mimeTypes.sort();

    // Cap to avoid oversized payloads on browsers with long lists
    var MAX_ITEMS = 30;
    var cappedPlugins = pluginNames.slice(0, MAX_ITEMS);
    var cappedMimes = mimeTypes.slice(0, MAX_ITEMS);

    var hasPdfViewer =
      pluginNames.some(function (n) { return /pdf/i.test(n); }) ||
      mimeTypes.some(function (m) { return /pdf/i.test(m); });

    // Simple djb2 hash of the combined list — cheap way to compare
    // fingerprints across sessions without sending the full list every time
    var raw = cappedPlugins.join(',') + '|' + cappedMimes.join(',');
    var hash = 5381;
    for (var k = 0; k < raw.length; k++) {
      hash = (hash << 5) + hash + raw.charCodeAt(k);
      hash = hash & hash;
    }

    pushCriticalEvent({
      type: 'plugin_snapshot',
      pluginCount: pluginNames.length,
      mimeTypeCount: mimeTypes.length,
      pluginNames: cappedPlugins,
      mimeTypes: cappedMimes,
      hasPdfViewer: hasPdfViewer,
      pluginsHash: 'ph_' + Math.abs(hash),
    });
  }

  // ---------- 11e. Composite fingerprint ----------
  // Emitted once canvas, WebGL, fonts and audio have all reported. Parts that
  // are randomized by the browser (Brave, Firefox RFP, Safari private) are
  // marked so the backend doesn't treat a changing hash as a new device.
  var COMPOSITE_PARTS = ['canvas', 'webgl', 'fonts', 'audio'];

  function setFingerprintPart(name, value) {
    state.fingerprintParts[name] = value;
    if (state.compositeSent) return;
    for (var i = 0; i < COMPOSITE_PARTS.length; i++) {
      if (!(COMPOSITE_PARTS[i] in state.fingerprintParts)) return;
    }
    state.compositeSent = true;
    var parts = {};
    var unstable = [];
    var raw = COMPOSITE_PARTS.map(function (p) {
      parts[p] = state.fingerprintParts[p];
      if (parts[p] === 'randomized' || parts[p] === 'na') unstable.push(p);
      return p + ':' + parts[p];
    }).join('|') + '|' + screen.width + 'x' + screen.height + '|' + (navigator.hardwareConcurrency || 'na') + '|' + navigator.platform;
    pushCriticalEvent({ type: 'composite_fingerprint', compositeHash: 'cf_' + hashString(raw), parts: parts, unavailableOrUnstable: unstable });
  }

  // ---------- 11f. Canvas fingerprint ----------
  function renderCanvasProbe() {
    var c = document.createElement('canvas');
    c.width = 280;
    c.height = 60;
    var ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.font = '11pt "Times New Roman"';
    ctx.fillText('Xylium,bf <canvas> 1.0 \ud83d\ude03', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.font = '18pt Arial';
    ctx.fillText('Xylium,bf <canvas> 1.0 \ud83d\ude03', 4, 45);
    ctx.globalCompositeOperation = 'multiply';
    var colors = ['#f2f', '#2ff', '#ff2'];
    for (var i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.arc(40 + i * 25, 30, 25, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.fill();
    }
    return c.toDataURL();
  }

  function captureCanvasFingerprint() {
    var a = null, b = null;
    try { a = renderCanvasProbe(); b = renderCanvasProbe(); } catch (e) { /* blocked */ }
    if (!a) {
      pushCriticalEvent({ type: 'canvas_fingerprint', supported: false });
      setFingerprintPart('canvas', 'na');
      return;
    }
    var randomized = a !== b; // anti-fingerprinting noise differs per render
    var hash = hashString(a);
    pushCriticalEvent({ type: 'canvas_fingerprint', supported: true, canvasHash: 'cv_' + hash, isRandomized: randomized, dataLength: a.length });
    setFingerprintPart('canvas', randomized ? 'randomized' : hash);
  }

  // ---------- 11g. WebGL renderer / vendor ----------
  function captureWebglFingerprint() {
    var gl = null;
    try {
      var c = document.createElement('canvas');
      gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    } catch (e) { /* ignore */ }
    if (!gl) {
      pushCriticalEvent({ type: 'webgl_fingerprint', supported: false });
      setFingerprintPart('webgl', 'na');
      return;
    }
    var vendor = gl.getParameter(gl.VENDOR);
    var renderer = gl.getParameter(gl.RENDERER);
    var unmaskedVendor = null, unmaskedRenderer = null;
    try {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
    } catch (e) { /* ignore */ }

    function param(name) {
      try {
        var v = gl.getParameter(gl[name]);
        return v && typeof v === 'object' && 'length' in v ? Array.prototype.slice.call(v) : v;
      } catch (e) { return null; }
    }
    var params = {
      maxTextureSize: param('MAX_TEXTURE_SIZE'),
      maxRenderbufferSize: param('MAX_RENDERBUFFER_SIZE'),
      maxViewportDims: param('MAX_VIEWPORT_DIMS'),
      maxVertexAttribs: param('MAX_VERTEX_ATTRIBS'),
      aliasedLineWidthRange: param('ALIASED_LINE_WIDTH_RANGE'),
      shadingLanguageVersion: param('SHADING_LANGUAGE_VERSION'),
    };
    var extensions = gl.getSupportedExtensions() || [];
    var effectiveRenderer = String(unmaskedRenderer || renderer || '');
    var paramsHash = hashString(JSON.stringify(params) + '|' + extensions.slice().sort().join(','));

    pushCriticalEvent({
      type: 'webgl_fingerprint',
      supported: true,
      vendor: vendor,
      renderer: renderer,
      unmaskedVendor: unmaskedVendor,
      unmaskedRenderer: unmaskedRenderer,
      // SwiftShader / llvmpipe = software rendering: typical of headless
      // browsers, VMs and cloud desktops.
      isSoftwareRenderer: /swiftshader|llvmpipe|softpipe|software|offscreen/i.test(effectiveRenderer),
      extensionCount: extensions.length,
      params: params,
      paramsHash: 'gl_' + paramsHash,
    });
    setFingerprintPart('webgl', hashString([vendor, renderer, unmaskedVendor, unmaskedRenderer, paramsHash].join('|')));

    try { var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) { /* ignore */ }
  }

  // ---------- 11h. Installed fonts (canvas measurement) ----------
  // A font counts as installed if text rendered in it measures differently
  // from all three generic fallbacks. Web fonts the page itself loads via
  // @font-face will also show up; Safari and Firefox RFP restrict this list.
  var FONT_PROBE_LIST = [
    'Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
    'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Lucida Console',
    'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Segoe UI Emoji', 'Tahoma',
    'Times New Roman', 'Trebuchet MS', 'Verdana', 'Nirmala UI', 'Mangal', 'Latha', 'MS Gothic', 'SimSun',
    'Malgun Gothic', 'Helvetica', 'Helvetica Neue', 'Menlo', 'Monaco', 'Geneva', 'Optima', 'Futura',
    'Gill Sans', 'Avenir', 'Baskerville', 'Didot', 'Hoefler Text', 'American Typewriter', 'PingFang SC',
    'Hiragino Sans', 'Apple Color Emoji', 'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans',
    'Noto Sans Tamil', 'Noto Color Emoji', 'Cantarell', 'Droid Sans', 'Roboto', 'Fira Sans', 'Source Code Pro',
  ];

  function captureFontFingerprint() {
    var ctx = null;
    try { ctx = document.createElement('canvas').getContext('2d'); } catch (e) { /* ignore */ }
    if (!ctx) {
      pushCriticalEvent({ type: 'font_fingerprint', supported: false });
      setFingerprintPart('fonts', 'na');
      return;
    }
    var SAMPLE = 'mmmmmmmmmmlli10OQ@#WwXx\u0BA4';
    var SIZE = '72px ';
    var bases = ['monospace', 'sans-serif', 'serif'];
    var baseWidths = bases.map(function (b) { ctx.font = SIZE + b; return ctx.measureText(SAMPLE).width; });
    var detected = [];
    for (var i = 0; i < FONT_PROBE_LIST.length; i++) {
      for (var j = 0; j < bases.length; j++) {
        ctx.font = SIZE + '"' + FONT_PROBE_LIST[i] + '", ' + bases[j];
        if (ctx.measureText(SAMPLE).width !== baseWidths[j]) { detected.push(FONT_PROBE_LIST[i]); break; }
      }
    }
    var fontsHash = hashString(detected.join(','));
    pushCriticalEvent({ type: 'font_fingerprint', supported: true, probedCount: FONT_PROBE_LIST.length, detectedCount: detected.length, fonts: detected, fontsHash: 'ft_' + fontsHash });
    setFingerprintPart('fonts', fontsHash);
  }

  // ---------- 11i. Audio context fingerprint ----------
  // Renders an oscillator through a compressor offline (no sound plays, no
  // user gesture needed) and hashes the output. Floating-point differences
  // in the audio stack make this stable per device/browser build.
  function captureAudioFingerprint() {
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) {
      pushCriticalEvent({ type: 'audio_fingerprint', supported: false });
      setFingerprintPart('audio', 'na');
      return;
    }
    var done = false;
    function fail(reason) {
      if (done) return;
      done = true;
      pushCriticalEvent({ type: 'audio_fingerprint', supported: true, failed: reason });
      setFingerprintPart('audio', 'na');
    }
    var timer = setTimeout(function () { fail('timeout'); }, 2000);
    try {
      var ctx = new Ctx(1, 5000, 44100);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50;
      comp.knee.value = 40;
      comp.ratio.value = 12;
      comp.attack.value = 0;
      comp.release.value = 0.25;
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start(0);
      var onRendered = function (buffer) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var data = buffer.getChannelData(0);
        var sum = 0;
        for (var i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
        var audioHash = hashString(Array.prototype.slice.call(data, 4500, 5000).join(','));
        pushCriticalEvent({ type: 'audio_fingerprint', supported: true, sampleSum: round(sum, 8), audioHash: 'au_' + audioHash });
        setFingerprintPart('audio', audioHash);
      };
      ctx.oncomplete = function (ev) { onRendered(ev.renderedBuffer); }; // older Safari
      var p = ctx.startRendering();
      if (p && typeof p.then === 'function') p.then(onRendered).catch(function () { fail('render_error'); });
    } catch (e) {
      clearTimeout(timer);
      fail('exception');
    }
  }

  // ---------- 11j. Language list ----------
  // A spoofed UA/locale often leaves navigator.language, navigator.languages
  // and the Intl locale disagreeing with each other.
  function captureLanguageSignals() {
    var langs = navigator.languages ? Array.prototype.slice.call(navigator.languages, 0, 10) : [];
    var primary = navigator.language || null;
    var intlLocale = null;
    try { intlLocale = Intl.DateTimeFormat().resolvedOptions().locale; } catch (e) { /* ignore */ }
    function base(l) { return l ? String(l).split('-')[0].toLowerCase() : null; }
    pushCriticalEvent({
      type: 'language_snapshot',
      languages: langs,
      languageCount: langs.length,
      primaryLanguage: primary,
      intlLocale: intlLocale,
      primaryMatchesList: langs.length ? langs[0] === primary : null,
      intlMatchesPrimary: intlLocale && primary ? base(intlLocale) === base(primary) : null,
    });
  }

  // ---------- 11k. Do Not Track / Global Privacy Control ----------
  // The DNT/Sec-GPC *headers* are also visible server-side; these are the JS
  // equivalents. NOTE: GPC is a legally recognised opt-out in some
  // jurisdictions (e.g. California) — review with counsel how it should
  // interact with requireConsent.
  function capturePrivacySignals() {
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack || null;
    pushCriticalEvent({
      type: 'privacy_signals',
      doNotTrack: dnt === '1' || dnt === 'yes' ? true : (dnt === '0' || dnt === 'no' ? false : null),
      globalPrivacyControl: typeof navigator.globalPrivacyControl === 'boolean' ? navigator.globalPrivacyControl : null,
      cookieEnabled: navigator.cookieEnabled,
    });
  }

  // ---------- 11l. Network: protocol, DNS / TCP / TLS timing, RTT variance ----------
  // nextHopProtocol tells us h3 / h2 / http/1.1 for the page load. JA3/JA4
  // and TCP fingerprints are not visible to JS and must be computed at the
  // edge / load balancer.
  function captureNetworkTiming() {
    var nav = null;
    try { nav = performance.getEntriesByType('navigation')[0]; } catch (e) { /* ignore */ }
    if (!nav) return;
    function span(a, b) { return a > 0 && b >= a ? round(b - a, 1) : null; }
    var proto = nav.nextHopProtocol || null;
    pushCriticalEvent({
      type: 'network_timing',
      protocol: proto,
      isHttp3: proto ? /^h3/.test(proto) : null,
      isHttp2: proto ? proto === 'h2' : null,
      dnsMs: span(nav.domainLookupStart, nav.domainLookupEnd),
      tcpConnectMs: span(nav.connectStart, nav.connectEnd),
      tlsMs: nav.secureConnectionStart > 0 ? span(nav.secureConnectionStart, nav.connectEnd) : null,
      ttfbMs: span(nav.requestStart, nav.responseStart),
      redirectCount: nav.redirectCount,
      fromCache: nav.transferSize === 0 && nav.decodedBodySize > 0,
    });
  }

  // RTT samples come from our own /collect requests, so no extra traffic.
  // Precise timing needs the API to send `Timing-Allow-Origin: <site origin>`;
  // without it we fall back to total request duration (precise: false).
  var rttSamples = [];
  var RTT_EMIT_EVERY = 5;
  var RTT_KEEP = 20;
  var rttSamplerInstalled = false;

  function installRttSampler() {
    if (rttSamplerInstalled || !config.apiEndpoint || typeof PerformanceObserver !== 'function') return;
    rttSamplerInstalled = true;
    var base = config.apiEndpoint.replace(/\/$/, '');
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (en) {
          if (en.name.indexOf(base) !== 0) return;
          var precise = en.requestStart > 0 && en.responseStart > 0;
          var sample = precise ? en.responseStart - en.requestStart : en.duration;
          if (!(sample > 0)) return;
          rttSamples.push({ v: sample, precise: precise });
          if (rttSamples.length > RTT_KEEP) rttSamples.shift();
          if (rttSamples.length % RTT_EMIT_EVERY !== 0 && rttSamples.length !== RTT_KEEP) return;
          var vals = rttSamples.map(function (s) { return s.v; });
          var st = summarize(vals);
          var jitter = 0;
          for (var i = 1; i < vals.length; i++) jitter += Math.abs(vals[i] - vals[i - 1]);
          pushEvent({
            type: 'rtt_variance',
            sampleCount: st.n,
            precise: rttSamples.every(function (s) { return s.precise; }),
            meanMs: st.mean,
            stdMs: st.std,
            minMs: st.min,
            maxMs: st.max,
            cv: st.cv,
            jitterMs: vals.length > 1 ? round(jitter / (vals.length - 1), 2) : null,
          });
        });
      }).observe({ type: 'resource', buffered: false });
    } catch (e) { /* ignore */ }
  }

  // ---------- 12. Autofill detection ----------
  function installAutofillWatcher() {
    var style = document.createElement('style');
    style.textContent =
      '@keyframes xyliumBFAutofillStart { from {} to {} }\n' +
      'input:-webkit-autofill { animation-name: xyliumBFAutofillStart; animation-duration: 0.001s; }';
    document.head.appendChild(style);
    document.addEventListener('animationstart', function (e) {
      if (e.animationName !== 'xyliumBFAutofillStart') return;
      var target = e.target;
      if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
      var field = classifyField(target);
      if (!field || state.autofillSeen[field]) return;
      state.autofillSeen[field] = true;
      pushCriticalEvent({ type: 'autofill', field: field, fillTimeMs: Math.round(performance.now() - state.startTime) });
    }, true);
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

  // ---------- 14. Geolocation ----------
  var TZ_GEO_MISMATCH_HOURS = 3.5;
  function maybeCaptureGeo() {
    if (!config.captureGeo || !state.consentGiven) return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      pushCriticalEvent({
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
      pushCriticalEvent({
        type: 'tz_geo_consistency',
        tzName: tzName,
        tzOffsetHours: actualOffsetH,
        solarOffsetHours: round(solarOffsetH, 1),
        deltaHours: round(delta, 1),
        isMismatch: delta > TZ_GEO_MISMATCH_HOURS,
      });
    }, function () {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }

  // ---------- 14b. Bot / automation detection ----------
  var AUTOMATION_WINDOW_KEYS = [
    'callPhantom', '_phantom', 'phantom', '__nightmare', 'domAutomation', 'domAutomationController',
    '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium', '__webdriverFunc', '__lastWatirAlert',
    '__lastWatirConfirm', '__lastWatirPrompt', '_WEBDRIVER_ELEM_CACHE', '__playwright__binding__',
    '__pwInitScripts', '__puppeteer_evaluation_script__', 'Cypress',
  ];
  var AUTOMATION_DOCUMENT_KEYS = [
    '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_function', '__webdriver_script_func',
    '__webdriver_script_fn', '__fxdriver_evaluate', '__driver_unwrapped', '__webdriver_unwrapped',
    '__driver_evaluate', '__selenium_unwrapped', '__fxdriver_unwrapped', '$cdc_asdjflasutopfhvcZLmcfl_',
    '$chrome_asyncScriptInfo', '__$webdriverAsyncExecutor',
  ];
  var AUTOMATION_KEY_RE = /^\$?cdc_|\$cdc_|^\$wdc_|^__playwright|^__pw_|^__puppeteer|^__selenium|^__webdriver|^__fxdriver/;

  function detectAutomationArtifacts() {
    var found = [];
    var i;
    for (i = 0; i < AUTOMATION_WINDOW_KEYS.length; i++) {
      try { if (AUTOMATION_WINDOW_KEYS[i] in window) found.push('window.' + AUTOMATION_WINDOW_KEYS[i]); } catch (e) { /* ignore */ }
    }
    for (i = 0; i < AUTOMATION_DOCUMENT_KEYS.length; i++) {
      try { if (AUTOMATION_DOCUMENT_KEYS[i] in document) found.push('document.' + AUTOMATION_DOCUMENT_KEYS[i]); } catch (e) { /* ignore */ }
    }
    try {
      Object.getOwnPropertyNames(window).forEach(function (k) {
        if (AUTOMATION_KEY_RE.test(k) && found.indexOf('window.' + k) === -1) found.push('window.' + k);
      });
      Object.getOwnPropertyNames(document).forEach(function (k) {
        if (AUTOMATION_KEY_RE.test(k) && found.indexOf('document.' + k) === -1) found.push('document.' + k);
      });
    } catch (e) { /* ignore */ }
    ['webdriver', 'selenium', 'driver'].forEach(function (attr) {
      if (document.documentElement && document.documentElement.getAttribute(attr) !== null) found.push('html[' + attr + ']');
    });
    return found;
  }

  function detectHeadlessSignals() {
    var ua = navigator.userAgent || '';
    var signals = [];
    var isChromeUa = /Chrome\//.test(ua);
    if (/HeadlessChrome/i.test(ua)) signals.push('ua_headless');
    var brands = navigator.userAgentData && navigator.userAgentData.brands;
    if (brands && brands.some(function (b) { return /headless/i.test(b.brand); })) signals.push('brand_headless');
    if (isChromeUa && !window.chrome) signals.push('chrome_object_missing');
    if (!navigator.languages || navigator.languages.length === 0) signals.push('no_languages');
    if (window.outerWidth === 0 && window.outerHeight === 0) signals.push('zero_outer_dimensions');
    if (!screen.width || !screen.height) signals.push('zero_screen');
    if (isChromeUa && detectDeviceType() === 'pc' && navigator.plugins && navigator.plugins.length === 0) signals.push('no_plugins_desktop_chrome');
    if (navigator.userAgentData && navigator.userAgentData.platform && navigator.platform &&
        /win/i.test(navigator.userAgentData.platform) !== /win/i.test(navigator.platform)) signals.push('platform_mismatch');
    return signals;
  }

  // Weak signal: when a CDP client (Puppeteer/Playwright) has Runtime.enable
  // active, console.* serialises its argument and triggers the stack getter.
  // An open DevTools window triggers it too, so never block on this alone.
  function detectCdpRuntime() {
    var hit = false;
    try {
      var err = new Error('');
      Object.defineProperty(err, 'stack', { get: function () { hit = true; return ''; } });
      console.debug(err);
    } catch (e) { /* ignore */ }
    return hit;
  }

  function captureAutomationSignals() {
    var artifacts = detectAutomationArtifacts();
    var headless = detectHeadlessSignals();
    var webdriver = navigator.webdriver === true;
    var cdp = detectCdpRuntime();
    pushCriticalEvent({
      type: 'automation_signals',
      webdriver: webdriver,
      artifacts: artifacts,
      headlessSignals: headless,
      cdpRuntimeDetected: cdp,
      indicatorCount: (webdriver ? 1 : 0) + artifacts.length + headless.length,
    });

    // Headless Chrome classically reports Notification.permission "denied"
    // while the Permissions API says "prompt" — impossible in a real browser.
    try {
      if (navigator.permissions && navigator.permissions.query && typeof Notification !== 'undefined') {
        navigator.permissions.query({ name: 'notifications' }).then(function (p) {
          if (Notification.permission === 'denied' && p.state === 'prompt') {
            pushCriticalEvent({ type: 'automation_signal', signal: 'notification_permission_inconsistent' });
          }
        }).catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
  }

  // CSS media query anomalies: the UA claims one kind of device but the
  // rendering engine reports input hardware / screen that don't match.
  function captureMediaQuerySignals() {
    if (!window.matchMedia) return;
    function mq(q) { try { return window.matchMedia(q).matches; } catch (e) { return null; } }
    var pointer = mq('(pointer: fine)') ? 'fine' : mq('(pointer: coarse)') ? 'coarse' : mq('(pointer: none)') ? 'none' : 'unknown';
    var hover = mq('(hover: hover)');
    var anyCoarse = mq('(any-pointer: coarse)');
    var touchPoints = navigator.maxTouchPoints || 0;
    var deviceType = detectDeviceType();
    var anomalies = [];
    if ((deviceType === 'mobile' || deviceType === 'tablet') && pointer === 'fine' && !anyCoarse && touchPoints === 0) anomalies.push('mobile_ua_without_touch');
    if (deviceType === 'pc' && pointer === 'coarse' && touchPoints === 0) anomalies.push('coarse_pointer_without_touch');
    if (deviceType === 'pc' && pointer === 'none') anomalies.push('no_pointer_device');
    if (mq('(device-width: ' + screen.width + 'px)') === false && mq('(device-height: ' + screen.height + 'px)') === false) anomalies.push('screen_size_mismatch');
    pushCriticalEvent({
      type: 'media_query_snapshot',
      pointer: pointer,
      hover: hover,
      anyPointerCoarse: anyCoarse,
      maxTouchPoints: touchPoints,
      colorScheme: mq('(prefers-color-scheme: dark)') ? 'dark' : 'light',
      reducedMotion: mq('(prefers-reduced-motion: reduce)'),
      forcedColors: mq('(forced-colors: active)'),
      colorGamut: mq('(color-gamut: p3)') ? 'p3' : mq('(color-gamut: srgb)') ? 'srgb' : null,
      hdr: mq('(dynamic-range: high)'),
      anomalies: anomalies,
    });
  }

  // Event integrity: isTrusted (synthetic events from dispatchEvent are
  // false) and timestamp precision. Chrome gives sub-ms event.timeStamp, so
  // key intervals landing on exact multiples of 10ms are a scripted-delay
  // signature. Firefox coarsens to 1ms, so compare integerTimestampRatio
  // against the browser family server-side before scoring.
  var INTEGRITY_TYPES = ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'input', 'mousemove'];
  var integrity = { total: 0, untrusted: 0, integerTs: 0, untrustedByType: {}, keyIntervals: [], lastKeyTs: null, emittedTotal: 0, moveCounter: 0 };

  function onIntegrityEvent(e) {
    if (!state.consentGiven) return;
    if (e.type === 'mousemove' && (integrity.moveCounter++ % 10) !== 0) return; // sample 1 in 10
    integrity.total += 1;
    if (e.isTrusted === false) {
      integrity.untrusted += 1;
      integrity.untrustedByType[e.type] = (integrity.untrustedByType[e.type] || 0) + 1;
    }
    var ts = e.timeStamp;
    if (typeof ts !== 'number') return;
    if (ts % 1 === 0) integrity.integerTs += 1;
    if (e.type === 'keydown') {
      if (integrity.lastKeyTs !== null) {
        var iv = ts - integrity.lastKeyTs;
        if (iv > 0 && iv < 2000) {
          integrity.keyIntervals.push(iv);
          if (integrity.keyIntervals.length > 200) integrity.keyIntervals.shift();
        }
      }
      integrity.lastKeyTs = ts;
    }
  }

  INTEGRITY_TYPES.forEach(function (t) {
    document.addEventListener(t, onIntegrityEvent, { capture: true, passive: true });
  });

  function emitIntegritySummary() {
    if (!state.consentGiven || integrity.total < 5 || integrity.total === integrity.emittedTotal) return;
    integrity.emittedTotal = integrity.total;
    var iv = integrity.keyIntervals;
    var st = summarize(iv);
    var roundCount = iv.filter(function (v) { return Math.abs(v / 10 - Math.round(v / 10)) < 1e-6; }).length;
    pushEvent({
      type: 'event_integrity',
      totalEvents: integrity.total,
      untrustedEvents: integrity.untrusted,
      untrustedRatio: round(integrity.untrusted / integrity.total, 3),
      untrustedByType: integrity.untrustedByType,
      integerTimestampRatio: round(integrity.integerTs / integrity.total, 3),
      keyIntervalCount: iv.length,
      keyIntervalCv: st ? st.cv : null,           // near 0 = metronome-regular typing
      roundIntervalRatio: iv.length ? round(roundCount / iv.length, 3) : null,
    });
  }

  setInterval(emitIntegritySummary, config.flushIntervalMs);
  preFlushHooks.push(emitIntegritySummary);

  // ---------- 14c. Cross-session identity & failed attempts ----------
  // persistentDeviceId lives in localStorage and survives tab close, unlike
  // the sessionId. isNewDevice drives the "new device first-seen" signal;
  // device-switch frequency and accounts-per-device are aggregated server-side.
  var DEVICE_ID_KEY = 'xylium_did_' + config.tenantId;
  var ATTEMPTS_KEY = 'xylium_attempts_' + config.tenantId;
  var ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

  function captureDeviceIdentity() {
    var now = Date.now();
    var rec = readStore(DEVICE_ID_KEY);
    var isNew = !rec || !rec.id;
    if (isNew) rec = { id: 'did_' + makeSessionId(), firstSeenAt: now, visitCount: 0, lastSeenAt: null };
    var prevLastSeen = rec.lastSeenAt;
    rec.visitCount += 1;
    rec.lastSeenAt = now;
    var persisted = writeStore(DEVICE_ID_KEY, rec);
    pushCriticalEvent({
      type: 'device_identity',
      persistentDeviceId: rec.id,
      isNewDevice: isNew,
      storageAvailable: persisted,
      firstSeenAt: rec.firstSeenAt,
      daysSinceFirstSeen: round((now - rec.firstSeenAt) / 86400000, 2),
      msSinceLastSeen: prevLastSeen ? now - prevLastSeen : null,
      visitCount: rec.visitCount,
    });
  }

  // Client-side view of the sliding window, useful when the backend has not
  // yet linked the device to a user. The server count remains authoritative.
  function reportLoginResult(success, reason) {
    if (!state.consentGiven) return;
    var now = Date.now();
    var list = (readStore(ATTEMPTS_KEY) || []).filter(function (ts) { return now - ts < ATTEMPT_WINDOW_MS; });
    var failedBefore = list.length;
    if (success) list = [];
    else list.push(now);
    writeStore(ATTEMPTS_KEY, list);
    if (!success) state.formSubmitted = false; // the next attempt is a new submit
    else removeStore(ABANDON_KEY);
    pushCriticalEvent({
      type: 'login_result',
      success: !!success,
      reason: reason ? String(reason).slice(0, 64) : null,
      failedAttemptsInWindow: success ? failedBefore : list.length,
      windowMs: ATTEMPT_WINDOW_MS,
    });
  }

  // ---------- 14d. Consent-gated one-shot captures ----------
  function runConsentedCaptures() {
    if (state.consentCapturesRan) return;
    state.consentCapturesRan = true;
    sendDeviceSnapshot();
    maybeCaptureGeo();
    captureTimeContext();
    capturePageEntryMethod();
    capturePluginSnapshot();
    captureBatterySnapshot();
    captureConnectionSnapshot();
    // v2.1
    captureDeviceIdentity();
    captureReferrerContext();
    captureLanguageSignals();
    capturePrivacySignals();
    captureNetworkTiming();
    captureAutomationSignals();
    captureMediaQuerySignals();
    checkFormReturn();
    installRttSampler();
    whenIdle(captureCanvasFingerprint);
    whenIdle(captureWebglFingerprint);
    whenIdle(captureFontFingerprint);
    whenIdle(captureAudioFingerprint);
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

  // ---------- 16. Public API ----------
  window.XyliumBF = {
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
      removeStore(DEVICE_ID_KEY);
      removeStore(ATTEMPTS_KEY);
      removeStore(ABANDON_KEY);
      console.log('[XyliumBF v2] consent revoked, capture stopped');
    },
    // Call after your own auth API responds (needed for SPA logins).
    reportLoginResult: function (success, reason) { reportLoginResult(success, reason); },
    // Call when an SPA form submits without a native submit event.
    markFormSubmitted: function () { markFormSubmitted('api'); },
    requestGeo: function () { maybeCaptureGeo(); },
    getSessionId: function () { return state.sessionId; },
    _debugFlushNow: function () { flush(false); },
  };

  installAutofillWatcher();
  installPasswordToggleWatcher();
  if (state.consentGiven) runConsentedCaptures();
})();

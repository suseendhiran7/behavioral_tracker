/**
 * Xylium Behavioral Fingerprinting SDK — v2
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
  };

  console.log('[XyliumBF v2] init', { tenantId: config.tenantId, appId: config.appId, sessionId: state.sessionId });

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

    // ---------- 5b. trajectory sample collection ----------
    if (isTrackingTrajectory && trajectoryBuffer.length < MAX_TRAJECTORY_SAMPLES) {
      trajectoryBuffer.push({ x: e.clientX, y: e.clientY });
    }

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
  var trajectoryBuffer = [];
  var trajectoryStart = null;
  var isTrackingTrajectory = false;
  var MAX_TRAJECTORY_SAMPLES = 200;

  document.addEventListener('mousedown', function (e) {
    isTrackingTrajectory = true;
    trajectoryBuffer = [];
    trajectoryStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    trajectoryBuffer.push({ x: e.clientX, y: e.clientY });
  }, { passive: true });

  document.addEventListener('mouseup', function (e) {
    if (!isTrackingTrajectory || !trajectoryStart || trajectoryBuffer.length < 2) {
      isTrackingTrajectory = false;
      return;
    }
    isTrackingTrajectory = false;
    trajectoryBuffer.push({ x: e.clientX, y: e.clientY });

    var start = trajectoryBuffer[0];
    var end = trajectoryBuffer[trajectoryBuffer.length - 1];
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var straightLinePx = Math.sqrt(dx * dx + dy * dy);

    var actualPathPx = 0;
    for (var i = 1; i < trajectoryBuffer.length; i++) {
      var segDx = trajectoryBuffer[i].x - trajectoryBuffer[i - 1].x;
      var segDy = trajectoryBuffer[i].y - trajectoryBuffer[i - 1].y;
      actualPathPx += Math.sqrt(segDx * segDx + segDy * segDy);
    }

    var maxDeviationPx = 0;
    var lineLen = straightLinePx;
    for (var j = 1; j < trajectoryBuffer.length - 1; j++) {
      var pt = trajectoryBuffer[j];
      var deviation;
      if (lineLen === 0) {
        var devDx = pt.x - start.x;
        var devDy = pt.y - start.y;
        deviation = Math.sqrt(devDx * devDx + devDy * devDy);
      } else {
        deviation = Math.abs(
          (end.y - start.y) * pt.x -
          (end.x - start.x) * pt.y +
          end.x * start.y -
          end.y * start.x
        ) / lineLen;
      }
      if (deviation > maxDeviationPx) maxDeviationPx = deviation;
    }

    var straightnessIndex = actualPathPx > 0
      ? Math.round((straightLinePx / actualPathPx) * 1000) / 1000
      : null;

    if (straightLinePx < 5) { trajectoryBuffer = []; trajectoryStart = null; return; }

    pushEvent({
      type: 'mouse_trajectory',
      straightnessIndex: straightnessIndex,
      actualPathPx: Math.round(actualPathPx),
      straightLinePx: Math.round(straightLinePx),
      maxDeviationPx: Math.round(maxDeviationPx),
      sampleCount: trajectoryBuffer.length,
      durationMs: Math.round(performance.now() - trajectoryStart.t),
    });

    // ---------- 5f. Overshoot detection ----------
    var OVERSHOOT_LOOKBACK = 20;
    var clickX = e.clientX;
    var clickY = e.clientY;
    var samples = trajectoryBuffer.slice(-OVERSHOOT_LOOKBACK);

    var minDistIdx = 0;
    var minDist = Infinity;
    for (var oi = 0; oi < samples.length; oi++) {
      var od = Math.sqrt(Math.pow(samples[oi].x - clickX, 2) + Math.pow(samples[oi].y - clickY, 2));
      if (od < minDist) { minDist = od; minDistIdx = oi; }
    }

    var didOvershoot = false;
    var overshootPx = 0;
    var correctionMs = 0;
    if (minDistIdx < samples.length - 1) {
      var maxPostDist = 0;
      for (var oj = minDistIdx + 1; oj < samples.length; oj++) {
        var postD = Math.sqrt(Math.pow(samples[oj].x - clickX, 2) + Math.pow(samples[oj].y - clickY, 2));
        if (postD > maxPostDist) maxPostDist = postD;
      }
      if (maxPostDist > 5) {
        didOvershoot = true;
        overshootPx = Math.round(maxPostDist);
        correctionMs = Math.round((samples.length - 1 - minDistIdx) * 16.67);
      }
    }

    var approachAngleDeg = null;
    if (samples.length >= 2) {
      var last = samples[samples.length - 1];
      var prev = samples[samples.length - 2];
      approachAngleDeg = Math.round(Math.atan2(last.y - prev.y, last.x - prev.x) * (180 / Math.PI));
    }

    var decelerationSamples = 0;
    var prevSpeed = Infinity;
    for (var ok = Math.max(0, samples.length - 10); ok < samples.length - 1; ok++) {
      var sdx = samples[ok + 1].x - samples[ok].x;
      var sdy = samples[ok + 1].y - samples[ok].y;
      var speed = Math.sqrt(sdx * sdx + sdy * sdy);
      if (speed < prevSpeed) decelerationSamples++;
      prevSpeed = speed;
    }

    pushEvent({
      type: 'overshoot',
      didOvershoot: didOvershoot,
      overshootPx: overshootPx,
      correctionMs: correctionMs,
      approachAngleDeg: approachAngleDeg,
      decelerationSamples: decelerationSamples,
    });

    trajectoryBuffer = [];
    trajectoryStart = null;
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
      pastedFromKeyboard: !e.isTrusted,
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
  function maybeCaptureGeo() {
    if (!config.captureGeo || !state.consentGiven) return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      pushCriticalEvent({
        type: 'geo',
        lat: Math.round(pos.coords.latitude * 100) / 100,
        lon: Math.round(pos.coords.longitude * 100) / 100,
      });
    }, function () {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
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
  window.addEventListener('pagehide', function () { flush(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });

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
      sendDeviceSnapshot();
      maybeCaptureGeo();
      captureTimeContext();       // fires AFTER consent — always works
      capturePageEntryMethod();   // fires AFTER consent — always works
      capturePluginSnapshot();
      captureBatterySnapshot();
      captureConnectionSnapshot();
    },
    revokeConsent: function () {
      state.consentGiven = false;
      state.buffer = [];
      console.log('[XyliumBF v2] consent revoked, capture stopped');
    },
    requestGeo: function () { maybeCaptureGeo(); },
    getSessionId: function () { return state.sessionId; },
    _debugFlushNow: function () { flush(false); },
  };

  installAutofillWatcher();
  if (state.consentGiven) {
    sendDeviceSnapshot();
    maybeCaptureGeo();
    captureTimeContext();
    capturePageEntryMethod();
    capturePluginSnapshot();
    captureBatterySnapshot();
    captureConnectionSnapshot();
  }
})();

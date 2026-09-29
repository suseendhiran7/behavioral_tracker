/**
 * Xylium pattern module — MOUSE
 * Requires: xylium-core.js (loaded first, or this self-queues until it is).
 *
 * Emits:
 *   first_mouse_move           time-to-first-move + first vector
 *   mousemove / mousedown / mouseup / click   (throttled move)
 *   mouse_trajectory           straightness / curvature of the approach path
 *   overshoot                  travelled past the target then corrected
 *   hover_before_click         dwell time on the element before clicking
 *   double_click / single_click_confirmed
 *   mouse_entropy              angle-change entropy of the cursor path
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;
  var pushCriticalEvent = core.pushCriticalEvent;
  var state = core.state;
  var signals = core.signals;
  var round = core.round;
  var fieldIdFor = core.fieldIdFor;
  var pageLoadTime = core.pageLoadTime;

  // ---------- 5. Capture: mouse ----------
  var lastMouseSample = 0;

  document.addEventListener('mousemove', function (e) {
    var now = performance.now();

    // ---------- 5a. Time-to-first-mouse-move — BEFORE throttle ----------
    if (!signals.firstMouseMoveDone) {
      signals.firstMouseMoveDone = true;
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
        beforeFirstKeypress: !signals.firstKeypressDone,
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
});

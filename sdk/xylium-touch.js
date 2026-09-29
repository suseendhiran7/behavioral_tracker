/**
 * Xylium pattern module — TOUCH
 * Requires: xylium-core.js
 *
 * Emits:
 *   touch_pressure   force / contact radius on touchstart
 *   swipe            direction / velocity / deceleration of a fling
 *   touch_tap        tap offset from target centre + finger jitter (tremor)
 *   multi_touch      pinch / multi-finger pan / multi-finger tap
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;
  var state = core.state;
  var round = core.round;
  var summarize = core.summarize;
  var fieldIdFor = core.fieldIdFor;

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
});

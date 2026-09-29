/**
 * Xylium pattern module — KEYBOARD
 * Requires: xylium-core.js
 *
 * Emits:
 *   keydown / keyup            normalized key events
 *   keytiming                  per-key hold + flight time
 *   keytiming_ngram            digraph / trigraph intervals
 *   correction_key             backspace / delete rhythm
 *   rightclick                 context-menu usage
 *   keyboard_shortcut          ctrl/cmd + c/v/x/a/z
 *   shift_pattern              shift-held vs caps-lock for uppercase
 *   typing_summary             per-field summary on blur (baseline drift)
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;
  var state = core.state;
  var signals = core.signals;
  var round = core.round;
  var summarize = core.summarize;
  var fieldIdFor = core.fieldIdFor;
  var classifyField = core.classifyField;
  var normalizeKey = core.normalizeKey;

  // ---------- 6. Capture: keyboard ----------
  // Track first keypress for the mouse module's 5a (beforeFirstKeypress).
  document.addEventListener('keydown', function (e) {
    if (!signals.firstKeypressDone) signals.firstKeypressDone = true;
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

  // ---------- 8f. Per-field typing summary (for baseline drift) ----------
  // Emitted on blur. The backend compares charsPerMinute / hold / flight to the
  // user's own historical averages (delta-from-baseline is server-side).
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

  core.addPreFlushHook(function () {
    Object.keys(state.typingStatsByField).forEach(emitTypingSummary);
  });
});

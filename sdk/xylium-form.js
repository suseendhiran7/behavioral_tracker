/**
 * Xylium pattern module — FORM
 * Requires: xylium-core.js
 *
 * Emits:
 *   focus / blur               field-level focus tracking
 *   field_focus_order          tab order / linearity / jumps
 *   field_time_spent           dwell time per field
 *   first_field_interaction    time from load to first field touch
 *   field_cleared / field_retyped / field_bulk_insert
 *   password_visibility_toggle eye-icon usage
 *   autofill                   browser / password-manager autofill
 *   form_submit / form_abandon / form_return
 *
 * Public API added: XyliumBF.markFormSubmitted()  (for SPA logins)
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;
  var pushCriticalEvent = core.pushCriticalEvent;
  var state = core.state;
  var config = core.config;
  var signals = core.signals;
  var fieldIdFor = core.fieldIdFor;
  var classifyField = core.classifyField;
  var readStore = core.readStore;
  var writeStore = core.writeStore;
  var removeStore = core.removeStore;
  var pageLoadTime = core.pageLoadTime;

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
      mouseMovedFirst: signals.firstMouseMoveDone,
      isTrusted: true,
    });
  }

  document.addEventListener('focus', function (e) { markFirstFieldInteraction(e.target, 'focus'); }, true);

  // ---------- 8d. Field corrections: cleared and retyped ----------
  // Tracks value *length* only — field contents are never read or sent.
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

  // ---------- 12. Autofill detection ----------
  function installAutofillWatcher() {
    var style = document.createElement('style');
    style.textContent =
      '@keyframes xyliumBFAutofillStart { from {} to {} }\n' +
      'input:-webkit-autofill { animation-name: xyliumBFAutofillStart; animation-duration: 0.001s; }';
    (document.head || document.documentElement).appendChild(style);
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

  // ---------- 8g. Form submit, abandonment and return ----------
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

  core.addPreFlushHook(function (reason) { if (reason === 'pagehide') recordAbandonIfNeeded(); });

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

  // ---------- Wiring ----------
  installAutofillWatcher();
  installPasswordToggleWatcher();

  // checkFormReturn is a consent-gated one-shot (order 150 in the original).
  core.onConsent(150, checkFormReturn);

  // Clean up the abandon record when consent is revoked.
  core.onRevoke(function () { removeStore(ABANDON_KEY); });

  // SPA logins that never fire a native submit call this.
  core.defineApi('markFormSubmitted', function () { markFormSubmitted('api'); });
});

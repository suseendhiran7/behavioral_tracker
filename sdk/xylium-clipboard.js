/**
 * Xylium pattern module — CLIPBOARD
 * Requires: xylium-core.js
 *
 * Emits:
 *   copy    field-level copy
 *   paste   paste length + shape (content itself is never sent)
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;
  var fieldIdFor = core.fieldIdFor;
  var classifyField = core.classifyField;

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
});

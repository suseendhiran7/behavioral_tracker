/* ============================================================================
 * xylium-identity.js — Cross-session identity & failed login attempts
 * ----------------------------------------------------------------------------
 * persistentDeviceId lives in localStorage and survives tab close (unlike the
 * per-tab sessionId held by the core). It drives the "new device first-seen"
 * signal; device-switch frequency and accounts-per-device are aggregated
 * server-side.
 *
 * reportLoginResult() keeps a client-side sliding window of failed attempts,
 * useful before the backend has linked the device to a user. The server count
 * stays authoritative.
 *
 * captureDeviceIdentity registers on the consent queue at order 80 so it fires
 * between the connection snapshot (70) and the referrer context (90), matching
 * the original single-file emission order. On revoke, the persisted device id
 * and attempt log are cleared so revoking consent really forgets the device.
 * (The abandon key is owned and cleared by the form module.)
 *
 * Load order does not matter: this file self-registers with the core.
 * ==========================================================================*/
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  var config = core.config;
  var state = core.state;
  var round = core.round;
  var readStore = core.readStore;
  var writeStore = core.writeStore;
  var removeStore = core.removeStore;

  // ---------- 14c. Cross-session identity & failed attempts ----------
  var DEVICE_ID_KEY = 'xylium_did_' + config.tenantId;
  var ATTEMPTS_KEY = 'xylium_attempts_' + config.tenantId;
  // Same tenant-scoped key the form module derives; clearing it on a
  // successful login mirrors the original single-file behaviour.
  var ABANDON_KEY = 'xylium_abandon_' + config.tenantId;
  var ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

  function captureDeviceIdentity() {
    var now = Date.now();
    var rec = readStore(DEVICE_ID_KEY);
    var isNew = !rec || !rec.id;
    if (isNew) rec = { id: 'did_' + core.makeSessionId(), firstSeenAt: now, visitCount: 0, lastSeenAt: null };
    var prevLastSeen = rec.lastSeenAt;
    rec.visitCount += 1;
    rec.lastSeenAt = now;
    var persisted = writeStore(DEVICE_ID_KEY, rec);
    core.pushCriticalEvent({
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
    core.pushCriticalEvent({
      type: 'login_result',
      success: !!success,
      reason: reason ? String(reason).slice(0, 64) : null,
      failedAttemptsInWindow: success ? failedBefore : list.length,
      windowMs: ATTEMPT_WINDOW_MS,
    });
  }

  // Consent-gated one-shot; order 80 preserves the original emission sequence
  // (immediately after the connection snapshot, before referrer context).
  core.onConsent(80, captureDeviceIdentity);

  // Public API: call after your own auth API responds (needed for SPA logins).
  core.defineApi('reportLoginResult', function (success, reason) { reportLoginResult(success, reason); });

  // Remove persisted identifiers so revoking consent really forgets the device.
  core.onRevoke(function () {
    removeStore(DEVICE_ID_KEY);
    removeStore(ATTEMPTS_KEY);
  });
});

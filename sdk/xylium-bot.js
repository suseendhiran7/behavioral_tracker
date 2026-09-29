/* ============================================================================
 * xylium-bot.js — Automation / headless / event-integrity signals
 * ----------------------------------------------------------------------------
 * Three related detectors:
 *   • automation_signals  — webdriver flags, injected automation globals,
 *                           headless-Chrome tells, and a weak CDP-runtime probe.
 *   • media_query_snapshot — CSS media-query facts (pointer/hover/color) and
 *                           UA-vs-hardware anomalies.
 *   • event_integrity     — isTrusted / timestamp-precision statistics that
 *                           surface synthesised (dispatchEvent) input and
 *                           metronome-regular scripted typing.
 *
 * The two one-shot captures register on the consent queue at 130 / 135 so they
 * fire between network-timing (120) and the form-return check (150), matching
 * the original single-file emission order. The rolling integrity summary runs
 * on the flush interval and once more just before the final beacon.
 *
 * Load order does not matter: this file self-registers with the core.
 * ==========================================================================*/
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  'use strict';

  var config = core.config;
  var state = core.state;
  var round = core.round;
  var summarize = core.summarize;
  var detectDeviceType = core.detectDeviceType;
  var pushEvent = core.pushEvent;
  var pushCriticalEvent = core.pushCriticalEvent;

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
  core.addPreFlushHook(emitIntegritySummary);

  // Consent-gated one-shots; orders 130/135 sit between network-timing (120)
  // and the form-return check (150) to preserve the original emission order.
  core.onConsent(130, captureAutomationSignals);
  core.onConsent(135, captureMediaQuerySignals);
});

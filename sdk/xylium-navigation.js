/**
 * Xylium pattern module — NAVIGATION / PAGE CONTEXT
 * Requires: xylium-core.js
 *
 * Emits:
 *   visibilitychange / resize
 *   back_navigation        browser back-button usage / panic-back
 *   time_context           time-of-day / day-of-week in the user's local tz
 *   page_entry_method      navigate / reload / back_forward
 *   referrer_context       classified referrer + phishing heuristics
 *   window_blur / window_focus / visibility_away   tab-switch mid-login
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;
  var pushCriticalEvent = core.pushCriticalEvent;
  var state = core.state;
  var round = core.round;
  var fieldIdFor = core.fieldIdFor;

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
      // Look-alike: referrer embeds our brand label but is a different domain.
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

  // ---------- Consent-gated one-shots (orders preserved from original) ----------
  core.onConsent(30, captureTimeContext);
  core.onConsent(40, capturePageEntryMethod);
  core.onConsent(90, captureReferrerContext);
});

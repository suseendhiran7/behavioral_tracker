/**
 * Xylium pattern module — DEVICE / FINGERPRINT
 * Requires: xylium-core.js
 *
 * Emits (all consent-gated one-shots unless noted):
 *   device_snapshot        screen / viewport / memory / cores / type / OS
 *   plugin_snapshot        plugin + MIME list (bot signal)
 *   battery_snapshot       charging / level (best-effort)
 *   connection_snapshot    effectiveType / downlink / rtt (best-effort)
 *   connection_change      (ongoing) network change
 *   canvas_fingerprint / webgl_fingerprint / font_fingerprint / audio_fingerprint
 *   composite_fingerprint  combined stable hash
 *   language_snapshot      navigator.languages vs Intl locale consistency
 *   privacy_signals        DNT / GPC / cookieEnabled
 *   network_timing         protocol / DNS / TCP / TLS / TTFB
 *   rtt_variance           (ongoing) RTT jitter of our own /collect requests
 */
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  var pushEvent = core.pushEvent;
  var pushCriticalEvent = core.pushCriticalEvent;
  var state = core.state;
  var config = core.config;
  var round = core.round;
  var summarize = core.summarize;
  var hashString = core.hashString;
  var whenIdle = core.whenIdle;
  var detectDeviceType = core.detectDeviceType;
  var detectOsFamily = core.detectOsFamily;

  // ---------- 11. Device snapshot ----------
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

    var MAX_ITEMS = 30;
    var cappedPlugins = pluginNames.slice(0, MAX_ITEMS);
    var cappedMimes = mimeTypes.slice(0, MAX_ITEMS);

    var hasPdfViewer =
      pluginNames.some(function (n) { return /pdf/i.test(n); }) ||
      mimeTypes.some(function (m) { return /pdf/i.test(m); });

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

  // ---------- 11e. Composite fingerprint ----------
  var COMPOSITE_PARTS = ['canvas', 'webgl', 'fonts', 'audio'];

  function setFingerprintPart(name, value) {
    state.fingerprintParts[name] = value;
    if (state.compositeSent) return;
    for (var i = 0; i < COMPOSITE_PARTS.length; i++) {
      if (!(COMPOSITE_PARTS[i] in state.fingerprintParts)) return;
    }
    state.compositeSent = true;
    var parts = {};
    var unstable = [];
    var raw = COMPOSITE_PARTS.map(function (p) {
      parts[p] = state.fingerprintParts[p];
      if (parts[p] === 'randomized' || parts[p] === 'na') unstable.push(p);
      return p + ':' + parts[p];
    }).join('|') + '|' + screen.width + 'x' + screen.height + '|' + (navigator.hardwareConcurrency || 'na') + '|' + navigator.platform;
    pushCriticalEvent({ type: 'composite_fingerprint', compositeHash: 'cf_' + hashString(raw), parts: parts, unavailableOrUnstable: unstable });
  }

  // ---------- 11f. Canvas fingerprint ----------
  function renderCanvasProbe() {
    var c = document.createElement('canvas');
    c.width = 280;
    c.height = 60;
    var ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.font = '11pt "Times New Roman"';
    ctx.fillText('Xylium,bf <canvas> 1.0 \ud83d\ude03', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.font = '18pt Arial';
    ctx.fillText('Xylium,bf <canvas> 1.0 \ud83d\ude03', 4, 45);
    ctx.globalCompositeOperation = 'multiply';
    var colors = ['#f2f', '#2ff', '#ff2'];
    for (var i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.arc(40 + i * 25, 30, 25, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.fill();
    }
    return c.toDataURL();
  }

  function captureCanvasFingerprint() {
    var a = null, b = null;
    try { a = renderCanvasProbe(); b = renderCanvasProbe(); } catch (e) { /* blocked */ }
    if (!a) {
      pushCriticalEvent({ type: 'canvas_fingerprint', supported: false });
      setFingerprintPart('canvas', 'na');
      return;
    }
    var randomized = a !== b; // anti-fingerprinting noise differs per render
    var hash = hashString(a);
    pushCriticalEvent({ type: 'canvas_fingerprint', supported: true, canvasHash: 'cv_' + hash, isRandomized: randomized, dataLength: a.length });
    setFingerprintPart('canvas', randomized ? 'randomized' : hash);
  }

  // ---------- 11g. WebGL renderer / vendor ----------
  function captureWebglFingerprint() {
    var gl = null;
    try {
      var c = document.createElement('canvas');
      gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    } catch (e) { /* ignore */ }
    if (!gl) {
      pushCriticalEvent({ type: 'webgl_fingerprint', supported: false });
      setFingerprintPart('webgl', 'na');
      return;
    }
    var vendor = gl.getParameter(gl.VENDOR);
    var renderer = gl.getParameter(gl.RENDERER);
    var unmaskedVendor = null, unmaskedRenderer = null;
    try {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
    } catch (e) { /* ignore */ }

    function param(name) {
      try {
        var v = gl.getParameter(gl[name]);
        return v && typeof v === 'object' && 'length' in v ? Array.prototype.slice.call(v) : v;
      } catch (e) { return null; }
    }
    var params = {
      maxTextureSize: param('MAX_TEXTURE_SIZE'),
      maxRenderbufferSize: param('MAX_RENDERBUFFER_SIZE'),
      maxViewportDims: param('MAX_VIEWPORT_DIMS'),
      maxVertexAttribs: param('MAX_VERTEX_ATTRIBS'),
      aliasedLineWidthRange: param('ALIASED_LINE_WIDTH_RANGE'),
      shadingLanguageVersion: param('SHADING_LANGUAGE_VERSION'),
    };
    var extensions = gl.getSupportedExtensions() || [];
    var effectiveRenderer = String(unmaskedRenderer || renderer || '');
    var paramsHash = hashString(JSON.stringify(params) + '|' + extensions.slice().sort().join(','));

    pushCriticalEvent({
      type: 'webgl_fingerprint',
      supported: true,
      vendor: vendor,
      renderer: renderer,
      unmaskedVendor: unmaskedVendor,
      unmaskedRenderer: unmaskedRenderer,
      // SwiftShader / llvmpipe = software rendering: typical of headless
      // browsers, VMs and cloud desktops.
      isSoftwareRenderer: /swiftshader|llvmpipe|softpipe|software|offscreen/i.test(effectiveRenderer),
      extensionCount: extensions.length,
      params: params,
      paramsHash: 'gl_' + paramsHash,
    });
    setFingerprintPart('webgl', hashString([vendor, renderer, unmaskedVendor, unmaskedRenderer, paramsHash].join('|')));

    try { var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) { /* ignore */ }
  }

  // ---------- 11h. Installed fonts (canvas measurement) ----------
  var FONT_PROBE_LIST = [
    'Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
    'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Lucida Console',
    'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Segoe UI Emoji', 'Tahoma',
    'Times New Roman', 'Trebuchet MS', 'Verdana', 'Nirmala UI', 'Mangal', 'Latha', 'MS Gothic', 'SimSun',
    'Malgun Gothic', 'Helvetica', 'Helvetica Neue', 'Menlo', 'Monaco', 'Geneva', 'Optima', 'Futura',
    'Gill Sans', 'Avenir', 'Baskerville', 'Didot', 'Hoefler Text', 'American Typewriter', 'PingFang SC',
    'Hiragino Sans', 'Apple Color Emoji', 'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans',
    'Noto Sans Tamil', 'Noto Color Emoji', 'Cantarell', 'Droid Sans', 'Roboto', 'Fira Sans', 'Source Code Pro',
  ];

  function captureFontFingerprint() {
    var ctx = null;
    try { ctx = document.createElement('canvas').getContext('2d'); } catch (e) { /* ignore */ }
    if (!ctx) {
      pushCriticalEvent({ type: 'font_fingerprint', supported: false });
      setFingerprintPart('fonts', 'na');
      return;
    }
    var SAMPLE = 'mmmmmmmmmmlli10OQ@#WwXx\u0BA4';
    var SIZE = '72px ';
    var bases = ['monospace', 'sans-serif', 'serif'];
    var baseWidths = bases.map(function (b) { ctx.font = SIZE + b; return ctx.measureText(SAMPLE).width; });
    var detected = [];
    for (var i = 0; i < FONT_PROBE_LIST.length; i++) {
      for (var j = 0; j < bases.length; j++) {
        ctx.font = SIZE + '"' + FONT_PROBE_LIST[i] + '", ' + bases[j];
        if (ctx.measureText(SAMPLE).width !== baseWidths[j]) { detected.push(FONT_PROBE_LIST[i]); break; }
      }
    }
    var fontsHash = hashString(detected.join(','));
    pushCriticalEvent({ type: 'font_fingerprint', supported: true, probedCount: FONT_PROBE_LIST.length, detectedCount: detected.length, fonts: detected, fontsHash: 'ft_' + fontsHash });
    setFingerprintPart('fonts', fontsHash);
  }

  // ---------- 11i. Audio context fingerprint ----------
  function captureAudioFingerprint() {
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) {
      pushCriticalEvent({ type: 'audio_fingerprint', supported: false });
      setFingerprintPart('audio', 'na');
      return;
    }
    var done = false;
    function fail(reason) {
      if (done) return;
      done = true;
      pushCriticalEvent({ type: 'audio_fingerprint', supported: true, failed: reason });
      setFingerprintPart('audio', 'na');
    }
    var timer = setTimeout(function () { fail('timeout'); }, 2000);
    try {
      var ctx = new Ctx(1, 5000, 44100);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50;
      comp.knee.value = 40;
      comp.ratio.value = 12;
      comp.attack.value = 0;
      comp.release.value = 0.25;
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start(0);
      var onRendered = function (buffer) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var data = buffer.getChannelData(0);
        var sum = 0;
        for (var i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
        var audioHash = hashString(Array.prototype.slice.call(data, 4500, 5000).join(','));
        pushCriticalEvent({ type: 'audio_fingerprint', supported: true, sampleSum: round(sum, 8), audioHash: 'au_' + audioHash });
        setFingerprintPart('audio', audioHash);
      };
      ctx.oncomplete = function (ev) { onRendered(ev.renderedBuffer); }; // older Safari
      var p = ctx.startRendering();
      if (p && typeof p.then === 'function') p.then(onRendered).catch(function () { fail('render_error'); });
    } catch (e) {
      clearTimeout(timer);
      fail('exception');
    }
  }

  // ---------- 11j. Language list ----------
  function captureLanguageSignals() {
    var langs = navigator.languages ? Array.prototype.slice.call(navigator.languages, 0, 10) : [];
    var primary = navigator.language || null;
    var intlLocale = null;
    try { intlLocale = Intl.DateTimeFormat().resolvedOptions().locale; } catch (e) { /* ignore */ }
    function base(l) { return l ? String(l).split('-')[0].toLowerCase() : null; }
    pushCriticalEvent({
      type: 'language_snapshot',
      languages: langs,
      languageCount: langs.length,
      primaryLanguage: primary,
      intlLocale: intlLocale,
      primaryMatchesList: langs.length ? langs[0] === primary : null,
      intlMatchesPrimary: intlLocale && primary ? base(intlLocale) === base(primary) : null,
    });
  }

  // ---------- 11k. Do Not Track / Global Privacy Control ----------
  function capturePrivacySignals() {
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack || null;
    pushCriticalEvent({
      type: 'privacy_signals',
      doNotTrack: dnt === '1' || dnt === 'yes' ? true : (dnt === '0' || dnt === 'no' ? false : null),
      globalPrivacyControl: typeof navigator.globalPrivacyControl === 'boolean' ? navigator.globalPrivacyControl : null,
      cookieEnabled: navigator.cookieEnabled,
    });
  }

  // ---------- 11l. Network: protocol, DNS / TCP / TLS timing, RTT variance ----------
  function captureNetworkTiming() {
    var nav = null;
    try { nav = performance.getEntriesByType('navigation')[0]; } catch (e) { /* ignore */ }
    if (!nav) return;
    function span(a, b) { return a > 0 && b >= a ? round(b - a, 1) : null; }
    var proto = nav.nextHopProtocol || null;
    pushCriticalEvent({
      type: 'network_timing',
      protocol: proto,
      isHttp3: proto ? /^h3/.test(proto) : null,
      isHttp2: proto ? proto === 'h2' : null,
      dnsMs: span(nav.domainLookupStart, nav.domainLookupEnd),
      tcpConnectMs: span(nav.connectStart, nav.connectEnd),
      tlsMs: nav.secureConnectionStart > 0 ? span(nav.secureConnectionStart, nav.connectEnd) : null,
      ttfbMs: span(nav.requestStart, nav.responseStart),
      redirectCount: nav.redirectCount,
      fromCache: nav.transferSize === 0 && nav.decodedBodySize > 0,
    });
  }

  // RTT samples come from our own /collect requests, so no extra traffic.
  var rttSamples = [];
  var RTT_EMIT_EVERY = 5;
  var RTT_KEEP = 20;
  var rttSamplerInstalled = false;

  function installRttSampler() {
    if (rttSamplerInstalled || !config.apiEndpoint || typeof PerformanceObserver !== 'function') return;
    rttSamplerInstalled = true;
    var base = config.apiEndpoint.replace(/\/$/, '');
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (en) {
          if (en.name.indexOf(base) !== 0) return;
          var precise = en.requestStart > 0 && en.responseStart > 0;
          var sample = precise ? en.responseStart - en.requestStart : en.duration;
          if (!(sample > 0)) return;
          rttSamples.push({ v: sample, precise: precise });
          if (rttSamples.length > RTT_KEEP) rttSamples.shift();
          if (rttSamples.length % RTT_EMIT_EVERY !== 0 && rttSamples.length !== RTT_KEEP) return;
          var vals = rttSamples.map(function (s) { return s.v; });
          var st = summarize(vals);
          var jitter = 0;
          for (var i = 1; i < vals.length; i++) jitter += Math.abs(vals[i] - vals[i - 1]);
          pushEvent({
            type: 'rtt_variance',
            sampleCount: st.n,
            precise: rttSamples.every(function (s) { return s.precise; }),
            meanMs: st.mean,
            stdMs: st.std,
            minMs: st.min,
            maxMs: st.max,
            cv: st.cv,
            jitterMs: vals.length > 1 ? round(jitter / (vals.length - 1), 2) : null,
          });
        });
      }).observe({ type: 'resource', buffered: false });
    } catch (e) { /* ignore */ }
  }

  // ---------- Consent-gated one-shots (orders preserved from original) ----------
  core.onConsent(10, sendDeviceSnapshot);
  core.onConsent(50, capturePluginSnapshot);
  core.onConsent(60, captureBatterySnapshot);
  core.onConsent(70, captureConnectionSnapshot);
  core.onConsent(100, captureLanguageSignals);
  core.onConsent(110, capturePrivacySignals);
  core.onConsent(120, captureNetworkTiming);
  core.onConsent(160, installRttSampler);
  core.onConsent(170, function () { whenIdle(captureCanvasFingerprint); });
  core.onConsent(180, function () { whenIdle(captureWebglFingerprint); });
  core.onConsent(190, function () { whenIdle(captureFontFingerprint); });
  core.onConsent(200, function () { whenIdle(captureAudioFingerprint); });
});

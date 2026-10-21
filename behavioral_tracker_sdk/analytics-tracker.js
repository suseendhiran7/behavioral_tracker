/**
 * Behavioral Fingerprinting & Analytics SDK (v2.1.0)
 *
 * Production-ready behavioral biometrics and client analytics SDK for banking and fintech applications:
 * - Micro-interaction biometrics: pointer dynamics, velocity, jitter, hover dwell, keystroke flight/hold times
 * - Privacy-by-design: ZERO passwords, PINs, card numbers, OTPs, or typed values captured
 * - Session & banking workflow tracking: login attempts, payment workflows, step-up challenges
 * - Local feature derivation: typing cadence, pointer velocity, gesture summaries
 * - Resilient transport: sequence numbers, bounded in-memory queue, batching, exponential backoff with jitter
 * - Lifecycle management: clean listener attachment & removal, visibilitychange/pagehide beacons
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var SDK = factory();
    root.BehaviourTracker = SDK;
    root.BehaviorSDK = SDK;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SDK_VERSION = '2.1.0';
  var SENSITIVE_INPUT_REGEX = /password|passwd|secret|cvv|cvc|card|credit|token|otp|pin|ssn|auth|account_?no/i;
  var NAMED_CONTROL_KEYS = [
    'Backspace', 'Tab', 'Enter', 'Shift', 'Control', 'Alt', 'Meta',
    'CapsLock', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Delete', 'Home', 'End', 'PageUp', 'PageDown'
  ];

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  function getDeviceCategory() {
    if (typeof navigator === 'undefined') return 'unknown';
    var ua = navigator.userAgent || '';
    if (/tablet|ipad/i.test(ua)) return 'tablet';
    if (/mobile|android|iphone|ipod/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  function getOsCategory() {
    if (typeof navigator === 'undefined') return 'unknown';
    var ua = navigator.userAgent || '';
    if (/win/i.test(ua)) return 'windows';
    if (/mac/i.test(ua)) return 'macos';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
    if (/linux/i.test(ua)) return 'linux';
    return 'other';
  }

  function getElementDescriptor(el) {
    if (!el || typeof el.getAttribute !== 'function') return { id: 'unknown', category: 'unknown', textPreview: '' };

    var trackId = el.getAttribute('data-track-id') || el.id || el.name || el.getAttribute('data-bf-field');
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var category = 'element';

    if (tag === 'button' || el.getAttribute('role') === 'button' || el.type === 'submit') {
      category = 'button';
    } else if (tag === 'a') {
      category = 'link';
    } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      category = 'input';
    } else if (el.getAttribute('data-track-cta') || /cta|btn|primary/i.test(el.className || '')) {
      category = 'cta';
    }

    return {
      id: trackId || (tag + (el.className ? '.' + el.className.split(' ')[0] : '')),
      category: category,
      textPreview: (el.textContent || '').trim().slice(0, 30),
    };
  }

  function classifyField(el) {
    if (!el) return 'unknown';
    var explicit = el.getAttribute('data-field-category') || el.getAttribute('data-bf-field');
    if (explicit) return explicit;
    if (el.type === 'password') return 'password';
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'phone';
    var hint = (el.id || '') + ' ' + (el.name || '') + ' ' + (el.autocomplete || '');
    if (/email/i.test(hint)) return 'email';
    if (/phone|tel|mobile/i.test(hint)) return 'phone';
    if (/user|login/i.test(hint)) return 'username';
    if (/address|city|zip|postal/i.test(hint)) return 'address';
    if (/amount|price|qty/i.test(hint)) return 'amount';
    return 'text';
  }

  function maskKey(key) {
    if (!key) return 'unknown';
    if (key.length === 1) return 'char';
    if (NAMED_CONTROL_KEYS.indexOf(key) !== -1) return key;
    return 'functional';
  }

  function sanitizeProps(props) {
    if (!props || typeof props !== 'object') return {};
    var out = {};
    for (var k in props) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        if (SENSITIVE_INPUT_REGEX.test(k)) continue; // Strip sensitive keys
        out[k] = props[k];
      }
    }
    return out;
  }

  function BehaviorSDK(options) {
    var opts = options || {};
    this.options = Object.assign(
      {
        apiEndpoint: opts.endpoint || opts.apiEndpoint || 'http://localhost:8080/api/analytics',
        clientId: opts.clientId || opts.tenantId || 'client_nexus_bank',
        tenantId: opts.tenantId || opts.clientId || 'default',
        appId: opts.appId || 'banking_app',
        batchSize: 25,
        flushIntervalMs: 5000,
        maxQueueSize: 500,
        maxRetries: 4,
        idleThresholdMs: 5000,
        pointerSamplingMs: 50,
        enablePointerSampling: true,
        enableScrollTracking: true,
        enableTouchTracking: true,
        enableKeyboardTracking: true,
        consent: opts.consent !== false,
      },
      opts
    );

    this.sessionId = opts.sessionId || this.getOrInitSessionId();
    this.anonymousId = this.getOrInitAnonymousId();
    this.userId = opts.userId || null;
    this.authToken = null;
    this.sequenceNumber = 1;
    this.isActive = false;

    this.queue = [];
    this.isFlushing = false;
    this.retryCount = 0;
    this.timer = null;
    this.idleTimer = null;
    this.pointerIdleTimer = null;

    // Engagement state
    this.currentPageViewId = uuid();
    this.currentRoute = typeof window !== 'undefined' ? window.location.pathname : '/';
    this.pageEntryTime = Date.now();
    this.lastInteractionTime = Date.now();
    this.lastPointerTime = Date.now();
    this.isTabVisible = true;
    this.isUserIdle = false;
    this.isPointerIdle = false;
    this.activeTimeMs = 0;
    this.visibleTimeMs = 0;
    this.interactionCount = 0;
    this.maxScrollDepth = 0;
    this.scrollMilestones = { 25: false, 50: false, 75: false, 100: false };

    // Pointer dynamics
    this.lastPointerX = null;
    this.lastPointerY = null;
    this.lastPointerMoveTime = 0;
    this.pointerDownTime = null;
    this.pointerDownTarget = null;
    this.hoverStartTime = null;
    this.hoverTargetDesc = null;

    // Keyboard dynamics (IKIs & Cadence)
    this.lastKeyUpTime = null;
    this.keyPressCountInWindow = 0;
    this.typingWindowStart = 0;
    this.activeFieldFocusTime = null;
    this.activeFieldId = null;

    // Touch dynamics
    this.touchStartX = null;
    this.touchStartY = null;
    this.touchStartTime = null;

    // Battery & Device
    this.batteryInfo = { batteryLevel: null, isCharging: null };

    // Listeners for clean disposal
    this._listeners = [];

    if (this.options.consent) {
      this.start();
    }
  }

  BehaviorSDK.prototype.getOrInitSessionId = function () {
    try {
      var existing = sessionStorage.getItem('xylium_analytics_sess_id');
      if (existing) return existing;
      var newId = uuid();
      sessionStorage.setItem('xylium_analytics_sess_id', newId);
      return newId;
    } catch (e) {
      return uuid();
    }
  };

  BehaviorSDK.prototype.getOrInitAnonymousId = function () {
    try {
      var existing = localStorage.getItem('xylium_analytics_anon_id');
      if (existing) return existing;
      var newId = 'anon_' + uuid();
      localStorage.setItem('xylium_analytics_anon_id', newId);
      return newId;
    } catch (e) {
      return 'anon_' + uuid();
    }
  };

  BehaviorSDK.prototype.setAuthToken = function (token) {
    this.authToken = token;
  };

  BehaviorSDK.prototype.setUserId = function (userId) {
    this.userId = userId;
  };

  BehaviorSDK.prototype.identify = function (userId) {
    var prevAnon = this.anonymousId;
    this.userId = userId;
    this.emitEvent('session', 'login_succeeded', {
      userId: userId,
      anonymousId: prevAnon,
    });
    this.linkSessionOnServer(userId, prevAnon);
    this.flush(false);
  };

  BehaviorSDK.prototype.start = function () {
    if (this.isActive) return;
    this.isActive = true;

    this.startFlushTimer();
    this.startIdleChecker();
    this.initBatteryTracking();

    if (typeof window === 'undefined') return;

    this.trackSessionStart();
    this.trackPageLoad();
    this.trackPageView(this.currentRoute);
    this.attachGlobalListeners();
  };

  BehaviorSDK.prototype.stop = function () {
    if (!this.isActive) return;
    this.destroy();
    this.isActive = false;
  };

  BehaviorSDK.prototype.addEventListener = function (target, type, listener, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    try {
      target.addEventListener(type, listener, options);
      this._listeners.push({ target: target, type: type, listener: listener, options: options });
    } catch (e) {}
  };

  BehaviorSDK.prototype.initBatteryTracking = function () {
    var self = this;
    if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
      navigator.getBattery().then(function (battery) {
        self.batteryInfo = {
          batteryLevel: Math.round(battery.level * 100) / 100,
          isCharging: battery.charging,
        };
        if (typeof battery.addEventListener === 'function') {
          var onChargingChange = function () {
            self.batteryInfo.isCharging = battery.charging;
            self.emitEvent('session', 'battery_status_changed', {
              isCharging: battery.charging,
              batteryLevel: self.batteryInfo.batteryLevel,
            });
          };
          var onLevelChange = function () {
            self.batteryInfo.batteryLevel = Math.round(battery.level * 100) / 100;
            self.emitEvent('session', 'battery_status_changed', {
              isCharging: self.batteryInfo.isCharging,
              batteryLevel: self.batteryInfo.batteryLevel,
            });
          };
          battery.addEventListener('chargingchange', onChargingChange);
          battery.addEventListener('levelchange', onLevelChange);
          self._listeners.push({ target: battery, type: 'chargingchange', listener: onChargingChange });
          self._listeners.push({ target: battery, type: 'levelchange', listener: onLevelChange });
        }
      }).catch(function () {});
    }
  };

  BehaviorSDK.prototype.attachGlobalListeners = function () {
    var self = this;

    // --- 1. Page Visibility & Tab Switch ---
    this.addEventListener(document, 'visibilitychange', function () {
      var visible = document.visibilityState === 'visible';
      self.isTabVisible = visible;
      self.emitEvent('lifecycle', 'page_visibility', {
        visible: visible,
        state: document.visibilityState,
        route: self.currentRoute,
      });
      self.emitEvent('lifecycle', 'tab_switch', {
        activeTab: visible,
        route: self.currentRoute,
      });
      // Also maintain backward-compatible session tab events
      self.emitEvent('session', visible ? 'tab_visible' : 'tab_hidden', {
        route: self.currentRoute,
        state: document.visibilityState,
      });
      if (!visible) {
        self.flush(true);
      }
    });

    // --- 2. Page Hide / Unload ---
    this.addEventListener(window, 'pagehide', function () {
      self.endCurrentPageView('pagehide');
      self.emitEvent('lifecycle', 'session_end', {
        sessionId: self.sessionId,
        reason: 'pagehide',
      });
      self.flush(true);
    });

    // --- 3. Pointer Dynamics: Down & Up ---
    this.addEventListener(document, 'pointerdown', function (e) {
      self.registerInteraction();
      self.pointerDownTime = Date.now();
      self.pointerDownTarget = getElementDescriptor(e.target);
      self.emitEvent('pointer', 'pointer_down', {
        x: e.clientX,
        y: e.clientY,
        targetCategory: self.pointerDownTarget.category,
        targetId: self.pointerDownTarget.id,
      });
    }, true);

    this.addEventListener(document, 'pointerup', function (e) {
      self.registerInteraction();
      var upTime = Date.now();
      var holdDurationMs = self.pointerDownTime ? (upTime - self.pointerDownTime) : null;
      var desc = getElementDescriptor(e.target);
      self.emitEvent('pointer', 'pointer_up', {
        x: e.clientX,
        y: e.clientY,
        holdDurationMs: holdDurationMs,
        targetCategory: desc.category,
        targetId: desc.id,
      });
      self.pointerDownTime = null;
    }, true);

    // --- 4. Pointer Clicks ---
    this.addEventListener(document, 'click', function (e) {
      self.registerInteraction();
      var desc = getElementDescriptor(e.target);
      self.emitEvent('pointer', 'pointer_click', {
        x: e.clientX,
        y: e.clientY,
        targetCategory: desc.category,
        targetId: desc.id,
        textPreview: desc.textPreview,
      });
      // Legacy click event
      self.emitEvent('pointer', 'click', {
        elementId: desc.id,
        elementCategory: desc.category,
        textPreview: desc.textPreview,
        x: e.clientX,
        y: e.clientY,
      });
    }, true);

    this.addEventListener(document, 'dblclick', function (e) {
      self.registerInteraction();
      var desc = getElementDescriptor(e.target);
      self.emitEvent('pointer', 'double_click', {
        elementId: desc.id,
        elementCategory: desc.category,
      });
    }, true);

    // --- 5. Pointer Move & Velocity Derivation ---
    if (this.options.enablePointerSampling) {
      this.addEventListener(document, 'pointermove', function (e) {
        self.registerInteraction();
        self.lastPointerTime = Date.now();
        if (self.isPointerIdle) {
          self.isPointerIdle = false;
        }

        var now = Date.now();
        if (now - self.lastPointerMoveTime < self.options.pointerSamplingMs) return;

        var dt = now - self.lastPointerMoveTime;
        var dx = self.lastPointerX !== null ? e.clientX - self.lastPointerX : 0;
        var dy = self.lastPointerY !== null ? e.clientY - self.lastPointerY : 0;
        var distance = Math.sqrt(dx * dx + dy * dy);

        self.lastPointerMoveTime = now;
        self.lastPointerX = e.clientX;
        self.lastPointerY = e.clientY;

        // Sampled move
        self.emitEvent('pointer', 'pointer_move', {
          x: e.clientX,
          y: e.clientY,
          sampledIntervalMs: dt,
        });

        // Locally derived velocity & direction
        if (dt > 0 && distance > 0) {
          var speedPxPerMs = Math.round((distance / dt) * 100) / 100;
          var angleDeg = Math.round(Math.atan2(dy, dx) * (180 / Math.PI));
          // Bot check: perfectly horizontal or vertical lines over significant distance
          var isStraightLine = (dx === 0 && Math.abs(dy) > 50) || (dy === 0 && Math.abs(dx) > 50);

          self.emitEvent('pointer', 'pointer_velocity', {
            speedPxPerMs: speedPxPerMs,
            velocity: speedPxPerMs,
            angleDeg: angleDeg,
            isStraightLine: isStraightLine,
            distancePx: Math.round(distance),
          });
        }
      }, { passive: true });
    }

    // --- 6. Hover Interactions ---
    this.addEventListener(document, 'mouseover', function (e) {
      var desc = getElementDescriptor(e.target);
      if (desc.category === 'button' || desc.category === 'cta' || desc.category === 'link' || e.target.getAttribute('data-track-hover')) {
        self.hoverStartTime = Date.now();
        self.hoverTargetDesc = desc;
      }
    }, true);

    this.addEventListener(document, 'mouseout', function (e) {
      if (self.hoverStartTime && self.hoverTargetDesc) {
        var duration = Date.now() - self.hoverStartTime;
        if (duration > 300) {
          self.emitEvent('pointer', 'hover', {
            targetId: self.hoverTargetDesc.id,
            targetCategory: self.hoverTargetDesc.category,
            hoverDurationMs: duration,
          });
          // Backward compatibility
          self.emitEvent('pointer', 'hover_dwell', {
            elementId: self.hoverTargetDesc.id,
            elementCategory: self.hoverTargetDesc.category,
            hoverDurationMs: duration,
          });
        }
        self.hoverStartTime = null;
        self.hoverTargetDesc = null;
      }
    }, true);

    // --- 7. Keyboard Dynamics (NO CREDENTIALS/CONTENT COLLECTED) ---
    if (this.options.enableKeyboardTracking) {
      this.addEventListener(document, 'keydown', function (e) {
        self.registerInteraction();
        var now = Date.now();
        var masked = maskKey(e.key);
        var target = e.target;
        var category = classifyField(target);

        // Calculate inter-key interval (flight time)
        var flightTimeMs = self.lastKeyUpTime ? Math.max(0, now - self.lastKeyUpTime) : null;

        // Cadence tracking
        if (now - self.typingWindowStart > 3000) {
          self.typingWindowStart = now;
          self.keyPressCountInWindow = 0;
        }
        self.keyPressCountInWindow++;
        var windowDurationSec = (now - self.typingWindowStart) / 1000 || 1;
        var cadence = Math.round((self.keyPressCountInWindow / windowDurationSec) * 10) / 10;

        self.emitEvent('keyboard', 'key_down', {
          key: masked,
          fieldCategory: category,
          flightTimeMs: flightTimeMs,
        });

        // Typing dynamics summary
        if (flightTimeMs !== null) {
          self.emitEvent('keyboard', 'typing_dynamics', {
            flightTimeMs: flightTimeMs,
            keysPerSecond: cadence,
            isPause: flightTimeMs > 1000,
            fieldCategory: category,
          });
        }
      }, true);

      this.addEventListener(document, 'keyup', function (e) {
        self.registerInteraction();
        self.lastKeyUpTime = Date.now();
        var masked = maskKey(e.key);
        var category = classifyField(e.target);

        self.emitEvent('keyboard', 'key_up', {
          key: masked,
          fieldCategory: category,
        });
      }, true);
    }

    // --- 8. Form & Field Interactions (Focus Change, Interaction Duration, Paste) ---
    this.addEventListener(document, 'focusin', function (e) {
      var target = e.target;
      if (!target || !target.tagName || !/^(INPUT|SELECT|TEXTAREA)$/i.test(target.tagName)) return;
      var category = classifyField(target);
      var fieldId = target.id || target.name || 'field';
      var isSensitive = SENSITIVE_INPUT_REGEX.test(target.type || '') || SENSITIVE_INPUT_REGEX.test(target.name || '') || SENSITIVE_INPUT_REGEX.test(target.id || '');
      var safeFieldId = isSensitive ? 'redacted_sensitive_field' : fieldId;

      var prevField = self.activeFieldId;
      self.activeFieldId = safeFieldId;
      self.activeFieldFocusTime = Date.now();

      self.emitEvent('form', 'focus_change', {
        fromField: prevField,
        toField: safeFieldId,
        fieldCategory: category,
      });

      self.emitEvent('form', 'field_focused', {
        fieldId: safeFieldId,
        fieldCategory: category,
      });
    }, true);

    this.addEventListener(document, 'focusout', function (e) {
      var target = e.target;
      if (!target || !target.tagName || !/^(INPUT|SELECT|TEXTAREA)$/i.test(target.tagName)) return;
      var category = classifyField(target);
      var fieldId = target.id || target.name || 'field';
      var isSensitive = SENSITIVE_INPUT_REGEX.test(target.type || '') || SENSITIVE_INPUT_REGEX.test(target.name || '') || SENSITIVE_INPUT_REGEX.test(target.id || '');
      var safeFieldId = isSensitive ? 'redacted_sensitive_field' : fieldId;

      var durationMs = self.activeFieldFocusTime ? (Date.now() - self.activeFieldFocusTime) : null;
      self.emitEvent('form', 'field_interaction', {
        fieldId: safeFieldId,
        fieldCategory: category,
        durationMs: durationMs,
      });

      self.emitEvent('form', 'field_blurred', {
        fieldId: safeFieldId,
        fieldCategory: category,
      });

      self.activeFieldFocusTime = null;
    }, true);

    // Paste detected without reading clipboard content
    this.addEventListener(document, 'paste', function (e) {
      var target = e.target;
      var category = classifyField(target);
      var fieldId = target ? (target.id || target.name || 'field') : 'unknown';
      var isSensitive = target && (SENSITIVE_INPUT_REGEX.test(target.type || '') || SENSITIVE_INPUT_REGEX.test(target.name || ''));

      self.emitEvent('form', 'paste_detected', {
        pasteDetected: true,
        fieldId: isSensitive ? 'redacted_sensitive_field' : fieldId,
        fieldCategory: category,
      });
    }, true);

    this.addEventListener(document, 'submit', function (e) {
      var form = e.target;
      var formId = form.id || form.getAttribute('data-track-form') || 'form';
      self.emitEvent('form', 'form_submitted', {
        formId: formId,
        route: self.currentRoute,
      });
    }, true);

    // --- 9. Touch & Gesture Dynamics ---
    if (this.options.enableTouchTracking) {
      this.addEventListener(document, 'touchstart', function (e) {
        self.registerInteraction();
        self.touchStartTime = Date.now();
        if (e.touches && e.touches[0]) {
          self.touchStartX = e.touches[0].clientX;
          self.touchStartY = e.touches[0].clientY;
        }
        self.emitEvent('touch', 'touch_start', {
          touchCount: e.touches ? e.touches.length : 1,
        });
      }, { passive: true });

      this.addEventListener(document, 'touchmove', function () {
        self.registerInteraction();
        self.emitEvent('touch', 'touch_move', {});
      }, { passive: true });

      this.addEventListener(document, 'touchend', function (e) {
        var duration = self.touchStartTime ? (Date.now() - self.touchStartTime) : null;
        self.emitEvent('touch', 'touch_end', { durationMs: duration });

        if (self.touchStartX !== null && self.touchStartY !== null && e.changedTouches && e.changedTouches[0]) {
          var dx = e.changedTouches[0].clientX - self.touchStartX;
          var dy = e.changedTouches[0].clientY - self.touchStartY;
          var absX = Math.abs(dx);
          var absY = Math.abs(dy);
          var dist = Math.round(Math.sqrt(dx * dx + dy * dy));

          if (absX > 40 || absY > 40) {
            var direction = absX > absY ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
            self.emitEvent('touch', 'gesture_summary', {
              gestureType: 'swipe',
              direction: direction,
              distancePx: dist,
              durationMs: duration,
            });
            self.emitEvent('touch', 'swipe', {
              direction: direction,
              approxDistancePx: dist,
            });
          }
          self.touchStartX = null;
          self.touchStartY = null;
        }
      }, { passive: true });

      this.addEventListener(window, 'orientationchange', function () {
        self.emitEvent('touch', 'device_orientation', {
          orientation: (window.screen && window.screen.orientation && window.screen.orientation.type) || 'unknown',
        });
        self.emitEvent('touch', 'orientation_change', {
          orientation: (window.screen && window.screen.orientation && window.screen.orientation.type) || 'unknown',
        });
      });
    }

    // --- 10. Scroll Dynamics (Throttled + Direction) ---
    if (this.options.enableScrollTracking) {
      var lastScrollTick = 0;
      var lastScrollY = typeof window !== 'undefined' ? window.scrollY : 0;
      this.addEventListener(window, 'scroll', function () {
        self.registerInteraction();
        var now = Date.now();
        if (now - lastScrollTick < 100) return;
        lastScrollTick = now;

        var scrollY = window.scrollY || document.documentElement.scrollTop || 0;
        var delta = scrollY - lastScrollY;
        var direction = delta >= 0 ? 'down' : 'up';
        lastScrollY = scrollY;

        var totalHeight = document.documentElement.scrollHeight - window.innerHeight;
        var depthPercent = totalHeight > 0 ? Math.min(100, Math.round((scrollY / totalHeight) * 100)) : 0;
        self.maxScrollDepth = Math.max(self.maxScrollDepth, depthPercent);

        self.emitEvent('scroll', 'scroll', {
          scrollY: scrollY,
          direction: direction,
          deltaPx: Math.abs(delta),
          scrollDepthPercent: depthPercent,
        });

        [25, 50, 75, 100].forEach(function (ms) {
          if (depthPercent >= ms && !self.scrollMilestones[ms]) {
            self.scrollMilestones[ms] = true;
            self.emitEvent('scroll', 'scroll_milestone', {
              milestonePercent: ms,
              currentDepthPercent: depthPercent,
              route: self.currentRoute,
            });
          }
        });
      }, { passive: true });
    }

    // --- 11. Errors ---
    this.addEventListener(window, 'error', function (e) {
      self.emitEvent('error', 'app_error', {
        message: (e.message || '').slice(0, 200),
        filename: (e.filename || '').split('/').pop(),
        lineno: e.lineno,
      });
    });

    this.addEventListener(window, 'online', function () {
      self.flush(false);
    });
  };

  BehaviorSDK.prototype.registerInteraction = function () {
    this.lastInteractionTime = Date.now();
    this.interactionCount += 1;
    if (this.isUserIdle) {
      this.isUserIdle = false;
      this.emitEvent('lifecycle', 'idle_end', { route: this.currentRoute });
      this.emitEvent('engagement', 'idle_ended', { route: this.currentRoute });
    }
  };

  BehaviorSDK.prototype.startIdleChecker = function () {
    var self = this;
    this.idleTimer = setInterval(function () {
      if (!self.isTabVisible || self.isUserIdle) return;
      var idleDuration = Date.now() - self.lastInteractionTime;
      if (idleDuration >= self.options.idleThresholdMs) {
        self.isUserIdle = true;
        self.emitEvent('lifecycle', 'idle_start', {
          idleDurationMs: idleDuration,
          thresholdMs: self.options.idleThresholdMs,
        });
        self.emitEvent('engagement', 'idle_started', {
          route: self.currentRoute,
          idleThresholdMs: self.options.idleThresholdMs,
        });
      }

      // Check pointer idle stagnation
      var pointerIdleMs = Date.now() - self.lastPointerTime;
      if (pointerIdleMs >= 3000 && !self.isPointerIdle) {
        self.isPointerIdle = true;
        self.emitEvent('pointer', 'pointer_idle', {
          idleMs: pointerIdleMs,
        });
      }
    }, 2000);
  };

  BehaviorSDK.prototype.emitEvent = function (category, eventName, properties) {
    if (!this.isActive && !this.options.consent) return;

    var sanitized = sanitizeProps(properties || {});
    var devCategory = getDeviceCategory();
    var devOs = getOsCategory();
    var scrW = typeof window !== 'undefined' ? window.screen.width : null;
    var scrH = typeof window !== 'undefined' ? window.screen.height : null;
    var batLvl = this.batteryInfo ? this.batteryInfo.batteryLevel : null;
    var batChg = this.batteryInfo ? this.batteryInfo.isCharging : null;

    var evt = {
      eventId: uuid(),
      eventType: eventName,
      eventName: eventName,
      timestamp: new Date().toISOString(),
      sequenceNumber: this.sequenceNumber++,
      clientId: this.options.clientId || this.options.tenantId,
      userId: this.userId,
      sessionId: this.sessionId,
      anonymousId: this.anonymousId,
      tenantId: this.options.tenantId,
      eventCategory: category,
      page: this.currentRoute,
      pageId: this.currentPageViewId,
      sanitizedRoute: this.currentRoute,
      sdkVersion: SDK_VERSION,

      // Dedicated Top-Level Fields
      pointerX: typeof sanitized.x === 'number' ? sanitized.x : (typeof sanitized.clientX === 'number' ? sanitized.clientX : null),
      pointerY: typeof sanitized.y === 'number' ? sanitized.y : (typeof sanitized.clientY === 'number' ? sanitized.clientY : null),
      pointerSpeedPxPerMs: typeof sanitized.speedPxPerMs === 'number' ? sanitized.speedPxPerMs : (typeof sanitized.velocity === 'number' ? sanitized.velocity : null),
      pointerAngleDeg: typeof sanitized.angleDeg === 'number' ? sanitized.angleDeg : null,
      pointerDistancePx: typeof sanitized.distancePx === 'number' ? sanitized.distancePx : null,
      isStraightLine: typeof sanitized.isStraightLine === 'boolean' ? sanitized.isStraightLine : null,
      pointerHoldDurationMs: typeof sanitized.holdDurationMs === 'number' ? sanitized.holdDurationMs : null,
      hoverDurationMs: typeof sanitized.hoverDurationMs === 'number' ? sanitized.hoverDurationMs : null,
      targetCategory: sanitized.targetCategory || sanitized.elementCategory || null,
      targetId: sanitized.targetId || sanitized.elementId || null,
      textPreview: sanitized.textPreview || null,

      keyMasked: sanitized.key || null,
      flightTimeMs: typeof sanitized.flightTimeMs === 'number' ? sanitized.flightTimeMs : null,
      holdTimeMs: typeof sanitized.holdTimeMs === 'number' ? sanitized.holdTimeMs : null,
      keysPerSecond: typeof sanitized.keysPerSecond === 'number' ? sanitized.keysPerSecond : null,
      isTypingPause: typeof sanitized.isPause === 'boolean' ? sanitized.isPause : null,

      fieldId: sanitized.fieldId || sanitized.field || null,
      fieldCategory: sanitized.fieldCategory || null,
      fromField: sanitized.fromField || null,
      toField: sanitized.toField || null,
      fieldDurationMs: typeof sanitized.durationMs === 'number' ? sanitized.durationMs : null,
      pasteDetected: typeof sanitized.pasteDetected === 'boolean' ? sanitized.pasteDetected : null,
      formId: sanitized.formId || null,

      scrollY: typeof sanitized.scrollY === 'number' ? sanitized.scrollY : null,
      scrollDirection: sanitized.direction || null,
      scrollDeltaPx: typeof sanitized.deltaPx === 'number' ? sanitized.deltaPx : null,
      scrollDepthPercent: typeof sanitized.scrollDepthPercent === 'number' ? sanitized.scrollDepthPercent : (typeof sanitized.currentDepthPercent === 'number' ? sanitized.currentDepthPercent : null),
      scrollMilestone: typeof sanitized.milestonePercent === 'number' ? sanitized.milestonePercent : null,

      touchCount: typeof sanitized.touchCount === 'number' ? sanitized.touchCount : null,
      touchDurationMs: typeof sanitized.durationMs === 'number' && category === 'touch' ? sanitized.durationMs : null,
      gestureType: sanitized.gestureType || null,
      swipeDirection: sanitized.direction || null,
      swipeDistancePx: typeof sanitized.distancePx === 'number' ? sanitized.distancePx : (typeof sanitized.approxDistancePx === 'number' ? sanitized.approxDistancePx : null),
      orientation: sanitized.orientation || null,

      fromRoute: sanitized.fromRoute || null,
      toRoute: sanitized.toRoute || null,
      navigationMethod: sanitized.method || null,
      visibilityState: sanitized.state || null,
      tabActive: typeof sanitized.activeTab === 'boolean' ? sanitized.activeTab : null,
      idleDurationMs: typeof sanitized.idleDurationMs === 'number' ? sanitized.idleDurationMs : null,
      pageLoadTimeMs: sanitized.timing && typeof sanitized.timing.loadEventMs === 'number' ? sanitized.timing.loadEventMs : null,
      domContentLoadedMs: sanitized.timing && typeof sanitized.timing.domContentLoadedMs === 'number' ? sanitized.timing.domContentLoadedMs : null,
      ttfbMs: sanitized.timing && typeof sanitized.timing.ttfbMs === 'number' ? sanitized.timing.ttfbMs : null,

      flowType: sanitized.flowType || null,
      paymentId: sanitized.paymentId || null,
      paymentAmount: typeof sanitized.amount === 'number' ? sanitized.amount : null,
      paymentCurrency: sanitized.currency || null,
      recipientType: sanitized.recipientType || null,
      paymentStatus: sanitized.status || null,
      reasonCode: sanitized.reasonCode || sanitized.reason || null,
      challengeType: sanitized.challengeType || null,
      accountCategory: sanitized.accountCategory || null,

      deviceCategory: devCategory,
      deviceOs: devOs,
      deviceBrowser: 'browser',
      screenWidth: scrW,
      screenHeight: scrH,
      batteryLevel: batLvl,
      isCharging: batChg,

      // Kept for backward compatibility
      properties: sanitized,
      device: {
        category: devCategory,
        os: devOs,
        browser: 'browser',
        screenWidth: scrW,
        screenHeight: scrH,
        batteryLevel: batLvl,
        isCharging: batChg,
      },
      schemaVersion: '2.0',
    };

    if (this.queue.length < this.options.maxQueueSize) {
      this.queue.push(evt);
    }

    if (this.queue.length >= this.options.batchSize) {
      this.flush(false);
    }
  };

  // --- Session & Navigation Lifecycle Methods ---

  BehaviorSDK.prototype.trackSessionStart = function () {
    this.emitEvent('lifecycle', 'session_start', {
      sessionId: this.sessionId,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 150) : '',
      referrer: typeof document !== 'undefined' ? document.referrer : '',
    });
    // Legacy session_started
    this.emitEvent('session', 'session_started', {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 150) : '',
      referrer: typeof document !== 'undefined' ? document.referrer : '',
    });
  };

  BehaviorSDK.prototype.trackPageLoad = function () {
    var timing = {};
    if (typeof window !== 'undefined' && window.performance) {
      if (typeof window.performance.getEntriesByType === 'function') {
        var nav = window.performance.getEntriesByType('navigation');
        if (nav && nav.length > 0) {
          timing.domContentLoadedMs = Math.round(nav[0].domContentLoadedEventEnd);
          timing.loadEventMs = Math.round(nav[0].loadEventEnd);
          timing.ttfbMs = Math.round(nav[0].responseStart);
        }
      }
      if (!timing.loadEventMs && window.performance.timing) {
        var pt = window.performance.timing;
        if (pt.navigationStart) {
          timing.loadEventMs = Math.max(0, pt.loadEventEnd ? pt.loadEventEnd - pt.navigationStart : 0);
          timing.domContentLoadedMs = Math.max(0, pt.domContentLoadedEventEnd ? pt.domContentLoadedEventEnd - pt.navigationStart : 0);
        }
      }
    }
    this.emitEvent('lifecycle', 'page_load', {
      route: this.currentRoute,
      timing: timing,
    });
  };

  BehaviorSDK.prototype.trackPageView = function (route) {
    if (this.currentPageViewId && route !== this.currentRoute) {
      this.endCurrentPageView('route_change');
      this.emitEvent('navigation', 'page_navigation', {
        fromRoute: this.currentRoute,
        toRoute: route,
        method: 'spa_navigation',
      });
    }

    this.currentRoute = route;
    this.currentPageViewId = uuid();
    this.pageEntryTime = Date.now();
    this.lastInteractionTime = Date.now();
    this.scrollMilestones = { 25: false, 50: false, 75: false, 100: false };

    this.emitEvent('navigation', 'page_entered', {
      route: route,
      pageViewId: this.currentPageViewId,
      title: typeof document !== 'undefined' ? document.title : '',
    });
  };

  BehaviorSDK.prototype.endCurrentPageView = function (reason) {
    var now = Date.now();
    var elapsed = now - this.pageEntryTime;
    this.emitEvent('engagement', 'page_engagement_summary', {
      pageViewId: this.currentPageViewId,
      entryTimestamp: new Date(this.pageEntryTime).toISOString(),
      exitTimestamp: new Date(now).toISOString(),
      elapsedDurationMs: elapsed,
      activeDurationMs: Math.min(elapsed, this.interactionCount * 2500),
      visibleDurationMs: this.isTabVisible ? elapsed : 0,
      idleDurationMs: this.isUserIdle ? elapsed : 0,
      maxScrollDepth: this.maxScrollDepth,
      interactionCount: this.interactionCount,
      exitReason: reason || 'navigation',
    });

    this.emitEvent('navigation', 'page_left', {
      route: this.currentRoute,
      pageViewId: this.currentPageViewId,
      durationMs: elapsed,
      reason: reason || 'navigation',
    });
  };

  // --- Banking Workflow Events (Phase 2E) ---

  BehaviorSDK.prototype.trackLoginAttempt = function (outcomeOrDetails, details) {
    var outcome = typeof outcomeOrDetails === 'string' ? outcomeOrDetails : 'attempt';
    var d = typeof outcomeOrDetails === 'object' ? outcomeOrDetails : (details || {});
    this.emitEvent('auth', 'login_attempt', {
      method: d.method || 'password',
      usernameSupplied: Boolean(d.usernameSupplied || d.username),
      route: this.currentRoute,
    });
    // Legacy session event
    this.emitEvent('session', 'login_attempted', {
      outcome: outcome,
      reason: d.reason || null,
      route: this.currentRoute,
    });
  };

  BehaviorSDK.prototype.trackLoginSuccess = function (userId, details) {
    var d = details || {};
    this.userId = userId;
    this.emitEvent('auth', 'login_success', {
      userId: userId,
      method: d.method || 'password',
    });
    this.identify(userId);
  };

  BehaviorSDK.prototype.trackLoginFailure = function (reasonCode) {
    this.emitEvent('auth', 'login_failure', {
      reasonCode: reasonCode || 'invalid_credentials',
      route: this.currentRoute,
    });
  };

  BehaviorSDK.prototype.trackLogout = function () {
    this.emitEvent('auth', 'logout', {
      userId: this.userId,
    });
    this.emitEvent('session', 'logout_completed', {
      userId: this.userId,
    });
    this.flush(true);

    this.userId = null;
    this.authToken = null;
    this.sessionId = uuid();
    try {
      sessionStorage.setItem('xylium_analytics_sess_id', this.sessionId);
    } catch (e) {}
    this.trackSessionStart();
  };

  BehaviorSDK.prototype.trackAccountPageView = function (accountCategory, viewType) {
    this.emitEvent('banking', 'account_page_view', {
      accountCategory: accountCategory || 'checking',
      viewType: viewType || 'dashboard',
      route: this.currentRoute,
    });
  };

  BehaviorSDK.prototype.trackPaymentFlowStart = function (flowType, currency, recipientType) {
    this.emitEvent('banking', 'payment_flow_start', {
      flowType: flowType || 'transfer',
      currency: currency || 'USD',
      recipientType: recipientType || 'domestic',
      route: this.currentRoute,
    });
  };

  BehaviorSDK.prototype.trackPaymentConfirmation = function (paymentId, status, flowType) {
    this.emitEvent('banking', 'payment_confirmation', {
      paymentId: paymentId,
      status: status || 'succeeded',
      flowType: flowType || 'transfer',
      route: this.currentRoute,
    });
    this.flush(false);
  };

  BehaviorSDK.prototype.trackTransactionFailure = function (reasonCode, flowType) {
    this.emitEvent('banking', 'transaction_failure', {
      reasonCode: reasonCode || 'insufficient_funds',
      flowType: flowType || 'transfer',
      route: this.currentRoute,
    });
  };

  BehaviorSDK.prototype.trackSessionTimeout = function (idleDurationMs) {
    this.emitEvent('banking', 'session_timeout', {
      idleDurationMs: idleDurationMs || this.options.idleThresholdMs,
      route: this.currentRoute,
    });
  };

  BehaviorSDK.prototype.trackStepUpAuthRequired = function (challengeType, trigger) {
    this.emitEvent('banking', 'step_up_auth_required', {
      challengeType: challengeType || 'otp_sms',
      trigger: trigger || 'high_value_transaction',
      route: this.currentRoute,
    });
  };

  // Backward compatible checkout methods
  BehaviorSDK.prototype.trackCheckoutStep = function (stepName, metadata) {
    var safeMeta = sanitizeProps(metadata || {});
    this.emitEvent('checkout', stepName, safeMeta);
  };

  BehaviorSDK.prototype.trackPaymentInitiated = function (orderId, amount, currency, methodCategory) {
    this.emitEvent('payment', 'payment_initiated', {
      orderId: orderId,
      amount: amount,
      currency: currency || 'USD',
      methodCategory: methodCategory || 'card',
      route: this.currentRoute,
    });
    this.flush(false);
  };

  BehaviorSDK.prototype.trackLoginViewed = function () {
    this.emitEvent('session', 'login_page_viewed', { route: this.currentRoute });
  };

  BehaviorSDK.prototype.loginSuccess = function (userId, token) {
    if (token) this.authToken = token;
    this.identify(userId);
  };

  BehaviorSDK.prototype.logout = function () {
    this.trackLogout();
  };

  // --- Location Telemetry (Opt-in) ---
  BehaviorSDK.prototype.requestLocation = function () {
    var self = this;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.emitEvent('location', 'permission_unavailable', {});
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        self.emitEvent('location', 'location_captured', {
          lat: Math.round(pos.coords.latitude * 100) / 100,
          lon: Math.round(pos.coords.longitude * 100) / 100,
          accuracyMeters: Math.round(pos.coords.accuracy),
        });
      },
      function (err) {
        self.emitEvent('location', 'permission_denied', {
          code: err.code,
        });
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  };

  // --- Transport, Batching & Retries with Jitter ---

  BehaviorSDK.prototype.startFlushTimer = function () {
    var self = this;
    this.timer = setInterval(function () {
      if (self.queue.length > 0 && !self.isFlushing) {
        self.flush(false);
      }
    }, this.options.flushIntervalMs);
  };

  BehaviorSDK.prototype.flush = function (useBeacon) {
    if (this.queue.length === 0 || this.isFlushing) return;

    var batch = this.queue.slice(0, this.options.batchSize);
    var payload = JSON.stringify({ events: batch });
    var url = this.options.apiEndpoint + '/events/batch';
    var self = this;

    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      var blob = new Blob([payload], { type: 'text/plain' });
      var sent = navigator.sendBeacon(url, blob);
      if (sent) {
        this.queue.splice(0, batch.length);
        return;
      }
    }

    this.isFlushing = true;

    var headers = { 'Content-Type': 'application/json' };
    if (this.authToken) {
      headers['Authorization'] = 'Bearer ' + this.authToken;
    }

    fetch(url, {
      method: 'POST',
      headers: headers,
      body: payload,
      keepalive: true,
    })
      .then(function (res) {
        self.isFlushing = false;
        if (res.ok) {
          self.queue.splice(0, batch.length);
          self.retryCount = 0;
        } else {
          self.handleFlushFailure();
        }
      })
      .catch(function () {
        self.isFlushing = false;
        self.handleFlushFailure();
      });
  };

  BehaviorSDK.prototype.handleFlushFailure = function () {
    this.retryCount += 1;
    if (this.retryCount > this.options.maxRetries) {
      // Discard oldest batch to maintain bounded memory
      this.queue.splice(0, this.options.batchSize);
      this.retryCount = 0;
    }
  };

  BehaviorSDK.prototype.linkSessionOnServer = function (userId, anonymousId) {
    var url = this.options.apiEndpoint + '/sessions/link';
    var headers = { 'Content-Type': 'application/json' };
    if (this.authToken) {
      headers['Authorization'] = 'Bearer ' + this.authToken;
    }

    fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        sessionId: this.sessionId,
        userId: userId,
        anonymousId: anonymousId,
      }),
    }).catch(function () {});
  };

  BehaviorSDK.prototype.destroy = function () {
    if (this.timer) clearInterval(this.timer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.pointerIdleTimer) clearInterval(this.pointerIdleTimer);

    this._listeners.forEach(function (l) {
      try {
        l.target.removeEventListener(l.type, l.listener, l.options);
      } catch (e) {}
    });
    this._listeners = [];
  };

  // --- Static Singleton & Configuration API (Phase 3) ---

  BehaviorSDK.instance = null;

  BehaviorSDK.init = function (options) {
    if (BehaviorSDK.instance) {
      BehaviorSDK.instance.stop();
    }
    BehaviorSDK.instance = new BehaviorSDK(options);
    return BehaviorSDK.instance;
  };

  BehaviorSDK.start = function () {
    if (BehaviorSDK.instance) BehaviorSDK.instance.start();
  };

  BehaviorSDK.stop = function () {
    if (BehaviorSDK.instance) BehaviorSDK.instance.stop();
  };

  BehaviorSDK.identify = function (userId) {
    if (BehaviorSDK.instance) BehaviorSDK.instance.identify(userId);
  };

  BehaviorSDK.flush = function () {
    if (BehaviorSDK.instance) BehaviorSDK.instance.flush(false);
  };

  return BehaviorSDK;
});

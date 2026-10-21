const mongoose = require('mongoose');

const BehaviourEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, default: null, index: true },
    anonymousId: { type: String, default: null, index: true },
    sessionId: { type: String, required: true, index: true },
    tenantId: { type: String, default: 'default', index: true },
    clientId: { type: String, default: null, index: true },
    sequenceNumber: { type: Number, default: 0 },
    eventName: { type: String, required: true, index: true },
    eventType: { type: String, default: null, index: true },
    eventCategory: {
      type: String,
      required: true,
      enum: [
        'session',
        'lifecycle',
        'pointer',
        'keyboard',
        'touch',
        'scroll',
        'engagement',
        'form',
        'navigation',
        'auth',
        'banking',
        'checkout',
        'payment',
        'error',
        'custom',
        'location',
        'device',
        'identity',
      ],
      index: true,
    },
    timestamp: { type: Date, required: true },
    serverReceivedAt: { type: Date, default: Date.now, index: true },
    pageId: { type: String, default: null },
    page: { type: String, default: null },
    sanitizedRoute: { type: String, default: '/' },

    // --- 1. Pointer & Mouse Fields (Top-Level) ---
    pointerX: { type: Number, default: null },
    pointerY: { type: Number, default: null },
    pointerSpeedPxPerMs: { type: Number, default: null },
    pointerAngleDeg: { type: Number, default: null },
    pointerDistancePx: { type: Number, default: null },
    isStraightLine: { type: Boolean, default: null },
    pointerHoldDurationMs: { type: Number, default: null },
    hoverDurationMs: { type: Number, default: null },
    targetCategory: { type: String, default: null },
    targetId: { type: String, default: null },
    textPreview: { type: String, default: null },

    // --- 2. Keyboard Fields (Top-Level) ---
    keyMasked: { type: String, default: null },
    flightTimeMs: { type: Number, default: null },
    holdTimeMs: { type: Number, default: null },
    keysPerSecond: { type: Number, default: null },
    isTypingPause: { type: Boolean, default: null },

    // --- 3. Form & Input Fields (Top-Level) ---
    fieldId: { type: String, default: null },
    fieldCategory: { type: String, default: null },
    fromField: { type: String, default: null },
    toField: { type: String, default: null },
    fieldDurationMs: { type: Number, default: null },
    pasteDetected: { type: Boolean, default: null },
    formId: { type: String, default: null },

    // --- 4. Scroll Fields (Top-Level) ---
    scrollY: { type: Number, default: null },
    scrollDirection: { type: String, default: null },
    scrollDeltaPx: { type: Number, default: null },
    scrollDepthPercent: { type: Number, default: null },
    scrollMilestone: { type: Number, default: null },

    // --- 5. Touch & Mobile Fields (Top-Level) ---
    touchCount: { type: Number, default: null },
    touchDurationMs: { type: Number, default: null },
    gestureType: { type: String, default: null },
    swipeDirection: { type: String, default: null },
    swipeDistancePx: { type: Number, default: null },
    orientation: { type: String, default: null },

    // --- 6. Lifecycle & Navigation Fields (Top-Level) ---
    fromRoute: { type: String, default: null },
    toRoute: { type: String, default: null },
    navigationMethod: { type: String, default: null },
    visibilityState: { type: String, default: null },
    tabActive: { type: Boolean, default: null },
    idleDurationMs: { type: Number, default: null },
    pageLoadTimeMs: { type: Number, default: null },
    domContentLoadedMs: { type: Number, default: null },
    ttfbMs: { type: Number, default: null },

    // --- 7. Banking & Financial Workflow Fields (Top-Level) ---
    flowType: { type: String, default: null },
    paymentId: { type: String, default: null },
    paymentAmount: { type: Number, default: null },
    paymentCurrency: { type: String, default: null },
    recipientType: { type: String, default: null },
    paymentStatus: { type: String, default: null },
    reasonCode: { type: String, default: null },
    challengeType: { type: String, default: null },
    accountCategory: { type: String, default: null },

    // --- 8. Flattened Device & Environmental Context (Top-Level) ---
    deviceCategory: { type: String, default: null },
    deviceOs: { type: String, default: null },
    deviceBrowser: { type: String, default: null },
    screenWidth: { type: Number, default: null },
    screenHeight: { type: Number, default: null },
    batteryLevel: { type: Number, default: null },
    isCharging: { type: Boolean, default: null },

    // Fallbacks for backward compatibility
    properties: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    device: {
      category: { type: String, default: 'unknown' },
      os: { type: String, default: 'unknown' },
      browser: { type: String, default: 'unknown' },
      screenWidth: { type: Number, default: null },
      screenHeight: { type: Number, default: null },
      batteryLevel: { type: Number, default: null },
      isCharging: { type: Boolean, default: null },
    },
    sdkVersion: { type: String, default: '2.1.0' },
    schemaVersion: { type: String, default: '2.0' },
  },
  {
    collection: 'behaviour_events',
    timestamps: false,
  }
);

BehaviourEventSchema.index({ userId: 1, timestamp: -1 });
BehaviourEventSchema.index({ sessionId: 1, timestamp: -1 });
BehaviourEventSchema.index({ sessionId: 1, sequenceNumber: 1 });
BehaviourEventSchema.index({ eventType: 1, timestamp: -1 });
BehaviourEventSchema.index({ userId: 1, eventCategory: 1, timestamp: -1 });
BehaviourEventSchema.index({ tenantId: 1, userId: 1, timestamp: -1 });

module.exports = mongoose.model('BehaviourEvent', BehaviourEventSchema);

const { z } = require('zod');

const SENSITIVE_KEY_REGEX = /^(password|passwd|secret|cvv|cvc|card_?number|token|otp|pin|auth_?code|ssn)$/i;

function sanitizeProperties(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(props)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      continue; // completely strip sensitive keys
    }
    // ensure value is not excessively deep or long
    if (typeof value === 'string') {
      cleaned[key] = value.length > 1000 ? value.slice(0, 1000) : value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      cleaned[key] = value;
    } else if (Array.isArray(value)) {
      cleaned[key] = value.slice(0, 50);
    } else if (typeof value === 'object') {
      cleaned[key] = sanitizeProperties(value);
    }
  }
  return cleaned;
}

const AnalyticsEventSchema = z.object({
  eventId: z.string().min(5).max(128),
  sessionId: z.string().min(5).max(128),
  anonymousId: z.string().max(128).nullable().optional(),
  userId: z.string().max(128).nullable().optional(),
  tenantId: z.string().max(128).optional().default('default'),
  clientId: z.string().max(128).nullable().optional(),
  sequenceNumber: z.number().int().nonnegative().optional().default(0),
  eventName: z.string().max(80).optional(),
  eventType: z.string().max(80).optional(),
  eventCategory: z.enum([
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
  ]),
  timestamp: z.union([z.string(), z.number()]).transform((val) => new Date(val)),
  pageId: z.string().max(128).nullable().optional(),
  page: z.string().max(256).nullable().optional(),
  sanitizedRoute: z.string().max(256).optional().default('/'),

  // Individual Top-Level Fields (Optional on input, populated by transformer)
  pointerX: z.number().nullable().optional(),
  pointerY: z.number().nullable().optional(),
  pointerSpeedPxPerMs: z.number().nullable().optional(),
  pointerAngleDeg: z.number().nullable().optional(),
  pointerDistancePx: z.number().nullable().optional(),
  isStraightLine: z.boolean().nullable().optional(),
  pointerHoldDurationMs: z.number().nullable().optional(),
  hoverDurationMs: z.number().nullable().optional(),
  targetCategory: z.string().max(60).nullable().optional(),
  targetId: z.string().max(120).nullable().optional(),
  textPreview: z.string().max(120).nullable().optional(),

  keyMasked: z.string().max(40).nullable().optional(),
  flightTimeMs: z.number().nullable().optional(),
  holdTimeMs: z.number().nullable().optional(),
  keysPerSecond: z.number().nullable().optional(),
  isTypingPause: z.boolean().nullable().optional(),

  fieldId: z.string().max(120).nullable().optional(),
  fieldCategory: z.string().max(60).nullable().optional(),
  fromField: z.string().max(120).nullable().optional(),
  toField: z.string().max(120).nullable().optional(),
  fieldDurationMs: z.number().nullable().optional(),
  pasteDetected: z.boolean().nullable().optional(),
  formId: z.string().max(120).nullable().optional(),

  scrollY: z.number().nullable().optional(),
  scrollDirection: z.string().max(20).nullable().optional(),
  scrollDeltaPx: z.number().nullable().optional(),
  scrollDepthPercent: z.number().nullable().optional(),
  scrollMilestone: z.number().nullable().optional(),

  touchCount: z.number().nullable().optional(),
  touchDurationMs: z.number().nullable().optional(),
  gestureType: z.string().max(40).nullable().optional(),
  swipeDirection: z.string().max(20).nullable().optional(),
  swipeDistancePx: z.number().nullable().optional(),
  orientation: z.string().max(40).nullable().optional(),

  fromRoute: z.string().max(256).nullable().optional(),
  toRoute: z.string().max(256).nullable().optional(),
  navigationMethod: z.string().max(60).nullable().optional(),
  visibilityState: z.string().max(30).nullable().optional(),
  tabActive: z.boolean().nullable().optional(),
  idleDurationMs: z.number().nullable().optional(),
  pageLoadTimeMs: z.number().nullable().optional(),
  domContentLoadedMs: z.number().nullable().optional(),
  ttfbMs: z.number().nullable().optional(),

  flowType: z.string().max(60).nullable().optional(),
  paymentId: z.string().max(128).nullable().optional(),
  paymentAmount: z.number().nullable().optional(),
  paymentCurrency: z.string().max(20).nullable().optional(),
  recipientType: z.string().max(60).nullable().optional(),
  paymentStatus: z.string().max(40).nullable().optional(),
  reasonCode: z.string().max(100).nullable().optional(),
  challengeType: z.string().max(60).nullable().optional(),
  accountCategory: z.string().max(60).nullable().optional(),

  deviceCategory: z.string().max(40).nullable().optional(),
  deviceOs: z.string().max(40).nullable().optional(),
  deviceBrowser: z.string().max(40).nullable().optional(),
  screenWidth: z.number().nullable().optional(),
  screenHeight: z.number().nullable().optional(),
  batteryLevel: z.number().nullable().optional(),
  isCharging: z.boolean().nullable().optional(),

  properties: z
    .record(z.unknown())
    .optional()
    .default({})
    .transform(sanitizeProperties),
  device: z
    .object({
      category: z.string().max(40).optional().default('unknown'),
      os: z.string().max(40).optional().default('unknown'),
      browser: z.string().max(40).optional().default('unknown'),
      screenWidth: z.number().nullable().optional(),
      screenHeight: z.number().nullable().optional(),
      batteryLevel: z.number().nullable().optional(),
      isCharging: z.boolean().nullable().optional(),
    })
    .passthrough()
    .optional()
    .default({}),
  sdkVersion: z.string().max(30).optional().default('2.1.0'),
  schemaVersion: z.string().max(10).optional().default('2.0'),
}).transform((data) => {
  const p = data.properties || {};
  const dev = data.device || {};
  const resolvedName = data.eventName || data.eventType || 'unknown_event';
  const resolvedType = data.eventType || data.eventName || 'unknown_event';
  const resolvedRoute = data.sanitizedRoute !== '/' ? data.sanitizedRoute : (data.page || '/');

  return {
    ...data,
    eventName: resolvedName,
    eventType: resolvedType,
    page: data.page || resolvedRoute,
    sanitizedRoute: resolvedRoute,

    // Unfold / map individual top-level fields
    pointerX: data.pointerX ?? (typeof p.x === 'number' ? p.x : (typeof p.clientX === 'number' ? p.clientX : null)),
    pointerY: data.pointerY ?? (typeof p.y === 'number' ? p.y : (typeof p.clientY === 'number' ? p.clientY : null)),
    pointerSpeedPxPerMs: data.pointerSpeedPxPerMs ?? (typeof p.speedPxPerMs === 'number' ? p.speedPxPerMs : (typeof p.velocity === 'number' ? p.velocity : null)),
    pointerAngleDeg: data.pointerAngleDeg ?? (typeof p.angleDeg === 'number' ? p.angleDeg : null),
    pointerDistancePx: data.pointerDistancePx ?? (typeof p.distancePx === 'number' ? p.distancePx : null),
    isStraightLine: data.isStraightLine ?? (typeof p.isStraightLine === 'boolean' ? p.isStraightLine : null),
    pointerHoldDurationMs: data.pointerHoldDurationMs ?? (typeof p.holdDurationMs === 'number' ? p.holdDurationMs : null),
    hoverDurationMs: data.hoverDurationMs ?? (typeof p.hoverDurationMs === 'number' ? p.hoverDurationMs : null),
    targetCategory: data.targetCategory ?? (p.targetCategory || p.elementCategory || null),
    targetId: data.targetId ?? (p.targetId || p.elementId || null),
    textPreview: data.textPreview ?? (p.textPreview || null),

    keyMasked: data.keyMasked ?? (p.key || null),
    flightTimeMs: data.flightTimeMs ?? (typeof p.flightTimeMs === 'number' ? p.flightTimeMs : null),
    holdTimeMs: data.holdTimeMs ?? (typeof p.holdTimeMs === 'number' ? p.holdTimeMs : null),
    keysPerSecond: data.keysPerSecond ?? (typeof p.keysPerSecond === 'number' ? p.keysPerSecond : null),
    isTypingPause: data.isTypingPause ?? (typeof p.isPause === 'boolean' ? p.isPause : null),

    fieldId: data.fieldId ?? (p.fieldId || p.field || null),
    fieldCategory: data.fieldCategory ?? (p.fieldCategory || null),
    fromField: data.fromField ?? (p.fromField || null),
    toField: data.toField ?? (p.toField || null),
    fieldDurationMs: data.fieldDurationMs ?? (typeof p.durationMs === 'number' ? p.durationMs : null),
    pasteDetected: data.pasteDetected ?? (typeof p.pasteDetected === 'boolean' ? p.pasteDetected : null),
    formId: data.formId ?? (p.formId || null),

    scrollY: data.scrollY ?? (typeof p.scrollY === 'number' ? p.scrollY : null),
    scrollDirection: data.scrollDirection ?? (p.direction || null),
    scrollDeltaPx: data.scrollDeltaPx ?? (typeof p.deltaPx === 'number' ? p.deltaPx : null),
    scrollDepthPercent: data.scrollDepthPercent ?? (typeof p.scrollDepthPercent === 'number' ? p.scrollDepthPercent : (typeof p.scrollDepth === 'number' ? p.scrollDepth : null)),
    scrollMilestone: data.scrollMilestone ?? (typeof p.milestonePercent === 'number' ? p.milestonePercent : null),

    touchCount: data.touchCount ?? (typeof p.touchCount === 'number' ? p.touchCount : null),
    touchDurationMs: data.touchDurationMs ?? (typeof p.durationMs === 'number' ? p.durationMs : null),
    gestureType: data.gestureType ?? (p.gestureType || null),
    swipeDirection: data.swipeDirection ?? (p.direction || null),
    swipeDistancePx: data.swipeDistancePx ?? (typeof p.distancePx === 'number' ? p.distancePx : (typeof p.approxDistancePx === 'number' ? p.approxDistancePx : null)),
    orientation: data.orientation ?? (p.orientation || null),

    fromRoute: data.fromRoute ?? (p.fromRoute || null),
    toRoute: data.toRoute ?? (p.toRoute || null),
    navigationMethod: data.navigationMethod ?? (p.method || null),
    visibilityState: data.visibilityState ?? (p.state || null),
    tabActive: data.tabActive ?? (typeof p.activeTab === 'boolean' ? p.activeTab : null),
    idleDurationMs: data.idleDurationMs ?? (typeof p.idleDurationMs === 'number' ? p.idleDurationMs : null),
    pageLoadTimeMs: data.pageLoadTimeMs ?? (p.timing && typeof p.timing.loadEventMs === 'number' ? p.timing.loadEventMs : null),
    domContentLoadedMs: data.domContentLoadedMs ?? (p.timing && typeof p.timing.domContentLoadedMs === 'number' ? p.timing.domContentLoadedMs : null),
    ttfbMs: data.ttfbMs ?? (p.timing && typeof p.timing.ttfbMs === 'number' ? p.timing.ttfbMs : null),

    flowType: data.flowType ?? (p.flowType || null),
    paymentId: data.paymentId ?? (p.paymentId || null),
    paymentAmount: data.paymentAmount ?? (typeof p.amount === 'number' ? p.amount : null),
    paymentCurrency: data.paymentCurrency ?? (p.currency || null),
    recipientType: data.recipientType ?? (p.recipientType || null),
    paymentStatus: data.paymentStatus ?? (p.status || null),
    reasonCode: data.reasonCode ?? (p.reasonCode || p.reason || null),
    challengeType: data.challengeType ?? (p.challengeType || null),
    accountCategory: data.accountCategory ?? (p.accountCategory || null),

    deviceCategory: data.deviceCategory ?? dev.category ?? 'unknown',
    deviceOs: data.deviceOs ?? dev.os ?? 'unknown',
    deviceBrowser: data.deviceBrowser ?? dev.browser ?? 'unknown',
    screenWidth: data.screenWidth ?? (typeof dev.screenWidth === 'number' ? dev.screenWidth : null),
    screenHeight: data.screenHeight ?? (typeof dev.screenHeight === 'number' ? dev.screenHeight : null),
    batteryLevel: data.batteryLevel ?? (typeof dev.batteryLevel === 'number' ? dev.batteryLevel : null),
    isCharging: data.isCharging ?? (typeof dev.isCharging === 'boolean' ? dev.isCharging : null),
  };
});

const EventBatchSchema = z.object({
  events: z.array(AnalyticsEventSchema).min(1).max(500),
});

const SessionStartSchema = z.object({
  sessionId: z.string().min(5).max(128),
  anonymousId: z.string().max(128).nullable().optional(),
  tenantId: z.string().max(128).optional().default('default'),
  startedAt: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val) => (val ? new Date(val) : new Date())),
  deviceMetadata: z.record(z.unknown()).optional().default({}),
});

const SessionEndSchema = z.object({
  sessionId: z.string().min(5).max(128),
  endedAt: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val) => (val ? new Date(val) : new Date())),
  summary: z.record(z.unknown()).optional().default({}),
});

const SessionLinkSchema = z.object({
  sessionId: z.string().min(5).max(128),
  userId: z.string().min(1).max(128),
  anonymousId: z.string().max(128).nullable().optional(),
});

const PaymentVerifySchema = z.object({
  paymentId: z.string().min(3).max(128),
  orderId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  sessionId: z.string().min(5).max(128),
  tenantId: z.string().max(128).optional().default('default'),
  amount: z.number().positive(),
  currency: z.string().max(10).optional().default('USD'),
  status: z.enum(['initiated', 'pending', 'succeeded', 'failed', 'cancelled']),
  paymentMethodCategory: z.string().max(40).optional().default('card'),
  failureReason: z.string().max(256).nullable().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

module.exports = {
  AnalyticsEventSchema,
  EventBatchSchema,
  SessionStartSchema,
  SessionEndSchema,
  SessionLinkSchema,
  PaymentVerifySchema,
  sanitizeProperties,
};

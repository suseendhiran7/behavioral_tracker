const crypto = require('crypto');
const { z } = require('zod');

// Sensitive field names to strip from properties to prevent credential/PII leaks
const SENSITIVE_PROPERTY_REGEX = /^(password|passcode|pin|otp|cvv|cvc|cardnumber|creditcard|card_number|card_pan|ssn|auth_secret)$/i;

function sanitizeProperties(props, depth = 0) {
  if (!props || typeof props !== 'object' || depth > 5) {
    return props || {};
  }
  if (Array.isArray(props)) {
    return props.slice(0, 100).map((item) => sanitizeProperties(item, depth + 1));
  }
  const clean = {};
  for (const [key, value] of Object.entries(props)) {
    if (SENSITIVE_PROPERTY_REGEX.test(key)) {
      continue; // Redacted / omitted entirely
    }
    if (value && typeof value === 'object') {
      clean[key] = sanitizeProperties(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

const SharedEventZodSchema = z.object({
  eventId: z.string().min(1).default(() => `evt_${crypto.randomUUID()}`),
  tenantId: z.string().min(1).default('default'),
  clientId: z.string().nullable().optional().default(null),
  userId: z.string().nullable().optional().default(null),
  sessionId: z.string().min(1),
  eventName: z.string().min(1),
  eventType: z.string().nullable().optional().default(null),
  eventCategory: z.string().default('custom'),
  timestamp: z.coerce.date().default(() => new Date()),
  serverReceivedAt: z.coerce.date().default(() => new Date()),
  sequenceNumber: z.number().int().nonnegative().default(0),
  page: z.string().nullable().optional().default(null),
  sanitizedRoute: z.string().nullable().optional().default('/'),
  sdkVersion: z.string().default('2.1.0'),
  schemaVersion: z.string().default('2.0'),

  // Pointer dynamics
  pointerX: z.number().nullable().optional().default(null),
  pointerY: z.number().nullable().optional().default(null),
  pointerSpeedPxPerMs: z.number().nullable().optional().default(null),
  pointerAngleDeg: z.number().nullable().optional().default(null),
  pointerDistancePx: z.number().nullable().optional().default(null),
  isStraightLine: z.boolean().nullable().optional().default(null),
  pointerHoldDurationMs: z.number().nullable().optional().default(null),
  hoverDurationMs: z.number().nullable().optional().default(null),
  targetCategory: z.string().nullable().optional().default(null),
  targetId: z.string().nullable().optional().default(null),
  textPreview: z.string().nullable().optional().default(null),

  // Keyboard dynamics
  keyMasked: z.string().nullable().optional().default(null),
  flightTimeMs: z.number().nullable().optional().default(null),
  holdTimeMs: z.number().nullable().optional().default(null),
  keysPerSecond: z.number().nullable().optional().default(null),
  isTypingPause: z.boolean().nullable().optional().default(null),

  // Form & inputs
  fieldId: z.string().nullable().optional().default(null),
  fieldCategory: z.string().nullable().optional().default(null),
  fromField: z.string().nullable().optional().default(null),
  toField: z.string().nullable().optional().default(null),
  fieldDurationMs: z.number().nullable().optional().default(null),
  pasteDetected: z.boolean().nullable().optional().default(null),
  formId: z.string().nullable().optional().default(null),

  // Scroll
  scrollY: z.number().nullable().optional().default(null),
  scrollDirection: z.string().nullable().optional().default(null),
  scrollDeltaPx: z.number().nullable().optional().default(null),
  scrollDepthPercent: z.number().nullable().optional().default(null),
  scrollMilestone: z.number().nullable().optional().default(null),

  // Touch
  touchCount: z.number().nullable().optional().default(null),
  touchDurationMs: z.number().nullable().optional().default(null),
  gestureType: z.string().nullable().optional().default(null),
  swipeDirection: z.string().nullable().optional().default(null),
  swipeDistancePx: z.number().nullable().optional().default(null),
  orientation: z.string().nullable().optional().default(null),

  // Lifecycle & Navigation
  fromRoute: z.string().nullable().optional().default(null),
  toRoute: z.string().nullable().optional().default(null),
  navigationMethod: z.string().nullable().optional().default(null),
  visibilityState: z.string().nullable().optional().default(null),
  tabActive: z.boolean().nullable().optional().default(null),
  idleDurationMs: z.number().nullable().optional().default(null),
  pageLoadTimeMs: z.number().nullable().optional().default(null),
  domContentLoadedMs: z.number().nullable().optional().default(null),
  ttfbMs: z.number().nullable().optional().default(null),

  // Banking
  flowType: z.string().nullable().optional().default(null),
  paymentId: z.string().nullable().optional().default(null),
  paymentAmount: z.number().nullable().optional().default(null),
  paymentCurrency: z.string().nullable().optional().default(null),
  recipientType: z.string().nullable().optional().default(null),
  paymentStatus: z.string().nullable().optional().default(null),
  reasonCode: z.string().nullable().optional().default(null),
  challengeType: z.string().nullable().optional().default(null),
  accountCategory: z.string().nullable().optional().default(null),

  // Device & environment
  deviceCategory: z.string().nullable().optional().default('unknown'),
  deviceOs: z.string().nullable().optional().default('unknown'),
  deviceBrowser: z.string().nullable().optional().default('unknown'),
  screenWidth: z.number().nullable().optional().default(null),
  screenHeight: z.number().nullable().optional().default(null),
  batteryLevel: z.number().nullable().optional().default(null),
  isCharging: z.boolean().nullable().optional().default(null),

  properties: z.record(z.any()).default(() => ({})),
  device: z.record(z.any()).default(() => ({})),
});

/**
 * Normalize and validate an event according to the canonical schema.
 * @param {Object} raw
 * @param {Object} context
 * @returns {Object} Normalized canonical event document
 */
function normalizeEvent(raw, context = {}) {
  const sanitizedProps = sanitizeProperties(raw.properties || {});

  // Extract nested device properties if flattened fields not directly provided
  const device = raw.device || {};
  const deviceCategory = raw.deviceCategory || device.category || 'unknown';
  const deviceOs = raw.deviceOs || device.os || 'unknown';
  const deviceBrowser = raw.deviceBrowser || device.browser || 'unknown';
  const screenWidth = raw.screenWidth ?? device.screenWidth ?? null;
  const screenHeight = raw.screenHeight ?? device.screenHeight ?? null;
  const batteryLevel = raw.batteryLevel ?? device.batteryLevel ?? null;
  const isCharging = raw.isCharging ?? device.isCharging ?? null;

  // Accept the SDK's raw `type`/`name` as a fallback so a caller that forgets
  // to map SDK events still produces a valid record instead of a 400.
  const eventType = raw.eventType || raw.eventName || raw.type || null;

  const input = {
    ...raw,
    eventId: raw.eventId || `evt_${crypto.randomUUID()}`,
    tenantId: raw.tenantId || context.tenantId || 'default',
    userId: context.userId !== undefined ? context.userId : (raw.userId || null),
    clientId: raw.clientId || context.clientId || null,
    eventType,
    eventName: raw.eventName || (raw.type === 'custom' && raw.name) || eventType || 'unknown_event',
    eventCategory: raw.eventCategory || 'custom',
    page: raw.page || raw.sanitizedRoute || '/',
    sanitizedRoute: raw.sanitizedRoute || raw.page || '/',
    deviceCategory,
    deviceOs,
    deviceBrowser,
    screenWidth,
    screenHeight,
    batteryLevel,
    isCharging,
    device,
    properties: sanitizedProps,
  };

  const parsed = SharedEventZodSchema.safeParse(input);
  if (!parsed.success) {
    const error = new Error(`Event validation failed: ${JSON.stringify(parsed.error.flatten())}`);
    error.status = 400;
    error.details = parsed.error.flatten();
    throw error;
  }

  return parsed.data;
}

module.exports = {
  SharedEventZodSchema,
  normalizeEvent,
  sanitizeProperties,
};

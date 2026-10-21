const config = require('./config');
const { LoginEvent, SessionEvent, PaymentEvent } = require('./models/EventStores');
const EventBatch = require('./models/EventBatch');
const Session = require('./models/Session');
const ipIntelService = require('./ipIntelService');
const databaseRegistry = require('./config/database-registry');

class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function deriveSessionId(events) {
  const ids = new Set(events.map((e) => e.sessionId).filter(Boolean));
  if (ids.size === 0) throw new BadRequestError('no sessionId present on any event');
  if (ids.size > 1) throw new BadRequestError('inconsistent sessionId within batch');
  return [...ids][0];
}

function isLoginEvent(evt) {
  return evt.type === 'identify' && !!evt.userId;
}

function isLogoutEvent(evt) {
  return evt.type === 'logout';
}

function isPaymentEvent(evt) {
  if (evt.pageType === 'payment') return true;
  return typeof evt.page === 'string' && config.paymentPagePattern.test(evt.page);
}

/**
 * Walk the batch in order and route every event to its bucket.
 *
 *   phase 'login'   → login_events   (until an identify event, which is
 *                                     itself stored in login_events)
 *   phase 'session' → payment_events if the event is on a payment page,
 *                     otherwise session_events. A logout event is stored in
 *                     session_events and switches the phase back to 'login'.
 */
function splitEvents(events, startPhase) {
  const buckets = { login: [], session: [], payment: [] };
  let phase = startPhase;
  let loginUserId = null;
  let loggedOut = false;

  for (const evt of events) {
    if (phase === 'login') {
      buckets.login.push(evt);
      if (isLoginEvent(evt)) {
        phase = 'session';
        loginUserId = evt.userId;
      }
    } else if (isLogoutEvent(evt)) {
      buckets.session.push(evt);
      phase = 'login';
      loggedOut = true;
    } else if (isPaymentEvent(evt)) {
      buckets.payment.push(evt);
    } else {
      buckets.session.push(evt);
    }
  }
  return { buckets, endPhase: phase, loginUserId, loggedOut };
}

// ---------- SDK event -> canonical event (used by the DB adapters) ----------

const CATEGORY_BY_TYPE = {
  mousemove: 'pointer', click: 'pointer', rightclick: 'pointer', double_click: 'pointer',
  single_click_confirmed: 'pointer', mousedown: 'pointer', mouseup: 'pointer',
  keydown: 'keyboard', keyup: 'keyboard', keytiming: 'keyboard',
  shift_pattern: 'keyboard', keyboard_shortcut: 'keyboard',
  copy: 'form', paste: 'form', focus: 'form', blur: 'form',
  field_cleared: 'form', field_retyped: 'form', field_bulk_insert: 'form',
  scroll: 'scroll',
  multi_touch: 'touch',
  visibilitychange: 'lifecycle', visibility_away: 'lifecycle', window_focus: 'lifecycle',
  resize: 'lifecycle', idle_start: 'lifecycle', idle_end: 'lifecycle',
  identify: 'identity', logout: 'identity',
  automation_signal: 'device', composite_fingerprint: 'device', canvas_fingerprint: 'device',
  webgl_fingerprint: 'device', font_fingerprint: 'device', audio_fingerprint: 'device',
};

function categoryFor(type) {
  if (CATEGORY_BY_TYPE[type]) return CATEGORY_BY_TYPE[type];
  if (/^touch|swipe/.test(type)) return 'touch';
  if (/^field_|^form_/.test(type)) return 'form';
  if (/^key/.test(type)) return 'keyboard';
  if (/^(mouse|pointer)/.test(type)) return 'pointer';
  return 'custom';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);

// Fields of the SDK envelope that are mapped explicitly below; everything
// else the SDK sent is kept in `properties` so nothing is lost.
const ENVELOPE_KEYS = new Set([
  'type', 'name', 't', 'sessionId', 'userId', 'page', 'pageType', 'props',
  'x', 'y', 'field', 'state', 'holdTimeMs', 'flightTimeMs', 'idleDurationMs',
]);

function toCanonicalEvent(evt, ctx) {
  const type = evt.type || 'unknown_event';
  const isCustom = type === 'custom' && typeof evt.name === 'string' && evt.name;
  const category = categoryFor(type);

  const extras = {};
  for (const [k, v] of Object.entries(evt)) {
    if (!ENVELOPE_KEYS.has(k) && v !== undefined) extras[k] = v;
  }

  return {
    sessionId: ctx.sessionId,
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    userId: ctx.userId,
    eventName: isCustom ? evt.name : type,
    eventType: type,
    eventCategory: category,
    sequenceNumber: typeof evt.sequenceNumber === 'number' ? evt.sequenceNumber : ctx.idx,
    page: str(evt.page),
    sanitizedRoute: str(evt.page),

    // `y` means scroll position on scroll events and pointer position otherwise
    pointerX: category === 'pointer' ? num(evt.x) : null,
    pointerY: category === 'pointer' ? num(evt.y) : null,
    scrollY: category === 'scroll' ? num(evt.y) : null,

    fieldId: str(evt.field),
    holdTimeMs: num(evt.holdTimeMs),
    flightTimeMs: num(evt.flightTimeMs),
    idleDurationMs: num(evt.idleDurationMs),
    visibilityState: str(evt.state),

    device: { fingerprint: ctx.deviceFingerprint },
    properties: {
      ...extras,
      ...(evt.props && typeof evt.props === 'object' ? evt.props : {}),
      sdkRelativeMs: num(evt.t), // ms since page start, NOT a wall-clock time
      pageType: evt.pageType ?? null,
    },
  };
}

function firstUserId(events, fallback) {
  const e = events.find((x) => x.userId);
  return e ? e.userId : fallback || null;
}

/**
 * Ingest one SDK batch: split it by session phase and store each part in
 * login_events / session_events / payment_events.
 */
async function ingest(dto, clientIp) {
  if (dto.events.length > config.maxBatchEvents) {
    throw new BadRequestError(`too many events (max ${config.maxBatchEvents})`);
  }

  const sessionId = deriveSessionId(dto.events);
  const existing = await Session.findById(sessionId).lean();

  // Sessions created before this change have no `phase`; infer it.
  const startPhase = existing ? existing.phase || (existing.userId ? 'session' : 'login') : 'login';
  const knownUserId = existing ? existing.userId : null;

  const { buckets, endPhase, loginUserId, loggedOut } = splitEvents(dto.events, startPhase);

  const identifyEvt = dto.events.find((e) => e.type === 'identify' && !!e.userId);
  const browserUserId = identifyEvt ? identifyEvt.userId : (loginUserId || knownUserId || null);

  const base = {
    tenantId: dto.tenantId,
    appId: dto.appId,
    sessionId,
    deviceFingerprint: dto.deviceFingerprint,
    clientIp,
  };

  const mongoose = require('mongoose');
  const activeType = databaseRegistry.getActiveType();
  const activeAdapter = databaseRegistry.getActiveAdapter();

  if (activeType === 'postgresql' && activeAdapter) {
    // The SDK sends its own compact shape ({ type, t, x, y, field, props, ... }),
    // but the adapters run normalizeEvent(), which validates the canonical
    // schema ({ eventName, eventType, eventCategory, pointerX, ... }).
    // Translate first, otherwise every batch fails with "eventName: Required".
    const rawEvents = dto.events.map((e, idx) =>
      toCanonicalEvent(e, {
        idx,
        sessionId,
        tenantId: dto.tenantId,
        clientId: dto.appId,
        userId: e.userId || browserUserId || null,
        deviceFingerprint: dto.deviceFingerprint,
      })
    );
    await activeAdapter.saveEvents(rawEvents);
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    await EventBatch.create({
      tenantId: dto.tenantId,
      appId: dto.appId,
      sessionId,
      userId: browserUserId,
      deviceFingerprint: dto.deviceFingerprint,
      eventCount: dto.events.length,
      events: dto.events,
      clientIp,
    }).catch((err) => console.warn('[collect] EventBatch.create warning:', err.message));
  }

  const writes = [];
  if (buckets.login.length) {
    writes.push(
      LoginEvent.create({ ...base, userId: loginUserId, eventCount: buckets.login.length, events: buckets.login })
    );
  }
  if (buckets.session.length) {
    writes.push(
      SessionEvent.create({
        ...base,
        userId: firstUserId(buckets.session, loginUserId || knownUserId),
        eventCount: buckets.session.length,
        events: buckets.session,
      })
    );
  }
  if (buckets.payment.length) {
    writes.push(
      PaymentEvent.create({
        ...base,
        userId: firstUserId(buckets.payment, loginUserId || knownUserId),
        eventCount: buckets.payment.length,
        events: buckets.payment,
      })
    );
  }
  await Promise.all(writes);

  const now = new Date();
  const $set = { lastSeenAt: now, phase: endPhase };
  if (loginUserId) $set.loggedInAt = now;
  if (loggedOut) $set.loggedOutAt = now;

  await Session.updateOne(
    { _id: sessionId },
    {
      $setOnInsert: {
        _id: sessionId,
        tenantId: dto.tenantId,
        appId: dto.appId,
        deviceFingerprint: dto.deviceFingerprint,
        firstSeenAt: now,
      },
      $set,
      $inc: { batchCount: 1, eventCount: dto.events.length },
    },
    { upsert: true }
  );

  // Server-side identify wins: don't overwrite a userId that is already set.
  if (loginUserId && !knownUserId) {
    await attachUserId(sessionId, loginUserId, 'browser', { setPhase: false });
  }
}

/**
 * Attach a userId to a session, mark it logged in, and backfill the userId
 * onto the pre-login events already stored in login_events.
 */
async function attachUserId(sessionId, userId, source, { setPhase = true } = {}) {
  const activeType = databaseRegistry.getActiveType();
  if (activeType === 'postgresql') {
    const activeAdapter = databaseRegistry.getActiveAdapter();
    if (activeAdapter && typeof activeAdapter.linkSessionEvents === 'function') {
      try {
        await activeAdapter.linkSessionEvents(sessionId, userId, 'default');
      } catch (err) {
        console.warn('[collect] postgres linkSessionEvents failed:', err.message);
      }
    }
  }

  const $set = { userId, identifiedBy: source };
  if (setPhase) {
    $set.phase = 'session';
    $set.loggedInAt = new Date();
  }
  await Session.updateOne({ _id: sessionId }, { $set });
  const res = await LoginEvent.updateMany({ sessionId, userId: null }, { $set: { userId } });
  console.log(
    `[collect] stitched userId=${userId} (${source}) onto session ${sessionId}; backfilled ${res.modifiedCount} login batch(es)`
  );
  if (require('mongoose').connection.readyState === 1) {
    await EventBatch.updateMany({ sessionId }, { $set: { userId } }).catch(() => {});
  }

  // Now that the user is known, score geo_is_new_country for this session.
  // Best-effort: a geo failure must never fail an identify.
  try {
    await ipIntelService.onUserIdentified(sessionId, userId);
  } catch (err) {
    console.warn('[collect] new-country evaluation failed', err.message);
  }
}

module.exports = { ingest, attachUserId, splitEvents, toCanonicalEvent, BadRequestError };

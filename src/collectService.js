const config = require('./config');
const { LoginEvent, SessionEvent, PaymentEvent } = require('./models/EventStores');
const Session = require('./models/Session');
const ipIntelService = require('./ipIntelService');

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

  const base = {
    tenantId: dto.tenantId,
    appId: dto.appId,
    sessionId,
    deviceFingerprint: dto.deviceFingerprint,
    clientIp,
  };

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
  // Now that the user is known, score geo_is_new_country for this session.
  // Best-effort: a geo failure must never fail an identify.
  try {
    await ipIntelService.onUserIdentified(sessionId, userId);
  } catch (err) {
    console.warn('[collect] new-country evaluation failed', err.message);
  }
}

module.exports = { ingest, attachUserId, splitEvents, BadRequestError };

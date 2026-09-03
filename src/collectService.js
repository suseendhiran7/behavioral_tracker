const config = require('./config');
const EventBatch = require('./models/EventBatch');
const Session = require('./models/Session');

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

/**
 * Ingest one SDK batch: store it in MongoDB keyed on sessionId.
 * Redis/BullMQ forwarding removed — data is stored locally only.
 */
async function ingest(dto, clientIp) {
  if (dto.events.length > config.maxBatchEvents) {
    throw Object.assign(new BadRequestError(`too many events (max ${config.maxBatchEvents})`), { status: 400 });
  }

  const sessionId = deriveSessionId(dto.events);

  const identifyEvt = dto.events.find((e) => e.type === 'identify' && !!e.userId);
  const browserUserId = identifyEvt ? identifyEvt.userId : null;

  const now = new Date();

  await EventBatch.create({
    tenantId: dto.tenantId,
    appId: dto.appId,
    sessionId,
    userId: browserUserId,
    deviceFingerprint: dto.deviceFingerprint,
    eventCount: dto.events.length,
    events: dto.events,
    clientIp,
  });

  const existing = await Session.findById(sessionId).lean();

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
      $set: { lastSeenAt: now },
      $inc: { batchCount: 1, eventCount: dto.events.length },
    },
    { upsert: true }
  );

  if (browserUserId && !(existing && existing.userId)) {
    await attachUserId(sessionId, browserUserId, 'browser');
    // Forward queue disabled — no Redis/BullMQ
  }
}

/**
 * Attach a userId to a session and backfill it onto every batch already
 * stored for that session.
 */
async function attachUserId(sessionId, userId, source) {
  await Session.updateOne({ _id: sessionId }, { $set: { userId, identifiedBy: source } });
  const res = await EventBatch.updateMany({ sessionId }, { $set: { userId } });
  console.log(
    `[collect] stitched userId=${userId} (${source}) onto session ${sessionId}; backfilled ${res.modifiedCount} batch(es)`
  );
}

module.exports = { ingest, attachUserId, BadRequestError };

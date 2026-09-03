const { Worker } = require('bullmq');
const axios = require('axios');
const config = require('../config');
const EventBatch = require('../models/EventBatch');
const Session = require('../models/Session');
const { FORWARD_QUEUE, connection } = require('./queue');

/**
 * Assembles ALL batches for a session into one payload and POSTs it to the
 * FastAPI feature service. We forward the WHOLE session (not per-batch)
 * because the model's features are session-level aggregates
 * (avg_typing_speed, total_duration, idle_time, ...). The natural trigger is
 * the identify event — exactly when you want a fraud score.
 *
 * Retries/backoff are handled by BullMQ (set at enqueue time in queue.js).
 */
async function processForwardJob(job) {
  const { sessionId } = job.data;

  const session = await Session.findById(sessionId).lean();
  if (!session) {
    console.warn(`[forward] session ${sessionId} not found; skipping`);
    return;
  }

  const batches = await EventBatch.find({ sessionId }).sort({ receivedAt: 1 }).lean();
  const events = batches.flatMap((b) => b.events || []);
  if (events.length === 0) {
    console.warn(`[forward] session ${sessionId} has no events; skipping`);
    return;
  }

  const payload = {
    sessionId,
    tenantId: session.tenantId,
    appId: session.appId,
    userId: session.userId,
    deviceFingerprint: session.deviceFingerprint,
    identifiedBy: session.identifiedBy,
    firstSeenAt: session.firstSeenAt,
    lastSeenAt: session.lastSeenAt,
    eventCount: events.length,
    events,
  };

  // Throws on non-2xx / network error -> BullMQ retries with backoff.
  await axios.post(config.fastapiIngestUrl, payload, {
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' },
  });

  await Session.updateOne({ _id: sessionId }, { forwarded: true });
  await EventBatch.updateMany({ sessionId }, { forwarded: true });

  console.log(`[forward] forwarded session ${sessionId} (${events.length} events) -> ${config.fastapiIngestUrl}`);
}

function startForwardWorker() {
  const worker = new Worker(FORWARD_QUEUE, processForwardJob, { connection });
  worker.on('failed', (job, err) => {
    console.error(`[forward] job ${job && job.id} failed: ${err.message}`);
  });
  return worker;
}

module.exports = { startForwardWorker };

const { Queue } = require('bullmq');
const config = require('../config');

const FORWARD_QUEUE = 'forward-session';

const connection = { host: config.redis.host, port: config.redis.port };

const forwardQueue = new Queue(FORWARD_QUEUE, { connection });

/**
 * Enqueue a session for forwarding to the feature service.
 * jobId dedupes concurrent/duplicate identify calls for the same session.
 * NOTE: BullMQ job ids cannot contain ':' — use '__' as the separator.
 */
async function enqueueForward(sessionId, reason) {
  await forwardQueue.add(
    'forward',
    { sessionId, reason },
    {
      jobId: `${sessionId}__${reason}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    }
  );
}

module.exports = { FORWARD_QUEUE, connection, forwardQueue, enqueueForward };

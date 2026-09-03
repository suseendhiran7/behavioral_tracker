/**
 * No-op forward queue — Redis/BullMQ removed.
 * enqueueForward is a stub; all forwarding logic is disabled.
 */

async function enqueueForward(sessionId, reason) {
  console.log(`[queue] forward skipped (no-op): sessionId=${sessionId}, reason=${reason}`);
}

module.exports = { enqueueForward };

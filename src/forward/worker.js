/**
 * Forward worker — Redis/BullMQ removed.
 * Returns a stub object with a no-op close() so server.js shutdown still works.
 */

function startForwardWorker() {
  console.log('[forward] worker disabled (no Redis/BullMQ) — running in direct-store mode');
  return {
    close: async () => {},
  };
}

module.exports = { startForwardWorker };

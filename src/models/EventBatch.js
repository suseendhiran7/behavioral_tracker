const mongoose = require('mongoose');

/**
 * One document per flushed SDK batch (not one growing array per session) —
 * keeps writes small and avoids the 16MB per-document ceiling.
 *
 * Keyed on sessionId, NOT userId: on a login page the behavioral data
 * arrives BEFORE the user is known. userId starts null and is backfilled
 * once an identify event / server-side /identify call lands.
 */
const EventBatchSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    appId: { type: String, required: true },
    sessionId: { type: String, required: true, index: true },
    userId: { type: String, default: null, index: true },
    deviceFingerprint: { type: String, required: true },
    eventCount: { type: Number, required: true },
    events: { type: [mongoose.Schema.Types.Mixed], required: true },
    forwarded: { type: Boolean, default: false, index: true },
    clientIp: { type: String, default: null },
  },
  {
    collection: 'event_batches',
    timestamps: { createdAt: 'receivedAt', updatedAt: false },
  }
);

EventBatchSchema.index({ sessionId: 1, receivedAt: 1 });
EventBatchSchema.index({ tenantId: 1, userId: 1 });

module.exports = mongoose.model('EventBatch', EventBatchSchema);

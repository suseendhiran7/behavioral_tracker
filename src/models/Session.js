const mongoose = require('mongoose');

/**
 * One summary doc per session, _id = sessionId. Fast lookup + stitching
 * record: running counts, whether userId is known yet, and which trust
 * level it came from ('browser' identify() vs 'server' /identify call).
 */
const SessionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    appId: { type: String, required: true },
    userId: { type: String, default: null, index: true },
    deviceFingerprint: { type: String, required: true },
    batchCount: { type: Number, default: 0 },
    eventCount: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    forwarded: { type: Boolean, default: false },
    identifiedBy: { type: String, enum: ['browser', 'server', null], default: null },
  },
  { collection: 'sessions', timestamps: true, _id: false }
);

module.exports = mongoose.model('Session', SessionSchema);

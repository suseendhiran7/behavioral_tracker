const mongoose = require('mongoose');

const PageEngagementSchema = new mongoose.Schema(
  {
    pageViewId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    userId: { type: String, default: null, index: true },
    tenantId: { type: String, default: 'default', index: true },
    pageId: { type: String, default: null },
    sanitizedRoute: { type: String, required: true },
    entryTimestamp: { type: Date, required: true },
    exitTimestamp: { type: Date, default: null },
    elapsedDurationMs: { type: Number, default: 0 },
    activeDurationMs: { type: Number, default: 0 },
    visibleDurationMs: { type: Number, default: 0 },
    idleDurationMs: { type: Number, default: 0 },
    maxScrollDepth: { type: Number, default: 0 },
    interactionCount: { type: Number, default: 0 },
    navigationSource: { type: String, default: null },
    exitReason: { type: String, default: null },
  },
  {
    collection: 'page_engagements',
    timestamps: true,
  }
);

PageEngagementSchema.index({ userId: 1, entryTimestamp: -1 });
PageEngagementSchema.index({ sessionId: 1, entryTimestamp: -1 });

module.exports = mongoose.model('PageEngagement', PageEngagementSchema);

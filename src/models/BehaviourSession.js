const mongoose = require('mongoose');

const BehaviourSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    tenantId: { type: String, default: 'default', index: true },
    clientId: { type: String, default: null, index: true },
    userId: { type: String, default: null, index: true },
    anonymousId: { type: String, default: null },
    startedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['active', 'ended', 'expired'],
      default: 'active',
      index: true,
    },
    sessionSummary: {
      interactionCount: { type: Number, default: 0 },
      pageCount: { type: Number, default: 0 },
      maxScrollDepth: { type: Number, default: 0 },
      activeDurationMs: { type: Number, default: 0 },
      paymentStatus: { type: String, default: 'none' },
      deviceCategory: { type: String, default: 'unknown' },
    },
    riskSummary: {
      riskScore: { type: Number, default: null },
      riskLevel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'INSUFFICIENT_DATA', null], default: null },
      confidence: { type: Number, default: null },
      evaluatedAt: { type: Date, default: null },
      signals: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },
    deviceMetadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    linkedAt: { type: Date, default: null },
    ipAddress: { type: String, default: null },
  },
  {
    collection: 'behaviour_sessions',
    timestamps: true,
  }
);

BehaviourSessionSchema.index({ userId: 1, startedAt: -1 });
BehaviourSessionSchema.index({ tenantId: 1, startedAt: -1 });

module.exports = mongoose.model('BehaviourSession', BehaviourSessionSchema);

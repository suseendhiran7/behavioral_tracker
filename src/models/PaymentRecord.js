const mongoose = require('mongoose');

const PaymentRecordSchema = new mongoose.Schema(
  {
    paymentId: { type: String, required: true, unique: true, index: true },
    orderId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    tenantId: { type: String, default: 'default', index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: {
      type: String,
      enum: ['initiated', 'pending', 'succeeded', 'failed', 'cancelled'],
      required: true,
      index: true,
    },
    paymentMethodCategory: { type: String, default: 'card' },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: String, default: 'server_callback' },
    failureReason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  {
    collection: 'payment_records',
    timestamps: true,
  }
);

PaymentRecordSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentRecord', PaymentRecordSchema);

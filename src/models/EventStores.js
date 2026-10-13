const mongoose = require('mongoose');

/**
 * Events are split by session phase into three collections:
 *
 *   login_events    everything BEFORE and AT login (page load, typing on the
 *                   login form, the identify / login_result event itself).
 *                   Also used again if the user logs out and stays on the site.
 *   session_events  everything AFTER login up to and including logout.
 *   payment_events  logged-in events that happened on a payment page.
 *
 * Same shape in all three: one document per (flushed SDK batch × phase), so
 * a batch that crosses the login boundary produces one doc in login_events
 * and one in session_events. Keeps writes small and under the 16MB ceiling.
 */
function buildSchema(collection) {
  const schema = new mongoose.Schema(
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
    { collection, timestamps: { createdAt: 'receivedAt', updatedAt: false } }
  );
  schema.index({ sessionId: 1, receivedAt: 1 });
  schema.index({ tenantId: 1, userId: 1 });
  return schema;
}

const LoginEvent = mongoose.model('LoginEvent', buildSchema('login_events'));
const SessionEvent = mongoose.model('SessionEvent', buildSchema('session_events'));
const PaymentEvent = mongoose.model('PaymentEvent', buildSchema('payment_events'));

const COLLECTIONS = ['login_events', 'session_events', 'payment_events'];

module.exports = { LoginEvent, SessionEvent, PaymentEvent, COLLECTIONS };

const mongoose = require('mongoose');

/**
 * Server-recorded IP verdict for a session. One doc per (sessionId, ip):
 * a session that shows up from two different IPs keeps both records, which
 * is itself a risk signal, and a later call can never overwrite an earlier
 * verdict.
 *
 * THIS is what the risk model should read — not the is_vpn / is_proxy
 * fields the SDK echoes back inside `network_risk` events, which pass
 * through the browser and can be tampered with.
 */
const NetworkIntelSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    appId: { type: String, default: null },
    sessionId: { type: String, required: true, index: true },
    userId: { type: String, default: null, index: true },
    ip: { type: String, required: true },
    country: { type: String, default: null },
    timezone: { type: String, default: null },
    isVpn: { type: Boolean, default: null },
    isProxy: { type: Boolean, default: null },
    isDatacenter: { type: Boolean, default: null },
    isTor: { type: Boolean, default: null },
    // null until the session is linked to a user (at lookup time if already
    // identified, otherwise when /identify or a browser identify lands).
    isNewCountry: { type: Boolean, default: null },
    evaluatedForUserId: { type: String, default: null },
    provider: { type: String, default: null },
    source: { type: String, required: true }, // 'provider' | 'cache' | 'private_ip' | 'disabled' | 'error'
  },
  { collection: 'network_intel', timestamps: true }
);

NetworkIntelSchema.index({ sessionId: 1, ip: 1 }, { unique: true });

module.exports = mongoose.model('NetworkIntel', NetworkIntelSchema);

const mongoose = require('mongoose');

/**
 * Countries each user has logged in from — the baseline for
 * geo_is_new_country. Server-side, per user, so it follows the user across
 * devices (the SDK's own fallback is only per browser).
 */
const UserGeoHistorySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    countries: { type: [String], default: [] },
  },
  { collection: 'user_geo_history', timestamps: true }
);

UserGeoHistorySchema.index({ tenantId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('UserGeoHistory', UserGeoHistorySchema);

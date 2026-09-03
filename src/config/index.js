require('dotenv').config();

function list(v) {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function jsonMap(v) {
  if (!v) return {};
  try {
    return JSON.parse(v);
  } catch {
    console.warn('[config] TENANT_API_KEYS is not valid JSON — treating as empty');
    return {};
  }
}

module.exports = {
  port: parseInt(process.env.PORT || '8080', 10),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/xylium',
  allowedTenants: list(process.env.ALLOWED_TENANTS),
  corsOrigins: list(process.env.CORS_ORIGINS),
  tenantApiKeys: jsonMap(process.env.TENANT_API_KEYS),
  maxBatchEvents: parseInt(process.env.MAX_BATCH_EVENTS || '500', 10),
  maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES || '262144', 10),
  rawTtlDays: parseInt(process.env.RAW_TTL_DAYS || '0', 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '3000', 10),
};

const { timingSafeEqual } = require('crypto');
const config = require('../config');

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Protects the server-to-server /identify endpoint. The customer's login
 * backend sends x-tenant-id + x-api-key. Secrets live in TENANT_API_KEYS and
 * are never exposed to browsers (unlike anything in the SDK script tag).
 */
function apiKeyGuard(req, res, next) {
  const tenantId = req.header('x-tenant-id');
  const apiKey = req.header('x-api-key');
  const keys = config.tenantApiKeys;

  if (!tenantId || !apiKey || !keys[tenantId]) {
    return res.status(401).json({ error: 'missing or unknown credentials' });
  }
  if (!safeEqual(apiKey, keys[tenantId])) {
    return res.status(401).json({ error: 'invalid api key' });
  }
  req.tenantId = tenantId;
  next();
}

module.exports = apiKeyGuard;

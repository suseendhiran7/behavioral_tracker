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

// TRUST_PROXY → Express `trust proxy`. "true"/"false", a hop count, or a
// comma list of subnets/keywords (loopback, linklocal, uniquelocal, CIDRs).
function trustProxy(v) {
  if (v === undefined || v === '') return 'loopback, linklocal, uniquelocal';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

const ipIntelProvider = (process.env.IP_INTEL_PROVIDER || 'none').toLowerCase();
if (!['none', 'ipqs', 'ipapi'].includes(ipIntelProvider)) {
  console.warn(`[config] unknown IP_INTEL_PROVIDER "${ipIntelProvider}" — /ip-intel will return nulls`);
}
if (ipIntelProvider === 'ipqs' && !process.env.IPQS_API_KEY) {
  console.warn('[config] IP_INTEL_PROVIDER=ipqs but IPQS_API_KEY is empty — /ip-intel will return nulls');
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  port: parseInt(process.env.PORT || '8080', 10),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/xylium',
  allowedTenants: list(process.env.ALLOWED_TENANTS),
  corsOrigins: list(process.env.CORS_ORIGINS),
  tenantApiKeys: jsonMap(process.env.TENANT_API_KEYS),
  maxBatchEvents: parseInt(process.env.MAX_BATCH_EVENTS || '500', 10),
  maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES || '262144', 10),
  // Regex (case-insensitive) matched against each event's `page` (URL path).
  // Logged-in events on a matching page go to payment_events.
  paymentPagePattern: new RegExp(process.env.PAYMENT_PAGE_PATTERN || '(payment|checkout|pay|billing)', 'i'),
  rawTtlDays: parseInt(process.env.RAW_TTL_DAYS || '0', 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '3000', 10),
  ipIntel: {
    provider: ipIntelProvider,
    apiKey: process.env.IPQS_API_KEY || '',
    strictness: parseInt(process.env.IPQS_STRICTNESS || '1', 10),
    timeoutMs: parseInt(process.env.IP_INTEL_TIMEOUT_MS || '3000', 10),
    cacheTtlMs: parseInt(process.env.IP_INTEL_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10),
    cacheMax: parseInt(process.env.IP_INTEL_CACHE_MAX || '10000', 10),
    rateLimitWindowMs: parseInt(process.env.IP_INTEL_RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMax: parseInt(process.env.IP_INTEL_RATE_LIMIT_MAX || '30', 10),
    // Dev only: public IP to classify instead of localhost. Ignored in production.
    devIp: process.env.IP_INTEL_DEV_IP || '',
  },
};

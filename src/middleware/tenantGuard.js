const config = require('../config');

function tenantGuard(req, res, next) {
  // Gate is open in dev if no tenants configured
  if (config.allowedTenants.length === 0) return next();

  // req.body can be undefined if Content-Type was wrong (e.g. sendBeacon)
  // Parse it safely
  const body = req.body || {};
  const tenantId = body.tenantId;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId missing' });
  }

  if (!config.allowedTenants.includes(tenantId)) {
    return res.status(403).json({ error: 'unknown tenant' });
  }

  next();
}

module.exports = tenantGuard;
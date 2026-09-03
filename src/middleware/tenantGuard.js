const config = require('../config');

/**
 * /collect is a PUBLIC endpoint the SDK calls from arbitrary browsers, so we
 * can't require a real secret here. We CAN reject batches whose tenantId
 * isn't on our allowlist, so someone can't spray junk with a made-up id.
 * If ALLOWED_TENANTS is empty, the gate is open (dev convenience).
 */
function tenantGuard(req, res, next) {
  if (config.allowedTenants.length === 0) return next();
  const tenantId = req.body && req.body.tenantId;
  if (!tenantId || !config.allowedTenants.includes(tenantId)) {
    return res.status(403).json({ error: 'unknown tenant' });
  }
  next();
}

module.exports = tenantGuard;

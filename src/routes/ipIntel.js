const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const tenantGuard = require('../middleware/tenantGuard');
const { IpIntelQuerySchema } = require('../validation');
const ipIntelService = require('../ipIntelService');
const { getClientIp } = require('../utils/clientIp');

const router = express.Router();

// The SDK calls this once per page load, so a tight per-IP limit protects the
// paid provider quota without affecting real users.
const limiter = rateLimit({
  windowMs: config.ipIntel.rateLimitWindowMs,
  max: config.ipIntel.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /ip-intel?tenantId=…&appId=…&sessionId=…
 * Called by xylium-network-risk.js in the browser. Classifies the REQUEST's
 * source IP (never an IP supplied by the client) and returns only the
 * booleans the SDK needs — raw provider data (fraud score, ISP, …) stays
 * server-side so attackers can't use the endpoint as a free VPN tester.
 */
router.get('/', limiter, tenantGuard, async (req, res, next) => {
  try {
    const parsed = IpIntelQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const result = await ipIntelService.lookupForSession({
      ...parsed.data,
      ip: getClientIp(req),
      userAgent: req.get('user-agent') || null,
      userLanguage: req.get('accept-language') || null,
    });
    res.set('Cache-Control', 'no-store');
    res.status(result.source === 'error' ? 502 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

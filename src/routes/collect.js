const express = require('express');
const tenantGuard = require('../middleware/tenantGuard');
const { CollectBatchSchema } = require('../validation');
const collectService = require('../collectService');
const { getClientIp } = require('../utils/clientIp');

const router = express.Router();

router.post('/', tenantGuard, async (req, res, next) => {
  try {
    const parsed = CollectBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
    }
    // Same trusted-proxy rules as /ip-intel, so both record the same IP.
    const ip = getClientIp(req);
    await collectService.ingest(parsed.data, ip);
    res.set('Cache-Control', 'no-store');
    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

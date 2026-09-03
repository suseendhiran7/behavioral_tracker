const express = require('express');
const tenantGuard = require('../middleware/tenantGuard');
const { CollectBatchSchema } = require('../validation');
const collectService = require('../collectService');

const router = express.Router();

router.post('/', tenantGuard, async (req, res, next) => {
  try {
    const parsed = CollectBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
    }
    const ip =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket.remoteAddress ||
      null;
    await collectService.ingest(parsed.data, ip);
    res.set('Cache-Control', 'no-store');
    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

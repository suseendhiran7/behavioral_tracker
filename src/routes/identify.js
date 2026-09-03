const express = require('express');
const apiKeyGuard = require('../middleware/apiKeyGuard');
const { IdentifySchema } = require('../validation');
const collectService = require('../collectService');

const router = express.Router();

/**
 * Trusted server-to-server identify. The customer's login backend calls this
 * after a verified login to stamp a real userId onto the session.
 * Forward queue removed — data is stored in MongoDB directly.
 */
router.post('/', apiKeyGuard, async (req, res, next) => {
  try {
    const parsed = IdentifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
    }
    const { sessionId, userId } = parsed.data;
    await collectService.attachUserId(sessionId, userId, 'server');
    // Forward queue disabled — no Redis/BullMQ
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

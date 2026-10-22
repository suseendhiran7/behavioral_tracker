const express = require('express');
const {
  EventBatchSchema,
  SessionStartSchema,
  SessionEndSchema,
  SessionLinkSchema,
  PaymentVerifySchema,
} = require('../analyticsValidation');
const analyticsService = require('../analyticsService');
const {
  optionalAuth,
  requireAuth,
  requireUserOrAdmin,
  requireServerOrAdmin,
} = require('../middleware/authMiddleware');

const router = express.Router();

function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket.remoteAddress ||
    null
  );
}

/**
 * Ingest a batch of behavioral events (authenticated or anonymous).
 */
router.post('/events/batch', optionalAuth, async (req, res, next) => {
  try {
    const parsed = EventBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid payload',
        details: parsed.error.flatten(),
      });
    }

    const ip = getClientIp(req);
    const result = await analyticsService.ingestEvents({
      events: parsed.data.events,
      clientIp: ip,
      authenticatedUser: req.user,
    });

    res.set('Cache-Control', 'no-store');
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Start a behavioral session explicitly.
 */
router.post('/sessions/start', optionalAuth, async (req, res, next) => {
  try {
    const parsed = SessionStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid payload',
        details: parsed.error.flatten(),
      });
    }

    const ip = getClientIp(req);
    const result = await analyticsService.startSession({
      ...parsed.data,
      authenticatedUser: req.user,
      ipAddress: ip,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * End a behavioral session explicitly.
 */
router.post('/sessions/end', optionalAuth, async (req, res, next) => {
  try {
    const parsed = SessionEndSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid payload',
        details: parsed.error.flatten(),
      });
    }

    const result = await analyticsService.endSession(parsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Link an anonymous session to an authenticated user ID.
 * Supports server-to-server linking or client-side linking on login.
 */
router.post('/sessions/link', optionalAuth, async (req, res, next) => {
  try {
    const parsed = SessionLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid payload',
        details: parsed.error.flatten(),
      });
    }

    const result = await analyticsService.linkSession(parsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Server-to-server payment verification callback.
 */
router.post('/payments/verify', requireServerOrAdmin, async (req, res, next) => {
  try {
    const parsed = PaymentVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid payload',
        details: parsed.error.flatten(),
      });
    }

    const result = await analyticsService.verifyPayment(parsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Query a user's chronological events.
 * Enforces ownership: only the user or admin can read this user's data.
 */
router.get('/users/:userId/events', requireUserOrAdmin('userId'), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { page, limit, startDate, endDate, eventCategory, sessionId } = req.query;
    const tenantId = req.headers['x-tenant-id'] || (req.user && req.user.tenantId) || req.query.tenantId || 'default';

    const result = await analyticsService.getUserEvents({
      userId,
      tenantId,
      page,
      limit,
      startDate,
      endDate,
      eventCategory,
      sessionId,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Query a user's session history.
 */
router.get('/users/:userId/sessions', requireUserOrAdmin('userId'), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { page, limit } = req.query;

    const result = await analyticsService.getUserSessions({
      userId,
      page,
      limit,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Query a user's aggregated interaction & journey summary.
 */
router.get('/users/:userId/summary', requireUserOrAdmin('userId'), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const tenantId = req.headers['x-tenant-id'] || (req.user && req.user.tenantId) || req.query.tenantId || 'default';
    const result = await analyticsService.getUserSummary({ userId, tenantId });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Query events for a specific session.
 */
router.get('/sessions/:sessionId/events', requireAuth, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { page, limit } = req.query;

    const result = await analyticsService.getSessionEvents({
      sessionId,
      page,
      limit,
      authenticatedUser: req.user,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Query behavioral risk analysis and signals for a session.
 */
router.get('/sessions/:sessionId/risk', requireAuth, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const riskService = require('../riskService');
    const result = await riskService.evaluateSessionRisk(sessionId);
    if (result.error) {
      return res.status(404).json(result);
    }
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Query behavioral risk analysis and signals for a user's latest session.
 */
router.get('/users/:userId/risk', requireUserOrAdmin('userId'), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const BehaviourSession = require('../models/BehaviourSession');
    const riskService = require('../riskService');
    const { pgAppStore } = require('../database/active-store');
    const pg = pgAppStore();
    const latestSession = pg
      ? await pg.findLatestUserSession(userId)
      : await BehaviourSession.findOne({ userId }).sort({ startedAt: -1 }).lean();
    if (!latestSession) {
      return res.status(404).json({ error: 'no sessions found for user' });
    }
    const result = await riskService.evaluateSessionRisk(latestSession.sessionId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GDPR / Privacy deletion endpoint.
 */
router.delete('/users/:userId', requireUserOrAdmin('userId'), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const result = await analyticsService.deleteUserData({ userId });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const eventService = require('../services/event.service');

function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket.remoteAddress ||
    null
  );
}

class EventController {
  /**
   * Ingest a batch of events.
   */
  async ingestBatch(req, res, next) {
    try {
      const { events, tenantId } = req.body;
      const ip = getClientIp(req);
      const result = await eventService.ingestEvents({
        events,
        clientIp: ip,
        authenticatedUser: req.user,
        tenantId,
      });
      res.set('Cache-Control', 'no-store');
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get single event by ID.
   */
  async getEventById(req, res, next) {
    try {
      const { eventId } = req.params;
      const tenantId = req.query.tenantId || (req.user && req.user.tenantId) || 'default';
      const event = await eventService.getEventById(eventId, tenantId);
      if (!event) {
        return res.status(404).json({ error: 'event not found' });
      }
      res.status(200).json({ event });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Query events with filtering & pagination.
   */
  async getEvents(req, res, next) {
    try {
      const tenantId = req.query.tenantId || (req.user && req.user.tenantId) || 'default';
      const filters = {
        tenantId,
        userId: req.query.userId,
        sessionId: req.query.sessionId,
        eventCategory: req.query.eventCategory,
        eventType: req.query.eventType,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      };
      const pagination = {
        page: req.query.page,
        limit: req.query.limit,
      };
      const result = await eventService.getEvents(filters, pagination);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Query events for a specific session.
   */
  async getSessionEvents(req, res, next) {
    try {
      const { sessionId } = req.params;
      const tenantId = req.query.tenantId || (req.user && req.user.tenantId) || 'default';
      const pagination = {
        page: req.query.page,
        limit: req.query.limit,
      };
      const result = await eventService.getSessionEvents(sessionId, tenantId, pagination);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Query events for a user.
   */
  async getUserEvents(req, res, next) {
    try {
      const { userId } = req.params;
      const tenantId = req.query.tenantId || (req.user && req.user.tenantId) || 'default';
      const filters = {
        sessionId: req.query.sessionId,
        eventCategory: req.query.eventCategory,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      };
      const pagination = {
        page: req.query.page,
        limit: req.query.limit,
      };
      const result = await eventService.getUserEvents(userId, tenantId, filters, pagination);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new EventController();

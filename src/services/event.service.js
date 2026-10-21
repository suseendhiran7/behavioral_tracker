const databaseRegistry = require('../config/database-registry');
const { normalizeEvent } = require('../database/schema/event.schema');

class EventService {
  /**
   * Resolve the currently active repository adapter.
   * @returns {import('../database/interfaces/event.repository')}
   */
  _getAdapter() {
    return databaseRegistry.getActiveAdapter();
  }

  /**
   * Process and ingest a batch of behavioral events into the active database.
   * Derives canonical user ID, sanitizes sensitive properties, and enforces idempotency.
   */
  async ingestEvents({ events, clientIp, authenticatedUser, tenantId }) {
    if (!events || !Array.isArray(events) || events.length === 0) {
      return { ok: true, count: 0, acceptedCount: 0 };
    }

    const effectiveTenantId = tenantId || (authenticatedUser && authenticatedUser.tenantId) || 'default';
    const effectiveUserId = authenticatedUser && authenticatedUser.userId ? authenticatedUser.userId : null;

    const normalizedEvents = events.map((raw) =>
      normalizeEvent(raw, {
        tenantId: raw.tenantId || effectiveTenantId,
        userId: effectiveUserId,
        clientId: raw.clientId || null,
        clientIp,
      })
    );

    const adapter = this._getAdapter();
    const result = await adapter.saveEvents(normalizedEvents);

    return {
      ok: true,
      acceptedCount: events.length,
      insertedCount: result.insertedCount,
      duplicateCount: result.duplicateCount,
      activeDatabase: databaseRegistry.getActiveType(),
    };
  }

  /**
   * Save a single event.
   */
  async saveEvent(rawEvent, context = {}) {
    const normalized = normalizeEvent(rawEvent, context);
    const adapter = this._getAdapter();
    return await adapter.saveEvent(normalized);
  }

  /**
   * Retrieve event by ID with tenant scoping.
   */
  async getEventById(eventId, tenantId = 'default') {
    const adapter = this._getAdapter();
    return await adapter.getEventById(eventId, tenantId);
  }

  /**
   * Query events with filtering and pagination.
   */
  async getEvents(filters = {}, pagination = {}) {
    const adapter = this._getAdapter();
    return await adapter.getEvents(filters, pagination);
  }

  /**
   * Retrieve chronological events for a specific session within a tenant.
   */
  async getSessionEvents(sessionId, tenantId = 'default', pagination = {}) {
    const adapter = this._getAdapter();
    return await adapter.getSessionEvents(sessionId, tenantId, pagination);
  }

  /**
   * Retrieve chronological events for a user within a tenant.
   */
  async getUserEvents(userId, tenantId = 'default', filters = {}, pagination = {}) {
    const adapter = this._getAdapter();
    return await adapter.getUserEvents(userId, tenantId, filters, pagination);
  }

  /**
   * Get aggregated counts matching filter criteria.
   */
  async getEventCounts(filters = {}) {
    const adapter = this._getAdapter();
    return await adapter.getEventCounts(filters);
  }

  /**
   * Backfill / link userId onto pre-login events for a session.
   */
  async linkSessionEvents(sessionId, userId, tenantId = 'default') {
    const adapter = this._getAdapter();
    return await adapter.linkSessionEvents(sessionId, userId, tenantId);
  }

  /**
   * Delete all event records for a user (GDPR compliance).
   */
  async deleteUserData(userId, tenantId = 'default') {
    const adapter = this._getAdapter();
    return await adapter.deleteUserData(userId, tenantId);
  }

  /**
   * Compute aggregated summary for a user.
   */
  async getUserSummary(userId, tenantId = 'default') {
    const adapter = this._getAdapter();
    return await adapter.getUserSummary(userId, tenantId);
  }
}

module.exports = new EventService();

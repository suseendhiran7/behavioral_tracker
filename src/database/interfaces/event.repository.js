/**
 * Abstract EventRepository Contract
 * Defines the unified database adapter contract for behavioral event persistence.
 */
class EventRepository {
  /**
   * Connect to the underlying database engine and initialize connection pools.
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('Method connect() must be implemented');
  }

  /**
   * Gracefully close connections and release pool resources.
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('Method disconnect() must be implemented');
  }

  /**
   * Perform an active health check on the database connection and schema.
   * @returns {Promise<{ status: 'healthy' | 'unhealthy', latencyMs: number, details?: any }>}
   */
  async healthCheck() {
    throw new Error('Method healthCheck() must be implemented');
  }

  /**
   * Save a single validated behavioral event.
   * Must enforce idempotency (duplicate eventId within tenant is safely ignored).
   * @param {Object} event
   * @returns {Promise<Object>} Persisted event
   */
  async saveEvent(event) {
    throw new Error('Method saveEvent(event) must be implemented');
  }

  /**
   * Save a batch of validated behavioral events with bulk write optimization.
   * @param {Array<Object>} events
   * @returns {Promise<{ insertedCount: number, duplicateCount: number }>}
   */
  async saveEvents(events) {
    throw new Error('Method saveEvents(events) must be implemented');
  }

  /**
   * Retrieve a specific event by ID with strict tenant isolation.
   * @param {string} eventId
   * @param {string} tenantId
   * @returns {Promise<Object|null>}
   */
  async getEventById(eventId, tenantId) {
    throw new Error('Method getEventById(eventId, tenantId) must be implemented');
  }

  /**
   * Query events matching filters with pagination and sorting.
   * @param {Object} filters
   * @param {Object} pagination - { page, limit }
   * @returns {Promise<{ events: Array<Object>, total: number, page: number, limit: number, totalPages: number }>}
   */
  async getEvents(filters, pagination) {
    throw new Error('Method getEvents(filters, pagination) must be implemented');
  }

  /**
   * Retrieve chronological events for a specific session within a tenant.
   * @param {string} sessionId
   * @param {string} tenantId
   * @param {Object} pagination
   * @returns {Promise<{ events: Array<Object>, total: number, page: number, limit: number, totalPages: number }>}
   */
  async getSessionEvents(sessionId, tenantId, pagination) {
    throw new Error('Method getSessionEvents(sessionId, tenantId, pagination) must be implemented');
  }

  /**
   * Retrieve chronological events for a user within a tenant.
   * @param {string} userId
   * @param {string} tenantId
   * @param {Object} filters
   * @param {Object} pagination
   * @returns {Promise<{ events: Array<Object>, total: number, page: number, limit: number, totalPages: number }>}
   */
  async getUserEvents(userId, tenantId, filters, pagination) {
    throw new Error('Method getUserEvents(userId, tenantId, filters, pagination) must be implemented');
  }

  /**
   * Get aggregated event counts matching filter criteria.
   * @param {Object} filters
   * @returns {Promise<{ total: number, byCategory?: Record<string, number>, byType?: Record<string, number> }>}
   */
  async getEventCounts(filters) {
    throw new Error('Method getEventCounts(filters) must be implemented');
  }

  /**
   * Return metadata about the adapter (type, engine version, connected host/db, pool stats).
   * Must NOT contain sensitive credentials.
   * @returns {Object}
   */
  getAdapterInfo() {
    throw new Error('Method getAdapterInfo() must be implemented');
  }

  /**
   * Backfill/link userId onto all pre-login events matching a sessionId.
   * @param {string} sessionId
   * @param {string} userId
   * @param {string} tenantId
   * @returns {Promise<{ modifiedCount: number }>}
   */
  async linkSessionEvents(sessionId, userId, tenantId) {
    throw new Error('Method linkSessionEvents(sessionId, userId, tenantId) must be implemented');
  }

  /**
   * Delete all event data associated with a user (GDPR compliance).
   * @param {string} userId
   * @param {string} tenantId
   * @returns {Promise<{ deletedCount: number }>}
   */
  async deleteUserData(userId, tenantId) {
    throw new Error('Method deleteUserData(userId, tenantId) must be implemented');
  }

  /**
   * Compute aggregated user summary and metrics.
   * @param {string} userId
   * @param {string} tenantId
   * @returns {Promise<Object>}
   */
  async getUserSummary(userId, tenantId) {
    throw new Error('Method getUserSummary(userId, tenantId) must be implemented');
  }
}

module.exports = EventRepository;

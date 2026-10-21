const databaseRegistry = require('../config/database-registry');
const DatabaseFactory = require('../database/factories/database.factory');
const { loadDatabaseConfig, sanitizeConfig } = require('../config/database.config');

const ALLOWED_DATABASES = ['postgresql', 'mongodb'];

class DatabaseSwitchService {
  /**
   * Validate that the requested database type is in the allowlist.
   */
  validateDatabaseType(type) {
    if (!type || typeof type !== 'string') {
      const err = new Error('Database type is required');
      err.status = 400;
      throw err;
    }
    const normalized = type.toLowerCase().trim();
    const resolved = (normalized === 'postgres') ? 'postgresql' : (normalized === 'mongo' ? 'mongodb' : normalized);
    if (!ALLOWED_DATABASES.includes(resolved)) {
      const err = new Error(`Invalid database type: '${type}'. Allowed types are: ${ALLOWED_DATABASES.join(', ')}`);
      err.status = 400;
      throw err;
    }
    return resolved;
  }

  /**
   * Test a candidate database connection without switching the active adapter.
   * @param {string} type
   */
  async testConnection(type) {
    const targetType = this.validateDatabaseType(type);
    const config = loadDatabaseConfig();

    let candidate = databaseRegistry.adapters.get(targetType);
    let createdTemporary = false;

    if (!candidate) {
      candidate = DatabaseFactory.createAdapter(targetType, config);
      createdTemporary = true;
    }

    const startTime = Date.now();
    try {
      if (!candidate.isConnected) {
        await candidate.connect();
      }
      const health = await candidate.healthCheck();
      if (health.status !== 'healthy') {
        throw new Error(health.error || 'Health check returned unhealthy status');
      }

      return {
        ok: true,
        databaseType: targetType,
        status: 'healthy',
        latencyMs: health.latencyMs || (Date.now() - startTime),
        info: candidate.getAdapterInfo(),
        details: health.details || {},
      };
    } catch (err) {
      return {
        ok: false,
        databaseType: targetType,
        status: 'unhealthy',
        latencyMs: Date.now() - startTime,
        error: err.message,
      };
    } finally {
      // If we created a temporary test adapter and it is NOT the active one, we can keep or disconnect
      // Keeping it cached in memory is usually fine, or if createdTemporary and failed, disconnect
    }
  }

  /**
   * Execute a controlled, atomic database switch with pre-validation and rollback.
   * @param {string} requestedType
   * @param {Object} adminUser
   */
  async switchDatabase(requestedType, adminUser = {}) {
    const targetType = this.validateDatabaseType(requestedType);
    const currentActiveType = databaseRegistry.getActiveType();

    if (targetType === currentActiveType) {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      const health = await activeAdapter.healthCheck();
      return {
        ok: true,
        alreadyActive: true,
        activeDatabase: currentActiveType,
        status: health.status,
        health,
        info: activeAdapter.getAdapterInfo(),
      };
    }

    // Acquire concurrency lock to prevent simultaneous switches
    databaseRegistry.acquireSwitchLock();

    try {
      const config = loadDatabaseConfig();
      let candidate = databaseRegistry.adapters.get(targetType);

      if (!candidate) {
        candidate = DatabaseFactory.createAdapter(targetType, config);
      }

      // Establish connection if not already connected
      if (!candidate.isConnected) {
        try {
          await candidate.connect();
        } catch (connErr) {
          const err = new Error(`Connection to ${targetType} failed: ${connErr.message}`);
          err.status = 502;
          throw err;
        }
      }

      // Health check & schema validation
      const health = await candidate.healthCheck();
      if (health.status !== 'healthy') {
        const errorMsg = health.error || 'Candidate database failed health check validation';
        databaseRegistry.recordHistory({
          admin: adminUser.username || adminUser.userId || 'admin',
          fromDatabase: currentActiveType,
          toDatabase: targetType,
          status: 'FAILED',
          message: `Switch to ${targetType} rejected: candidate health check failed`,
          error: new Error(errorMsg),
        });

        const err = new Error(`Cannot switch to ${targetType}: database is unhealthy (${errorMsg})`);
        err.status = 502;
        throw err;
      }

      // Perform atomic switch in registry
      databaseRegistry.setActiveAdapter(targetType, candidate, adminUser);

      return {
        ok: true,
        previousDatabase: currentActiveType,
        activeDatabase: targetType,
        status: 'healthy',
        health,
        info: candidate.getAdapterInfo(),
      };
    } catch (err) {
      if (err.status !== 502) {
        databaseRegistry.recordHistory({
          admin: adminUser.username || adminUser.userId || 'admin',
          fromDatabase: currentActiveType,
          toDatabase: targetType,
          status: 'FAILED',
          message: `Switch to ${targetType} failed: ${err.message}`,
          error: err,
        });
      }
      throw err;
    } finally {
      databaseRegistry.releaseSwitchLock();
    }
  }

  /**
   * Get operational health status for all databases and the active adapter.
   */
  async getStatus() {
    const activeType = databaseRegistry.getActiveType();
    const config = loadDatabaseConfig();
    const results = {};

    for (const type of ALLOWED_DATABASES) {
      const adapter = databaseRegistry.adapters.get(type);
      if (adapter && adapter.isConnected) {
        try {
          const health = await adapter.healthCheck();
          results[type] = {
            configured: true,
            connected: true,
            isActive: type === activeType,
            status: health.status,
            latencyMs: health.latencyMs,
            details: health.details || {},
            info: adapter.getAdapterInfo(),
          };
        } catch (e) {
          results[type] = {
            configured: true,
            connected: false,
            isActive: type === activeType,
            status: 'unhealthy',
            error: e.message,
          };
        }
      } else {
        // Not connected yet; show configured status
        results[type] = {
          configured: true,
          connected: false,
          isActive: type === activeType,
          status: 'idle_or_disconnected',
          target: type === 'postgresql' ? `${config.postgresql.host}:${config.postgresql.port}/${config.postgresql.database}` : config.mongodb.database,
        };
      }
    }

    return {
      activeDatabase: activeType,
      isSwitchInProgress: databaseRegistry.isSwitchInProgress(),
      databases: results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get sanitized configuration.
   */
  getConfig() {
    const rawConfig = loadDatabaseConfig();
    return {
      activeDatabase: databaseRegistry.getActiveType() || rawConfig.activeDatabase,
      configuration: sanitizeConfig(rawConfig),
      allowedDatabases: ALLOWED_DATABASES,
    };
  }

  /**
   * Get audit log of database switches.
   */
  getSwitchHistory() {
    return databaseRegistry.getSwitchHistory();
  }
}

module.exports = new DatabaseSwitchService();

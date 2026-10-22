const crypto = require('crypto');
const DatabaseFactory = require('../database/factories/database.factory');
const { loadDatabaseConfig } = require('./database.config');

class DatabaseRegistry {
  constructor() {
    this.activeType = null;
    this.activeAdapter = null;
    this.adapters = new Map(); // Cache of initialized adapters
    this.isSwitching = false;
    this.switchHistory = [];
    this.initialized = false;
  }

  /**
   * Initialize the database registry with the configured default active database.
   * @param {string} [initialType]
   * @param {Object} [customConnections] - Optional custom connections for tests
   */
  async initialize(initialType = null, customConnections = {}) {
    const config = loadDatabaseConfig();
    const raw = String(initialType || 'mongodb').toLowerCase().trim();
    // Accept the same aliases as the adapter factory ('postgres', 'mongo').
    const targetType = raw === 'postgres' ? 'postgresql' : raw === 'mongo' ? 'mongodb' : raw;

    // If an adapter is already active and healthy, don't reinitialize unless forced
    if (this.initialized && this.activeAdapter && this.activeType === targetType) {
      return this.activeAdapter;
    }

    let adapter = this.adapters.get(targetType);
    if (!adapter) {
      adapter = DatabaseFactory.createAdapter(targetType, config, customConnections[targetType]);
      await adapter.connect();
      this.adapters.set(targetType, adapter);
    } else if (!adapter.isConnected) {
      await adapter.connect();
    }

    this.activeType = targetType;
    this.activeAdapter = adapter;
    this.initialized = true;

    this.recordHistory({
      admin: 'SYSTEM_BOOT',
      fromDatabase: null,
      toDatabase: targetType,
      status: 'SUCCESS',
      message: `System initialized with active database: ${targetType}`,
    });

    console.log(`[DatabaseRegistry] Active database initialized: ${targetType.toUpperCase()}`);
    return this.activeAdapter;
  }

  /**
   * Return the currently active event repository adapter.
   * Auto-initializes if not yet called.
   * @returns {import('../database/interfaces/event.repository')}
   */
  getActiveAdapter() {
    if (!this.activeAdapter) {
      const config = loadDatabaseConfig();
      const targetType = this.activeType || 'mongodb';
      this.activeAdapter = DatabaseFactory.createAdapter(targetType, config);
      this.activeType = targetType;
      this.adapters.set(targetType, this.activeAdapter);
      this.initialized = true;
    }
    return this.activeAdapter;
  }

  /**
   * Return the active database type ('postgresql' | 'mongodb').
   * @returns {string}
   */
  getActiveType() {
    return this.activeType || 'mongodb';
  }

  /**
   * Check if a database switch is currently in progress.
   * @returns {boolean}
   */
  isSwitchInProgress() {
    return this.isSwitching;
  }

  /**
   * Acquire switching lock. Throws if another switch is underway.
   */
  acquireSwitchLock() {
    if (this.isSwitching) {
      const err = new Error('A database switch is already in progress. Please wait for completion.');
      err.status = 409;
      throw err;
    }
    this.isSwitching = true;
  }

  /**
   * Release switching lock.
   */
  releaseSwitchLock() {
    this.isSwitching = false;
  }

  /**
   * Atomically switch the active database adapter.
   * Retains the previous adapter so any in-flight requests finish safely.
   * @param {string} targetType
   * @param {import('../database/interfaces/event.repository')} candidateAdapter
   * @param {Object} adminInfo
   */
  setActiveAdapter(targetType, candidateAdapter, adminInfo = {}) {
    const previousType = this.activeType;

    // Cache the adapter instance
    this.adapters.set(targetType, candidateAdapter);

    // Controlled atomic assignment
    this.activeAdapter = candidateAdapter;
    this.activeType = targetType;

    this.recordHistory({
      admin: adminInfo.username || adminInfo.userId || 'admin',
      fromDatabase: previousType,
      toDatabase: targetType,
      status: 'SUCCESS',
      message: `Successfully switched active database from ${previousType} to ${targetType}`,
    });

    console.log(`[DatabaseRegistry] Active database switched to: ${targetType.toUpperCase()}`);
  }

  /**
   * Record a database switch or startup event in audit log.
   */
  recordHistory({ admin, fromDatabase, toDatabase, status, message, error = null }) {
    const entry = {
      id: `sw_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      admin: admin || 'unknown_admin',
      fromDatabase,
      toDatabase,
      status, // 'SUCCESS' | 'FAILED'
      message,
      error: error ? (error.message || String(error)) : null,
    };
    this.switchHistory.unshift(entry);
    if (this.switchHistory.length > 50) {
      this.switchHistory.pop();
    }
    return entry;
  }

  /**
   * Retrieve switch history audit log.
   */
  getSwitchHistory() {
    return [...this.switchHistory];
  }

  /**
   * Graceful shutdown of all open adapters.
   */
  async shutdownAll() {
    console.log('[DatabaseRegistry] Gracefully disconnecting all database adapters...');
    for (const [type, adapter] of this.adapters.entries()) {
      try {
        await adapter.disconnect();
        console.log(`[DatabaseRegistry] Disconnected ${type}`);
      } catch (err) {
        console.warn(`[DatabaseRegistry] Error disconnecting ${type}:`, err.message);
      }
    }
    this.activeAdapter = null;
    this.activeType = null;
    this.adapters.clear();
    this.initialized = false;
  }
}

// Export singleton instance
module.exports = new DatabaseRegistry();

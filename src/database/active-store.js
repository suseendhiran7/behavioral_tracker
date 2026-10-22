'use strict';

/**
 * One place to ask "where does data go right now?".
 *
 * The active database (ACTIVE_DATABASE, or an admin switch at runtime)
 * decides where EVERYTHING is stored. When PostgreSQL is active, services use
 * these stores and never touch MongoDB; when MongoDB is active they use the
 * Mongoose models as before.
 */

const mongoose = require('mongoose');
const databaseRegistry = require('../config/database-registry');

function isPostgresActive() {
  return databaseRegistry.getActiveType() === 'postgresql';
}

function activeAdapter() {
  return databaseRegistry.getActiveAdapter();
}

/** PgAppStore (sessions, network intel, payments, ...) or null when Mongo is active. */
function pgAppStore() {
  if (!isPostgresActive()) return null;
  const adapter = activeAdapter();
  return adapter && typeof adapter.getAppStore === 'function' ? adapter.getAppStore() : null;
}

/** PgEventStore (login_/session_/payment_events) or null when Mongo is active. */
function pgEventStore() {
  if (!isPostgresActive()) return null;
  const adapter = activeAdapter();
  return adapter && typeof adapter.getEventStore === 'function' ? adapter.getEventStore() : null;
}

/** True only when MongoDB is the active database AND connected. */
function mongoActiveAndReady() {
  return !isPostgresActive() && mongoose.connection.readyState === 1;
}

module.exports = { isPostgresActive, activeAdapter, pgAppStore, pgEventStore, mongoActiveAndReady };

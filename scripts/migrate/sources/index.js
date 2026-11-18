'use strict';

/**
 * Registry of supported sources. To add a new database later:
 *   1. write sources/<name>.source.js implementing the same interface as MongoSource
 *   2. write entities/<name>.entities.js mapping its tables/collections to Postgres columns
 *   3. register it here
 * Nothing on the Postgres side changes.
 */
module.exports = {
  mongo: {
    create: (dbConfig) => new (require('./mongo.source'))(dbConfig.mongodb),
    entities: () => require('../entities/mongo.entities').entities,
  },
};

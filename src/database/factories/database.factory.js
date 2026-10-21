const PostgreSQLAdapter = require('../adapters/postgresql.adapter');
const MongoDBAdapter = require('../adapters/mongodb.adapter');
const { loadDatabaseConfig } = require('../../config/database.config');

class DatabaseFactory {
  /**
   * Instantiate an adapter of the given type.
   * @param {'postgresql' | 'mongodb'} type
   * @param {Object} [overrideConfig]
   * @param {any} [customConnection] - Optional custom connection/pool (e.g. for testing)
   * @returns {import('../interfaces/event.repository')}
   */
  static createAdapter(type, overrideConfig = null, customConnection = null) {
    const normalizedType = (type || '').toLowerCase();
    const config = overrideConfig || loadDatabaseConfig();

    switch (normalizedType) {
      case 'postgres':
      case 'postgresql':
        return new PostgreSQLAdapter(config.postgresql || config, customConnection);

      case 'mongo':
      case 'mongodb':
        return new MongoDBAdapter(config.mongodb || config, customConnection);

      default:
        throw new Error(`Unsupported database adapter type: '${type}'. Supported types: ['postgresql', 'mongodb']`);
    }
  }
}

module.exports = DatabaseFactory;

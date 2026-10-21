const { z } = require('zod');
require('dotenv').config();

const DatabaseConfigSchema = z.object({
  activeDatabase: z.enum(['mongodb', 'postgresql']).default('mongodb'),

  mongodb: z.object({
    uri: z.string().default('mongodb://localhost:27017/xylium'),
    database: z.string().default('xylium'),
    maxPoolSize: z.number().int().positive().default(20),
    minPoolSize: z.number().int().nonnegative().default(2),
    serverSelectionTimeoutMS: z.number().int().positive().default(5000),
    socketTimeoutMS: z.number().int().positive().default(30000),
  }),

  postgresql: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().positive().default(5432),
    database: z.string().default('behavioral_events'),
    user: z.string().default('postgres'),
    password: z.string().default(''),
    ssl: z.boolean().default(false),
    maxPoolSize: z.number().int().positive().default(20),
    idleTimeoutMillis: z.number().int().positive().default(30000),
    connectionTimeoutMillis: z.number().int().positive().default(5000),
  }),
});

function parseMongoDatabase(uri) {
  try {
    const url = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    const path = url.pathname.replace(/^\//, '');
    return path || 'xylium';
  } catch {
    return 'xylium';
  }
}

function loadDatabaseConfig() {
  const activeDatabase = 'mongodb';
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/xylium';
  const mongoDbName = process.env.MONGODB_DATABASE || parseMongoDatabase(mongoUri);

  const rawConfig = {
    activeDatabase,
    mongodb: {
      uri: mongoUri,
      database: mongoDbName,
      maxPoolSize: parseInt(process.env.MONGO_MAX_POOL || '20', 10),
      minPoolSize: parseInt(process.env.MONGO_MIN_POOL || '2', 10),
      serverSelectionTimeoutMS: parseInt(process.env.MONGO_TIMEOUT_MS || '5000', 10),
      socketTimeoutMS: parseInt(process.env.MONGO_SOCKET_TIMEOUT_MS || '30000', 10),
    },
    postgresql: {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DATABASE || 'behavioral_events',
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || '',
      ssl: process.env.POSTGRES_SSL === 'true',
      maxPoolSize: parseInt(process.env.POSTGRES_MAX_POOL || '20', 10),
      idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT_MS || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT_MS || '5000', 10),
    },
  };

  const parsed = DatabaseConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    console.error('[database.config] Configuration validation failed:', parsed.error.format());
    throw new Error(`Invalid database configuration: ${JSON.stringify(parsed.error.flatten())}`);
  }

  return parsed.data;
}

/**
 * Mask sensitive credentials for API responses and logs.
 */
function sanitizeConfig(config) {
  const masked = JSON.parse(JSON.stringify(config));
  if (masked.postgresql) {
    masked.postgresql.password = masked.postgresql.password ? '******' : '';
  }
  if (masked.mongodb && masked.mongodb.uri) {
    masked.mongodb.uri = masked.mongodb.uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+(@)/, '$1******$2');
  }
  return masked;
}

module.exports = {
  loadDatabaseConfig,
  sanitizeConfig,
  DatabaseConfigSchema,
};

const mongoose = require('mongoose');
const config = require('./config');
const databaseRegistry = require('./config/database-registry');
const createApp = require('./app');
const { startForwardWorker } = require('./forward/worker');

async function main() {
  // Connect Mongoose
  try {
    await mongoose.connect(config.mongoUri);
    console.log(`[XyliumIngestion] connected to Mongo`);

    if (config.rawTtlDays > 0) {
      await mongoose.connection
        .collection('event_batches')
        .createIndex({ receivedAt: 1 }, { expireAfterSeconds: config.rawTtlDays * 86400 })
        .catch((e) => console.warn('[server] TTL index setup failed', e.message));
    }
  } catch (err) {
    console.warn(`[server] MongoDB startup warning: ${err.message}`);
  }

  // Initialize Dual Database Registry with default active database in code (mongodb)
  try {
    await databaseRegistry.initialize('mongodb');
    const activeAdapter = databaseRegistry.getActiveAdapter();
    const health = await activeAdapter.healthCheck();
    if (health.status !== 'healthy') {
      console.warn(`[server] Warning: Active database (${databaseRegistry.getActiveType()}) reported unhealthy status:`, health.error);
    } else {
      console.log(`[server] Active database (${databaseRegistry.getActiveType()}) verified healthy (${health.latencyMs}ms)`);
    }
  } catch (err) {
    console.error(`[server] Active database initialization error: ${err.message}`);
  }

  const worker = startForwardWorker();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[XyliumIngestion] listening on :${config.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] received ${signal}, shutting down...`);
    server.close();
    await worker.close();
    await databaseRegistry.shutdownAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});

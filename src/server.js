const mongoose = require('mongoose');
const config = require('./config');
const databaseRegistry = require('./config/database-registry');
const createApp = require('./app');
const { COLLECTIONS } = require('./models/EventStores');
const { startForwardWorker } = require('./forward/worker');

async function main() {
  const activeDb = (process.env.ACTIVE_DATABASE || 'mongodb').toLowerCase();
  const usePostgres = activeDb === 'postgresql' || activeDb === 'postgres';

  // Connect Mongoose only when MongoDB is the active database. With PostgreSQL
  // active nothing is stored in Mongo (if an admin switches to MongoDB later,
  // the Mongo adapter connects then).
  if (!usePostgres) try {
    await mongoose.connect(config.mongoUri);
    console.log(`[XyliumIngestion] connected to Mongo`);

    if (config.rawTtlDays > 0) {
      for (const name of COLLECTIONS) {
        await mongoose.connection
          .collection(name)
          .createIndex({ receivedAt: 1 }, { expireAfterSeconds: config.rawTtlDays * 86400 })
          .catch((e) => console.warn(`[server] TTL index setup failed for ${name}`, e.message));
      }
    }
  } catch (err) {
    console.warn(`[server] MongoDB startup warning: ${err.message}`);
  }

  // Initialize Dual Database Registry with default active database in code (mongodb)
  try {
    const db = usePostgres ? 'postgresql' : 'mongodb';
    await databaseRegistry.initialize(db);
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

  // PostgreSQL version of the Mongo TTL index: purge raw event rows older than
  // RAW_TTL_DAYS from login_/session_/payment_events and event_batches, hourly.
  let retentionTimer = null;
  if (config.rawTtlDays > 0) {
    const purge = async () => {
      if (databaseRegistry.getActiveType() !== 'postgresql') return;
      try {
        const res = await databaseRegistry.getActiveAdapter().getAppStore().purgeRawOlderThan(config.rawTtlDays);
        const total = Object.values(res).reduce((a, b) => a + b, 0);
        if (total) console.log(`[retention] purged ${total} PostgreSQL row(s) older than ${config.rawTtlDays} day(s)`, res);
      } catch (err) {
        console.warn('[retention] PostgreSQL purge failed:', err.message);
      }
    };
    purge();
    retentionTimer = setInterval(purge, 60 * 60 * 1000);
    retentionTimer.unref();
  }

  const worker = startForwardWorker();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[XyliumIngestion] listening on :${config.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] received ${signal}, shutting down...`);
    server.close();
    if (retentionTimer) clearInterval(retentionTimer);
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

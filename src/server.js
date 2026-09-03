const mongoose = require('mongoose');
const config = require('./config');
const createApp = require('./app');
const { startForwardWorker } = require('./forward/worker');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log(`[XyliumIngestion] connected to Mongo`);

  if (config.rawTtlDays > 0) {
    await mongoose.connection
      .collection('event_batches')
      .createIndex({ receivedAt: 1 }, { expireAfterSeconds: config.rawTtlDays * 86400 })
      .catch((e) => console.warn('[server] TTL index setup failed', e.message));
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
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});

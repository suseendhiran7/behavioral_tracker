const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');

const healthRouter = require('./routes/health');
const collectRouter = require('./routes/collect');
const identifyRouter = require('./routes/identify');

function createApp() {
  const app = express();

  // CORS: the SDK POSTs cross-origin from customer sites. "*" is dev-only.
  const origins = config.corsOrigins;
  app.use(
    cors({
      origin: origins.length === 0 || origins.includes('*') ? true : origins,
      methods: ['POST', 'GET', 'OPTIONS'],
      maxAge: 86400,
    })
  );

  // Body size cap applied before any parsing/validation.
  app.use(express.json({ limit: config.maxPayloadBytes }));

  // Coarse IP-based abuse cap. Real per-tenant limits belong at the LB/gateway
  // — many legitimate users share one IP (corporate NAT / mobile CGNAT), so
  // keep this high or you'll silently drop telemetry.
  app.use(
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.use('/health', healthRouter);
  app.use('/collect', collectRouter);
  app.use('/identify', identifyRouter);

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Central error handler — catches BadRequestError, JSON parse errors, etc.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload too large' });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[error]', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = createApp;

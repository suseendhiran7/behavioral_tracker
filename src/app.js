const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const healthRouter = require('./routes/health');
const collectRouter = require('./routes/collect');
const identifyRouter = require('./routes/identify');

function createApp() {
  const app = express();

  // CORS — must be first, before everything
  const origins = config.corsOrigins;
  app.use(
    cors({
      origin: origins.length === 0 || origins.includes('*') ? true : origins,
      methods: ['POST', 'GET', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-tenant-id'],
      maxAge: 86400,
    })
  );

  // Handle preflight explicitly — browsers send OPTIONS before POST
  app.options('*', cors());

  // Parse application/json
  app.use(express.json({ limit: config.maxPayloadBytes }));

  // ── KEY FIX ──────────────────────────────────────────────────────
  // sendBeacon (fired on page unload/logout) sends Content-Type: text/plain
  // express.json() ignores it → req.body stays undefined → tenantGuard
  // can't read tenantId → 403. This middleware catches those requests
  // and parses the JSON manually before any route sees it.
  app.use((req, res, next) => {
    if (
      req.method === 'POST' &&
      req.is('text/plain') &&
      (!req.body || Object.keys(req.body).length === 0)
    ) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try {
          req.body = JSON.parse(raw);
        } catch (e) {
          req.body = {};
        }
        next();
      });
      req.on('error', () => {
        req.body = {};
        next();
      });
    } else {
      next();
    }
  });

  // Rate limiting
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

  // Central error handler
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
/**
 * tests/setupEnv.js
 * -------------------------------------------------------------------------
 * Runs before every test FILE's own imports (Jest "setupFiles"). Sets
 * deterministic env vars so tests never depend on the real .env — in
 * particular XYLIUM_SDK_DIR is pointed at a throwaway temp folder instead
 * of the real (Windows) SDK path, so tests never touch real SDK files.
 *
 * dotenv (loaded inside src/config/index.js) does NOT override variables
 * already present in process.env, so setting them here first wins.
 */
'use strict';

const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.MONGO_URI = 'mongodb://localhost:27017/xylium_test';

process.env.ALLOWED_TENANTS = 'tenant_test001,tenant_abc123';
process.env.CORS_ORIGINS = '*';
process.env.TENANT_API_KEYS = JSON.stringify({
  tenant_test001: 'changeme-secret',
  tenant_abc123: 'changeme-secret',
});

process.env.MAX_BATCH_EVENTS = '500';
process.env.MAX_PAYLOAD_BYTES = '262144';
process.env.RAW_TTL_DAYS = '0';

// High enough that express-rate-limit never interferes with a test run.
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_MAX = '100000';

// Unique per test FILE (Jest gives each file its own module registry, and
// re-runs setupFiles for each), so parallel test files never collide.
process.env.XYLIUM_SDK_DIR = path.join(
  os.tmpdir(),
  `xylium-sdk-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

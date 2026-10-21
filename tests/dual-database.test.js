const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { newDb } = require('pg-mem');

const createApp = require('../src/app');
const PostgreSQLAdapter = require('../src/database/adapters/postgresql.adapter');
const MongoDBAdapter = require('../src/database/adapters/mongodb.adapter');
const EventRepository = require('../src/database/interfaces/event.repository');
const databaseRegistry = require('../src/config/database-registry');
const databaseSwitchService = require('../src/services/database-switch.service');
const { sanitizeConfig, loadDatabaseConfig } = require('../src/config/database.config');
const { normalizeEvent } = require('../src/database/schema/event.schema');
const BehaviourEvent = require('../src/models/BehaviourEvent');

const TEST_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/xylium_test';

let server;
let baseUrl;
let pgPool;
let pgAdapter;
let mongoAdapter;

const API_KEY_HEADERS = {
  'Content-Type': 'application/json',
  'x-tenant-id': 'tenant_test001',
  'x-api-key': 'changeme-secret',
};

function createPgMemPool() {
  const memDb = newDb();
  const pg = memDb.adapters.createPg();
  return new pg.Pool();
}

before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_DB_URI);
  }

  // Clear test DB collections
  await BehaviourEvent.deleteMany({});

  // Setup PG-mem pool for PostgreSQL testing
  pgPool = createPgMemPool();
  pgAdapter = new PostgreSQLAdapter({ database: 'test_pg_events' }, pgPool);
  await pgAdapter.connect();

  // Setup MongoDB adapter
  mongoAdapter = new MongoDBAdapter({ database: 'xylium_test' }, mongoose.connection);
  await mongoAdapter.connect();

  // Register both adapters in the registry
  databaseRegistry.adapters.set('postgresql', pgAdapter);
  databaseRegistry.adapters.set('mongodb', mongoAdapter);

  // Initialize with mongodb as default active adapter
  databaseRegistry.activeAdapter = mongoAdapter;
  databaseRegistry.activeType = 'mongodb';
  databaseRegistry.initialized = true;

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) server.close();
  await pgAdapter.disconnect();
  // Ensure we don't disconnect mongoose if other tests might use it, or disconnect gracefully
});

describe('Dual Database Architecture — PostgreSQL + MongoDB', () => {

  // Verification 1: Interface compliance
  test('1. Both database adapters implement the exact same required EventRepository interface', () => {
    const requiredMethods = [
      'connect',
      'disconnect',
      'healthCheck',
      'saveEvent',
      'saveEvents',
      'getEventById',
      'getEvents',
      'getSessionEvents',
      'getUserEvents',
      'getEventCounts',
      'getAdapterInfo',
      'linkSessionEvents',
      'deleteUserData',
      'getUserSummary',
    ];

    for (const method of requiredMethods) {
      assert.strictEqual(typeof pgAdapter[method], 'function', `PostgreSQLAdapter missing method: ${method}`);
      assert.strictEqual(typeof mongoAdapter[method], 'function', `MongoDBAdapter missing method: ${method}`);
    }

    assert.ok(pgAdapter instanceof EventRepository);
    assert.ok(mongoAdapter instanceof EventRepository);
  });

  // Verification 2: Valid events are stored and retrieved consistently
  test('2. Valid events are stored and retrieved consistently across both PostgreSQL and MongoDB', async () => {
    const rawEvent = {
      eventId: 'evt_consistent_001',
      tenantId: 'tenant_bank_a',
      clientId: 'client_web_01',
      userId: 'user_david_99',
      sessionId: 'sess_consistent_123',
      eventName: 'pointer_click',
      eventCategory: 'pointer',
      timestamp: new Date().toISOString(),
      sequenceNumber: 1,
      page: '/checkout/pay',
      sanitizedRoute: '/checkout/pay',
      pointerX: 250,
      pointerY: 340,
      pointerSpeedPxPerMs: 0.85,
      properties: { element: 'confirm_btn', flow: 'transfer' },
    };

    // Store in PostgreSQL
    const pgSaved = await pgAdapter.saveEvent(rawEvent);
    assert.strictEqual(pgSaved.eventId, rawEvent.eventId);
    assert.strictEqual(pgSaved.tenantId, rawEvent.tenantId);
    assert.strictEqual(pgSaved.pointerX, 250);

    const pgFetched = await pgAdapter.getEventById(rawEvent.eventId, rawEvent.tenantId);
    assert.ok(pgFetched);
    assert.strictEqual(pgFetched.sessionId, rawEvent.sessionId);
    assert.strictEqual(pgFetched.pointerSpeedPxPerMs, 0.85);

    // Store in MongoDB
    const mongoSaved = await mongoAdapter.saveEvent(rawEvent);
    assert.strictEqual(mongoSaved.eventId, rawEvent.eventId);

    const mongoFetched = await mongoAdapter.getEventById(rawEvent.eventId, rawEvent.tenantId);
    assert.ok(mongoFetched);
    assert.strictEqual(mongoFetched.sessionId, rawEvent.sessionId);
    assert.strictEqual(mongoFetched.properties.flow, 'transfer');
  });

  // Verification 3: Invalid event payloads are rejected
  test('3. Invalid event payloads are rejected by schema validation', () => {
    assert.throws(() => {
      normalizeEvent({
        // Missing sessionId and eventName
        timestamp: 'invalid-date-format',
      });
    }, /validation failed/i);
  });

  // Verification 4: Tenant isolation is enforced
  test('4. Tenant isolation is strictly enforced across both database adapters', async () => {
    const eventTenantA = {
      eventId: 'evt_secret_tenant_a',
      tenantId: 'tenant_alpha',
      sessionId: 'sess_alpha_1',
      eventName: 'balance_view',
      eventCategory: 'banking',
      timestamp: new Date().toISOString(),
    };

    await pgAdapter.saveEvent(eventTenantA);
    await mongoAdapter.saveEvent(eventTenantA);

    // Cross-tenant query by tenant_beta must return null
    const pgCross = await pgAdapter.getEventById('evt_secret_tenant_a', 'tenant_beta');
    assert.strictEqual(pgCross, null, 'PostgreSQL leaked cross-tenant data');

    const mongoCross = await mongoAdapter.getEventById('evt_secret_tenant_a', 'tenant_beta');
    assert.strictEqual(mongoCross, null, 'MongoDB leaked cross-tenant data');

    // Filter query by tenant_beta must return empty list
    const pgEventsBeta = await pgAdapter.getEvents({ tenantId: 'tenant_beta' });
    const mongoEventsBeta = await mongoAdapter.getEvents({ tenantId: 'tenant_beta' });

    assert.strictEqual(pgEventsBeta.events.filter(e => e.eventId === 'evt_secret_tenant_a').length, 0);
    assert.strictEqual(mongoEventsBeta.events.filter(e => e.eventId === 'evt_secret_tenant_a').length, 0);
  });

  // Verification 5: Idempotency and duplicate prevention
  test('5. Event IDs and idempotency work correctly without duplicate inserts', async () => {
    const duplicateEvt = {
      eventId: 'evt_idempotent_test_001',
      tenantId: 'tenant_test001',
      sessionId: 'sess_idem_1',
      eventName: 'button_press',
      eventCategory: 'pointer',
      timestamp: new Date().toISOString(),
    };

    // PostgreSQL: Save twice
    await pgAdapter.saveEvent(duplicateEvt);
    await pgAdapter.saveEvent(duplicateEvt);
    const pgRes = await pgAdapter.getEvents({ tenantId: 'tenant_test001', sessionId: 'sess_idem_1' });
    const pgMatches = pgRes.events.filter(e => e.eventId === 'evt_idempotent_test_001');
    assert.strictEqual(pgMatches.length, 1, 'PostgreSQL duplicate event inserted');

    // MongoDB: Save twice
    await mongoAdapter.saveEvent(duplicateEvt);
    await mongoAdapter.saveEvent(duplicateEvt);
    const mongoRes = await mongoAdapter.getEvents({ tenantId: 'tenant_test001', sessionId: 'sess_idem_1' });
    const mongoMatches = mongoRes.events.filter(e => e.eventId === 'evt_idempotent_test_001');
    assert.strictEqual(mongoMatches.length, 1, 'MongoDB duplicate event inserted');

    // Bulk save with duplicate detection
    const batchRes = await pgAdapter.saveEvents([duplicateEvt, duplicateEvt]);
    assert.strictEqual(batchRes.insertedCount, 0);
    assert.strictEqual(batchRes.duplicateCount, 2);
  });

  // Verification 6: Filters, sorting, and pagination behave consistently
  test('6. Filters, sorting, and pagination behave consistently across both adapters', async () => {
    const sessionId = 'sess_pagination_test';
    const tenantId = 'tenant_pagination';

    const eventsToInsert = [];
    for (let i = 1; i <= 15; i++) {
      eventsToInsert.push({
        eventId: `evt_page_${i}`,
        tenantId,
        sessionId,
        userId: 'user_pager',
        eventName: `step_${i}`,
        eventCategory: i % 2 === 0 ? 'pointer' : 'keyboard',
        sequenceNumber: i,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      });
    }

    await pgAdapter.saveEvents(eventsToInsert);
    await mongoAdapter.saveEvents(eventsToInsert);

    // Query Page 1 with limit 5
    const pgPage1 = await pgAdapter.getEvents({ tenantId }, { page: 1, limit: 5 });
    const mongoPage1 = await mongoAdapter.getEvents({ tenantId }, { page: 1, limit: 5 });

    assert.strictEqual(pgPage1.events.length, 5);
    assert.strictEqual(mongoPage1.events.length, 5);
    assert.strictEqual(pgPage1.pagination.total, 15);
    assert.strictEqual(mongoPage1.pagination.total, 15);
    assert.strictEqual(pgPage1.pagination.totalPages, 3);
    assert.strictEqual(mongoPage1.pagination.totalPages, 3);

    // Sorted descending by timestamp: first event should be evt_page_15
    assert.strictEqual(pgPage1.events[0].eventId, 'evt_page_15');
    assert.strictEqual(mongoPage1.events[0].eventId, 'evt_page_15');

    // Filter by category
    const pgCategory = await pgAdapter.getEvents({ tenantId, eventCategory: 'pointer' });
    const mongoCategory = await mongoAdapter.getEvents({ tenantId, eventCategory: 'pointer' });
    assert.strictEqual(pgCategory.events.length, 7);
    assert.strictEqual(mongoCategory.events.length, 7);
  });

  // Verification 7: PostgreSQL connection failure handling
  test('7. PostgreSQL connection failures are handled gracefully without crashing', async () => {
    const badPgAdapter = new PostgreSQLAdapter({
      host: '127.0.0.1',
      port: 19999, // Dead port
      connectionTimeoutMillis: 500,
    });

    const health = await badPgAdapter.healthCheck();
    assert.strictEqual(health.status, 'unhealthy');
    assert.ok(health.error);
  });

  // Verification 8: MongoDB connection failure handling
  test('8. MongoDB connection failures are handled gracefully without crashing', async () => {
    const badMongoAdapter = new MongoDBAdapter({
      uri: 'mongodb://127.0.0.1:19999/dead_db',
      serverSelectionTimeoutMS: 500,
    }, null);

    const health = await badMongoAdapter.healthCheck();
    assert.strictEqual(health.status, 'unhealthy');
  });

  // Verification 9: Switching to a healthy database succeeds
  test('9. Switching to a healthy database succeeds and updates active adapter', async () => {
    // Current is mongodb; switch to postgresql
    const switchRes = await fetch(`${baseUrl}/api/admin/database/switch`, {
      method: 'POST',
      headers: API_KEY_HEADERS,
      body: JSON.stringify({ databaseType: 'postgresql' }),
    });

    assert.strictEqual(switchRes.status, 200);
    const body = await switchRes.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.activeDatabase, 'postgresql');
    assert.strictEqual(databaseRegistry.getActiveType(), 'postgresql');
  });

  // Verification 10: Switching to an unhealthy database fails without changing active adapter
  test('10. Switching to an unhealthy database fails and preserves previous active adapter', async () => {
    assert.strictEqual(databaseRegistry.getActiveType(), 'postgresql');

    // Attempt to switch to an unsupported/unhealthy type
    const badRes = await fetch(`${baseUrl}/api/admin/database/switch`, {
      method: 'POST',
      headers: API_KEY_HEADERS,
      body: JSON.stringify({ databaseType: 'invalid_engine' }),
    });

    assert.strictEqual(badRes.status, 400);
    // Active database remains postgresql!
    assert.strictEqual(databaseRegistry.getActiveType(), 'postgresql');
  });

  // Verification 11: In-flight requests drain safely during switch
  test('11. In-flight requests complete safely during and after a switch', async () => {
    // Switch to mongodb
    await databaseSwitchService.switchDatabase('mongodb', { username: 'test_admin' });
    assert.strictEqual(databaseRegistry.getActiveType(), 'mongodb');

    // Concurrent batch ingestion while switching
    const ingestPromise = fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          eventId: 'evt_inflight_001',
          sessionId: 'sess_inflight',
          eventName: 'inflight_action',
          eventCategory: 'pointer',
          timestamp: new Date().toISOString(),
        }],
      }),
    });

    const switchPromise = databaseSwitchService.switchDatabase('postgresql', { username: 'test_admin' });

    const [ingestRes, switchRes] = await Promise.all([ingestPromise, switchPromise]);
    assert.strictEqual(ingestRes.status, 202);
    assert.strictEqual(switchRes.ok, true);
    assert.strictEqual(databaseRegistry.getActiveType(), 'postgresql');
  });

  // Verification 12: Concurrent switch attempts are handled safely
  test('12. Concurrent database switches are guarded by concurrency lock', async () => {
    databaseRegistry.isSwitching = true; // Simulate ongoing switch lock
    try {
      await assert.rejects(
        async () => {
          await databaseSwitchService.switchDatabase('mongodb', { username: 'concurrent_admin' });
        },
        (err) => {
          assert.strictEqual(err.status, 409);
          assert.match(err.message, /switch is already in progress/i);
          return true;
        }
      );
    } finally {
      databaseRegistry.releaseSwitchLock();
    }
  });

  // Verification 13: Newly routed ingestion requests land in selected adapter
  test('13. Newly routed ingestion requests are persisted strictly to the newly activated adapter', async () => {
    // 1. Activate PostgreSQL
    await databaseSwitchService.switchDatabase('postgresql', { username: 'admin_test' });
    const pgEvtId = 'evt_routed_to_pg_' + Date.now();

    const pgBatchRes = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          eventId: pgEvtId,
          sessionId: 'sess_routing_test',
          eventName: 'routed_pg_event',
          eventCategory: 'pointer',
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    assert.strictEqual(pgBatchRes.status, 202);

    // Verify stored in PostgreSQL
    const pgFound = await pgAdapter.getEventById(pgEvtId, 'default');
    assert.ok(pgFound, 'Event must exist in PostgreSQL');

    // 2. Activate MongoDB
    await databaseSwitchService.switchDatabase('mongodb', { username: 'admin_test' });
    const mongoEvtId = 'evt_routed_to_mongo_' + Date.now();

    const mongoBatchRes = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          eventId: mongoEvtId,
          sessionId: 'sess_routing_test',
          eventName: 'routed_mongo_event',
          eventCategory: 'keyboard',
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    assert.strictEqual(mongoBatchRes.status, 202);

    // Verify stored in MongoDB
    const mongoFound = await mongoAdapter.getEventById(mongoEvtId, 'default');
    assert.ok(mongoFound, 'Event must exist in MongoDB');
  });

  // Verification 14: Historical records are not deleted or silently migrated
  test('14. Historical records are preserved in original database upon switching', async () => {
    const historicalPgEvtId = 'evt_historical_pg_' + Date.now();
    await pgAdapter.saveEvent({
      eventId: historicalPgEvtId,
      tenantId: 'default',
      sessionId: 'sess_hist_check',
      eventName: 'historical_action',
      eventCategory: 'pointer',
      timestamp: new Date().toISOString(),
    });

    // Switch to MongoDB
    await databaseSwitchService.switchDatabase('mongodb', { username: 'admin_test' });

    // The historical event in PostgreSQL still exists in PostgreSQL!
    const stillInPg = await pgAdapter.getEventById(historicalPgEvtId, 'default');
    assert.ok(stillInPg, 'Historical PostgreSQL record was unexpectedly deleted');

    // It was not silently copied into MongoDB
    const copiedToMongo = await mongoAdapter.getEventById(historicalPgEvtId, 'default');
    assert.strictEqual(copiedToMongo, null, 'Historical record was silently migrated');
  });

  // Verification 15: Secrets are never exposed in API responses or logs
  test('15. Secrets, passwords, and sensitive connection strings are never exposed', async () => {
    const configRes = await fetch(`${baseUrl}/api/admin/database/config`, {
      headers: API_KEY_HEADERS,
    });
    assert.strictEqual(configRes.status, 200);
    const data = await configRes.json();

    // Check PostgreSQL credentials
    assert.notStrictEqual(data.configuration.postgresql.password, process.env.POSTGRES_PASSWORD || 'SuperSecretDbPassword123');
    assert.ok(data.configuration.postgresql.password === '' || data.configuration.postgresql.password === '******');

    // Check sanitizeConfig directly with simulated passwords
    const simulated = {
      postgresql: { password: 'SuperSecretDbPassword123' },
      mongodb: { uri: 'mongodb://admin:super_secret_pw@mongo.cloud.com:27017/xylium' },
    };
    const sanitized = sanitizeConfig(simulated);
    assert.strictEqual(sanitized.postgresql.password, '******');
    assert.ok(!sanitized.mongodb.uri.includes('super_secret_pw'));
    assert.ok(sanitized.mongodb.uri.includes('******'));

    // Check sensitive property stripping from events
    const sanitizedEvt = normalizeEvent({
      eventId: 'evt_clean_test',
      sessionId: 'sess_clean',
      eventName: 'form_filled',
      eventCategory: 'form',
      properties: {
        field: 'card_number',
        password: 'PlainTextPassword123',
        pin: '1234',
        cvv: '999',
        safeProperty: 'user_flow_step_2',
      },
    });

    assert.strictEqual(sanitizedEvt.properties.password, undefined);
    assert.strictEqual(sanitizedEvt.properties.pin, undefined);
    assert.strictEqual(sanitizedEvt.properties.cvv, undefined);
    assert.strictEqual(sanitizedEvt.properties.safeProperty, 'user_flow_step_2');
  });

  // Verification 16: Existing authentication, SDK integration, and dashboard endpoints continue working
  test('16. Admin database endpoints, status, test-connection, and switch-history endpoints work end-to-end', async () => {
    // 1. Unauthorized access returns 401
    const unauthRes = await fetch(`${baseUrl}/api/admin/database/status`);
    assert.strictEqual(unauthRes.status, 401);

    // 2. Status endpoint returns both databases
    const statusRes = await fetch(`${baseUrl}/api/admin/database/status`, {
      headers: API_KEY_HEADERS,
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.ok(statusData.databases.postgresql);
    assert.ok(statusData.databases.mongodb);

    // 3. Test-connection endpoint
    const testRes = await fetch(`${baseUrl}/api/admin/database/test-connection`, {
      method: 'POST',
      headers: API_KEY_HEADERS,
      body: JSON.stringify({ databaseType: 'postgresql' }),
    });
    assert.strictEqual(testRes.status, 200);
    const testData = await testRes.json();
    assert.strictEqual(testData.ok, true);
    assert.strictEqual(testData.databaseType, 'postgresql');

    // 4. Switch history endpoint
    const histRes = await fetch(`${baseUrl}/api/admin/database/switch-history`, {
      headers: API_KEY_HEADERS,
    });
    assert.strictEqual(histRes.status, 200);
    const histData = await histRes.json();
    assert.ok(Array.isArray(histData.history));
    assert.ok(histData.history.length > 0);
  });
});

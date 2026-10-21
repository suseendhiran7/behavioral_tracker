const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const createApp = require('../src/app');
const { generateToken } = require('../src/utils/token');
const BehaviourEvent = require('../src/models/BehaviourEvent');
const BehaviourSession = require('../src/models/BehaviourSession');
const PageEngagement = require('../src/models/PageEngagement');
const PaymentRecord = require('../src/models/PaymentRecord');
const BehaviourTracker = require('../behavioral_tracker_sdk/analytics-tracker');

const TEST_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/xylium_test';

let server;
let baseUrl;
const API_KEY_HEADERS = {
  'Content-Type': 'application/json',
  'x-tenant-id': 'tenant_test001',
  'x-api-key': 'changeme-secret',
};

before(async () => {
  await mongoose.connect(TEST_DB_URI);
  // Clear test db
  await Promise.all([
    BehaviourEvent.deleteMany({}),
    BehaviourSession.deleteMany({}),
    PageEngagement.deleteMany({}),
    PaymentRecord.deleteMany({}),
  ]);

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
  await mongoose.disconnect();
});

describe('User-Linked Behaviour Analytics & Tracking System', () => {
  // Scenario 1: Anonymous events before login
  test('1. Anonymous events before login are ingested with userId null and correct sessionId', async () => {
    const sessionId = 'sess_anon_001';
    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_anon_1',
            sessionId,
            anonymousId: 'anon_user_99',
            eventName: 'page_entered',
            eventCategory: 'navigation',
            timestamp: new Date().toISOString(),
            sanitizedRoute: '/login',
          },
          {
            eventId: 'evt_anon_2',
            sessionId,
            anonymousId: 'anon_user_99',
            eventName: 'click',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
            sanitizedRoute: '/login',
            properties: { elementId: 'submit_btn' },
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);
    const data = await res.json();
    assert.strictEqual(data.ok, true);

    const events = await BehaviourEvent.find({ sessionId }).lean();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].userId, null);
    assert.strictEqual(events[0].sessionId, sessionId);
  });

  // Scenario 2: Successful login and anonymous-session linking
  test('2. Successful login links anonymous session and backfills historical events', async () => {
    const sessionId = 'sess_anon_001';
    const userId = 'user_alice_123';

    const linkRes = await fetch(`${baseUrl}/api/analytics/sessions/link`, {
      method: 'POST',
      headers: API_KEY_HEADERS,
      body: JSON.stringify({
        sessionId,
        userId,
        anonymousId: 'anon_user_99',
      }),
    });

    assert.strictEqual(linkRes.status, 200);
    const linkData = await linkRes.json();
    assert.strictEqual(linkData.ok, true);
    assert.strictEqual(linkData.userId, userId);

    // Verify historical events got backfilled
    const events = await BehaviourEvent.find({ sessionId, eventCategory: { $ne: 'session' } }).lean();
    assert.ok(events.length >= 2);
    for (const evt of events) {
      assert.strictEqual(evt.userId, userId, 'Pre-login event should now have Alice userId');
    }

    // Verify session document is updated
    const sessionDoc = await BehaviourSession.findOne({ sessionId }).lean();
    assert.strictEqual(sessionDoc.userId, userId);
    assert.ok(sessionDoc.linkedAt);
  });

  // Scenario 3: Failed login
  test('3. Failed login does not create false authenticated-user association', async () => {
    const failedSessionId = 'sess_failed_login_002';
    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_failed_1',
            sessionId: failedSessionId,
            eventName: 'login_attempted',
            eventCategory: 'session',
            timestamp: new Date().toISOString(),
            properties: { outcome: 'failure', reason: 'invalid_credentials' },
          },
        ],
      }),
    });

    const evt = await BehaviourEvent.findOne({ eventId: 'evt_failed_1' }).lean();
    assert.strictEqual(evt.userId, null, 'Failed login event must have null userId');

    const session = await BehaviourSession.findOne({ sessionId: failedSessionId }).lean();
    assert.strictEqual(session.userId, null);
  });

  // Scenario 4: Authenticated event ingestion
  test('4. Authenticated event ingestion is associated with canonical user', async () => {
    const userId = 'user_alice_123';
    const token = generateToken({ userId, role: 'user', tenantId: 'tenant_test001' });

    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_auth_1',
            sessionId: 'sess_anon_001',
            eventName: 'dashboard_viewed',
            eventCategory: 'navigation',
            timestamp: new Date().toISOString(),
            sanitizedRoute: '/dashboard',
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);
    const stored = await BehaviourEvent.findOne({ eventId: 'evt_auth_1' }).lean();
    assert.strictEqual(stored.userId, userId);
  });

  // Scenario 5: Spoofed userId rejection
  test('5. Spoofed userId in request payload is overridden by canonical server identity', async () => {
    const realUserId = 'user_alice_123';
    const spoofedUserId = 'user_victim_999';
    const token = generateToken({ userId: realUserId, role: 'user', tenantId: 'tenant_test001' });

    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_spoof_attempt_1',
            sessionId: 'sess_anon_001',
            userId: spoofedUserId, // Spoofed!
            eventName: 'sensitive_action',
            eventCategory: 'custom',
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    const stored = await BehaviourEvent.findOne({ eventId: 'evt_spoof_attempt_1' }).lean();
    assert.strictEqual(stored.userId, realUserId, 'Server must enforce real userId and ignore payload');
    assert.notStrictEqual(stored.userId, spoofedUserId);
  });

  // Scenario 6: Switching between two user accounts in same browser
  test('6. Switching between two user accounts creates clear identity boundary without data mixing', async () => {
    const sessionBob = 'sess_bob_003';
    const userBob = 'user_bob_456';
    const tokenBob = generateToken({ userId: userBob, role: 'user', tenantId: 'tenant_test001' });

    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBob}`,
      },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_bob_1',
            sessionId: sessionBob,
            eventName: 'product_searched',
            eventCategory: 'navigation',
            timestamp: new Date().toISOString(),
            properties: { category: 'electronics' },
          },
        ],
      }),
    });

    const aliceEvents = await BehaviourEvent.find({ userId: 'user_alice_123' }).lean();
    const bobEvents = await BehaviourEvent.find({ userId: userBob }).lean();

    assert.ok(aliceEvents.length > 0);
    assert.ok(bobEvents.length > 0);

    // Verify zero intersection
    const aliceIds = new Set(aliceEvents.map((e) => e.eventId));
    const bobIds = new Set(bobEvents.map((e) => e.eventId));
    for (const bId of bobIds) {
      assert.strictEqual(aliceIds.has(bId), false, 'Alice and Bob events must not mix');
    }
  });

  // Scenario 7: Logout and session expiry
  test('7. Logout and session end marks session as ended', async () => {
    const endRes = await fetch(`${baseUrl}/api/analytics/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess_anon_001',
        summary: { reason: 'user_logged_out' },
      }),
    });

    assert.strictEqual(endRes.status, 200);
    const sess = await BehaviourSession.findOne({ sessionId: 'sess_anon_001' }).lean();
    assert.strictEqual(sess.status, 'ended');
    assert.ok(sess.endedAt);
  });

  // Scenario 8: Duplicate event delivery (idempotent ingestion)
  test('8. Duplicate event delivery is handled idempotently without error or duplicates', async () => {
    const duplicateEvt = {
      eventId: 'evt_idempotent_test_1',
      sessionId: 'sess_idemp_1',
      eventName: 'checkout_click',
      eventCategory: 'checkout',
      timestamp: new Date().toISOString(),
    };

    // First delivery
    const res1 = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [duplicateEvt] }),
    });
    assert.strictEqual(res1.status, 202);

    // Second delivery of identical eventId
    const res2 = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [duplicateEvt] }),
    });
    assert.strictEqual(res2.status, 202);

    // Verify database contains only 1 record
    const count = await BehaviourEvent.countDocuments({ eventId: 'evt_idempotent_test_1' });
    assert.strictEqual(count, 1);
  });

  // Scenario 9: Batch validation and oversized payload rejection
  test('9. Invalid batch payloads (empty, invalid category, oversized) are rejected with 400', async () => {
    // Empty events array
    const resEmpty = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    assert.strictEqual(resEmpty.status, 400);

    // Invalid category
    const resBadCat = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_bad_cat',
            sessionId: 'sess_bad',
            eventName: 'foo',
            eventCategory: 'INVALID_CATEGORY',
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    assert.strictEqual(resBadCat.status, 400);
  });

  // Scenario 10: Pagination and user-level event retrieval
  test('10. User-level event retrieval supports pagination, sorting, and category filters', async () => {
    const userId = 'user_alice_123';
    const token = generateToken({ userId, role: 'user', tenantId: 'tenant_test001' });

    const res = await fetch(`${baseUrl}/api/analytics/users/${userId}/events?page=1&limit=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.events.length, 2);
    assert.strictEqual(data.pagination.page, 1);
    assert.strictEqual(data.pagination.limit, 2);
    assert.ok(data.pagination.total >= 2);
    assert.ok(data.pagination.totalPages >= 1);
  });

  // Scenario 11: Authorization preventing access to another user's analytics
  test('11. User A is forbidden (403) from accessing User B analytics', async () => {
    const tokenAlice = generateToken({ userId: 'user_alice_123', role: 'user', tenantId: 'tenant_test001' });

    // Alice attempts to read Bob's events
    const res = await fetch(`${baseUrl}/api/analytics/users/user_bob_456/events`, {
      headers: { Authorization: `Bearer ${tokenAlice}` },
    });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, 'forbidden');

    // Unauthenticated request receives 401
    const resNoAuth = await fetch(`${baseUrl}/api/analytics/users/user_bob_456/events`);
    assert.strictEqual(resNoAuth.status, 401);
  });

  // Scenario 12: Route changes without duplicate page views
  test('12. Page view tracking and route changes capture engagement without duplicates', async () => {
    const pageViewId = 'pv_dash_101';
    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_pv_enter',
            sessionId: 'sess_pv_test',
            eventName: 'page_entered',
            eventCategory: 'navigation',
            sanitizedRoute: '/dashboard',
            timestamp: new Date().toISOString(),
          },
          {
            eventId: 'evt_pv_summary',
            sessionId: 'sess_pv_test',
            eventName: 'page_engagement_summary',
            eventCategory: 'engagement',
            sanitizedRoute: '/dashboard',
            timestamp: new Date().toISOString(),
            properties: {
              pageViewId,
              entryTimestamp: new Date(Date.now() - 5000).toISOString(),
              exitTimestamp: new Date().toISOString(),
              elapsedDurationMs: 5000,
              activeDurationMs: 4200,
              maxScrollDepth: 75,
              interactionCount: 8,
              exitReason: 'route_change',
            },
          },
        ],
      }),
    });

    const pe = await PageEngagement.findOne({ pageViewId }).lean();
    assert.ok(pe, 'Page engagement document must be saved');
    assert.strictEqual(pe.sanitizedRoute, '/dashboard');
    assert.strictEqual(pe.activeDurationMs, 4200);
    assert.strictEqual(pe.maxScrollDepth, 75);
  });

  // Scenario 13: Scroll throttling and milestone tracking
  test('13. Scroll milestone events (25, 50, 75, 100%) are recorded accurately', async () => {
    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_scroll_25',
            sessionId: 'sess_scroll_1',
            eventName: 'scroll_milestone',
            eventCategory: 'scroll',
            timestamp: new Date().toISOString(),
            properties: { milestonePercent: 25, scrollDepth: 25 },
          },
          {
            eventId: 'evt_scroll_50',
            sessionId: 'sess_scroll_1',
            eventName: 'scroll_milestone',
            eventCategory: 'scroll',
            timestamp: new Date().toISOString(),
            properties: { milestonePercent: 50, scrollDepth: 50 },
          },
        ],
      }),
    });

    const sess = await BehaviourSession.findOne({ sessionId: 'sess_scroll_1' }).lean();
    assert.strictEqual(sess.sessionSummary.maxScrollDepth, 50);
  });

  // Scenario 14: Browser offline and retry queue behaviour
  test('14. Client BehaviourTracker handles queueing, bounded queue, and flush retries', () => {
    const tracker = new BehaviourTracker({
      apiEndpoint: `${baseUrl}/api/analytics`,
      batchSize: 10,
      maxQueueSize: 20,
      flushIntervalMs: 100000, // manual flush for test
    });

    assert.ok(tracker.sessionId);
    assert.ok(tracker.anonymousId);

    // Enqueue 5 events
    for (let i = 0; i < 5; i++) {
      tracker.emitEvent('pointer', 'click', { testIndex: i });
    }
    assert.ok(tracker.queue.length >= 5);

    // Queue does not exceed maxQueueSize
    for (let i = 0; i < 30; i++) {
      tracker.emitEvent('pointer', 'click', { testIndex: i });
    }
    assert.ok(tracker.queue.length <= 20, 'Queue must not exceed bounded limit');

    tracker.destroy();
  });

  // Scenario 15: Sensitive-field exclusion
  test('15. Sensitive fields (passwords, cards, CVVs, OTPs) are stripped from properties', async () => {
    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_sensitive_strip_1',
            sessionId: 'sess_sens_1',
            eventName: 'form_filled',
            eventCategory: 'form',
            timestamp: new Date().toISOString(),
            properties: {
              fieldCategory: 'email',
              safeMetadata: 'checkout_step_1',
              password: 'SuperSecretPassword123!', // Must be stripped!
              cardNumber: '4111222233334444', // Must be stripped!
              cvv: '123', // Must be stripped!
              otp: '998811', // Must be stripped!
            },
          },
        ],
      }),
    });

    const stored = await BehaviourEvent.findOne({ eventId: 'evt_sensitive_strip_1' }).lean();
    assert.strictEqual(stored.properties.safeMetadata, 'checkout_step_1');
    assert.strictEqual(stored.properties.password, undefined, 'password must be stripped');
    assert.strictEqual(stored.properties.cardNumber, undefined, 'cardNumber must be stripped');
    assert.strictEqual(stored.properties.cvv, undefined, 'cvv must be stripped');
    assert.strictEqual(stored.properties.otp, undefined, 'otp must be stripped');
  });

  // Scenario 16: Payment success and failure verification
  test('16. Payment outcomes are verified server-side and recorded authoritatively', async () => {
    const payRes = await fetch(`${baseUrl}/api/analytics/payments/verify`, {
      method: 'POST',
      headers: API_KEY_HEADERS,
      body: JSON.stringify({
        paymentId: 'pay_9988_success',
        orderId: 'ord_1234',
        userId: 'user_alice_123',
        sessionId: 'sess_anon_001',
        amount: 149.5,
        currency: 'USD',
        status: 'succeeded',
        paymentMethodCategory: 'card',
        metadata: { gateway: 'stripe' },
      }),
    });

    assert.strictEqual(payRes.status, 200);
    const payData = await payRes.json();
    assert.strictEqual(payData.ok, true);

    const record = await PaymentRecord.findOne({ paymentId: 'pay_9988_success' }).lean();
    assert.strictEqual(record.status, 'succeeded');
    assert.strictEqual(record.amount, 149.5);

    // Verify verified event was emitted
    const payEvent = await BehaviourEvent.findOne({
      eventName: 'payment_succeeded',
      userId: 'user_alice_123',
    }).lean();
    assert.ok(payEvent);
    assert.strictEqual(payEvent.properties.serverVerified, true);
  });

  // Scenario 17: Location permission denied
  test('17. Location permission denied is captured safely without blocking flow', async () => {
    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_geo_denied_1',
            sessionId: 'sess_geo_1',
            eventName: 'permission_denied',
            eventCategory: 'location',
            timestamp: new Date().toISOString(),
            properties: { message: 'denied', code: 1 },
          },
        ],
      }),
    });

    const evt = await BehaviourEvent.findOne({ eventId: 'evt_geo_denied_1' }).lean();
    assert.ok(evt);
    assert.strictEqual(evt.eventCategory, 'location');
    assert.strictEqual(evt.properties.message, 'denied');
  });

  // Scenario 18: Retention and deletion behaviour (GDPR delete user data)
  test('18. User data deletion removes events, page engagements, and anonymizes sessions', async () => {
    const tempUser = 'user_to_delete_99';
    const token = generateToken({ userId: tempUser, role: 'user', tenantId: 'tenant_test001' });

    // Ingest event for temp user
    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_gdpr_1',
            sessionId: 'sess_gdpr_1',
            eventName: 'click',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    assert.ok((await BehaviourEvent.countDocuments({ userId: tempUser })) > 0);

    // Delete user data
    const delRes = await fetch(`${baseUrl}/api/analytics/users/${tempUser}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(await BehaviourEvent.countDocuments({ userId: tempUser }), 0);
  });

  // Scenario 19: Database failure or bad request does not crash application
  test('19. Malformed input or error conditions return proper HTTP errors without crashing server', async () => {
    // Malformed JSON handled by Express
    const badJsonRes = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not a valid json{[[',
    });
    assert.strictEqual(badJsonRes.status, 400);

    // Server remains up and healthy
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'ok');
  });

  // Scenario 20: Cleanup of event listeners and timers
  test('20. BehaviourTracker destroy() correctly unbinds listeners and cleans up timers', () => {
    const tracker = new BehaviourTracker({
      apiEndpoint: `${baseUrl}/api/analytics`,
      flushIntervalMs: 5000,
    });

    assert.ok(tracker.timer);
    assert.ok(tracker.idleTimer);

    tracker.destroy();

    assert.strictEqual(tracker._listeners.length, 0);
  });

  // Bonus Verification: User Summary Aggregation API
  test('User summary API provides accurate aggregated statistics and journey insights', async () => {
    const userId = 'user_alice_123';
    const token = generateToken({ userId, role: 'user', tenantId: 'tenant_test001' });

    const res = await fetch(`${baseUrl}/api/analytics/users/${userId}/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.strictEqual(res.status, 200);
    const summary = await res.json();
    assert.strictEqual(summary.userId, userId);
    assert.ok(summary.totalEvents > 0);
    assert.ok(summary.paymentSummary.succeeded >= 1);
    assert.ok(summary.categoryBreakdown);
  });

  // Battery and charging telemetry verification
  test('Battery and charging data is ingested, validated, and stored in device metadata', async () => {
    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_battery_test_01',
            sessionId: 'sess_battery_01',
            eventName: 'click',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
            device: {
              category: 'mobile',
              batteryLevel: 0.82,
              isCharging: true,
            },
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);
    const stored = await BehaviourEvent.findOne({ eventId: 'evt_battery_test_01' }).lean();
    assert.ok(stored);
    assert.strictEqual(stored.device.batteryLevel, 0.82);
    assert.strictEqual(stored.device.isCharging, true);
  });

  // Scenario 23: Pointer dynamics (pointer_move, pointer_velocity, pointer_down, pointer_up, hover, pointer_idle)
  test('23. Pointer dynamics (pointer_move, pointer_velocity, pointer_down, pointer_up, hover) are ingested with sequence numbers', async () => {
    const sessionId = 'sess_pointer_dynamics_01';
    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_pt_down_1',
            sessionId,
            clientId: 'client_nexus_bank',
            sequenceNumber: 1,
            eventType: 'pointer_down',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
            page: '/dashboard',
            properties: { x: 120, y: 340, targetCategory: 'button', targetId: 'btn_transfer' },
          },
          {
            eventId: 'evt_pt_up_1',
            sessionId,
            clientId: 'client_nexus_bank',
            sequenceNumber: 2,
            eventType: 'pointer_up',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
            page: '/dashboard',
            properties: { x: 120, y: 340, holdDurationMs: 95, targetCategory: 'button' },
          },
          {
            eventId: 'evt_pt_vel_1',
            sessionId,
            clientId: 'client_nexus_bank',
            sequenceNumber: 3,
            eventType: 'pointer_velocity',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
            page: '/dashboard',
            properties: { speedPxPerMs: 1.25, velocity: 1.25, angleDeg: 45, isStraightLine: false },
          },
          {
            eventId: 'evt_pt_hover_1',
            sessionId,
            clientId: 'client_nexus_bank',
            sequenceNumber: 4,
            eventType: 'hover',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
            page: '/dashboard',
            properties: { targetId: 'btn_transfer', hoverDurationMs: 420 },
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);
    const evts = await BehaviourEvent.find({ sessionId }).sort({ sequenceNumber: 1 }).lean();
    assert.strictEqual(evts.length, 4);
    assert.strictEqual(evts[0].eventType, 'pointer_down');
    assert.strictEqual(evts[0].sequenceNumber, 1);
    assert.strictEqual(evts[0].clientId, 'client_nexus_bank');
    // Top-level individual fields verified
    assert.strictEqual(evts[0].pointerX, 120);
    assert.strictEqual(evts[0].pointerY, 340);
    assert.strictEqual(evts[0].targetCategory, 'button');
    assert.strictEqual(evts[0].targetId, 'btn_transfer');

    assert.strictEqual(evts[1].pointerHoldDurationMs, 95);

    assert.strictEqual(evts[2].eventType, 'pointer_velocity');
    assert.strictEqual(evts[2].pointerSpeedPxPerMs, 1.25);
    assert.strictEqual(evts[2].pointerAngleDeg, 45);
    assert.strictEqual(evts[2].isStraightLine, false);

    assert.strictEqual(evts[3].eventType, 'hover');
    assert.strictEqual(evts[3].hoverDurationMs, 420);
  });

  // Scenario 24: Keyboard dynamics (key_down, key_up, typing_dynamics) without recording character content
  test('24. Keyboard dynamics (key_down, typing_dynamics) ingest cadence and flight times without plaintext characters', async () => {
    const sessionId = 'sess_keyboard_dynamics_01';
    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_kb_down_1',
            sessionId,
            sequenceNumber: 1,
            eventType: 'key_down',
            eventCategory: 'keyboard',
            timestamp: new Date().toISOString(),
            page: '/login',
            properties: { key: 'char', fieldCategory: 'username', flightTimeMs: 120 },
          },
          {
            eventId: 'evt_kb_dyn_1',
            sessionId,
            sequenceNumber: 2,
            eventType: 'typing_dynamics',
            eventCategory: 'keyboard',
            timestamp: new Date().toISOString(),
            page: '/login',
            properties: { flightTimeMs: 120, keysPerSecond: 4.8, isPause: false, fieldCategory: 'username' },
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);
    const kbEvt = await BehaviourEvent.findOne({ eventId: 'evt_kb_dyn_1' }).lean();
    assert.ok(kbEvt);
    // Top-level individual fields verified
    assert.strictEqual(kbEvt.keysPerSecond, 4.8);
    assert.strictEqual(kbEvt.flightTimeMs, 120);
    assert.strictEqual(kbEvt.isTypingPause, false);
    assert.strictEqual(kbEvt.fieldCategory, 'username');
  });

  // Scenario 25: Form interactions (focus_change, paste_detected)
  test('25. Form interaction tracking captures focus_change and paste_detected safely', async () => {
    const sessionId = 'sess_form_interactions_01';
    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_focus_chg_1',
            sessionId,
            sequenceNumber: 1,
            eventType: 'focus_change',
            eventCategory: 'form',
            timestamp: new Date().toISOString(),
            page: '/transfer',
            properties: { fromField: 'amount', toField: 'beneficiary', fieldCategory: 'text' },
          },
          {
            eventId: 'evt_paste_1',
            sessionId,
            sequenceNumber: 2,
            eventType: 'paste_detected',
            eventCategory: 'form',
            timestamp: new Date().toISOString(),
            page: '/transfer',
            properties: { pasteDetected: true, fieldId: 'beneficiary_acct', fieldCategory: 'text' },
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);
    const pasteEvt = await BehaviourEvent.findOne({ eventId: 'evt_paste_1' }).lean();
    assert.ok(pasteEvt);
    // Top-level individual fields verified
    assert.strictEqual(pasteEvt.pasteDetected, true);
    assert.strictEqual(pasteEvt.fieldId, 'beneficiary_acct');
    assert.strictEqual(pasteEvt.fieldCategory, 'text');
  });

  // Scenario 26: Banking and Financial Workflow Events
  test('26. Banking workflows (login_attempt, payment_flow_start, payment_confirmation, step_up_auth_required) are ingested authoritatively', async () => {
    const sessionId = 'sess_banking_workflow_01';
    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_bank_login_att',
            sessionId,
            sequenceNumber: 1,
            eventType: 'login_attempt',
            eventCategory: 'auth',
            timestamp: new Date().toISOString(),
            page: '/login',
            properties: { method: 'password', usernameSupplied: true },
          },
          {
            eventId: 'evt_bank_step_up',
            sessionId,
            sequenceNumber: 2,
            eventType: 'step_up_auth_required',
            eventCategory: 'banking',
            timestamp: new Date().toISOString(),
            page: '/transfer',
            properties: { challengeType: 'otp_sms', trigger: 'high_value_transaction' },
          },
          {
            eventId: 'evt_bank_pay_start',
            sessionId,
            sequenceNumber: 3,
            eventType: 'payment_flow_start',
            eventCategory: 'banking',
            timestamp: new Date().toISOString(),
            page: '/transfer',
            properties: { flowType: 'wire_transfer', currency: 'USD', recipientType: 'international' },
          },
          {
            eventId: 'evt_bank_pay_conf',
            sessionId,
            sequenceNumber: 4,
            eventType: 'payment_confirmation',
            eventCategory: 'banking',
            timestamp: new Date().toISOString(),
            page: '/transfer',
            properties: { paymentId: 'pay_wire_8899', status: 'succeeded', flowType: 'wire_transfer' },
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);
    const stepUp = await BehaviourEvent.findOne({ eventId: 'evt_bank_step_up' }).lean();
    assert.ok(stepUp);
    assert.strictEqual(stepUp.eventCategory, 'banking');
    // Top-level individual fields verified
    assert.strictEqual(stepUp.challengeType, 'otp_sms');

    const payConf = await BehaviourEvent.findOne({ eventId: 'evt_bank_pay_conf' }).lean();
    assert.ok(payConf);
    assert.strictEqual(payConf.paymentId, 'pay_wire_8899');
    assert.strictEqual(payConf.paymentStatus, 'succeeded');
    assert.strictEqual(payConf.flowType, 'wire_transfer');
  });

  // Scenario 27: Behavioral Risk Analysis & Explainable Risk Scoring Engine
  test('27. Behavioral risk scoring API evaluates session biometrics and returns explainable signals', async () => {
    const sessionId = 'sess_risk_eval_01';
    // Create session
    await BehaviourSession.create({
      sessionId,
      tenantId: 'tenant_test001',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      status: 'active',
      sessionSummary: { interactionCount: 15 },
    });

    // Ingest simulated organic human events
    await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_risk_pt_1',
            sessionId,
            sequenceNumber: 1,
            eventType: 'pointer_velocity',
            eventCategory: 'pointer',
            timestamp: new Date(Date.now() - 4000).toISOString(),
            properties: { speedPxPerMs: 0.85, isStraightLine: false, directionChange: true },
          },
          {
            eventId: 'evt_risk_kb_1',
            sessionId,
            sequenceNumber: 2,
            eventType: 'typing_dynamics',
            eventCategory: 'keyboard',
            timestamp: new Date(Date.now() - 2000).toISOString(),
            properties: { flightTimeMs: 180, keysPerSecond: 4.5 },
          },
          {
            eventId: 'evt_risk_pay_1',
            sessionId,
            sequenceNumber: 3,
            eventType: 'payment_confirmation',
            eventCategory: 'banking',
            timestamp: new Date().toISOString(),
            properties: { paymentId: 'pay_risk_101', status: 'succeeded' },
          },
        ],
      }),
    });

    // Query risk assessment
    const riskRes = await fetch(`${baseUrl}/api/analytics/sessions/${sessionId}/risk`, {
      headers: API_KEY_HEADERS,
    });

    assert.strictEqual(riskRes.status, 200);
    const riskData = await riskRes.json();
    assert.ok(typeof riskData.riskScore === 'number');
    assert.ok(riskData.riskLevel);
    assert.ok(Array.isArray(riskData.signals));
    assert.strictEqual(riskData.recommendedAction, 'ALLOW');
    assert.ok(riskData.confidence >= 0.3);
  });

  // Scenario 28: BehaviorSDK static initialization and listener lifecycle
  test('28. BehaviorSDK.init() correctly configures instance and clean listener unbinding', () => {
    const sdkInstance = BehaviourTracker.init({
      endpoint: `${baseUrl}/api/analytics`,
      clientId: 'bank_test_client',
      tenantId: 'tenant_test001',
      consent: true,
      batchSize: 5,
    });

    assert.ok(sdkInstance);
    assert.strictEqual(sdkInstance.options.clientId, 'bank_test_client');
    assert.strictEqual(sdkInstance.isActive, true);

    // Call stop to clean up
    BehaviourTracker.stop();
    assert.strictEqual(sdkInstance.isActive, false);
    assert.strictEqual(sdkInstance._listeners.length, 0);
  });

  // Scenario 29: Pure Flat Event Payload Ingestion (each event into individual key-values directly at root)
  test('29. Ingest pure flat events with individual keys at the root without properties wrapper', async () => {
    const sessionId = 'sess_pure_flat_001';
    const res = await fetch(`${baseUrl}/api/analytics/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt_flat_pointer_1',
            sessionId,
            sequenceNumber: 1,
            clientId: 'client_nexus_bank',
            eventType: 'pointer_velocity',
            eventCategory: 'pointer',
            timestamp: new Date().toISOString(),
            page: '/transfers',
            pointerX: 450,
            pointerY: 720,
            pointerSpeedPxPerMs: 1.62,
            pointerAngleDeg: 125,
            pointerDistancePx: 85,
            isStraightLine: false,
            deviceCategory: 'desktop',
            deviceOs: 'windows',
            batteryLevel: 0.88,
            isCharging: false,
          },
          {
            eventId: 'evt_flat_banking_1',
            sessionId,
            sequenceNumber: 2,
            clientId: 'client_nexus_bank',
            eventType: 'payment_confirmation',
            eventCategory: 'banking',
            timestamp: new Date().toISOString(),
            page: '/transfers',
            flowType: 'wire_transfer',
            paymentId: 'pay_flat_9900',
            paymentAmount: 5000,
            paymentCurrency: 'USD',
            paymentStatus: 'succeeded',
            recipientType: 'domestic',
          },
        ],
      }),
    });

    assert.strictEqual(res.status, 202);

    const ptDoc = await BehaviourEvent.findOne({ eventId: 'evt_flat_pointer_1' }).lean();
    assert.ok(ptDoc);
    assert.strictEqual(ptDoc.pointerX, 450);
    assert.strictEqual(ptDoc.pointerY, 720);
    assert.strictEqual(ptDoc.pointerSpeedPxPerMs, 1.62);
    assert.strictEqual(ptDoc.pointerAngleDeg, 125);
    assert.strictEqual(ptDoc.pointerDistancePx, 85);
    assert.strictEqual(ptDoc.isStraightLine, false);
    assert.strictEqual(ptDoc.deviceCategory, 'desktop');
    assert.strictEqual(ptDoc.batteryLevel, 0.88);

    const bkDoc = await BehaviourEvent.findOne({ eventId: 'evt_flat_banking_1' }).lean();
    assert.ok(bkDoc);
    assert.strictEqual(bkDoc.flowType, 'wire_transfer');
    assert.strictEqual(bkDoc.paymentId, 'pay_flat_9900');
    assert.strictEqual(bkDoc.paymentAmount, 5000);
    assert.strictEqual(bkDoc.paymentCurrency, 'USD');
    assert.strictEqual(bkDoc.paymentStatus, 'succeeded');
    assert.strictEqual(bkDoc.recipientType, 'domestic');
  });
});

'use strict';

/**
 * Everything that used to be Mongo-only, running with PostgreSQL active and
 * NO MongoDB: IP intelligence + new-country detection, event batches,
 * analytics sessions / page engagement / payments / risk, GDPR delete,
 * retention. Uses the embedded pg-mem engine.
 */

const { newDb } = require('pg-mem');
const PostgreSQLAdapter = require('../src/database/adapters/postgresql.adapter');
const databaseRegistry = require('../src/config/database-registry');
const config = require('../src/config');
const ipIntelService = require('../src/ipIntelService');
const collectService = require('../src/collectService');
const analyticsService = require('../src/analyticsService');
const riskService = require('../src/riskService');
const { TABLES } = require('../src/database/postgres/pg-app-store');

let pool;
let adapter;
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await pool.query(sql, p)).rows;

function mockProvider(country) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, country_code: country, timezone: 'Asia/Kolkata', vpn: false, proxy: false, tor: false, connection_type: 'Residential' }),
  });
}

const collectDto = (sessionId, events) => ({
  tenantId: 'tenant_test001',
  appId: 'app_test001',
  deviceFingerprint: 'fp_1',
  events: events.map((e, i) => ({ sessionId, t: i, page: '/login', pageType: null, userId: null, ...e })),
});

beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  pool = new (newDb().adapters.createPg().Pool)();
  adapter = new PostgreSQLAdapter({ database: 'test' }, pool);
  await adapter.connect();
  databaseRegistry.adapters.set('postgresql', adapter);
  databaseRegistry.activeAdapter = adapter;
  databaseRegistry.activeType = 'postgresql';
  databaseRegistry.initialized = true;
  config.ipIntel.provider = 'ipqs';
  config.ipIntel.apiKey = 'test-key';
  config.ipIntel.devIp = '';
});

afterAll(() => {
  databaseRegistry.activeAdapter = null;
  databaseRegistry.activeType = null;
  databaseRegistry.adapters.clear();
  console.log.mockRestore();
  delete global.fetch;
});

beforeEach(() => ipIntelService._resetCacheForTests());

test('all replacement tables exist and none uses JSON', async () => {
  for (const [table, ddl] of Object.entries(TABLES)) {
    await pool.query(`SELECT * FROM ${table} LIMIT 1`);
    expect(ddl).not.toMatch(/json/i);
  }
});

describe('IP intelligence in PostgreSQL', () => {
  test('lookup stores network_intel; identify evaluates is_new_country against user_geo_history', async () => {
    // Session 1: first login ever from IN -> no baseline -> null
    mockProvider('IN');
    await collectService.ingest(collectDto('ip_s1', [{ type: 'focus', field: 'username' }]), '49.205.1.1');
    const r1 = await ipIntelService.lookupForSession({ tenantId: 'tenant_test001', appId: 'app_test001', sessionId: 'ip_s1', ip: '49.205.1.1' });
    expect(r1).toMatchObject({ country: 'IN', is_vpn: false, is_datacenter: false, is_new_country: null, source: 'provider' });

    let ni = await one(`SELECT * FROM network_intel WHERE session_id = 'ip_s1'`);
    expect(ni).toMatchObject({ ip: '49.205.1.1', country: 'IN', is_vpn: false, provider: 'ipqs', source: 'provider', user_id: null });

    await collectService.attachUserId('ip_s1', 'u_ip', 'server');
    ni = await one(`SELECT * FROM network_intel WHERE session_id = 'ip_s1'`);
    expect(ni).toMatchObject({ user_id: 'u_ip', evaluated_for_user_id: 'u_ip', is_new_country: null });
    expect(await all(`SELECT country FROM user_geo_history WHERE user_id = 'u_ip'`)).toEqual([{ country: 'IN' }]);

    // Session 2: same user, already logged in, now from FR -> new country
    mockProvider('FR');
    await collectService.ingest(collectDto('ip_s2', [{ type: 'identify', userId: 'u_ip' }]), '88.1.1.1');
    const r2 = await ipIntelService.lookupForSession({ tenantId: 'tenant_test001', appId: 'app_test001', sessionId: 'ip_s2', ip: '88.1.1.1' });
    expect(r2.is_new_country).toBe(true);
    expect((await all(`SELECT country FROM user_geo_history WHERE user_id = 'u_ip' ORDER BY country`)).map((r) => r.country)).toEqual(['FR', 'IN']);

    // Session 3: back in IN -> known country
    mockProvider('IN');
    await collectService.ingest(collectDto('ip_s3', [{ type: 'identify', userId: 'u_ip' }]), '49.205.1.2');
    const r3 = await ipIntelService.lookupForSession({ tenantId: 'tenant_test001', appId: 'app_test001', sessionId: 'ip_s3', ip: '49.205.1.2' });
    expect(r3.is_new_country).toBe(false);
  });

  test('repeat lookup for the same session+ip updates the row instead of duplicating it', async () => {
    mockProvider('IN');
    await ipIntelService.lookupForSession({ tenantId: 'tenant_test001', sessionId: 'ip_s4', ip: '49.205.9.9' });
    ipIntelService._resetCacheForTests();
    mockProvider('SG');
    await ipIntelService.lookupForSession({ tenantId: 'tenant_test001', sessionId: 'ip_s4', ip: '49.205.9.9' });
    const rows = await all(`SELECT country FROM network_intel WHERE session_id = 'ip_s4'`);
    expect(rows).toEqual([{ country: 'SG' }]);
  });
});

describe('/collect batches', () => {
  test('event_batches gets one row per batch and the userId after identify', async () => {
    await collectService.ingest(collectDto('b_s1', [{ type: 'focus', field: 'username' }, { type: 'keydown', key: 'a' }]), '1.2.3.4');
    let b = await one(`SELECT * FROM event_batches WHERE session_id = 'b_s1'`);
    expect(b).toMatchObject({ event_count: 2, client_ip: '1.2.3.4', user_id: null, device_fingerprint: 'fp_1' });
    const linked = await all(`SELECT COUNT(*) AS c FROM login_events WHERE batch_id = $1`, [b.batch_id]);
    expect(Number(linked[0].c)).toBe(2);

    await collectService.attachUserId('b_s1', 'u_b', 'server');
    b = await one(`SELECT * FROM event_batches WHERE session_id = 'b_s1'`);
    expect(b.user_id).toBe('u_b');
  });
});

describe('analytics API in PostgreSQL', () => {
  const S = 'an_s1';

  test('startSession stores device metadata as separate columns', async () => {
    const { session } = await analyticsService.startSession({
      sessionId: S,
      anonymousId: 'anon_1',
      tenantId: 'default',
      deviceMetadata: { category: 'mobile', os: 'android', screenWidth: 412 },
      ipAddress: '1.2.3.4',
    });
    expect(session).toMatchObject({ sessionId: S, status: 'active', anonymousId: 'anon_1', deviceMetadata: { category: 'mobile', os: 'android', screenWidth: 412 } });
    const row = await one(`SELECT * FROM behaviour_sessions WHERE session_id = $1`, [S]);
    expect(row).toMatchObject({ device_meta_category: 'mobile', device_meta_os: 'android', device_meta_screen_width: 412 });
  });

  test('ingestEvents bumps the session and stores page engagement', async () => {
    const base = { sessionId: S, tenantId: 'default', sanitizedRoute: '/home' };
    await analyticsService.ingestEvents({
      clientIp: '1.2.3.4',
      events: [
        { ...base, eventId: 'e1', eventName: 'click', eventCategory: 'pointer', pointerX: 1, pointerY: 2 },
        { ...base, eventId: 'e2', eventName: 'scroll', eventCategory: 'scroll', scrollDepthPercent: 60 },
        {
          ...base, eventId: 'e3', eventName: 'page_exit', eventCategory: 'engagement',
          properties: { pageViewId: 'pv1', activeDurationMs: 4000, maxScrollDepth: 60, interactionCount: 3 },
        },
      ],
    });
    const row = await one(`SELECT * FROM behaviour_sessions WHERE session_id = $1`, [S]);
    expect(row.interaction_count).toBe(1);
    expect(row.max_scroll_depth).toBe(60);
    expect(row.page_count).toBe(1);
    const pe = await one(`SELECT * FROM page_engagements WHERE page_view_id = 'pv1'`);
    expect(pe).toMatchObject({ session_id: S, active_duration_ms: 4000, max_scroll_depth: 60, user_id: null });
  });

  test('linkSession sets the user, back-fills page engagement and writes an audit event', async () => {
    const res = await analyticsService.linkSession({ sessionId: S, userId: 'u_an' });
    expect(res).toMatchObject({ ok: true, userId: 'u_an' });
    expect((await one(`SELECT user_id FROM page_engagements WHERE page_view_id = 'pv1'`)).user_id).toBe('u_an');
    expect(await one(`SELECT event_name FROM events WHERE session_id = $1 AND event_name = 'session_linked'`, [S])).toBeTruthy();
  });

  test('verifyPayment stores payment metadata as columns and updates the session', async () => {
    const { payment } = await analyticsService.verifyPayment({
      paymentId: 'pay_1', orderId: 'ord_1', userId: 'u_an', sessionId: S, amount: 499.5, currency: 'INR',
      status: 'succeeded', paymentMethodCategory: 'upi', metadata: { gateway: 'razorpay', attempt: 1 },
    });
    expect(payment).toMatchObject({ paymentId: 'pay_1', amount: 499.5, status: 'succeeded', metadata: { gateway: 'razorpay', attempt: 1 } });
    expect(await one(`SELECT metadata_gateway, metadata_attempt FROM payment_records WHERE payment_id = 'pay_1'`))
      .toEqual({ metadata_gateway: 'razorpay', metadata_attempt: 1 });
    expect((await one(`SELECT payment_status FROM behaviour_sessions WHERE session_id = $1`, [S])).payment_status).toBe('succeeded');
  });

  test('user summary includes engagement and payment summary', async () => {
    const sum = await analyticsService.getUserSummary({ userId: 'u_an' });
    expect(sum.totalSessions).toBe(1);
    expect(sum.pageVisits).toEqual({ '/home': 1 });
    expect(sum.engagement.totalActiveDurationMs).toBe(4000);
    expect(sum.paymentSummary).toMatchObject({ totalTransactions: 1, succeeded: 1 });
  });

  test('risk evaluation saves the risk summary and one row per signal', async () => {
    const ev = await riskService.evaluateSessionRisk(S);
    expect(ev.sessionId).toBe(S);
    const row = await one(`SELECT risk_score, risk_level FROM behaviour_sessions WHERE session_id = $1`, [S]);
    expect(row.risk_score).toBe(ev.riskScore);
    const signals = await all(`SELECT code FROM session_risk_signals WHERE session_id = $1 ORDER BY signal_index`, [S]);
    expect(signals.map((s) => s.code)).toEqual(ev.signals.map((s) => s.code));
    const { session } = await analyticsService.getSessionEvents({ sessionId: S, authenticatedUser: { role: 'admin' } });
    expect(session.riskSummary.signals.map((s) => s.code)).toEqual(ev.signals.map((s) => s.code));
  });

  test('risk signal metrics become metric_* columns', async () => {
    await adapter.getAppStore().saveRiskSummary(S, {
      riskScore: 45, riskLevel: 'MEDIUM', confidence: 0.75, evaluatedAt: new Date(),
      signals: [{ code: 'SUPERHUMAN_TYPING_CADENCE', severity: 'HIGH', description: 'x', metric: { meanCadence: 24.5 } }],
    });
    expect(await one(`SELECT metric_mean_cadence FROM session_risk_signals WHERE session_id = $1`, [S])).toEqual({ metric_mean_cadence: 24.5 });
    const s = await adapter.getAppStore().findSession(S);
    expect(s.riskSummary.signals[0].metric).toEqual({ meanCadence: 24.5 });
  });

  test('endSession stores the final summary as columns; listing sessions works', async () => {
    const { session } = await analyticsService.endSession({ sessionId: S, summary: { reason: 'logout', tabs: 2 } });
    expect(session).toMatchObject({ status: 'ended', sessionSummary: { finalSummary: { reason: 'logout', tabs: 2 } } });
    const list = await analyticsService.getUserSessions({ userId: 'u_an' });
    expect(list.pagination.total).toBe(1);
    expect(list.sessions[0].sessionId).toBe(S);
  });

  test('deleteUserData removes engagement + payments and anonymises sessions', async () => {
    const res = await analyticsService.deleteUserData({ userId: 'u_an' });
    expect(res).toMatchObject({ ok: true, deletedEngagements: 1, deletedPayments: 1 });
    expect(await one(`SELECT user_id, anonymous_id FROM behaviour_sessions WHERE session_id = $1`, [S]))
      .toEqual({ user_id: null, anonymous_id: 'anonymized' });
  });
});

test('retention purge deletes raw rows older than RAW_TTL_DAYS', async () => {
  await pool.query(`UPDATE login_events SET received_at = $1 WHERE session_id = 'b_s1'`, [new Date(Date.now() - 40 * 86400000)]);
  await pool.query(`UPDATE event_batches SET received_at = $1 WHERE session_id = 'b_s1'`, [new Date(Date.now() - 40 * 86400000)]);
  const res = await adapter.getAppStore().purgeRawOlderThan(30);
  expect(res.login_events).toBe(2);
  expect(res.event_batches).toBe(1);
  expect(await one(`SELECT COUNT(*) AS c FROM login_events WHERE session_id = 'ip_s1'`)).toEqual({ c: expect.anything() });
});

test("registry accepts the 'postgres' alias", async () => {
  const reg = require('../src/config/database-registry');
  const saved = { a: reg.activeAdapter, t: reg.activeType, i: reg.initialized };
  reg.initialized = false;
  reg.adapters.set('postgresql', adapter);
  await reg.initialize('postgres');
  expect(reg.getActiveType()).toBe('postgresql');
  Object.assign(reg, { activeAdapter: saved.a, activeType: saved.t, initialized: saved.i });
});

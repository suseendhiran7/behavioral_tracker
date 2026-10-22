'use strict';

/**
 * PostgreSQL login_events / session_events / payment_events, end to end
 * through collectService with PostgreSQL as the active database and NO Mongo.
 * Uses the embedded pg-mem engine (same as the adapter's fallback).
 */

const { newDb } = require('pg-mem');
const PostgreSQLAdapter = require('../src/database/adapters/postgresql.adapter');
const databaseRegistry = require('../src/config/database-registry');
const { ingest, attachUserId } = require('../src/collectService');
const { flattenEvent, columnNameFor } = require('../src/database/postgres/event-flattener');
const { SDK_COLUMNS, ENVELOPE_COLUMNS } = require('../src/database/postgres/sdk-event-columns');
const { diff } = require('../scripts/pg-sdk-columns');
const path = require('path');

let adapter;
let pool;

const SESSION = 'sess_pg_1';
const dto = (events, sessionId = SESSION) => ({
  tenantId: 'tenant_test001',
  appId: 'app_test001',
  deviceFingerprint: 'fp_pg',
  events: events.map((e, i) => ({ sessionId, t: 100 + i, page: '/login', pageType: null, userId: null, ...e })),
});
// Lists a table's columns in a way that works on pg-mem (insert + read back a probe row).
const columnsOf = async (table) => {
  await pool.query(`INSERT INTO ${table} (tenant_id, session_id, event_type) VALUES ('probe', 'probe', 'probe')`);
  const r = (await pool.query(`SELECT * FROM ${table} WHERE session_id = 'probe'`)).rows[0];
  await pool.query(`DELETE FROM ${table} WHERE session_id = 'probe'`);
  return Object.keys(r);
};
const rows = async (table, where = '') =>
  (await pool.query(`SELECT * FROM ${table} ${where} ORDER BY id`)).rows;

beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const mem = newDb();
  const pg = mem.adapters.createPg();
  pool = new pg.Pool();
  adapter = new PostgreSQLAdapter({ database: 'test' }, pool);
  await adapter.connect();
  databaseRegistry.adapters.set('postgresql', adapter);
  databaseRegistry.activeAdapter = adapter;
  databaseRegistry.activeType = 'postgresql';
  databaseRegistry.initialized = true;
});

afterAll(() => {
  databaseRegistry.activeAdapter = null;
  databaseRegistry.activeType = null;
  databaseRegistry.adapters.clear();
  console.log.mockRestore();
});

describe('schema', () => {
  test('creates the three event tables and xylium_sessions, one column per SDK field, no JSON', async () => {
    for (const t of ['login_events', 'session_events', 'payment_events']) {
      const cols = await columnsOf(t);
      expect(cols).toEqual(expect.arrayContaining(['hold_time_ms', 'is_trusted', 'params_max_viewport_dims_1', 'fonts', 'geo_lat']));
      expect(cols.length).toBe(SDK_COLUMNS.size + ENVELOPE_COLUMNS.length);
    }
    await pool.query('SELECT * FROM xylium_sessions LIMIT 0');
    for (const [, meta] of SDK_COLUMNS) expect(meta.type).not.toMatch(/json/i);
    for (const [, type] of ENVELOPE_COLUMNS) expect(type).not.toMatch(/json/i);
  });

  test('every field the SDK sends has a catalog column', () => {
    const { missing } = diff(path.join(__dirname, '..', 'sdk'));
    expect(missing).toEqual([]);
  });

  test('connect() is idempotent (tables already there)', async () => {
    adapter.eventStore.ready = null;
    await expect(adapter.eventStore.ensureSchema()).resolves.toBeUndefined();
  });
});

describe('flattening rules', () => {
  test('camelCase, nested objects, small numeric arrays and string lists', () => {
    const flat = flattenEvent({
      type: 'webgl_fingerprint', t: 5, sessionId: 's', userId: null, page: '/', pageType: null,
      holdTimeMs: 81,
      params: { maxViewportDims: [16384, 16384], shadingLanguageVersion: 'WebGL GLSL ES 1.0' },
      fonts: ['Arial', 'Calibri'],
      intervalMs: [120, 95],
    });
    expect(flat).toEqual({
      hold_time_ms: 81,
      params_max_viewport_dims_1: 16384,
      params_max_viewport_dims_2: 16384,
      params_shading_language_version: 'WebGL GLSL ES 1.0',
      fonts: 'Arial | Calibri',
      interval_ms_1: 120,
      interval_ms_2: 95,
    });
  });

  test('field names that collide with envelope columns are prefixed', () => {
    expect(columnNameFor(['id'])).toBe('sdk_id');
    expect(columnNameFor(['props', 'id'])).toBe('props_id');
  });
});

describe('ingest() with PostgreSQL active', () => {
  test('pre-login + identify -> login_events, after login -> session_events', async () => {
    await ingest(dto([
      { type: 'keytiming', field: 'username', holdTimeMs: 81, flightTimeMs: 140 },
      { type: 'paste', field: 'password', isPasswordField: true, pastedLength: 12, isTrusted: true },
      { type: 'identify', userId: 'user_42' },
      { type: 'click', x: 10, y: 20, field: 'menu', page: '/dashboard', userId: 'user_42' },
    ]), '1.2.3.4');

    const login = await rows('login_events', `WHERE session_id = '${SESSION}'`);
    expect(login.map((r) => r.event_type)).toEqual(['keytiming', 'paste', 'identify']);
    expect(login[0].hold_time_ms).toBe(81);
    expect(login[0].flight_time_ms).toBe(140);
    expect(login[0].field).toBe('username');
    expect(login[1].is_password_field).toBe(true);
    expect(login[1].pasted_length).toBe(12);
    expect(login[0].client_ip).toBe('1.2.3.4');
    expect(login[0].event_category).toBe('keyboard');
    // browser identify back-fills the pre-login rows
    expect(login.every((r) => r.user_id === 'user_42')).toBe(true);

    const session = await rows('session_events', `WHERE session_id = '${SESSION}'`);
    expect(session).toHaveLength(1);
    expect(session[0]).toMatchObject({ event_type: 'click', x: 10, y: 20, user_id: 'user_42', page: '/dashboard', batch_seq: 3 });

    const s = (await pool.query(`SELECT * FROM xylium_sessions WHERE session_id = '${SESSION}'`)).rows[0];
    expect(s).toMatchObject({ phase: 'session', user_id: 'user_42', identified_by: 'browser', batch_count: 1, event_count: 4 });
  });

  test('later batch: phase is remembered, payment page -> payment_events', async () => {
    await ingest(dto([
      { type: 'keytiming', field: 'card', holdTimeMs: 70, page: '/checkout/pay', userId: 'user_42' },
      { type: 'login_result', success: true, failedAttemptsInWindow: 0, page: '/account', userId: 'user_42' },
    ]), '1.2.3.4');
    const pay = await rows('payment_events', `WHERE session_id = '${SESSION}'`);
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ event_type: 'keytiming', field: 'card', hold_time_ms: 70, user_id: 'user_42' });
    const session = await rows('session_events', `WHERE session_id = '${SESSION}' AND event_type = 'login_result'`);
    expect(session[0].success).toBe(true);
    expect(session[0].failed_attempts_in_window).toBe(0);
  });

  test('logout -> session_events, then events go back to login_events', async () => {
    await ingest(dto([
      { type: 'logout', page: '/account', userId: 'user_42' },
      { type: 'mousemove', x: 1, y: 2, page: '/login' },
    ]), '1.2.3.4');
    const lastSession = (await rows('session_events', `WHERE session_id = '${SESSION}'`)).pop();
    expect(lastSession.event_type).toBe('logout');
    const lastLogin = (await rows('login_events', `WHERE session_id = '${SESSION}'`)).pop();
    expect(lastLogin.event_type).toBe('mousemove');
    const s = (await pool.query(`SELECT phase, logged_out_at FROM xylium_sessions WHERE session_id = '${SESSION}'`)).rows[0];
    expect(s.phase).toBe('login');
    expect(s.logged_out_at).not.toBeNull();
  });

  test('nested / list SDK fields land in their own columns', async () => {
    await ingest(dto([
      {
        type: 'webgl_fingerprint', supported: true, vendor: 'WebKit', isSoftwareRenderer: false,
        params: { maxTextureSize: 16384, maxViewportDims: [32767, 32767], aliasedLineWidthRange: [1, 1] },
      },
      { type: 'font_fingerprint', supported: true, fonts: ['Arial', 'Verdana'], detectedCount: 2 },
      { type: 'composite_fingerprint', compositeHash: 'cf_1', parts: { canvas: 'abc', webgl: 'na' }, unavailableOrUnstable: ['webgl'] },
      { type: 'keytiming_ngram', field: 'username', n: 3, intervalMs: [110, 98] },
    ], 'sess_pg_2'), '5.6.7.8');
    const r = await rows('login_events', `WHERE session_id = 'sess_pg_2'`);
    expect(r[0]).toMatchObject({ params_max_texture_size: 16384, params_max_viewport_dims_1: 32767, is_software_renderer: false, supported: true });
    expect(r[1]).toMatchObject({ fonts: 'Arial | Verdana', detected_count: 2 });
    expect(r[2]).toMatchObject({ parts_canvas: 'abc', parts_webgl: 'na', unavailable_or_unstable: 'webgl' });
    expect(r[3]).toMatchObject({ n: 3, interval_ms_1: 110, interval_ms_2: 98 });
  });

  test('a field the catalog does not know gets a new column in all three tables', async () => {
    await ingest(dto([
      { type: 'custom', name: 'transfer_started', props: { amount: 250.5, currency: 'INR', isNewPayee: true } },
      { type: 'brand_new_pattern', brandNewScore: 0.73 },
    ], 'sess_pg_3'), '5.6.7.8');
    const r = await rows('login_events', `WHERE session_id = 'sess_pg_3'`);
    expect(r[0]).toMatchObject({ event_type: 'custom', event_name: 'transfer_started', props_amount: 250.5, props_currency: 'INR', props_is_new_payee: true });
    expect(r[1]).toMatchObject({ event_type: 'brand_new_pattern', brand_new_score: 0.73 });
    for (const t of ['session_events', 'payment_events']) {
      const cols = await columnsOf(t);
      expect(cols).toEqual(expect.arrayContaining(['props_amount', 'brand_new_score']));
    }
  });

  test('a wrongly-typed value is stored as NULL instead of failing the batch', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await ingest(dto([{ type: 'keytiming', field: 'x', holdTimeMs: 'oops' }], 'sess_pg_4'), '5.6.7.8');
    const r = await rows('login_events', `WHERE session_id = 'sess_pg_4'`);
    expect(r[0].hold_time_ms).toBeNull();
    console.warn.mockRestore();
  });

  test('server-side identify back-fills login_events and marks the session logged in', async () => {
    await ingest(dto([{ type: 'focus', field: 'username' }], 'sess_pg_5'), '5.6.7.8');
    await attachUserId('sess_pg_5', 'user_99', 'server');
    const r = await rows('login_events', `WHERE session_id = 'sess_pg_5'`);
    expect(r[0].user_id).toBe('user_99');
    const s = (await pool.query(`SELECT * FROM xylium_sessions WHERE session_id = 'sess_pg_5'`)).rows[0];
    expect(s).toMatchObject({ user_id: 'user_99', identified_by: 'server', phase: 'session' });

    await ingest(dto([{ type: 'click', x: 3, y: 4, page: '/home' }], 'sess_pg_5'), '5.6.7.8');
    const session = await rows('session_events', `WHERE session_id = 'sess_pg_5'`);
    expect(session[0]).toMatchObject({ event_type: 'click', user_id: 'user_99' });
  });

  test('canonical events table is still written for /api/events', async () => {
    const r = await pool.query(`SELECT COUNT(*) AS c FROM events WHERE session_id = 'sess_pg_2'`);
    expect(Number(r.rows[0].c)).toBe(4);
  });
});

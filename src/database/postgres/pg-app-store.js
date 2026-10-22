'use strict';

/**
 * PostgreSQL replacements for every remaining MongoDB collection, used when
 * PostgreSQL is the active database. No JSON / JSONB columns: free-form
 * objects (device metadata, session summary, payment metadata, risk signal
 * metrics) are flattened into their own auto-added columns, with the same
 * rules as the SDK event tables.
 *
 *   Mongo collection       PostgreSQL table
 *   ---------------------  -----------------------------------------------
 *   network_intel          network_intel
 *   user_geo_history       user_geo_history     (one row per user+country)
 *   behaviour_sessions     behaviour_sessions   (+ device_meta_*, final_summary_*)
 *   (riskSummary.signals)  session_risk_signals (one row per signal, + metric_*)
 *   page_engagements       page_engagements
 *   payment_records        payment_records      (+ metadata_*)
 *   event_batches          event_batches        (batch info; the events
 *                                                themselves are in login_/
 *                                                session_/payment_events)
 *   sessions               xylium_sessions      (see pg-event-store.js)
 */

const { flattenObject, inferSqlType, camelCase } = require('./event-flattener');
const { EVENT_TABLES } = require('./sdk-event-columns');

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;
const PG_HARD_COLUMN_LIMIT = 1600;

const TABLES = {
  event_batches: `
    batch_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    app_id TEXT,
    session_id TEXT NOT NULL,
    user_id TEXT,
    device_fingerprint TEXT,
    event_count INTEGER NOT NULL DEFAULT 0,
    client_ip TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  network_intel: `
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    app_id TEXT,
    session_id TEXT NOT NULL,
    user_id TEXT,
    ip TEXT NOT NULL,
    country TEXT,
    timezone TEXT,
    is_vpn BOOLEAN,
    is_proxy BOOLEAN,
    is_datacenter BOOLEAN,
    is_tor BOOLEAN,
    is_new_country BOOLEAN,
    evaluated_for_user_id TEXT,
    provider TEXT,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, ip)`,

  user_geo_history: `
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    country TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, user_id, country)`,

  behaviour_sessions: `
    session_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    client_id TEXT,
    user_id TEXT,
    anonymous_id TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active',
    interaction_count DOUBLE PRECISION NOT NULL DEFAULT 0,
    page_count DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_scroll_depth DOUBLE PRECISION NOT NULL DEFAULT 0,
    active_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'none',
    device_category TEXT NOT NULL DEFAULT 'unknown',
    risk_score DOUBLE PRECISION,
    risk_level TEXT,
    risk_confidence DOUBLE PRECISION,
    risk_evaluated_at TIMESTAMPTZ,
    linked_at TIMESTAMPTZ,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  session_risk_signals: `
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL,
    signal_index INTEGER NOT NULL,
    code TEXT,
    severity TEXT,
    description TEXT`,

  page_engagements: `
    page_view_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    page_id TEXT,
    sanitized_route TEXT NOT NULL DEFAULT '/',
    entry_timestamp TIMESTAMPTZ NOT NULL,
    exit_timestamp TIMESTAMPTZ,
    elapsed_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    active_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    visible_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    idle_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_scroll_depth DOUBLE PRECISION NOT NULL DEFAULT 0,
    interaction_count DOUBLE PRECISION NOT NULL DEFAULT 0,
    navigation_source TEXT,
    exit_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  payment_records: `
    payment_id TEXT PRIMARY KEY,
    order_id TEXT,
    user_id TEXT,
    session_id TEXT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    amount DOUBLE PRECISION,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL,
    payment_method_category TEXT NOT NULL DEFAULT 'card',
    verified_at TIMESTAMPTZ,
    verified_by TEXT NOT NULL DEFAULT 'server_callback',
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
};

const INDEXES = [
  ['event_batches', 'session', '(session_id, received_at)'],
  ['network_intel', 'session', '(session_id)'],
  ['network_intel', 'user', '(tenant_id, user_id)'],
  ['behaviour_sessions', 'user', '(user_id, started_at)'],
  ['session_risk_signals', 'session', '(session_id, signal_index)'],
  ['page_engagements', 'session', '(session_id)'],
  ['page_engagements', 'user', '(user_id, entry_timestamp)'],
  ['payment_records', 'user', '(user_id, created_at)'],
  ['payment_records', 'session', '(session_id)'],
];

// Free-form objects -> column prefix (behaviour_sessions / payment_records / signals)
const PREFIX = { device: 'device_meta', summary: 'final_summary', metadata: 'metadata', metric: 'metric' };

class PgAppStore {
  /** @param {() => import('pg').Pool} getPool */
  constructor(getPool, options = {}) {
    this.getPool = getPool;
    this.maxColumns = Math.min(
      options.maxColumns ?? parseInt(process.env.PG_EVENT_MAX_COLUMNS || '1200', 10),
      PG_HARD_COLUMN_LIMIT - 50
    );
    this.ready = null;
    this.columns = new Map(); // table -> Map(column -> SQL type)
    this.ddlLock = Promise.resolve();
    this.warned = new Set();
  }

  _warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[PgAppStore] ${msg}`);
  }

  // ---------------------------------------------------------------- schema

  ensureSchema(client = null) {
    if (!this.ready) {
      this.ready = this._createSchema(client).catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  async _createSchema(client) {
    const db = client || this.getPool();
    this.columns = new Map();
    for (const [table, body] of Object.entries(TABLES)) {
      if (!(await this._tableExists(db, table))) {
        await db.query(`CREATE TABLE IF NOT EXISTS ${q(table)} (${body}\n)`);
      }
      await this._loadColumns(db, table, body);
    }
    for (const [table, name, cols] of INDEXES) {
      await db.query(`CREATE INDEX IF NOT EXISTS ${q(`ix_${table}_${name}`)} ON ${q(table)} ${cols}`);
    }
  }

  async _tableExists(db, table) {
    try {
      await db.query(`SELECT 1 FROM ${q(table)} LIMIT 1`);
      return true;
    } catch (err) {
      if (err.code === '42P01' || /does not exist/i.test(err.message)) return false;
      throw err;
    }
  }

  async _loadColumns(db, table, body) {
    const cols = new Map();
    // Fixed columns from the DDL (also covers engines with a thin information_schema).
    for (const line of body.split('\n')) {
      const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+([A-Z]+(?: PRECISION)?)/);
      if (m && !['UNIQUE', 'PRIMARY'].includes(m[1].toUpperCase())) cols.set(m[1], normaliseType(m[2]));
    }
    try {
      const res = await db.query(
        'SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1',
        [table]
      );
      for (const r of res.rows) if (!cols.has(r.column_name)) cols.set(r.column_name, normaliseType(r.data_type));
    } catch {
      /* best effort */
    }
    this.columns.set(table, cols);
  }

  /** Add any not-yet-existing columns for a flattened object. */
  async _ensureColumns(table, flat) {
    const known = this.columns.get(table);
    const missing = [];
    for (const [col, v] of Object.entries(flat)) {
      if (!known.has(col) && v !== null && v !== undefined) missing.push([col, inferSqlType(v)]);
    }
    if (!missing.length) return;
    const run = async () => {
      for (const [col, type] of missing) {
        if (known.has(col)) continue;
        if (known.size >= this.maxColumns) {
          this._warnOnce(`cap:${table}`, `column limit reached on ${table}; "${col}" not stored`);
          continue;
        }
        try {
          await this.getPool().query(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(col)} ${type}`);
        } catch (err) {
          if (err.code !== '42701') throw err;
        }
        known.set(col, type);
      }
    };
    const p = this.ddlLock.then(run, run);
    this.ddlLock = p.catch(() => {});
    await p;
  }

  _coerce(table, col, value) {
    if (value === null || value === undefined) return null;
    const type = this.columns.get(table).get(col);
    if (type === 'DOUBLE PRECISION') {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      this._warnOnce(`t:${table}.${col}`, `non-numeric value for ${table}.${col} stored as NULL`);
      return null;
    }
    if (type === 'BOOLEAN') {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 'true') return true;
      if (value === 0 || value === 'false') return false;
      this._warnOnce(`t:${table}.${col}`, `non-boolean value for ${table}.${col} stored as NULL`);
      return null;
    }
    if (type === 'TIMESTAMPTZ') return value instanceof Date ? value : new Date(value);
    if (type === 'INTEGER') return Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
    return typeof value === 'string' ? value : String(value);
  }

  /** Flatten a free-form object under a prefix and make sure its columns exist. */
  async _flat(table, prefix, obj) {
    const flat = obj && typeof obj === 'object' ? flattenObject(obj, [prefix]) : {};
    await this._ensureColumns(table, flat);
    // drop anything we could not create (column cap)
    const known = this.columns.get(table);
    for (const col of Object.keys(flat)) if (!known.has(col)) delete flat[col];
    return flat;
  }

  /**
   * INSERT ... ON CONFLICT helper. `values` maps column -> value.
   * `onConflict` is the conflict target, `updates` the SET expressions.
   */
  async _upsert(db, table, values, onConflict, updates) {
    const cols = Object.keys(values);
    const params = cols.map((c) => this._coerce(table, c, values[c]));
    const ph = cols.map((_, i) => `$${i + 1}`);
    let sql = `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${ph.join(', ')})`;
    if (onConflict) {
      sql += updates && updates.length
        ? ` ON CONFLICT (${onConflict}) DO UPDATE SET ${updates.join(', ')}`
        : ` ON CONFLICT (${onConflict}) DO NOTHING`;
    }
    const res = await db.query(`${sql} RETURNING *`, params);
    return res.rows[0] || null;
  }

  async _update(table, where, whereParams, values, extraSets = []) {
    const cols = Object.keys(values);
    const params = [...whereParams];
    const sets = cols.map((c) => {
      params.push(this._coerce(table, c, values[c]));
      return `${q(c)} = $${params.length}`;
    });
    const res = await this.getPool().query(
      `UPDATE ${q(table)} SET ${[...sets, ...extraSets].join(', ')} WHERE ${where} RETURNING *`,
      params
    );
    return res;
  }

  async _query(sql, params) {
    await this.ensureSchema();
    return this.getPool().query(sql, params);
  }

  // ================================================================ event batches

  async insertEventBatch(b) {
    await this.ensureSchema();
    await this._upsert(this.getPool(), 'event_batches', {
      batch_id: b.batchId,
      tenant_id: b.tenantId,
      app_id: b.appId ?? null,
      session_id: b.sessionId,
      user_id: b.userId ?? null,
      device_fingerprint: b.deviceFingerprint ?? null,
      event_count: b.eventCount,
      client_ip: b.clientIp ?? null,
    }, 'batch_id', null);
  }

  async setEventBatchUser(sessionId, userId) {
    const res = await this._query('UPDATE event_batches SET user_id = $2 WHERE session_id = $1', [sessionId, userId]);
    return res.rowCount || 0;
  }

  // ================================================================ network intel

  async upsertNetworkIntel({ tenantId, appId, sessionId, ip, data, provider, source }) {
    await this.ensureSchema();
    const row = await this._upsert(this.getPool(), 'network_intel', {
      tenant_id: tenantId,
      app_id: appId || null,
      session_id: sessionId,
      ip,
      country: data.country,
      timezone: data.timezone,
      is_vpn: data.isVpn,
      is_proxy: data.isProxy,
      is_datacenter: data.isDatacenter,
      is_tor: data.isTor,
      provider: provider || null,
      source,
    }, 'session_id, ip', [
      'country = EXCLUDED.country',
      'timezone = EXCLUDED.timezone',
      'is_vpn = EXCLUDED.is_vpn',
      'is_proxy = EXCLUDED.is_proxy',
      'is_datacenter = EXCLUDED.is_datacenter',
      'is_tor = EXCLUDED.is_tor',
      'provider = EXCLUDED.provider',
      'source = EXCLUDED.source',
      'updated_at = NOW()',
    ]);
    return mapNetworkIntel(row);
  }

  async findNetworkIntelWithCountry(sessionId) {
    const res = await this._query(
      'SELECT * FROM network_intel WHERE session_id = $1 AND country IS NOT NULL ORDER BY id',
      [sessionId]
    );
    return res.rows.map(mapNetworkIntel);
  }

  async markNetworkIntelEvaluated(id, userId, isNewCountry) {
    await this._query(
      'UPDATE network_intel SET user_id = $2, is_new_country = $3, evaluated_for_user_id = $2, updated_at = NOW() WHERE id = $1',
      [id, userId, isNewCountry]
    );
  }

  async getUserCountries(tenantId, userId) {
    const res = await this._query(
      'SELECT country FROM user_geo_history WHERE tenant_id = $1 AND user_id = $2 ORDER BY first_seen_at',
      [tenantId, userId]
    );
    return res.rows.map((r) => r.country);
  }

  async addUserCountry(tenantId, userId, country) {
    await this.ensureSchema();
    await this._upsert(this.getPool(), 'user_geo_history', { tenant_id: tenantId, user_id: userId, country }, 'tenant_id, user_id, country', null);
  }

  // ================================================================ behaviour sessions

  /** /api/analytics/events/batch: create-or-bump a session from a batch. */
  async upsertSessionFromEvents(s, now, clientIp) {
    await this.ensureSchema();
    const device = await this._flat('behaviour_sessions', PREFIX.device, s.device);
    await this._upsert(this.getPool(), 'behaviour_sessions', {
      session_id: s.sessionId,
      tenant_id: s.tenantId || 'default',
      anonymous_id: s.anonymousId || null,
      started_at: now,
      last_activity_at: now,
      status: 'active',
      user_id: s.userId || null,
      interaction_count: s.interactionCount,
      page_count: s.pageCount,
      max_scroll_depth: s.maxScrollDepth,
      ip_address: clientIp || null,
      ...device,
    }, 'session_id', [
      'last_activity_at = EXCLUDED.last_activity_at',
      `status = 'active'`,
      'user_id = COALESCE(EXCLUDED.user_id, behaviour_sessions.user_id)',
      'interaction_count = behaviour_sessions.interaction_count + EXCLUDED.interaction_count',
      'page_count = behaviour_sessions.page_count + EXCLUDED.page_count',
      'max_scroll_depth = GREATEST(behaviour_sessions.max_scroll_depth, EXCLUDED.max_scroll_depth)',
      'updated_at = NOW()',
    ]);
  }

  async startSession({ sessionId, tenantId, anonymousId, startedAt, deviceMetadata, ipAddress, userId }) {
    await this.ensureSchema();
    const device = await this._flat('behaviour_sessions', PREFIX.device, deviceMetadata);
    const row = await this._upsert(this.getPool(), 'behaviour_sessions', {
      session_id: sessionId,
      tenant_id: tenantId || 'default',
      anonymous_id: anonymousId || null,
      started_at: startedAt,
      last_activity_at: startedAt,
      status: 'active',
      user_id: userId || null,
      ip_address: ipAddress || null,
      ...device,
    }, 'session_id', [
      'last_activity_at = EXCLUDED.last_activity_at',
      `status = 'active'`,
      'user_id = COALESCE(EXCLUDED.user_id, behaviour_sessions.user_id)',
      'updated_at = NOW()',
    ]);
    return this._withSignals(row);
  }

  async endSession({ sessionId, endedAt, summary }) {
    await this.ensureSchema();
    const flat = await this._flat('behaviour_sessions', PREFIX.summary, summary);
    const res = await this._update('behaviour_sessions', 'session_id = $1', [sessionId], {
      ended_at: endedAt,
      last_activity_at: endedAt,
      status: 'ended',
      ...flat,
    }, ['updated_at = NOW()']);
    return this._withSignals(res.rows[0] || null);
  }

  async linkSession({ sessionId, userId, anonymousId, now }) {
    await this.ensureSchema();
    const values = { session_id: sessionId, user_id: userId, linked_at: now };
    const updates = ['user_id = EXCLUDED.user_id', 'linked_at = EXCLUDED.linked_at', 'updated_at = NOW()'];
    if (anonymousId) {
      values.anonymous_id = anonymousId;
      updates.push('anonymous_id = EXCLUDED.anonymous_id');
    }
    const row = await this._upsert(this.getPool(), 'behaviour_sessions', values, 'session_id', updates);
    return this._withSignals(row);
  }

  async findSession(sessionId) {
    const res = await this._query('SELECT * FROM behaviour_sessions WHERE session_id = $1', [sessionId]);
    return this._withSignals(res.rows[0] || null);
  }

  async findLatestUserSession(userId) {
    const res = await this._query(
      'SELECT * FROM behaviour_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1',
      [userId]
    );
    return this._withSignals(res.rows[0] || null);
  }

  async listUserSessions(userId, { skip = 0, limit = 20 } = {}) {
    const [rows, count] = await Promise.all([
      this._query(
        'SELECT * FROM behaviour_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3',
        [userId, limit, skip]
      ),
      this._query('SELECT COUNT(*) AS total FROM behaviour_sessions WHERE user_id = $1', [userId]),
    ]);
    return { sessions: await this._withSignalsMany(rows.rows), total: Number(count.rows[0].total) };
  }

  async listAllUserSessions(userId) {
    const res = await this._query('SELECT * FROM behaviour_sessions WHERE user_id = $1 ORDER BY started_at DESC', [userId]);
    return this._withSignalsMany(res.rows);
  }

  async findHistoricalSessions(userId, excludeSessionId, limit = 10) {
    const res = await this._query(
      `SELECT * FROM behaviour_sessions
        WHERE user_id = $1 AND session_id <> $2 AND status IN ('active', 'ended')
        LIMIT $3`,
      [userId, excludeSessionId, limit]
    );
    return res.rows.map((r) => mapSession(r, []));
  }

  async setSessionPaymentStatus(sessionId, status) {
    await this._query(
      'UPDATE behaviour_sessions SET payment_status = $2, updated_at = NOW() WHERE session_id = $1',
      [sessionId, status]
    );
  }

  async saveRiskSummary(sessionId, { riskScore, riskLevel, confidence, evaluatedAt, signals }) {
    await this.ensureSchema();
    // Create any new metric_* columns BEFORE opening the transaction: an
    // ALTER TABLE on another connection would wait on this transaction's locks.
    const flats = [];
    for (const sig of signals || []) flats.push(await this._flat('session_risk_signals', PREFIX.metric, sig.metric));
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE behaviour_sessions SET risk_score = $2, risk_level = $3, risk_confidence = $4,
           risk_evaluated_at = $5, updated_at = NOW() WHERE session_id = $1`,
        [sessionId, riskScore, riskLevel, confidence, evaluatedAt]
      );
      await client.query('DELETE FROM session_risk_signals WHERE session_id = $1', [sessionId]);
      for (let i = 0; i < (signals || []).length; i++) {
        const { code, severity, description } = signals[i];
        const flat = flats[i];
        await this._upsert(client, 'session_risk_signals', {
          session_id: sessionId,
          evaluated_at: evaluatedAt,
          signal_index: i,
          code: code ?? null,
          severity: severity ?? null,
          description: description ?? null,
          ...flat,
        }, null, null);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async anonymizeUserSessions(userId) {
    const res = await this._query(
      `UPDATE behaviour_sessions SET user_id = NULL, anonymous_id = 'anonymized', updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
    return res.rowCount || 0;
  }

  async _withSignals(row) {
    if (!row) return null;
    const res = await this.getPool().query(
      'SELECT * FROM session_risk_signals WHERE session_id = $1 ORDER BY signal_index',
      [row.session_id]
    );
    return mapSession(row, res.rows);
  }

  async _withSignalsMany(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.session_id);
    const res = await this.getPool().query(
      `SELECT * FROM session_risk_signals WHERE session_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY signal_index`,
      ids
    );
    const bySession = new Map();
    for (const s of res.rows) {
      if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
      bySession.get(s.session_id).push(s);
    }
    return rows.map((r) => mapSession(r, bySession.get(r.session_id) || []));
  }

  // ================================================================ page engagements

  async upsertPageEngagement(pe) {
    await this.ensureSchema();
    await this._upsert(this.getPool(), 'page_engagements', {
      page_view_id: pe.pageViewId,
      session_id: pe.sessionId,
      tenant_id: pe.tenantId || 'default',
      page_id: pe.pageId,
      sanitized_route: pe.sanitizedRoute || '/',
      entry_timestamp: pe.entryTimestamp,
      exit_timestamp: pe.exitTimestamp,
      elapsed_duration_ms: pe.elapsedDurationMs,
      active_duration_ms: pe.activeDurationMs,
      visible_duration_ms: pe.visibleDurationMs,
      idle_duration_ms: pe.idleDurationMs,
      max_scroll_depth: pe.maxScrollDepth,
      interaction_count: pe.interactionCount,
      navigation_source: pe.navigationSource,
      exit_reason: pe.exitReason,
      user_id: pe.userId || null,
    }, 'page_view_id', [
      'exit_timestamp = EXCLUDED.exit_timestamp',
      'elapsed_duration_ms = EXCLUDED.elapsed_duration_ms',
      'active_duration_ms = EXCLUDED.active_duration_ms',
      'visible_duration_ms = EXCLUDED.visible_duration_ms',
      'idle_duration_ms = EXCLUDED.idle_duration_ms',
      'max_scroll_depth = EXCLUDED.max_scroll_depth',
      'interaction_count = EXCLUDED.interaction_count',
      'navigation_source = EXCLUDED.navigation_source',
      'exit_reason = EXCLUDED.exit_reason',
      'user_id = COALESCE(EXCLUDED.user_id, page_engagements.user_id)',
      'updated_at = NOW()',
    ]);
  }

  async backfillPageEngagementUser(sessionId, userId) {
    const res = await this._query(
      'UPDATE page_engagements SET user_id = $2, updated_at = NOW() WHERE session_id = $1 AND user_id IS NULL',
      [sessionId, userId]
    );
    return res.rowCount || 0;
  }

  async listUserPageEngagements(userId) {
    const res = await this._query('SELECT * FROM page_engagements WHERE user_id = $1 ORDER BY entry_timestamp DESC', [userId]);
    return res.rows.map(mapPageEngagement);
  }

  async deleteUserPageEngagements(userId) {
    const res = await this._query('DELETE FROM page_engagements WHERE user_id = $1', [userId]);
    return res.rowCount || 0;
  }

  // ================================================================ payments

  async upsertPayment(dto, now) {
    await this.ensureSchema();
    const meta = await this._flat('payment_records', PREFIX.metadata, dto.metadata);
    const values = {
      payment_id: dto.paymentId,
      order_id: dto.orderId,
      user_id: dto.userId,
      session_id: dto.sessionId,
      tenant_id: dto.tenantId || 'default',
      amount: dto.amount,
      currency: dto.currency || 'USD',
      status: dto.status,
      payment_method_category: dto.paymentMethodCategory || 'card',
      failure_reason: dto.failureReason || null,
      verified_at: now,
      verified_by: 'server_verification',
      ...meta,
    };
    const updates = Object.keys(values)
      .filter((c) => c !== 'payment_id')
      .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
      .concat('updated_at = NOW()');
    const row = await this._upsert(this.getPool(), 'payment_records', values, 'payment_id', updates);
    return mapPayment(row);
  }

  async listUserPayments(userId) {
    const res = await this._query('SELECT * FROM payment_records WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return res.rows.map(mapPayment);
  }

  async deleteUserPayments(userId) {
    const res = await this._query('DELETE FROM payment_records WHERE user_id = $1', [userId]);
    return res.rowCount || 0;
  }

  // ================================================================ retention

  /**
   * PostgreSQL version of the Mongo TTL index (RAW_TTL_DAYS): delete raw
   * event rows and batch records older than `days`.
   */
  async purgeRawOlderThan(days) {
    if (!(days > 0)) return {};
    const cutoff = new Date(Date.now() - days * 86400000);
    const out = {};
    for (const table of [...Object.values(EVENT_TABLES), 'event_batches']) {
      try {
        const res = await this._query(`DELETE FROM ${q(table)} WHERE received_at < $1`, [cutoff]);
        out[table] = res.rowCount || 0;
      } catch (err) {
        if (!/does not exist/i.test(err.message)) throw err;
      }
    }
    return out;
  }

  describe() {
    return { tables: Object.keys(TABLES) };
  }
}

// ---------------------------------------------------------------- row mappers
// Rebuild the same document shapes the Mongo models returned, so API
// responses do not change when the active database changes.

function normaliseType(t) {
  const s = String(t).toUpperCase();
  if (s.includes('DOUBLE') || s === 'NUMERIC' || s === 'REAL' || s === 'FLOAT8') return 'DOUBLE PRECISION';
  if (s.includes('INT') || s === 'BIGSERIAL' || s === 'SERIAL') return 'INTEGER';
  if (s.startsWith('BOOL')) return 'BOOLEAN';
  if (s.startsWith('TIMESTAMP')) return 'TIMESTAMPTZ';
  return 'TEXT';
}

function prefixed(row, prefix) {
  const out = {};
  const p = `${prefix}_`;
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith(p) && v !== null && v !== undefined) out[camelCase(k.slice(p.length))] = v;
  }
  return out;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function mapSession(r, signalRows) {
  if (!r) return null;
  const finalSummary = prefixed(r, PREFIX.summary);
  return {
    sessionId: r.session_id,
    tenantId: r.tenant_id,
    clientId: r.client_id,
    userId: r.user_id,
    anonymousId: r.anonymous_id,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at,
    endedAt: r.ended_at,
    status: r.status,
    sessionSummary: {
      interactionCount: num(r.interaction_count) ?? 0,
      pageCount: num(r.page_count) ?? 0,
      maxScrollDepth: num(r.max_scroll_depth) ?? 0,
      activeDurationMs: num(r.active_duration_ms) ?? 0,
      paymentStatus: r.payment_status,
      deviceCategory: r.device_category,
      ...(Object.keys(finalSummary).length ? { finalSummary } : {}),
    },
    riskSummary: {
      riskScore: num(r.risk_score),
      riskLevel: r.risk_level,
      confidence: num(r.risk_confidence),
      evaluatedAt: r.risk_evaluated_at,
      signals: (signalRows || []).map((s) => {
        const metric = prefixed(s, PREFIX.metric);
        return {
          code: s.code,
          severity: s.severity,
          description: s.description,
          ...(Object.keys(metric).length ? { metric } : {}),
        };
      }),
    },
    deviceMetadata: prefixed(r, PREFIX.device),
    linkedAt: r.linked_at,
    ipAddress: r.ip_address,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapNetworkIntel(r) {
  if (!r) return null;
  return {
    _id: r.id,
    id: r.id,
    tenantId: r.tenant_id,
    appId: r.app_id,
    sessionId: r.session_id,
    userId: r.user_id,
    ip: r.ip,
    country: r.country,
    timezone: r.timezone,
    isVpn: r.is_vpn,
    isProxy: r.is_proxy,
    isDatacenter: r.is_datacenter,
    isTor: r.is_tor,
    isNewCountry: r.is_new_country,
    evaluatedForUserId: r.evaluated_for_user_id,
    provider: r.provider,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapPageEngagement(r) {
  return {
    pageViewId: r.page_view_id,
    sessionId: r.session_id,
    userId: r.user_id,
    tenantId: r.tenant_id,
    pageId: r.page_id,
    sanitizedRoute: r.sanitized_route,
    entryTimestamp: r.entry_timestamp,
    exitTimestamp: r.exit_timestamp,
    elapsedDurationMs: num(r.elapsed_duration_ms),
    activeDurationMs: num(r.active_duration_ms),
    visibleDurationMs: num(r.visible_duration_ms),
    idleDurationMs: num(r.idle_duration_ms),
    maxScrollDepth: num(r.max_scroll_depth),
    interactionCount: num(r.interaction_count),
    navigationSource: r.navigation_source,
    exitReason: r.exit_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapPayment(r) {
  if (!r) return null;
  return {
    paymentId: r.payment_id,
    orderId: r.order_id,
    userId: r.user_id,
    sessionId: r.session_id,
    tenantId: r.tenant_id,
    amount: num(r.amount),
    currency: r.currency,
    status: r.status,
    paymentMethodCategory: r.payment_method_category,
    verifiedAt: r.verified_at,
    verifiedBy: r.verified_by,
    failureReason: r.failure_reason,
    metadata: prefixed(r, PREFIX.metadata),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = PgAppStore;
module.exports.TABLES = TABLES;

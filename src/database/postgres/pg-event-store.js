'use strict';

/**
 * PostgreSQL storage for the login / session / payment event split.
 *
 * Mirrors the Mongo login_events / session_events / payment_events
 * collections, but stores ONE ROW PER SDK EVENT with ONE COLUMN PER SDK FIELD
 * (no JSON), so the tables can be read directly as ML input.
 *
 *   login_events     events before and at login (and after a logout)
 *   session_events   logged-in events up to and including logout
 *   payment_events   logged-in events on a payment page
 *   xylium_sessions  per-session phase / user tracking (replaces the Mongo
 *                    `sessions` collection when PostgreSQL is active)
 *
 * Tables are created on first use (CREATE TABLE IF NOT EXISTS). A field the
 * catalog doesn't know yet (new SDK pattern, custom track() props) gets its
 * own column on first sight, added to all three event tables so they always
 * share one schema.
 */

const crypto = require('crypto');
const { flattenEvent, inferSqlType } = require('./event-flattener');
const { ENVELOPE_COLUMNS, SDK_COLUMNS, EVENT_TABLES, SESSIONS_TABLE } = require('./sdk-event-columns');

const ENVELOPE_NAMES = new Set(ENVELOPE_COLUMNS.map(([n]) => n));
// Columns we write explicitly on insert (id and received_at use defaults).
const INSERT_ENVELOPE = ENVELOPE_COLUMNS.map(([n]) => n).filter((n) => n !== 'id' && n !== 'received_at');

// Keep well below PostgreSQL's 65535 bind-parameter limit per statement.
const MAX_PARAMS_PER_INSERT = 30000;
const PG_HARD_COLUMN_LIMIT = 1600;

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

function envBool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v));
}

class PgEventStore {
  /**
   * @param {() => import('pg').Pool} getPool  pool getter (the adapter may swap
   *   its pool, e.g. when it falls back to the embedded engine)
   * @param {object} [options]
   */
  constructor(getPool, options = {}) {
    this.getPool = getPool;
    this.autoAddColumns = options.autoAddColumns ?? envBool(process.env.PG_EVENT_AUTO_COLUMNS, true);
    this.maxColumns = Math.min(
      options.maxColumns ?? parseInt(process.env.PG_EVENT_MAX_COLUMNS || '1200', 10),
      PG_HARD_COLUMN_LIMIT - 50
    );
    this.columnTypes = new Map(); // column -> SQL type (SDK feature columns only)
    this.ready = null; // promise of the initial schema creation
    this.ddlLock = Promise.resolve(); // serialises ALTER TABLEs inside this process
    this.warned = new Set();
  }

  _warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[PgEventStore] ${msg}`);
  }

  // ---------------------------------------------------------------- schema

  /** Create tables/indexes once. Safe to call repeatedly and concurrently. */
  ensureSchema(client = null) {
    if (!this.ready) {
      this.ready = this._createSchema(client).catch((err) => {
        this.ready = null; // allow a retry on the next call
        throw err;
      });
    }
    return this.ready;
  }

  async _createSchema(client) {
    const db = client || this.getPool();
    this.columnTypes = new Map(); // may be a fresh database (switch / embedded fallback)

    const envelopeSql = ENVELOPE_COLUMNS.map(([n, t]) => `${q(n)} ${t}`);
    const featureSql = [...SDK_COLUMNS.entries()].map(([n, c]) => `${q(n)} ${c.type}`);

    const created = new Set();
    for (const table of Object.values(EVENT_TABLES)) {
      if (!(await this._tableExists(db, table))) {
        await db.query(`CREATE TABLE IF NOT EXISTS ${q(table)} (\n  ${[...envelopeSql, ...featureSql].join(',\n  ')}\n)`);
        created.add(table);
      }
      await db.query(`CREATE INDEX IF NOT EXISTS ${q(`ix_${table}_session`)} ON ${q(table)} (tenant_id, session_id, received_at)`);
      await db.query(`CREATE INDEX IF NOT EXISTS ${q(`ix_${table}_user`)} ON ${q(table)} (tenant_id, user_id, received_at)`);
      await db.query(`CREATE INDEX IF NOT EXISTS ${q(`ix_${table}_type`)} ON ${q(table)} (event_type, received_at)`);
    }

    if (!(await this._tableExists(db, SESSIONS_TABLE))) await db.query(`
      CREATE TABLE IF NOT EXISTS ${q(SESSIONS_TABLE)} (
        session_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        app_id TEXT,
        device_fingerprint TEXT,
        user_id TEXT,
        identified_by TEXT,
        phase TEXT NOT NULL DEFAULT 'login',
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        logged_in_at TIMESTAMPTZ,
        logged_out_at TIMESTAMPTZ,
        batch_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS ${q(`ix_${SESSIONS_TABLE}_user`)} ON ${q(SESSIONS_TABLE)} (tenant_id, user_id)`);

    // The tables may already exist from an older SDK version: add any
    // catalog column they are missing, then learn every column's real type.
    for (const [n, c] of SDK_COLUMNS) this.columnTypes.set(n, c.type);
    await this._loadExistingColumns(db);
    await this._addMissingCatalogColumns(db, created);
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

  async _loadExistingColumns(db) {
    try {
      const res = await db.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ANY($1)`,
        [Object.values(EVENT_TABLES)]
      );
      this.existing = new Map(Object.values(EVENT_TABLES).map((t) => [t, new Set()]));
      for (const r of res.rows) {
        this.existing.get(r.table_name)?.add(r.column_name);
        if (ENVELOPE_NAMES.has(r.column_name)) continue;
        const t = String(r.data_type).toLowerCase();
        const type = t.startsWith('double') || t === 'numeric' || t === 'real' || t.includes('int')
          ? 'DOUBLE PRECISION'
          : t === 'boolean' ? 'BOOLEAN' : 'TEXT';
        // An auto-added column keeps whatever type it was created with.
        if (!SDK_COLUMNS.has(r.column_name)) this.columnTypes.set(r.column_name, type);
      }
    } catch (err) {
      // Embedded engine has a partial information_schema; ADD COLUMN IF NOT
      // EXISTS below still makes the schema correct.
      this.existing = null;
    }
  }

  async _addMissingCatalogColumns(db, created) {
    for (const table of Object.values(EVENT_TABLES)) {
      if (created.has(table)) continue; // just created with every catalog column
      let have = this.existing && this.existing.get(table);
      if (have && have.size === 0) have = null; // engine without information_schema data
      for (const [n, type] of this.columnTypes) {
        if (have && have.has(n)) continue;
        await db.query(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(n)} ${type}`);
      }
    }
  }

  /** Add columns for fields seen for the first time (all three tables). */
  async _ensureColumns(newCols) {
    if (!newCols.size) return;
    const run = async () => {
      const pool = this.getPool();
      for (const [col, type] of newCols) {
        if (this.columnTypes.has(col)) continue;
        if (this.columnTypes.size + ENVELOPE_COLUMNS.length >= this.maxColumns) {
          this._warnOnce('cap', `column limit ${this.maxColumns} reached; new field "${col}" is not stored. ` +
            'Raise PG_EVENT_MAX_COLUMNS or prune unused columns.');
          continue;
        }
        for (const table of Object.values(EVENT_TABLES)) {
          try {
            await pool.query(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(col)} ${type}`);
          } catch (err) {
            if (err.code !== '42701') throw err; // 42701 = another process added it first
          }
        }
        this.columnTypes.set(col, type);
        console.log(`[PgEventStore] added column ${col} ${type} to event tables`);
      }
    };
    const p = this.ddlLock.then(run, run);
    this.ddlLock = p.catch(() => {});
    return p;
  }

  // ---------------------------------------------------------------- writes

  _coerce(col, value) {
    if (value === null || value === undefined) return null;
    const type = this.columnTypes.get(col);
    if (type === 'DOUBLE PRECISION') {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      this._warnOnce(`type:${col}`, `value for numeric column "${col}" is not a number (${typeof value}); stored as NULL`);
      return null;
    }
    if (type === 'BOOLEAN') {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 'true') return true;
      if (value === 0 || value === 'false') return false;
      this._warnOnce(`type:${col}`, `value for boolean column "${col}" is not a boolean (${typeof value}); stored as NULL`);
      return null;
    }
    return typeof value === 'string' ? value : String(value);
  }

  /**
   * Turn bucketed SDK events into rows.
   * @param {Array<{ evt: object, bucket: 'login'|'session'|'payment', seq: number, userId: string|null, category: string }>} items
   * @param {object} base  tenantId, appId, sessionId, deviceFingerprint, clientIp, batchId
   */
  async buildRows(items, base) {
    const newCols = new Map();
    const rows = items.map(({ evt, bucket, seq, userId, category }) => {
      const flat = flattenEvent(evt);
      for (const [col, v] of Object.entries(flat)) {
        if (!this.columnTypes.has(col) && v !== null && !newCols.has(col)) newCols.set(col, inferSqlType(v));
      }
      const type = typeof evt.type === 'string' && evt.type ? evt.type : 'unknown_event';
      return {
        table: EVENT_TABLES[bucket],
        envelope: {
          tenant_id: base.tenantId,
          app_id: base.appId ?? null,
          session_id: base.sessionId,
          user_id: userId ?? null,
          device_fingerprint: base.deviceFingerprint ?? null,
          client_ip: base.clientIp ?? null,
          event_type: type,
          event_name: type === 'custom' && typeof evt.name === 'string' && evt.name ? evt.name : type,
          event_category: category ?? null,
          page: typeof evt.page === 'string' ? evt.page : null,
          page_type: evt.pageType == null ? null : String(evt.pageType),
          sdk_t_ms: typeof evt.t === 'number' && Number.isFinite(evt.t) ? evt.t : null,
          batch_id: base.batchId,
          batch_seq: seq,
        },
        flat,
      };
    });
    if (this.autoAddColumns) await this._ensureColumns(newCols);
    else for (const col of newCols.keys()) this._warnOnce(`skip:${col}`, `unknown field column "${col}" skipped (PG_EVENT_AUTO_COLUMNS=false)`);
    return rows;
  }

  async _insertRows(client, table, rows) {
    // Column set = envelope + every known feature column present in this chunk.
    const featureCols = [];
    const seen = new Set();
    for (const r of rows) {
      for (const col of Object.keys(r.flat)) {
        if (!seen.has(col) && this.columnTypes.has(col)) {
          seen.add(col);
          featureCols.push(col);
        }
      }
    }
    const cols = [...INSERT_ENVELOPE, ...featureCols];
    const perRow = cols.length;
    const chunkSize = Math.max(1, Math.floor(MAX_PARAMS_PER_INSERT / perRow));

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const params = [];
      const tuples = chunk.map((r) => {
        const ph = [];
        for (const c of INSERT_ENVELOPE) { params.push(r.envelope[c]); ph.push(`$${params.length}`); }
        for (const c of featureCols) { params.push(this._coerce(c, r.flat[c])); ph.push(`$${params.length}`); }
        return `(${ph.join(', ')})`;
      });
      await client.query(`INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')}`, params);
    }
  }

  /**
   * Store one ingested batch: event rows + session state, in one transaction.
   * @returns {{ login: number, session: number, payment: number }}
   */
  async saveBatch({ rows, session }) {
    await this.ensureSchema();
    const client = await this.getPool().connect();
    const counts = { login: 0, session: 0, payment: 0 };
    try {
      await client.query('BEGIN');
      for (const [bucket, table] of Object.entries(EVENT_TABLES)) {
        const tableRows = rows.filter((r) => r.table === table);
        if (!tableRows.length) continue;
        await this._insertRows(client, table, tableRows);
        counts[bucket] = tableRows.length;
      }
      if (session) await this._upsertSession(client, session);
      await client.query('COMMIT');
      return counts;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async _upsertSession(db, s) {
    await db.query(
      `INSERT INTO ${q(SESSIONS_TABLE)}
         (session_id, tenant_id, app_id, device_fingerprint, phase,
          first_seen_at, last_seen_at, logged_in_at, logged_out_at, batch_count, event_count)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, 1, $9)
       ON CONFLICT (session_id) DO UPDATE SET
         phase = EXCLUDED.phase,
         last_seen_at = EXCLUDED.last_seen_at,
         logged_in_at = COALESCE(EXCLUDED.logged_in_at, ${q(SESSIONS_TABLE)}.logged_in_at),
         logged_out_at = COALESCE(EXCLUDED.logged_out_at, ${q(SESSIONS_TABLE)}.logged_out_at),
         batch_count = ${q(SESSIONS_TABLE)}.batch_count + 1,
         event_count = ${q(SESSIONS_TABLE)}.event_count + EXCLUDED.event_count`,
      [
        s.sessionId, s.tenantId, s.appId ?? null, s.deviceFingerprint ?? null, s.phase,
        s.now, s.loggedInAt ?? null, s.loggedOutAt ?? null, s.eventCount,
      ]
    );
  }

  // ---------------------------------------------------------------- sessions

  async getSession(sessionId) {
    await this.ensureSchema();
    const res = await this.getPool().query(
      `SELECT session_id, tenant_id, user_id, phase, identified_by FROM ${q(SESSIONS_TABLE)} WHERE session_id = $1`,
      [sessionId]
    );
    const r = res.rows[0];
    return r ? { sessionId: r.session_id, tenantId: r.tenant_id, userId: r.user_id, phase: r.phase, identifiedBy: r.identified_by } : null;
  }

  /**
   * Attach a userId to a session and back-fill it onto that session's
   * pre-login rows in login_events (same behaviour as the Mongo path).
   */
  async attachUser(sessionId, userId, source, { setPhase = true } = {}) {
    await this.ensureSchema();
    const pool = this.getPool();
    const now = new Date();
    const sets = ['user_id = $2', 'identified_by = $3'];
    const params = [sessionId, userId, source];
    if (setPhase) {
      sets.push(`phase = 'session'`, `logged_in_at = $4`);
      params.push(now);
    }
    await pool.query(`UPDATE ${q(SESSIONS_TABLE)} SET ${sets.join(', ')} WHERE session_id = $1`, params);
    const res = await pool.query(
      `UPDATE ${q(EVENT_TABLES.login)} SET user_id = $2 WHERE session_id = $1 AND user_id IS NULL`,
      [sessionId, userId]
    );
    return { backfilled: res.rowCount || 0 };
  }

  // ---------------------------------------------------------------- info

  describe() {
    return {
      tables: Object.values(EVENT_TABLES),
      sessionsTable: SESSIONS_TABLE,
      featureColumns: this.columnTypes.size,
      envelopeColumns: ENVELOPE_COLUMNS.length,
      autoAddColumns: this.autoAddColumns,
      maxColumns: this.maxColumns,
    };
  }

  static newBatchId() {
    return crypto.randomUUID();
  }
}

module.exports = PgEventStore;

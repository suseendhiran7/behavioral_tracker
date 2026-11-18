'use strict';

/**
 * PostgreSQL target for the migration.
 *
 * Postgres is the "original" schema, so everything here goes through the
 * app's own PostgreSQLAdapter / PgEventStore / PgAppStore. That way migrated
 * rows are flattened and typed exactly like rows written by live traffic.
 *
 * Duplicate protection lives HERE, in the database, not in the source code:
 *   1. every target table gets a unique key (prepareConstraints)
 *   2. every insert is INSERT ... ON CONFLICT (key) DO NOTHING / guarded UPDATE
 * So re-running the migration, retrying a batch, or a crash halfway can
 * never create a second copy of a row.
 */

const { Pool } = require('pg');
const PostgreSQLAdapter = require('../../../src/database/adapters/postgresql.adapter');

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;
const MAX_PARAMS = 30000; // stay well under Postgres' 65535 bind-parameter limit

/**
 * Unique keys the migration relies on. Most already exist in the app schema;
 * the ones marked `add` are missing today and are created by prepareConstraints().
 */
const UNIQUE_KEYS = {
  events: { cols: ['tenant_id', 'event_id'] },
  xylium_sessions: { cols: ['session_id'] },
  event_batches: { cols: ['batch_id'] },
  network_intel: { cols: ['session_id', 'ip'] },
  user_geo_history: { cols: ['tenant_id', 'user_id', 'country'] },
  behaviour_sessions: { cols: ['session_id'] },
  page_engagements: { cols: ['page_view_id'] },
  payment_records: { cols: ['payment_id'] },
  login_events: { cols: ['batch_id', 'batch_seq'], add: 'ux_login_events_batch' },
  session_events: { cols: ['batch_id', 'batch_seq'], add: 'ux_session_events_batch' },
  payment_events: { cols: ['batch_id', 'batch_seq'], add: 'ux_payment_events_batch' },
  // Live code (saveRiskSummary) deletes and rewrites a session's signals, so
  // (session_id, signal_index) is unique by design; we make Postgres enforce it.
  session_risk_signals: { cols: ['session_id', 'signal_index'], add: 'ux_session_risk_signals' },
};

class PostgresTarget {
  constructor(pgConfig) {
    this.pgConfig = pgConfig;
    this.pool = null;
    this.adapter = null;
  }

  /**
   * Connect to the REAL database. The app adapter silently falls back to an
   * in-memory engine when Postgres is unreachable; for a migration that would
   * mean "success" with the data written nowhere, so we never call
   * adapter.connect() and fail hard instead.
   */
  async connect() {
    const c = this.pgConfig;
    this.pool = new Pool({
      host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
      ssl: c.ssl ? { rejectUnauthorized: false } : false,
      max: c.maxPoolSize || 10,
    });
    const client = await this.pool.connect(); // throws if Postgres is not reachable
    try {
      const { rows } = await client.query('SELECT current_database() AS db, version() AS v');
      this.dbName = rows[0].db;
      this.adapter = new PostgreSQLAdapter(c, this.pool);
      this.adapter.isConnected = true;
      await this.adapter._initializeSchema(client); // creates every app table if missing
    } finally {
      client.release();
    }
    this.eventStore = this.adapter.getEventStore();
    this.appStore = this.adapter.getAppStore();
    await this.eventStore.ensureSchema();
    await this.appStore.ensureSchema();
    this.eventColumns = this.adapter._getInsertColumnsSql().split(',').map((s) => s.trim()).filter(Boolean);
  }

  async close() {
    if (this.pool) await this.pool.end();
  }

  // ------------------------------------------------------------ preparation

  /** Bookkeeping tables: checkpoints (resume point) and rejects (bad records). */
  async prepareBookkeeping() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS migration_checkpoints (
        source       TEXT NOT NULL,
        entity       TEXT NOT NULL,
        last_key     TEXT,
        last_key_type TEXT,
        docs_read    BIGINT NOT NULL DEFAULT 0,
        rows_inserted BIGINT NOT NULL DEFAULT 0,
        rows_skipped_duplicate BIGINT NOT NULL DEFAULT 0,
        docs_rejected BIGINT NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'running',
        started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, entity)
      )`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS migration_rejects (
        source     TEXT NOT NULL,
        entity     TEXT NOT NULL,
        source_id  TEXT NOT NULL,
        reason     TEXT NOT NULL,
        sample     TEXT,
        rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, entity, source_id)
      )`);
  }

  /**
   * Add the unique keys that are missing today. Before adding one, check that
   * the table has no duplicates already; if it does, stop and report them
   * (we never delete data automatically).
   */
  async prepareConstraints(log = console.log) {
    const problems = [];
    for (const [table, key] of Object.entries(UNIQUE_KEYS)) {
      if (!key.add) continue;
      const cols = key.cols.map(q).join(', ');
      const notNull = key.cols.map((c) => `${q(c)} IS NOT NULL`).join(' AND ');
      const dup = await this.pool.query(
        `SELECT COUNT(*)::bigint AS groups, COALESCE(SUM(n - 1), 0)::bigint AS extra FROM (
           SELECT COUNT(*) AS n FROM ${q(table)} WHERE ${notNull} GROUP BY ${cols} HAVING COUNT(*) > 1
         ) d`
      );
      const extra = Number(dup.rows[0].extra);
      if (extra > 0) {
        problems.push(`${table}: ${extra} duplicate row(s) on (${key.cols.join(', ')})`);
        continue;
      }
      // CONCURRENTLY: don't block live inserts on big tables while the index builds.
      try {
        await this.pool.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${q(key.add)} ON ${q(table)} (${cols})`);
      } catch (err) {
        // A failed CONCURRENTLY build leaves an INVALID index behind; drop and retry normally.
        await this.pool.query(`DROP INDEX IF EXISTS ${q(key.add)}`);
        await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(key.add)} ON ${q(table)} (${cols})`);
      }
      log(`  unique key ok: ${table} (${key.cols.join(', ')})`);
    }
    if (problems.length) {
      const err = new Error(
        'Existing duplicates found in Postgres. Fix these before migrating ' +
        '(run with --report-duplicates to list them):\n  ' + problems.join('\n  ')
      );
      err.code = 'EXISTING_DUPLICATES';
      throw err;
    }
  }

  // ------------------------------------------------------------ checkpoints

  async getCheckpoint(source, entity) {
    const { rows } = await this.pool.query(
      'SELECT * FROM migration_checkpoints WHERE source = $1 AND entity = $2', [source, entity]
    );
    return rows[0] || null;
  }

  async resetCheckpoint(source, entity) {
    await this.pool.query('DELETE FROM migration_checkpoints WHERE source = $1 AND entity = $2', [source, entity]);
  }

  /** Saved in the SAME transaction as the batch, so data and resume point never disagree. */
  async saveCheckpoint(db, source, entity, lastKey, lastKeyType, delta, status = 'running') {
    await db.query(
      `INSERT INTO migration_checkpoints AS c
         (source, entity, last_key, last_key_type, docs_read, rows_inserted, rows_skipped_duplicate, docs_rejected, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source, entity) DO UPDATE SET
         last_key = COALESCE(EXCLUDED.last_key, c.last_key),
         last_key_type = COALESCE(EXCLUDED.last_key_type, c.last_key_type),
         docs_read = c.docs_read + EXCLUDED.docs_read,
         rows_inserted = c.rows_inserted + EXCLUDED.rows_inserted,
         rows_skipped_duplicate = c.rows_skipped_duplicate + EXCLUDED.rows_skipped_duplicate,
         docs_rejected = c.docs_rejected + EXCLUDED.docs_rejected,
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [source, entity, lastKey, lastKeyType, delta.docsRead || 0, delta.inserted || 0,
        delta.skipped || 0, delta.rejected || 0, status]
    );
  }

  async reject(source, entity, sourceId, reason, doc) {
    let sample = null;
    try { sample = JSON.stringify(doc).slice(0, 2000); } catch { /* ignore */ }
    await this.pool.query(
      `INSERT INTO migration_rejects (source, entity, source_id, reason, sample)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, entity, source_id) DO UPDATE SET reason = EXCLUDED.reason, sample = EXCLUDED.sample, rejected_at = NOW()`,
      [source, entity, String(sourceId), String(reason).slice(0, 2000), sample]
    );
  }

  // ------------------------------------------------------------ writes

  /**
   * Idempotent multi-row insert.
   *   rows       array of { column: value } (already coerced)
   *   onConflict 'skip'  -> ON CONFLICT (key) DO NOTHING            (default)
   *              'newer' -> overwrite only if the incoming row is newer,
   *                         judged by opts.newerColumn
   *   returning  optional column to return for rows that were actually written
   * Returns { written, returned[] }.
   */
  async insertRows(db, table, rows, { onConflict = 'skip', newerColumn = null, returning = null } = {}) {
    if (!rows.length) return { written: 0, returned: [] };
    const key = UNIQUE_KEYS[table];
    if (!key) throw new Error(`No unique key registered for table "${table}" - refusing to insert without duplicate protection`);

    const cols = [];
    const seen = new Set();
    for (const r of rows) for (const c of Object.keys(r)) if (!seen.has(c)) { seen.add(c); cols.push(c); }
    for (const k of key.cols) if (!seen.has(k)) throw new Error(`${table}: rows are missing key column "${k}"`);

    let conflictSql = ` ON CONFLICT (${key.cols.map(q).join(', ')}) DO NOTHING`;
    if (onConflict === 'newer' && newerColumn && seen.has(newerColumn)) {
      const sets = cols.filter((c) => !key.cols.includes(c)).map((c) => `${q(c)} = EXCLUDED.${q(c)}`);
      if (sets.length) {
        conflictSql = ` ON CONFLICT (${key.cols.map(q).join(', ')}) DO UPDATE SET ${sets.join(', ')}` +
          ` WHERE ${q(table)}.${q(newerColumn)} IS NULL OR ${q(table)}.${q(newerColumn)} < EXCLUDED.${q(newerColumn)}`;
      }
    }

    // Postgres rejects one statement touching the same key twice; dedupe the batch itself first (last wins).
    const byKey = new Map();
    for (const r of rows) byKey.set(JSON.stringify(key.cols.map((k) => r[k])), r);
    const unique = [...byKey.values()];

    const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
    let written = 0;
    const returned = [];
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const params = [];
      const tuples = chunk.map((r) => `(${cols.map((c) => {
        params.push(r[c] === undefined ? null : r[c]);
        return `$${params.length}`;
      }).join(', ')})`);
      const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')}${conflictSql}` +
        (returning ? ` RETURNING ${q(returning)}` : '');
      const res = await db.query(sql, params);
      written += res.rowCount || 0;
      if (returning) for (const row of res.rows) returned.push(row[returning]);
    }
    return { written, returned, attempted: rows.length };
  }

  // ------------------------------------------------------------ verification

  async count(sql, params = []) {
    const { rows } = await this.pool.query(sql, params);
    return Number(rows[0].n);
  }

  /** Rows that violate a table's unique key. Must be 0 everywhere. */
  async duplicateReport(limit = 20) {
    const out = [];
    for (const [table, key] of Object.entries(UNIQUE_KEYS)) {
      const cols = key.cols.map(q).join(', ');
      const notNull = key.cols.map((c) => `${q(c)} IS NOT NULL`).join(' AND ');
      try {
        const { rows } = await this.pool.query(
          `SELECT ${cols}, COUNT(*) AS copies FROM ${q(table)} WHERE ${notNull}
            GROUP BY ${cols} HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT ${limit}`
        );
        out.push({ table, key: key.cols, duplicates: rows });
      } catch (err) {
        out.push({ table, key: key.cols, error: err.message });
      }
    }
    return out;
  }
}

module.exports = { PostgresTarget, UNIQUE_KEYS, q };

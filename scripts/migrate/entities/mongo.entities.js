'use strict';

/**
 * Mongo collection -> Postgres table mappings.
 *
 * Postgres is the contract: every mapping produces rows with Postgres column
 * names, built with the app's own flatteners (PgEventStore.buildRows,
 * PgAppStore._flat) so a migrated row is indistinguishable from a live one.
 *
 * Each entity:
 *   name, collection
 *   map(doc, ctx)          -> [{ table, rows, newerColumn? }]   (runs OUTSIDE the
 *                             transaction, because it may ALTER TABLE to add columns)
 *   load(db, writes, ctx)  -> optional custom write order (default: in order)
 *   verifyDoc(doc, ctx)    -> true if this source doc is fully present in Postgres
 *   counts(ctx)            -> { source, target, targetLabel }
 *
 * The order of this list matters: parents before children.
 */

const { categoryFor } = require('../../../src/collectService');
const { normalizeEvent } = require('../../../src/database/schema/event.schema');

const SOURCE = 'mongo';

// ---------------------------------------------------------------- helpers

const hex = (doc) => (doc._id && doc._id.toHexString ? doc._id.toHexString() : String(doc._id));
const idTime = (doc) => (doc._id && doc._id.getTimestamp ? doc._id.getTimestamp() : null);
const dateOr = (...vals) => {
  for (const v of vals) if (v != null) return v instanceof Date ? v : new Date(v);
  return null;
};

function required(doc, fields) {
  for (const f of fields) {
    if (doc[f] == null || doc[f] === '') throw new Error(`missing required field "${f}"`);
  }
}

/** Coerce + drop unknown columns for a PgAppStore table (same rules as live writes). */
function appRow(ctx, table, values) {
  const known = ctx.target.appStore.columns.get(table);
  const row = {};
  for (const [col, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (!known.has(col)) continue;
    row[col] = ctx.target.appStore._coerce(table, col, v);
  }
  return row;
}

async function flat(ctx, table, prefix, obj) {
  if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) return {};
  return ctx.target.appStore._flat(table, prefix, obj);
}

async function exists(ctx, sql, params) {
  const { rows } = await ctx.target.pool.query(`SELECT EXISTS(${sql}) AS ok`, params);
  return rows[0].ok;
}

// ---------------------------------------------------------------- SDK event collections

/**
 * login_events / session_events / payment_events.
 * Mongo: one document per (batch x phase) holding an `events` array.
 * Postgres: one row per event, one column per SDK field.
 *
 * Deterministic key: batch_id = "mongo:<collection>:<_id>", batch_seq = index
 * in the array. Same document -> same keys on every run, and the unique index
 * on (batch_id, batch_seq) rejects any repeat.
 */
function sdkEventEntity(collection, bucket) {
  const batchIdOf = (doc) => `mongo:${collection}:${hex(doc)}`;
  return {
    name: collection,
    collection,
    async map(doc, ctx) {
      required(doc, ['tenantId', 'sessionId']);
      const events = Array.isArray(doc.events) ? doc.events : [];
      const bad = events.findIndex((e) => !e || typeof e !== 'object' || Array.isArray(e));
      if (bad !== -1) throw new Error(`events[${bad}] is not an object`);

      const items = events.map((evt, i) => ({
        evt,
        bucket,
        seq: i,
        userId: evt.userId || doc.userId || null,
        category: categoryFor(evt.type || 'unknown_event'),
      }));
      const store = ctx.target.eventStore;
      const built = await store.buildRows(items, {
        tenantId: doc.tenantId,
        appId: doc.appId,
        sessionId: doc.sessionId,
        deviceFingerprint: doc.deviceFingerprint,
        clientIp: doc.clientIp,
        batchId: batchIdOf(doc),
      });
      const receivedAt = dateOr(doc.receivedAt, idTime(doc), new Date());
      const rows = built.map((r) => {
        const row = { ...r.envelope, received_at: receivedAt };
        for (const [col, v] of Object.entries(r.flat)) {
          if (store.columnTypes.has(col)) row[col] = store._coerce(col, v);
        }
        return row;
      });
      return [{ table: collection, rows, immutable: true }];
    },
    async verifyDoc(doc, ctx) {
      const n = Array.isArray(doc.events) ? doc.events.length : 0;
      const { rows } = await ctx.target.pool.query(
        `SELECT COUNT(*)::int AS n FROM "${collection}" WHERE batch_id = $1`, [batchIdOf(doc)]
      );
      return rows[0].n === n;
    },
    async counts(ctx) {
      const source = await ctx.source.aggregateCount(collection, [
        { $group: { _id: null, n: { $sum: { $size: { $ifNull: ['$events', []] } } } } },
      ]);
      const target = await ctx.target.count(
        `SELECT COUNT(*) AS n FROM "${collection}" WHERE batch_id LIKE $1`, [`mongo:${collection}:%`]
      );
      return { source, sourceLabel: 'events inside documents', target, targetLabel: 'migrated rows' };
    },
  };
}

// ---------------------------------------------------------------- entities

const entities = [
  // ---- sessions (Mongo `sessions`, _id = sessionId) -> xylium_sessions
  {
    name: 'sessions',
    collection: 'sessions',
    async map(doc) {
      required(doc, ['_id', 'tenantId']);
      const first = dateOr(doc.firstSeenAt, doc.createdAt, new Date());
      return [{
        table: 'xylium_sessions',
        newerColumn: 'last_seen_at',
        rows: [{
          session_id: String(doc._id),
          tenant_id: doc.tenantId,
          app_id: doc.appId ?? null,
          device_fingerprint: doc.deviceFingerprint ?? null,
          user_id: doc.userId ?? null,
          identified_by: doc.identifiedBy ?? null,
          phase: doc.phase || 'login',
          first_seen_at: first,
          last_seen_at: dateOr(doc.lastSeenAt, doc.updatedAt, first),
          logged_in_at: dateOr(doc.loggedInAt),
          logged_out_at: dateOr(doc.loggedOutAt),
          batch_count: Number.isFinite(doc.batchCount) ? Math.round(doc.batchCount) : 0,
          event_count: Number.isFinite(doc.eventCount) ? Math.round(doc.eventCount) : 0,
        }],
      }];
    },
    verifyDoc: (doc, ctx) => exists(ctx, 'SELECT 1 FROM xylium_sessions WHERE session_id = $1', [String(doc._id)]),
    async counts(ctx) {
      return { source: await ctx.source.count('sessions'), target: await ctx.target.count('SELECT COUNT(*) AS n FROM xylium_sessions'), targetLabel: 'total rows (includes live)' };
    },
  },

  // ---- behaviour_sessions (+ riskSummary.signals -> session_risk_signals)
  {
    name: 'behaviour_sessions',
    collection: 'behaviour_sessions',
    async map(doc, ctx) {
      required(doc, ['sessionId']);
      const s = doc.sessionSummary || {};
      const r = doc.riskSummary || {};
      const device = await flat(ctx, 'behaviour_sessions', 'device_meta', doc.deviceMetadata);
      const summary = await flat(ctx, 'behaviour_sessions', 'final_summary', s.finalSummary);
      const started = dateOr(doc.startedAt, doc.createdAt, idTime(doc), new Date());
      const session = appRow(ctx, 'behaviour_sessions', {
        session_id: doc.sessionId,
        tenant_id: doc.tenantId || 'default',
        client_id: doc.clientId ?? null,
        user_id: doc.userId ?? null,
        anonymous_id: doc.anonymousId ?? null,
        started_at: started,
        last_activity_at: dateOr(doc.lastActivityAt, started),
        ended_at: dateOr(doc.endedAt),
        status: doc.status || 'active',
        interaction_count: s.interactionCount ?? 0,
        page_count: s.pageCount ?? 0,
        max_scroll_depth: s.maxScrollDepth ?? 0,
        active_duration_ms: s.activeDurationMs ?? 0,
        payment_status: s.paymentStatus || 'none',
        device_category: s.deviceCategory || 'unknown',
        risk_score: r.riskScore ?? null,
        risk_level: r.riskLevel ?? null,
        risk_confidence: r.confidence ?? null,
        risk_evaluated_at: dateOr(r.evaluatedAt),
        linked_at: dateOr(doc.linkedAt),
        ip_address: doc.ipAddress ?? null,
        created_at: dateOr(doc.createdAt, started),
        updated_at: dateOr(doc.updatedAt, doc.createdAt, started),
        ...device,
        ...summary,
      });

      const signals = [];
      const list = Array.isArray(r.signals) ? r.signals : [];
      for (let i = 0; i < list.length; i++) {
        const sig = list[i] && typeof list[i] === 'object' ? list[i] : { description: String(list[i]) };
        const metric = await flat(ctx, 'session_risk_signals', 'metric', sig.metric);
        signals.push(appRow(ctx, 'session_risk_signals', {
          session_id: doc.sessionId,
          evaluated_at: dateOr(r.evaluatedAt, doc.updatedAt, started),
          signal_index: i,
          code: sig.code ?? null,
          severity: sig.severity ?? null,
          description: sig.description ?? null,
          ...metric,
        }));
      }
      return [
        { table: 'behaviour_sessions', rows: [session], newerColumn: 'updated_at' },
        { table: 'session_risk_signals', rows: signals, childOf: 'behaviour_sessions' },
      ];
    },
    /**
     * Signals belong to one risk evaluation. Only write them for sessions we
     * actually inserted (or overwrote in --mode newer); otherwise a session
     * that already exists in Postgres would get Mongo signals mixed into its
     * own evaluation.
     */
    async load(db, writes, ctx) {
      const sessions = writes.filter((w) => w.table === 'behaviour_sessions').flatMap((w) => w.rows);
      const signals = writes.filter((w) => w.table === 'session_risk_signals').flatMap((w) => w.rows);
      const res = await ctx.target.insertRows(db, 'behaviour_sessions', sessions, {
        onConflict: ctx.mode, newerColumn: 'updated_at', returning: 'session_id',
      });
      const written = new Set(res.returned);
      let sigWritten = 0;
      if (written.size) {
        if (ctx.mode === 'newer') {
          await db.query('DELETE FROM session_risk_signals WHERE session_id = ANY($1)', [[...written]]);
        }
        const r2 = await ctx.target.insertRows(db, 'session_risk_signals', signals.filter((s) => written.has(s.session_id)));
        sigWritten = r2.written;
      }
      return { written: res.written + sigWritten, attempted: sessions.length + signals.length };
    },
    verifyDoc: (doc, ctx) => exists(ctx, 'SELECT 1 FROM behaviour_sessions WHERE session_id = $1', [doc.sessionId]),
    async counts(ctx) {
      return { source: await ctx.source.count('behaviour_sessions'), target: await ctx.target.count('SELECT COUNT(*) AS n FROM behaviour_sessions'), targetLabel: 'total rows (includes live)' };
    },
  },

  // ---- network_intel  (unique: session_id + ip, same as Mongo)
  {
    name: 'network_intel',
    collection: 'network_intel',
    async map(doc, ctx) {
      required(doc, ['tenantId', 'sessionId', 'ip']);
      return [{
        table: 'network_intel',
        newerColumn: 'updated_at',
        rows: [appRow(ctx, 'network_intel', {
          tenant_id: doc.tenantId,
          app_id: doc.appId ?? null,
          session_id: doc.sessionId,
          user_id: doc.userId ?? null,
          ip: doc.ip,
          country: doc.country ?? null,
          timezone: doc.timezone ?? null,
          is_vpn: doc.isVpn ?? null,
          is_proxy: doc.isProxy ?? null,
          is_datacenter: doc.isDatacenter ?? null,
          is_tor: doc.isTor ?? null,
          is_new_country: doc.isNewCountry ?? null,
          evaluated_for_user_id: doc.evaluatedForUserId ?? null,
          provider: doc.provider ?? null,
          source: doc.source || 'migrated',
          created_at: dateOr(doc.createdAt, idTime(doc), new Date()),
          updated_at: dateOr(doc.updatedAt, doc.createdAt, idTime(doc), new Date()),
        })],
      }];
    },
    verifyDoc: (doc, ctx) => exists(ctx, 'SELECT 1 FROM network_intel WHERE session_id = $1 AND ip = $2', [doc.sessionId, doc.ip]),
    async counts(ctx) {
      return { source: await ctx.source.count('network_intel'), target: await ctx.target.count('SELECT COUNT(*) AS n FROM network_intel'), targetLabel: 'total rows (includes live)' };
    },
  },

  // ---- user_geo_history: Mongo keeps a `countries` array; Postgres has one row per country
  {
    name: 'user_geo_history',
    collection: 'user_geo_history',
    async map(doc, ctx) {
      required(doc, ['tenantId', 'userId']);
      // Mongo has no per-country time; the document's creation time is the best we have.
      const firstSeen = dateOr(doc.createdAt, idTime(doc), new Date());
      const countries = [...new Set((doc.countries || []).filter((c) => typeof c === 'string' && c))];
      return [{
        table: 'user_geo_history',
        immutable: true,
        rows: countries.map((country) => appRow(ctx, 'user_geo_history', {
          tenant_id: doc.tenantId, user_id: doc.userId, country, first_seen_at: firstSeen,
        })),
      }];
    },
    async verifyDoc(doc, ctx) {
      const countries = [...new Set((doc.countries || []).filter((c) => typeof c === 'string' && c))];
      if (!countries.length) return true;
      const { rows } = await ctx.target.pool.query(
        'SELECT COUNT(*)::int AS n FROM user_geo_history WHERE tenant_id = $1 AND user_id = $2 AND country = ANY($3)',
        [doc.tenantId, doc.userId, countries]
      );
      return rows[0].n === countries.length;
    },
    async counts(ctx) {
      const source = await ctx.source.aggregateCount('user_geo_history', [
        // $setUnion drops repeats inside one array, same as map() does
        { $group: { _id: null, n: { $sum: { $size: { $setUnion: [{ $ifNull: ['$countries', []] }, []] } } } } },
      ]);
      return { source, sourceLabel: 'countries inside documents', target: await ctx.target.count('SELECT COUNT(*) AS n FROM user_geo_history'), targetLabel: 'total rows (includes live)' };
    },
  },

  // ---- page_engagements
  {
    name: 'page_engagements',
    collection: 'page_engagements',
    async map(doc, ctx) {
      required(doc, ['pageViewId', 'sessionId']);
      const entry = dateOr(doc.entryTimestamp, doc.createdAt, idTime(doc), new Date());
      return [{
        table: 'page_engagements',
        newerColumn: 'updated_at',
        rows: [appRow(ctx, 'page_engagements', {
          page_view_id: doc.pageViewId,
          session_id: doc.sessionId,
          user_id: doc.userId ?? null,
          tenant_id: doc.tenantId || 'default',
          page_id: doc.pageId ?? null,
          sanitized_route: doc.sanitizedRoute || '/',
          entry_timestamp: entry,
          exit_timestamp: dateOr(doc.exitTimestamp),
          elapsed_duration_ms: doc.elapsedDurationMs ?? 0,
          active_duration_ms: doc.activeDurationMs ?? 0,
          visible_duration_ms: doc.visibleDurationMs ?? 0,
          idle_duration_ms: doc.idleDurationMs ?? 0,
          max_scroll_depth: doc.maxScrollDepth ?? 0,
          interaction_count: doc.interactionCount ?? 0,
          navigation_source: doc.navigationSource ?? null,
          exit_reason: doc.exitReason ?? null,
          created_at: dateOr(doc.createdAt, entry),
          updated_at: dateOr(doc.updatedAt, doc.createdAt, entry),
        })],
      }];
    },
    verifyDoc: (doc, ctx) => exists(ctx, 'SELECT 1 FROM page_engagements WHERE page_view_id = $1', [doc.pageViewId]),
    async counts(ctx) {
      return { source: await ctx.source.count('page_engagements'), target: await ctx.target.count('SELECT COUNT(*) AS n FROM page_engagements'), targetLabel: 'total rows (includes live)' };
    },
  },

  // ---- payment_records (+ metadata -> metadata_* columns)
  {
    name: 'payment_records',
    collection: 'payment_records',
    async map(doc, ctx) {
      required(doc, ['paymentId', 'status']);
      const meta = await flat(ctx, 'payment_records', 'metadata', doc.metadata);
      const created = dateOr(doc.createdAt, idTime(doc), new Date());
      return [{
        table: 'payment_records',
        newerColumn: 'updated_at',
        rows: [appRow(ctx, 'payment_records', {
          payment_id: doc.paymentId,
          order_id: doc.orderId ?? null,
          user_id: doc.userId ?? null,
          session_id: doc.sessionId ?? null,
          tenant_id: doc.tenantId || 'default',
          amount: doc.amount ?? null,
          currency: doc.currency || 'USD',
          status: doc.status,
          payment_method_category: doc.paymentMethodCategory || 'card',
          verified_at: dateOr(doc.verifiedAt),
          verified_by: doc.verifiedBy || 'server_callback',
          failure_reason: doc.failureReason ?? null,
          created_at: created,
          updated_at: dateOr(doc.updatedAt, created),
          ...meta,
        })],
      }];
    },
    verifyDoc: (doc, ctx) => exists(ctx, 'SELECT 1 FROM payment_records WHERE payment_id = $1', [doc.paymentId]),
    async counts(ctx) {
      return { source: await ctx.source.count('payment_records'), target: await ctx.target.count('SELECT COUNT(*) AS n FROM payment_records'), targetLabel: 'total rows (includes live)' };
    },
  },

  // ---- event_batches: batch INFO only. The events inside it are NOT copied
  // from here: Mongo also wrote them to login/session/payment_events, and
  // copying both would create every event twice.
  {
    name: 'event_batches',
    collection: 'event_batches',
    async map(doc, ctx) {
      required(doc, ['tenantId', 'sessionId']);
      return [{
        table: 'event_batches',
        immutable: true,
        rows: [appRow(ctx, 'event_batches', {
          batch_id: `mongo:event_batches:${hex(doc)}`,
          tenant_id: doc.tenantId,
          app_id: doc.appId ?? null,
          session_id: doc.sessionId,
          user_id: doc.userId ?? null,
          device_fingerprint: doc.deviceFingerprint ?? null,
          event_count: Number.isFinite(doc.eventCount) ? doc.eventCount : (doc.events || []).length,
          client_ip: doc.clientIp ?? null,
          received_at: dateOr(doc.receivedAt, idTime(doc), new Date()),
        })],
      }];
    },
    verifyDoc: (doc, ctx) => exists(ctx, 'SELECT 1 FROM event_batches WHERE batch_id = $1', [`mongo:event_batches:${hex(doc)}`]),
    async counts(ctx) {
      return { source: await ctx.source.count('event_batches'), target: await ctx.target.count(`SELECT COUNT(*) AS n FROM event_batches WHERE batch_id LIKE 'mongo:event_batches:%'`), targetLabel: 'migrated rows' };
    },
  },

  sdkEventEntity('login_events', 'login'),
  sdkEventEntity('session_events', 'session'),
  sdkEventEntity('payment_events', 'payment'),

  // ---- behaviour_events -> canonical `events` table (already keyed on tenant_id + event_id)
  {
    name: 'behaviour_events',
    collection: 'behaviour_events',
    async map(doc, ctx) {
      required(doc, ['eventId', 'sessionId']); // eventId MUST come from the source, never generated
      const e = normalizeEvent(doc);
      const params = ctx.target.adapter._getInsertParams(e);
      const cols = ctx.target.eventColumns;
      if (params.length !== cols.length) throw new Error('events column/param mismatch');
      const row = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      return [{ table: 'events', rows: [row], immutable: true }];
    },
    verifyDoc: (doc, ctx) => exists(ctx, 'SELECT 1 FROM events WHERE tenant_id = $1 AND event_id = $2', [doc.tenantId || 'default', doc.eventId]),
    async counts(ctx) {
      return { source: await ctx.source.count('behaviour_events'), target: await ctx.target.count('SELECT COUNT(*) AS n FROM events'), targetLabel: 'total rows (includes live)' };
    },
  },
];

module.exports = { SOURCE, entities };

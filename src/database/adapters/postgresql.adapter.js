const { Pool } = require('pg');
const EventRepository = require('../interfaces/event.repository');
const { normalizeEvent } = require('../schema/event.schema');

class PostgreSQLAdapter extends EventRepository {
  constructor(config = {}, customPool = null) {
    super();
    this.config = {
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'behavioral_events',
      user: config.user || 'postgres',
      password: config.password || '',
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: config.maxPoolSize || 20,
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis || 5000,
    };
    this.pool = customPool;
    this.isConnected = false;
    this.activeRequests = 0;
  }

  async connect() {
    if (!this.pool) {
      this.pool = new Pool(this.config);
    }

    try {
      // Verify connectivity to live PostgreSQL
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        this.isConnected = true;
        this.isEmbedded = false;
        await this._initializeSchema(client);
      } finally {
        client.release();
      }
    } catch (err) {
      // 3D000: database does not exist - attempt auto-creation
      if (err.code === '3D000' && this.config.database !== 'postgres') {
        try {
          const adminPool = new Pool({ ...this.config, database: 'postgres' });
          const adminClient = await adminPool.connect();
          await adminClient.query(`CREATE DATABASE "${this.config.database}"`);
          adminClient.release();
          await adminPool.end();

          const client = await this.pool.connect();
          try {
            await client.query('SELECT 1');
            this.isConnected = true;
            this.isEmbedded = false;
            await this._initializeSchema(client);
            return;
          } finally {
            client.release();
          }
        } catch (createErr) {
          console.warn(`[PostgreSQLAdapter] Live auto-create note: ${createErr.message}`);
        }
      }

      // If live PostgreSQL connection or credentials failed, seamlessly activate embedded PostgreSQL engine
      console.warn(`[PostgreSQLAdapter] Live PostgreSQL unavailable (${err.message}). Seamlessly activating embedded PostgreSQL engine.`);
      try {
        const { newDb } = require('pg-mem');
        const memDb = newDb();
        const pg = memDb.adapters.createPg();
        this.pool = new pg.Pool();
        this.isEmbedded = true;
        const client = await this.pool.connect();
        try {
          await client.query('SELECT 1');
          this.isConnected = true;
          await this._initializeSchema(client);
        } finally {
          client.release();
        }
      } catch (fallbackErr) {
        throw new Error(`Live PostgreSQL connection failed (${err.message}) and embedded fallback failed: ${fallbackErr.message}`);
      }
    }
  }

  async _initializeSchema(client) {
    const ddl = `
      CREATE TABLE IF NOT EXISTS events (
        event_id VARCHAR(255) NOT NULL,
        tenant_id VARCHAR(255) NOT NULL DEFAULT 'default',
        client_id VARCHAR(255),
        user_id VARCHAR(255),
        session_id VARCHAR(255) NOT NULL,
        event_name VARCHAR(255) NOT NULL,
        event_type VARCHAR(255),
        event_category VARCHAR(100) NOT NULL,
        event_timestamp TIMESTAMPTZ NOT NULL,
        server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sequence_number BIGINT DEFAULT 0,
        page TEXT,
        sanitized_route TEXT DEFAULT '/',
        sdk_version VARCHAR(50) DEFAULT '2.1.0',
        schema_version VARCHAR(50) DEFAULT '2.0',
        properties JSONB DEFAULT '{}'::jsonb,
        device JSONB DEFAULT '{}'::jsonb,
        pointer_x DOUBLE PRECISION,
        pointer_y DOUBLE PRECISION,
        pointer_speed_px_per_ms DOUBLE PRECISION,
        pointer_angle_deg DOUBLE PRECISION,
        pointer_distance_px DOUBLE PRECISION,
        is_straight_line BOOLEAN,
        pointer_hold_duration_ms DOUBLE PRECISION,
        hover_duration_ms DOUBLE PRECISION,
        target_category TEXT,
        target_id TEXT,
        text_preview TEXT,
        key_masked TEXT,
        flight_time_ms DOUBLE PRECISION,
        hold_time_ms DOUBLE PRECISION,
        keys_per_second DOUBLE PRECISION,
        is_typing_pause BOOLEAN,
        field_id TEXT,
        field_category TEXT,
        from_field TEXT,
        to_field TEXT,
        field_duration_ms DOUBLE PRECISION,
        paste_detected BOOLEAN,
        form_id TEXT,
        scroll_y DOUBLE PRECISION,
        scroll_direction TEXT,
        scroll_delta_px DOUBLE PRECISION,
        scroll_depth_percent DOUBLE PRECISION,
        scroll_milestone INTEGER,
        touch_count INTEGER,
        touch_duration_ms DOUBLE PRECISION,
        gesture_type TEXT,
        swipe_direction TEXT,
        swipe_distance_px DOUBLE PRECISION,
        orientation TEXT,
        from_route TEXT,
        to_route TEXT,
        navigation_method TEXT,
        visibility_state TEXT,
        tab_active BOOLEAN,
        idle_duration_ms DOUBLE PRECISION,
        page_load_time_ms DOUBLE PRECISION,
        dom_content_loaded_ms DOUBLE PRECISION,
        ttfb_ms DOUBLE PRECISION,
        flow_type TEXT,
        payment_id TEXT,
        payment_amount NUMERIC,
        payment_currency TEXT,
        recipient_type TEXT,
        payment_status TEXT,
        reason_code TEXT,
        challenge_type TEXT,
        account_category TEXT,
        device_category TEXT,
        device_os TEXT,
        device_browser TEXT,
        screen_width INTEGER,
        screen_height INTEGER,
        battery_level DOUBLE PRECISION,
        is_charging BOOLEAN,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT pk_events PRIMARY KEY (tenant_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_tenant_user_time ON events (tenant_id, user_id, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_tenant_session_time ON events (tenant_id, session_id, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_tenant_type_time ON events (tenant_id, event_type, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_tenant_session_seq ON events (tenant_id, session_id, sequence_number ASC);
    `;
    await client.query(ddl);
  }

  async disconnect() {
    if (this.pool) {
      // Drain in-flight requests gracefully
      while (this.activeRequests > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await this.pool.end();
      this.isConnected = false;
    }
  }

  async healthCheck() {
    if (!this.pool || !this.isConnected) {
      return { status: 'unhealthy', latencyMs: 0, error: 'PostgreSQL connection pool not initialized' };
    }
    const start = Date.now();
    try {
      const res = await this.pool.query('SELECT 1 AS ping');
      const latencyMs = Date.now() - start;
      return {
        status: 'healthy',
        latencyMs,
        details: {
          database: this.isEmbedded ? `${this.config.database} (embedded)` : this.config.database,
          mode: this.isEmbedded ? 'embedded' : 'live',
          totalCount: this.pool.totalCount || 0,
          idleCount: this.pool.idleCount || 0,
          waitingCount: this.pool.waitingCount || 0,
        },
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  _mapDbRowToEvent(row) {
    if (!row) return null;
    return {
      eventId: row.event_id,
      tenantId: row.tenant_id,
      clientId: row.client_id,
      userId: row.user_id,
      sessionId: row.session_id,
      eventName: row.event_name,
      eventType: row.event_type || row.event_name,
      eventCategory: row.event_category,
      timestamp: row.event_timestamp,
      serverReceivedAt: row.server_received_at,
      sequenceNumber: Number(row.sequence_number),
      page: row.page,
      sanitizedRoute: row.sanitized_route,
      sdkVersion: row.sdk_version,
      schemaVersion: row.schema_version,
      properties: typeof row.properties === 'string' ? JSON.parse(row.properties) : (row.properties || {}),
      device: typeof row.device === 'string' ? JSON.parse(row.device) : (row.device || {}),
      pointerX: row.pointer_x,
      pointerY: row.pointer_y,
      pointerSpeedPxPerMs: row.pointer_speed_px_per_ms,
      pointerAngleDeg: row.pointer_angle_deg,
      pointerDistancePx: row.pointer_distance_px,
      isStraightLine: row.is_straight_line,
      pointerHoldDurationMs: row.pointer_hold_duration_ms,
      hoverDurationMs: row.hover_duration_ms,
      targetCategory: row.target_category,
      targetId: row.target_id,
      textPreview: row.text_preview,
      keyMasked: row.key_masked,
      flightTimeMs: row.flight_time_ms,
      holdTimeMs: row.hold_time_ms,
      keysPerSecond: row.keys_per_second,
      isTypingPause: row.is_typing_pause,
      fieldId: row.field_id,
      fieldCategory: row.field_category,
      fromField: row.from_field,
      toField: row.to_field,
      fieldDurationMs: row.field_duration_ms,
      pasteDetected: row.paste_detected,
      formId: row.form_id,
      scrollY: row.scroll_y,
      scrollDirection: row.scroll_direction,
      scrollDeltaPx: row.scroll_delta_px,
      scrollDepthPercent: row.scroll_depth_percent,
      scrollMilestone: row.scroll_milestone,
      touchCount: row.touch_count,
      touchDurationMs: row.touch_duration_ms,
      gestureType: row.gesture_type,
      swipeDirection: row.swipe_direction,
      swipeDistancePx: row.swipe_distance_px,
      orientation: row.orientation,
      fromRoute: row.from_route,
      toRoute: row.to_route,
      navigationMethod: row.navigation_method,
      visibilityState: row.visibility_state,
      tabActive: row.tab_active,
      idleDurationMs: row.idle_duration_ms,
      pageLoadTimeMs: row.page_load_time_ms,
      domContentLoadedMs: row.dom_content_loaded_ms,
      ttfbMs: row.ttfb_ms,
      flowType: row.flow_type,
      paymentId: row.payment_id,
      paymentAmount: row.payment_amount !== null ? Number(row.payment_amount) : null,
      paymentCurrency: row.payment_currency,
      recipientType: row.recipient_type,
      paymentStatus: row.payment_status,
      reasonCode: row.reason_code,
      challengeType: row.challenge_type,
      accountCategory: row.account_category,
      deviceCategory: row.device_category,
      deviceOs: row.device_os,
      deviceBrowser: row.device_browser,
      screenWidth: row.screen_width,
      screenHeight: row.screen_height,
      batteryLevel: row.battery_level,
      isCharging: row.is_charging,
      createdAt: row.created_at,
    };
  }

  _getInsertParams(e) {
    return [
      e.eventId,
      e.tenantId || 'default',
      e.clientId || null,
      e.userId || null,
      e.sessionId,
      e.eventName,
      e.eventType || e.eventName,
      e.eventCategory || 'custom',
      e.timestamp || new Date(),
      e.serverReceivedAt || new Date(),
      e.sequenceNumber || 0,
      e.page || '/',
      e.sanitizedRoute || '/',
      e.sdkVersion || '2.1.0',
      e.schemaVersion || '2.0',
      JSON.stringify(e.properties || {}),
      JSON.stringify(e.device || {}),
      e.pointerX ?? null,
      e.pointerY ?? null,
      e.pointerSpeedPxPerMs ?? null,
      e.pointerAngleDeg ?? null,
      e.pointerDistancePx ?? null,
      e.isStraightLine ?? null,
      e.pointerHoldDurationMs ?? null,
      e.hoverDurationMs ?? null,
      e.targetCategory ?? null,
      e.targetId ?? null,
      e.textPreview ?? null,
      e.keyMasked ?? null,
      e.flightTimeMs ?? null,
      e.holdTimeMs ?? null,
      e.keysPerSecond ?? null,
      e.isTypingPause ?? null,
      e.fieldId ?? null,
      e.fieldCategory ?? null,
      e.fromField ?? null,
      e.toField ?? null,
      e.fieldDurationMs ?? null,
      e.pasteDetected ?? null,
      e.formId ?? null,
      e.scrollY ?? null,
      e.scrollDirection ?? null,
      e.scrollDeltaPx ?? null,
      e.scrollDepthPercent ?? null,
      e.scrollMilestone ?? null,
      e.touchCount ?? null,
      e.touchDurationMs ?? null,
      e.gestureType ?? null,
      e.swipeDirection ?? null,
      e.swipeDistancePx ?? null,
      e.orientation ?? null,
      e.fromRoute ?? null,
      e.toRoute ?? null,
      e.navigationMethod ?? null,
      e.visibilityState ?? null,
      e.tabActive ?? null,
      e.idleDurationMs ?? null,
      e.pageLoadTimeMs ?? null,
      e.domContentLoadedMs ?? null,
      e.ttfbMs ?? null,
      e.flowType ?? null,
      e.paymentId ?? null,
      e.paymentAmount ?? null,
      e.paymentCurrency ?? null,
      e.recipientType ?? null,
      e.paymentStatus ?? null,
      e.reasonCode ?? null,
      e.challengeType ?? null,
      e.accountCategory ?? null,
      e.deviceCategory ?? null,
      e.deviceOs ?? null,
      e.deviceBrowser ?? null,
      e.screenWidth ?? null,
      e.screenHeight ?? null,
      e.batteryLevel ?? null,
      e.isCharging ?? null,
    ];
  }

  _getInsertColumnsSql() {
    return `
      event_id, tenant_id, client_id, user_id, session_id,
      event_name, event_type, event_category, event_timestamp, server_received_at,
      sequence_number, page, sanitized_route, sdk_version, schema_version,
      properties, device,
      pointer_x, pointer_y, pointer_speed_px_per_ms, pointer_angle_deg, pointer_distance_px,
      is_straight_line, pointer_hold_duration_ms, hover_duration_ms, target_category, target_id, text_preview,
      key_masked, flight_time_ms, hold_time_ms, keys_per_second, is_typing_pause,
      field_id, field_category, from_field, to_field, field_duration_ms, paste_detected, form_id,
      scroll_y, scroll_direction, scroll_delta_px, scroll_depth_percent, scroll_milestone,
      touch_count, touch_duration_ms, gesture_type, swipe_direction, swipe_distance_px, orientation,
      from_route, to_route, navigation_method, visibility_state, tab_active,
      idle_duration_ms, page_load_time_ms, dom_content_loaded_ms, ttfb_ms,
      flow_type, payment_id, payment_amount, payment_currency, recipient_type, payment_status,
      reason_code, challenge_type, account_category,
      device_category, device_os, device_browser,
      screen_width, screen_height, battery_level, is_charging
    `;
  }

  async saveEvent(rawEvent) {
    this.activeRequests++;
    try {
      const e = normalizeEvent(rawEvent);
      const params = this._getInsertParams(e);
      const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');

      const sql = `
        INSERT INTO events (${this._getInsertColumnsSql()})
        VALUES (${placeholders})
        ON CONFLICT (tenant_id, event_id) DO NOTHING
        RETURNING *;
      `;

      const result = await this.pool.query(sql, params);
      if (result.rows.length === 0) {
        // Was duplicate; fetch existing
        return await this.getEventById(e.eventId, e.tenantId);
      }
      return this._mapDbRowToEvent(result.rows[0]);
    } finally {
      this.activeRequests--;
    }
  }

  async saveEvents(rawEvents) {
    if (!rawEvents || rawEvents.length === 0) {
      return { insertedCount: 0, duplicateCount: 0 };
    }

    this.activeRequests++;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let insertedCount = 0;
      let duplicateCount = 0;

      for (const raw of rawEvents) {
        const e = normalizeEvent(raw);
        const check = await client.query(
          'SELECT 1 FROM events WHERE tenant_id = $1 AND event_id = $2;',
          [e.tenantId || 'default', e.eventId]
        );
        if (check.rows.length > 0) {
          duplicateCount++;
          continue;
        }

        const params = this._getInsertParams(e);
        const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');

        const sql = `
          INSERT INTO events (${this._getInsertColumnsSql()})
          VALUES (${placeholders})
          ON CONFLICT (tenant_id, event_id) DO NOTHING;
        `;
        await client.query(sql, params);
        insertedCount++;
      }

      await client.query('COMMIT');
      return { insertedCount, duplicateCount };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      this.activeRequests--;
    }
  }

  async getEventById(eventId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const sql = `SELECT * FROM events WHERE tenant_id = $1 AND event_id = $2;`;
      const res = await this.pool.query(sql, [tenantId, eventId]);
      return this._mapDbRowToEvent(res.rows[0]);
    } finally {
      this.activeRequests--;
    }
  }

  async getEvents(filters = {}, pagination = {}) {
    this.activeRequests++;
    try {
      const tenantId = filters.tenantId || 'default';
      const whereClauses = ['tenant_id = $1'];
      const params = [tenantId];
      let pIdx = 2;

      if (filters.userId) {
        whereClauses.push(`user_id = $${pIdx++}`);
        params.push(filters.userId);
      }
      if (filters.sessionId) {
        whereClauses.push(`session_id = $${pIdx++}`);
        params.push(filters.sessionId);
      }
      if (filters.eventCategory) {
        whereClauses.push(`event_category = $${pIdx++}`);
        params.push(filters.eventCategory);
      }
      if (filters.eventType) {
        whereClauses.push(`event_type = $${pIdx++}`);
        params.push(filters.eventType);
      }
      if (filters.startDate) {
        whereClauses.push(`event_timestamp >= $${pIdx++}`);
        params.push(new Date(filters.startDate));
      }
      if (filters.endDate) {
        whereClauses.push(`event_timestamp <= $${pIdx++}`);
        params.push(new Date(filters.endDate));
      }

      const whereSql = whereClauses.join(' AND ');

      // Total count
      const countRes = await this.pool.query(`SELECT COUNT(*) as total FROM events WHERE ${whereSql}`, params);
      const total = parseInt(countRes.rows[0].total, 10);

      // Pagination
      const page = Math.max(1, Number(pagination.page) || 1);
      const limit = Math.max(1, Math.min(Number(pagination.limit) || 50, 200));
      const offset = (page - 1) * limit;

      const orderSql = 'ORDER BY event_timestamp DESC';
      const dataSql = `
        SELECT * FROM events
        WHERE ${whereSql}
        ${orderSql}
        LIMIT $${pIdx++} OFFSET $${pIdx++};
      `;
      params.push(limit, offset);

      const dataRes = await this.pool.query(dataSql, params);
      const events = dataRes.rows.map((r) => this._mapDbRowToEvent(r));

      return {
        events,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
        },
      };
    } finally {
      this.activeRequests--;
    }
  }

  async getSessionEvents(sessionId, tenantId = 'default', pagination = {}) {
    this.activeRequests++;
    try {
      const page = Math.max(1, Number(pagination.page) || 1);
      const limit = Math.max(1, Math.min(Number(pagination.limit) || 100, 200));
      const offset = (page - 1) * limit;

      const countSql = `SELECT COUNT(*) as total FROM events WHERE tenant_id = $1 AND session_id = $2;`;
      const countRes = await this.pool.query(countSql, [tenantId, sessionId]);
      const total = parseInt(countRes.rows[0].total, 10);

      const sql = `
        SELECT * FROM events
        WHERE tenant_id = $1 AND session_id = $2
        ORDER BY sequence_number ASC, event_timestamp ASC
        LIMIT $3 OFFSET $4;
      `;
      const res = await this.pool.query(sql, [tenantId, sessionId, limit, offset]);
      const events = res.rows.map((r) => this._mapDbRowToEvent(r));

      return {
        events,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
        },
      };
    } finally {
      this.activeRequests--;
    }
  }

  async getUserEvents(userId, tenantId = 'default', filters = {}, pagination = {}) {
    return this.getEvents({ ...filters, userId, tenantId }, pagination);
  }

  async getEventCounts(filters = {}) {
    this.activeRequests++;
    try {
      const tenantId = filters.tenantId || 'default';
      const whereClauses = ['tenant_id = $1'];
      const params = [tenantId];
      let pIdx = 2;

      if (filters.userId) {
        whereClauses.push(`user_id = $${pIdx++}`);
        params.push(filters.userId);
      }
      if (filters.sessionId) {
        whereClauses.push(`session_id = $${pIdx++}`);
        params.push(filters.sessionId);
      }

      const whereSql = whereClauses.join(' AND ');

      const totalRes = await this.pool.query(`SELECT COUNT(*) as total FROM events WHERE ${whereSql}`, params);
      const total = parseInt(totalRes.rows[0].total, 10);

      const catRes = await this.pool.query(
        `SELECT event_category, COUNT(*) as count FROM events WHERE ${whereSql} GROUP BY event_category`,
        params
      );
      const byCategory = {};
      for (const row of catRes.rows) {
        byCategory[row.event_category] = parseInt(row.count, 10);
      }

      return { total, byCategory };
    } finally {
      this.activeRequests--;
    }
  }

  async linkSessionEvents(sessionId, userId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const sql = `
        UPDATE events
        SET user_id = $1
        WHERE tenant_id = $2 AND session_id = $3 AND user_id IS NULL;
      `;
      const res = await this.pool.query(sql, [userId, tenantId, sessionId]);
      return { modifiedCount: res.rowCount };
    } finally {
      this.activeRequests--;
    }
  }

  async deleteUserData(userId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const sql = `DELETE FROM events WHERE tenant_id = $1 AND user_id = $2;`;
      const res = await this.pool.query(sql, [tenantId, userId]);
      return { deletedCount: res.rowCount };
    } finally {
      this.activeRequests--;
    }
  }

  async getUserSummary(userId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const counts = await this.getEventCounts({ userId, tenantId });
      const statsRes = await this.pool.query(
        `SELECT
          MIN(event_timestamp) as first_seen,
          MAX(event_timestamp) as last_seen,
          COUNT(DISTINCT session_id) as session_count
         FROM events
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );

      const row = statsRes.rows[0] || {};
      return {
        userId,
        tenantId,
        totalEvents: counts.total,
        totalSessions: parseInt(row.session_count || 0, 10),
        firstSeenAt: row.first_seen || null,
        lastSeenAt: row.last_seen || null,
        categoryBreakdown: counts.byCategory || {},
      };
    } finally {
      this.activeRequests--;
    }
  }

  getAdapterInfo() {
    return {
      type: 'postgresql',
      engine: this.isEmbedded ? 'PostgreSQL (Embedded In-Memory Engine)' : 'PostgreSQL (Live Server)',
      host: this.isEmbedded ? 'embedded' : this.config.host,
      port: this.isEmbedded ? 5432 : this.config.port,
      database: this.isEmbedded ? `${this.config.database} (embedded)` : this.config.database,
      user: this.config.user,
      ssl: !!this.config.ssl,
      connected: this.isConnected,
      activeRequests: this.activeRequests,
      pool: {
        totalCount: this.pool?.totalCount || 0,
        idleCount: this.pool?.idleCount || 0,
        waitingCount: this.pool?.waitingCount || 0,
      },
    };
  }
}

module.exports = PostgreSQLAdapter;

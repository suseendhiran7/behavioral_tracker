const mongoose = require('mongoose');
const EventRepository = require('../interfaces/event.repository');
const { normalizeEvent } = require('../schema/event.schema');
const BehaviourEvent = require('../../models/BehaviourEvent');

class MongoDBAdapter extends EventRepository {
  constructor(config = {}, connection = undefined) {
    super();
    this.config = {
      uri: config.uri || 'mongodb://localhost:27017/xylium',
      database: config.database || 'xylium',
      maxPoolSize: config.maxPoolSize || 20,
      minPoolSize: config.minPoolSize || 2,
      serverSelectionTimeoutMS: config.serverSelectionTimeoutMS || 5000,
      socketTimeoutMS: config.socketTimeoutMS || 30000,
    };
    if (connection !== undefined) {
      this.connection = connection;
      this.isDedicated = true;
    } else {
      this.connection = mongoose.connection;
      this.isDedicated = false;
    }
    this.isConnected = this.connection ? this.connection.readyState === 1 : false;
    this.activeRequests = 0;
  }

  async connect() {
    if (this.connection && this.connection.readyState === 1) {
      this.isConnected = true;
      await this._ensureIndexes();
      return;
    }

    if (this.isDedicated && !this.connection) {
      this.connection = await mongoose.createConnection(this.config.uri, {
        maxPoolSize: this.config.maxPoolSize,
        minPoolSize: this.config.minPoolSize,
        serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMS,
        socketTimeoutMS: this.config.socketTimeoutMS,
      }).asPromise();
    } else if (!this.connection || this.connection.readyState !== 1) {
      await mongoose.connect(this.config.uri, {
        maxPoolSize: this.config.maxPoolSize,
        minPoolSize: this.config.minPoolSize,
        serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMS,
        socketTimeoutMS: this.config.socketTimeoutMS,
      });
      this.connection = mongoose.connection;
    }

    this.isConnected = true;
    await this._ensureIndexes();
  }

  async _ensureIndexes() {
    try {
      const col = this._getCollection();
      await col.createIndex({ tenantId: 1, eventId: 1 }, { unique: true });
      await col.createIndex({ tenantId: 1, userId: 1, timestamp: -1 });
      await col.createIndex({ tenantId: 1, sessionId: 1, timestamp: -1 });
      await col.createIndex({ tenantId: 1, eventType: 1, timestamp: -1 });
      await col.createIndex({ tenantId: 1, sessionId: 1, sequenceNumber: 1 });
    } catch (e) {
      console.warn('[MongoDBAdapter] Index initialization note:', e.message);
    }
  }

  _getCollection() {
    if (this.connection && this.connection.db) {
      return this.connection.db.collection('behaviour_events');
    }
    return BehaviourEvent.collection;
  }

  async disconnect() {
    while (this.activeRequests > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.isDedicated && this.connection) {
      await this.connection.close();
    } else if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    this.isConnected = false;
  }

  async healthCheck() {
    const conn = this.isDedicated ? this.connection : (this.connection || mongoose.connection);
    if (!conn || conn.readyState !== 1) {
      return { status: 'unhealthy', latencyMs: 0, error: 'MongoDB connection not open' };
    }
    const start = Date.now();
    try {
      const db = conn.db;
      if (!db) {
        throw new Error('Database object not available');
      }
      await db.command({ ping: 1 });
      const latencyMs = Date.now() - start;
      return {
        status: 'healthy',
        latencyMs,
        details: {
          database: db.databaseName,
          readyState: conn.readyState,
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

  _mapDocToEvent(doc) {
    if (!doc) return null;
    const { _id, __v, ...rest } = doc;
    return {
      ...rest,
      properties: rest.properties || {},
      device: rest.device || {},
    };
  }

  async saveEvent(rawEvent) {
    this.activeRequests++;
    try {
      const doc = normalizeEvent(rawEvent);
      const col = this._getCollection();

      await col.updateOne(
        { tenantId: doc.tenantId, eventId: doc.eventId },
        { $setOnInsert: doc },
        { upsert: true }
      );

      return doc;
    } finally {
      this.activeRequests--;
    }
  }

  async saveEvents(rawEvents) {
    if (!rawEvents || rawEvents.length === 0) {
      return { insertedCount: 0, duplicateCount: 0 };
    }

    this.activeRequests++;
    try {
      const col = this._getCollection();
      const ops = rawEvents.map((raw) => {
        const doc = normalizeEvent(raw);
        return {
          updateOne: {
            filter: { tenantId: doc.tenantId, eventId: doc.eventId },
            update: { $setOnInsert: doc },
            upsert: true,
          },
        };
      });

      const res = await col.bulkWrite(ops, { ordered: false });
      const insertedCount = (res.upsertedCount || 0) + (res.insertedCount || 0);
      const duplicateCount = rawEvents.length - insertedCount;
      return { insertedCount, duplicateCount };
    } finally {
      this.activeRequests--;
    }
  }

  async getEventById(eventId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const col = this._getCollection();
      const doc = await col.findOne({ tenantId, eventId });
      return this._mapDocToEvent(doc);
    } finally {
      this.activeRequests--;
    }
  }

  async getEvents(filters = {}, pagination = {}) {
    this.activeRequests++;
    try {
      const tenantId = filters.tenantId || 'default';
      const query = { tenantId };

      if (filters.userId) query.userId = filters.userId;
      if (filters.sessionId) query.sessionId = filters.sessionId;
      if (filters.eventCategory) query.eventCategory = filters.eventCategory;
      if (filters.eventType) {
        query.$or = [{ eventType: filters.eventType }, { eventName: filters.eventType }];
      }
      if (filters.startDate || filters.endDate) {
        query.timestamp = {};
        if (filters.startDate) query.timestamp.$gte = new Date(filters.startDate);
        if (filters.endDate) query.timestamp.$lte = new Date(filters.endDate);
      }

      const page = Math.max(1, Number(pagination.page) || 1);
      const limit = Math.max(1, Math.min(Number(pagination.limit) || 50, 200));
      const skip = (page - 1) * limit;

      const col = this._getCollection();
      const [docs, total] = await Promise.all([
        col.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
        col.countDocuments(query),
      ]);

      const events = docs.map((d) => this._mapDocToEvent(d));

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
      const query = { tenantId, sessionId };
      const page = Math.max(1, Number(pagination.page) || 1);
      const limit = Math.max(1, Math.min(Number(pagination.limit) || 100, 200));
      const skip = (page - 1) * limit;

      const col = this._getCollection();
      const [docs, total] = await Promise.all([
        col.find(query).sort({ sequenceNumber: 1, timestamp: 1 }).skip(skip).limit(limit).toArray(),
        col.countDocuments(query),
      ]);

      const events = docs.map((d) => this._mapDocToEvent(d));

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
      const match = { tenantId };
      if (filters.userId) match.userId = filters.userId;
      if (filters.sessionId) match.sessionId = filters.sessionId;

      const col = this._getCollection();
      const [total, catAgg] = await Promise.all([
        col.countDocuments(match),
        col.aggregate([
          { $match: match },
          { $group: { _id: '$eventCategory', count: { $sum: 1 } } },
        ]).toArray(),
      ]);

      const byCategory = {};
      for (const item of catAgg) {
        if (item._id) byCategory[item._id] = item.count;
      }

      return { total, byCategory };
    } finally {
      this.activeRequests--;
    }
  }

  async linkSessionEvents(sessionId, userId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const col = this._getCollection();
      const res = await col.updateMany(
        { tenantId, sessionId, userId: null },
        { $set: { userId } }
      );
      return { modifiedCount: res.modifiedCount };
    } finally {
      this.activeRequests--;
    }
  }

  async deleteUserData(userId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const col = this._getCollection();
      const res = await col.deleteMany({ tenantId, userId });
      return { deletedCount: res.deletedCount };
    } finally {
      this.activeRequests--;
    }
  }

  async getUserSummary(userId, tenantId = 'default') {
    this.activeRequests++;
    try {
      const col = this._getCollection();
      const counts = await this.getEventCounts({ userId, tenantId });

      const stats = await col.aggregate([
        { $match: { tenantId, userId } },
        {
          $group: {
            _id: null,
            firstSeen: { $min: '$timestamp' },
            lastSeen: { $max: '$timestamp' },
            sessions: { $addToSet: '$sessionId' },
          },
        },
      ]).toArray();

      const summary = stats[0] || {};

      return {
        userId,
        tenantId,
        totalEvents: counts.total,
        totalSessions: summary.sessions ? summary.sessions.length : 0,
        firstSeenAt: summary.firstSeen || null,
        lastSeenAt: summary.lastSeen || null,
        categoryBreakdown: counts.byCategory || {},
      };
    } finally {
      this.activeRequests--;
    }
  }

  getAdapterInfo() {
    return {
      type: 'mongodb',
      uri: this.config.uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+(@)/, '$1******$2'),
      database: this.config.database,
      connected: this.isConnected,
      activeRequests: this.activeRequests,
      readyState: this.connection ? this.connection.readyState : 0,
    };
  }
}

module.exports = MongoDBAdapter;

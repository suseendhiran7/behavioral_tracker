'use strict';

/**
 * MongoDB source.
 *
 * Every source connector implements the same small interface, so supporting
 * a new database later (MySQL, another Postgres, ...) means writing one new
 * file like this one plus its entity mappings; the Postgres side never changes.
 *
 *   connect() / close()
 *   readBatch(collection, afterKey, limit) -> { docs, lastKey }
 *       keyset pagination: "give me the next N records after this key",
 *       never skip/offset (offset gets slower on every page at lakhs of rows)
 *   count(collection, filter)
 *   aggregateCount(collection, pipeline)
 *   encodeKey(key) / decodeKey(text, type) -> store the resume point as text
 */

const mongoose = require('mongoose');

class MongoSource {
  constructor({ uri, database }) {
    this.uri = uri;
    this.database = database;
    this.name = 'mongo';
  }

  async connect() {
    this.conn = await mongoose.createConnection(this.uri, {
      dbName: this.database,
      serverSelectionTimeoutMS: 10000,
      // Read from a secondary when there is one, to keep load off the live primary.
      readPreference: 'secondaryPreferred',
    }).asPromise();
    this.db = this.conn.db;
  }

  async close() {
    if (this.conn) await this.conn.close();
  }

  async collectionExists(name) {
    const found = await this.db.listCollections({ name }, { nameOnly: true }).toArray();
    return found.length > 0;
  }

  async readBatch(collection, afterKey, limit) {
    const filter = afterKey == null ? {} : { _id: { $gt: afterKey } };
    const docs = await this.db.collection(collection)
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return { docs, lastKey: docs.length ? docs[docs.length - 1]._id : afterKey };
  }

  async count(collection, filter = {}) {
    return this.db.collection(collection).countDocuments(filter);
  }

  async aggregateCount(collection, pipeline) {
    const res = await this.db.collection(collection).aggregate(pipeline, { allowDiskUse: true }).toArray();
    return res.length ? Number(res[0].n) : 0;
  }

  /** Random documents, used by --verify to spot-check that records really landed. */
  async sample(collection, n) {
    return this.db.collection(collection).aggregate([{ $sample: { size: n } }]).toArray();
  }

  idOf(doc) {
    return this.encodeKey(doc._id).key;
  }

  encodeKey(key) {
    if (key == null) return { key: null, type: null };
    if (key instanceof mongoose.Types.ObjectId || key?._bsontype === 'ObjectId') {
      return { key: key.toHexString(), type: 'objectid' };
    }
    if (typeof key === 'number') return { key: String(key), type: 'number' };
    return { key: String(key), type: 'string' };
  }

  decodeKey(text, type) {
    if (text == null) return null;
    if (type === 'objectid') return new mongoose.Types.ObjectId(text);
    if (type === 'number') return Number(text);
    return text;
  }
}

module.exports = MongoSource;

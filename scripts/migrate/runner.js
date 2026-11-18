'use strict';

/**
 * Source-agnostic migration loop.
 *
 *   read N records after the bookmark  ->  map to Postgres rows
 *   ->  ONE transaction: insert rows (ON CONFLICT) + move the bookmark  ->  repeat
 *
 * If a batch fails, it is retried one record at a time so a single bad record
 * goes to migration_rejects instead of stopping the whole run.
 */

class Runner {
  constructor({ source, target, entities, sourceName, opts, log = console.log }) {
    this.source = source;
    this.target = target;
    this.entities = entities;
    this.sourceName = sourceName;
    this.opts = opts;
    this.log = log;
    this.stopping = false;
    this.ctx = { source, target, mode: opts.mode };
  }

  requestStop() {
    if (!this.stopping) this.log('\nStop requested: finishing the current batch, then exiting. Run again to resume.');
    this.stopping = true;
  }

  selected() {
    if (!this.opts.only.length) return this.entities;
    const names = new Set(this.entities.map((e) => e.name));
    for (const n of this.opts.only) if (!names.has(n)) throw new Error(`Unknown entity "${n}". Known: ${[...names].join(', ')}`);
    return this.entities.filter((e) => this.opts.only.includes(e.name));
  }

  // ---------------------------------------------------------------- migrate

  async migrateAll() {
    const list = this.selected();
    const queue = [...list];
    const results = [];
    const workers = Array.from({ length: Math.max(1, this.opts.parallel) }, async () => {
      while (queue.length && !this.stopping) {
        const entity = queue.shift();
        results.push(await this.migrateEntity(entity));
      }
    });
    await Promise.all(workers);
    return results;
  }

  async migrateEntity(entity) {
    const { source, target, sourceName, opts } = this;
    const tag = `[${entity.name}]`;

    if (!(await source.collectionExists(entity.collection))) {
      this.log(`${tag} source "${entity.collection}" not found, skipping`);
      return { entity: entity.name, skipped: true };
    }
    if (opts.reset) await target.resetCheckpoint(sourceName, entity.name);

    const cp = await target.getCheckpoint(sourceName, entity.name);
    let after = cp ? source.decodeKey(cp.last_key, cp.last_key_type) : null;
    const totals = { docsRead: 0, inserted: 0, skipped: 0, rejected: 0 };
    const total = await source.count(entity.collection).catch(() => null);
    this.log(`${tag} start${cp ? ` (resuming after ${cp.last_key})` : ''}; ${total ?? '?'} source records`);
    const t0 = Date.now();

    while (!this.stopping) {
      const { docs, lastKey } = await source.readBatch(entity.collection, after, opts.batch);
      if (!docs.length) break;

      // 1. map (outside the transaction: may add new columns with ALTER TABLE)
      const mapped = [];
      let rejected = 0;
      for (const doc of docs) {
        try {
          mapped.push({ doc, writes: await entity.map(doc, this.ctx) });
        } catch (err) {
          rejected++;
          if (!opts.dryRun) await target.reject(sourceName, entity.name, source.idOf(doc), `map: ${err.message}`, doc);
          else this.log(`${tag} would reject ${source.idOf(doc)}: ${err.message}`);
        }
      }

      // 2. write + bookmark in one transaction
      const { key, type } = source.encodeKey(lastKey);
      const delta = { docsRead: docs.length, inserted: 0, skipped: 0, rejected };
      const ok = await this.tx(async (db) => {
        const r = await this.load(db, entity, mapped.flatMap((m) => m.writes));
        delta.inserted += r.written;
        delta.skipped += r.attempted - r.written;
        if (!opts.dryRun) await target.saveCheckpoint(db, sourceName, entity.name, key, type, delta);
      });

      // 3. batch failed -> retry record by record, reject only the bad ones
      if (!ok.success) {
        this.log(`${tag} batch failed (${ok.error.message}); retrying one record at a time`);
        delta.inserted = 0;
        delta.skipped = 0;
        for (const m of mapped) {
          const one = await this.tx(async (db) => {
            const r = await this.load(db, entity, m.writes);
            delta.inserted += r.written;
            delta.skipped += r.attempted - r.written;
          });
          if (!one.success) {
            delta.rejected++;
            if (!opts.dryRun) await target.reject(sourceName, entity.name, source.idOf(m.doc), `insert: ${one.error.message}`, m.doc);
          }
        }
        if (!opts.dryRun) await this.tx((db) => target.saveCheckpoint(db, sourceName, entity.name, key, type, delta));
      }

      for (const k of Object.keys(totals)) totals[k] += delta[k];
      after = lastKey;
      const secs = (Date.now() - t0) / 1000;
      this.log(`${tag} read ${totals.docsRead}${total ? `/${total}` : ''} | inserted ${totals.inserted} | ` +
        `already present ${totals.skipped} | rejected ${totals.rejected} | ${Math.round(totals.docsRead / Math.max(secs, 0.001))} docs/s`);
      if (docs.length < opts.batch) break;
    }

    if (!opts.dryRun && !this.stopping) {
      await this.tx((db) => target.saveCheckpoint(db, sourceName, entity.name, null, null, {}, 'done'));
    }
    this.log(`${tag} ${this.stopping ? 'paused' : 'finished'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { entity: entity.name, ...totals };
  }

  async load(db, entity, writes) {
    if (entity.load) return entity.load(db, writes, this.ctx);
    let written = 0;
    let attempted = 0;
    // group rows per table, keeping first-seen table order (parents first)
    const groups = new Map();
    for (const w of writes) {
      if (!groups.has(w.table)) groups.set(w.table, { ...w, rows: [] });
      groups.get(w.table).rows.push(...w.rows);
    }
    for (const g of groups.values()) {
      const r = await this.target.insertRows(db, g.table, g.rows, {
        onConflict: g.immutable ? 'skip' : this.ctx.mode,
        newerColumn: g.newerColumn,
      });
      written += r.written;
      attempted += g.rows.length;
    }
    return { written, attempted };
  }

  /** Run fn in a transaction. In --dry-run everything is rolled back. */
  async tx(fn) {
    const client = await this.target.pool.connect();
    try {
      await client.query('BEGIN');
      await fn(client);
      await client.query(this.opts.dryRun ? 'ROLLBACK' : 'COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return { success: false, error };
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- verify

  async verify(sampleSize = 500) {
    let healthy = true;
    this.log('Counts and spot checks');
    for (const entity of this.selected()) {
      if (!(await this.source.collectionExists(entity.collection))) continue;
      const c = await entity.counts(this.ctx);
      const { rows: rej } = await this.target.pool.query(
        'SELECT source_id FROM migration_rejects WHERE source = $1 AND entity = $2', [this.sourceName, entity.name]
      );
      const rejectedIds = new Set(rej.map((r) => r.source_id));

      // spot check: random source records must exist in Postgres (rejected ones are listed separately)
      const sample = (await this.source.sample(entity.collection, sampleSize))
        .filter((d) => !rejectedIds.has(this.source.idOf(d)));
      const missing = [];
      for (const doc of sample) {
        if (!(await entity.verifyDoc(doc, this.ctx))) missing.push(this.source.idOf(doc));
      }

      // counts: "migrated rows" can be compared exactly; tables shared with live traffic can only be >=
      const exact = c.targetLabel === 'migrated rows';
      const countOk = exact ? c.target === c.source : c.target >= c.source;
      let status = 'OK  ';
      let note = '';
      if (missing.length) status = 'FAIL';
      else if (!countOk && rejectedIds.size) { status = 'WARN'; note = ' -> difference comes from rejected records, review migration_rejects'; }
      else if (!countOk) status = 'FAIL';
      if (status === 'FAIL') healthy = false;

      this.log(`  ${status} ${entity.name}: source ${c.source}${c.sourceLabel ? ` (${c.sourceLabel})` : ''}, ` +
        `postgres ${c.target} (${c.targetLabel}), rejected ${rejectedIds.size}, ` +
        `spot check ${sample.length - missing.length}/${sample.length} found` +
        (missing.length ? `; missing e.g. ${missing.slice(0, 5).join(', ')}` : '') + note);
    }

    this.log('Duplicate check (must be zero everywhere)');
    for (const d of await this.target.duplicateReport()) {
      if (d.error) { this.log(`  skip ${d.table}: ${d.error.split('\n')[0]}`); continue; }
      if (d.duplicates.length) healthy = false;
      this.log(`  ${d.duplicates.length ? 'FAIL' : 'OK  '} ${d.table} (${d.key.join(', ')})` +
        (d.duplicates.length ? `: ${d.duplicates.length}+ duplicated keys, e.g. ${JSON.stringify(d.duplicates[0])}` : ''));
    }
    return healthy;
  }
}

module.exports = Runner;

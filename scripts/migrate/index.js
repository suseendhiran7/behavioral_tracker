#!/usr/bin/env node
'use strict';

/**
 * Migrate data from another database into the PostgreSQL schema.
 *
 *   node scripts/migrate                        migrate everything from Mongo
 *   node scripts/migrate --only payment_records  one or more entities (comma separated)
 *   node scripts/migrate --dry-run              map + insert inside a rolled-back transaction
 *   node scripts/migrate --verify               counts, spot checks, duplicate check
 *   node scripts/migrate --report-duplicates    list duplicates already in Postgres
 *
 * Options:
 *   --source mongo        which source connector (see sources/index.js)
 *   --batch 2000          records read per batch / per transaction
 *   --mode skip|newer     what to do when a row already exists in Postgres:
 *                           skip  (default) keep the Postgres row, never overwrite
 *                           newer overwrite only if the source row is newer (updated_at)
 *                         Either way a duplicate row can never be created.
 *   --reset               forget the bookmark and re-read from the start (still no duplicates)
 *   --parallel 1          entities migrated at the same time
 *   --sample 500          records spot-checked per entity in --verify
 *
 * Connection settings come from the same .env as the app
 * (MONGO_URI / MONGODB_DATABASE, POSTGRES_HOST / _PORT / _DATABASE / _USER / _PASSWORD / _SSL).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { loadDatabaseConfig } = require('../../src/config/database.config');
const { PostgresTarget } = require('./target/postgres');
const sources = require('./sources');
const Runner = require('./runner');

function parseArgs(argv) {
  const opts = {
    source: 'mongo', batch: 2000, mode: 'skip', only: [], parallel: 1, sample: 500,
    reset: false, dryRun: false, verify: false, reportDuplicates: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (a.includes('=')) return a.split('=').slice(1).join('=');
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const flag = a.split('=')[0];
    switch (flag) {
      case '--source': opts.source = val(); break;
      case '--batch': opts.batch = parseInt(val(), 10); break;
      case '--mode': opts.mode = val(); break;
      case '--only': opts.only = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--parallel': opts.parallel = parseInt(val(), 10); break;
      case '--sample': opts.sample = parseInt(val(), 10); break;
      case '--reset': opts.reset = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--verify': opts.verify = true; break;
      case '--report-duplicates': opts.reportDuplicates = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`Unknown option ${a}`);
    }
  }
  if (!['skip', 'newer'].includes(opts.mode)) throw new Error('--mode must be skip or newer');
  if (!(opts.batch > 0 && opts.batch <= 50000)) throw new Error('--batch must be 1..50000');
  if (!sources[opts.source]) throw new Error(`Unknown --source "${opts.source}". Known: ${Object.keys(sources).join(', ')}`);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, ''));
    return 0;
  }

  const dbConfig = loadDatabaseConfig();
  const target = new PostgresTarget(dbConfig.postgresql);
  const sourceDef = sources[opts.source];
  const source = sourceDef.create(dbConfig);

  console.log(`Connecting: ${opts.source} -> postgres ${dbConfig.postgresql.host}:${dbConfig.postgresql.port}/${dbConfig.postgresql.database}`);
  await target.connect();
  await source.connect();
  const runner = new Runner({ source, target, entities: sourceDef.entities(), sourceName: opts.source, opts });
  process.on('SIGINT', () => runner.requestStop());
  process.on('SIGTERM', () => runner.requestStop());

  try {
    if (opts.reportDuplicates) {
      for (const d of await target.duplicateReport(100)) {
        if (d.error || !d.duplicates.length) continue;
        console.log(`\n${d.table} (${d.key.join(', ')}):`);
        console.table(d.duplicates);
      }
      return 0;
    }

    await target.prepareBookkeeping();
    if (opts.verify) return (await runner.verify(opts.sample)) ? 0 : 1;

    console.log('Checking unique keys in Postgres');
    await target.prepareConstraints();
    if (opts.dryRun) console.log('DRY RUN: every transaction is rolled back, nothing is saved');

    const results = await runner.migrateAll();
    console.log('\nSummary');
    console.table(results.filter((r) => !r.skipped));
    console.log(runner.stopping ? 'Paused. Run the same command again to resume.' : 'Done. Run with --verify to check the result.');
    return 0;
  } finally {
    await source.close().catch(() => {});
    await target.close().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});

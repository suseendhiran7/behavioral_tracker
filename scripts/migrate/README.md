# Data migration into PostgreSQL

Copies data from another database (today: MongoDB) into this app's PostgreSQL
tables. Postgres is the original schema; every source is mapped to its columns.

## Why there can be no duplicates

1. Every target table has a unique key. Four tables had none, so the tool adds them
   (`login_events`, `session_events`, `payment_events` on `(batch_id, batch_seq)`,
   `session_risk_signals` on `(session_id, signal_index)`).
2. Every record gets a fixed key from the source, e.g. `batch_id = mongo:login_events:<_id>`.
   Same record -> same key on every run.
3. Every insert is `INSERT ... ON CONFLICT DO NOTHING`, so Postgres itself refuses a repeat.

So you can stop it, crash it, or run it again as many times as you like.

## How to run

Uses the same `.env` as the app (`MONGO_URI`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, ...).

```bash
# 0. take a Postgres backup first

# 1. try it: everything is rolled back, nothing is saved
npm run migrate -- --dry-run

# 2. real run (Ctrl+C is safe: it finishes the current batch, run again to resume)
npm run migrate

# 3. check: counts, random spot checks, duplicate check
npm run migrate -- --verify
```

Other options: `--only payment_records,login_events`, `--batch 5000`, `--parallel 3`,
`--reset` (re-read from the start), `--mode newer` (see below), `--report-duplicates`.

## Switching the app over

1. Run the migration while the app still writes to Mongo (bulk copy, can take a while).
2. Switch the app to Postgres.
3. Run `npm run migrate` once more: it picks up only the documents added since the
   last run (it remembers where it stopped in `migration_checkpoints`).
4. Run `npm run migrate -- --verify`.

Note: a document that was CHANGED in Mongo after it was copied is not copied again.
If that matters (e.g. sessions/payments updated late), run step 3 as
`npm run migrate -- --reset --mode newer`: it re-reads everything and overwrites a
Postgres row only when the Mongo copy has a newer `updated_at`. It still never
creates a duplicate and never overwrites newer live data.

## Bad records

A record that cannot be mapped or inserted does not stop the run. It is saved in
`migration_rejects` with the reason. Fix the data and run `--reset` to retry.

## What is copied

| Mongo collection | Postgres table |
|---|---|
| sessions | xylium_sessions |
| behaviour_sessions | behaviour_sessions + session_risk_signals |
| network_intel | network_intel |
| user_geo_history | user_geo_history (one row per country) |
| page_engagements | page_engagements |
| payment_records | payment_records |
| event_batches | event_batches (batch info only, see below) |
| login_events / session_events / payment_events | same names, one row per event |
| behaviour_events | events |

`event_batches` in Mongo also holds the events, but the same events are in
`login_events` / `session_events` / `payment_events`. They are copied only from
there, otherwise every event would be stored twice.

## Adding another source database later

1. `sources/<name>.source.js` - same methods as `mongo.source.js`
   (`connect`, `readBatch`, `count`, `encodeKey`/`decodeKey`, ...).
2. `entities/<name>.entities.js` - map each table/collection to Postgres columns.
3. Register it in `sources/index.js`, run with `--source <name>`.

The Postgres side (`target/postgres.js`, `runner.js`) does not change.

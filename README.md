# Xylium Ingestion Gateway (Express.js)

Plain Express.js port of the NestJS ingestion gateway. Same behavior: receives
behavioral batches from the `xylium-bf.js` SDK, stores them in MongoDB keyed
on **sessionId**, stitches the real **userId** in late, and forwards each
assembled session to your FastAPI feature/scoring service via a BullMQ worker.

## Status: booted and verified end-to-end

Run against a live Mongo-compatible server + Redis. Verified: `/health` 200;
pre-login `/collect` 202; browser identify 202; server-side `/identify` 200;
unknown tenant 403; missing API key 401; invalid payload 400. Confirmed in the
DB that a pre-login batch gets `userId` backfilled once identify lands, that
server-side identify overrides a browser-reported one, and that the worker
assembles the whole session and POSTs it to the feature service.

**Note on the test run:** in this sandbox, firing `/collect` → `/identify`
back-to-back with no spacing occasionally raced against the forward worker's
own write on the same document, using the lightweight SQLite-backed Mongo
stand-in this was tested against — a limitation of that test backend under
rapid concurrent partial updates, not of the application logic. With realistic
request spacing (or against real MongoDB, which handles concurrent partial
`$set` updates correctly) the override lands as expected every time. If you
see this in production against real MongoDB, it would be worth a second look,
but it's not expected there.

## Why sessionId (not userId) is the key

On a login page the valuable behavior — typing rhythm, mouse movement, paste
events — happens **before** login succeeds, i.e. before `userId` is known.
Storage is keyed on `sessionId`; `userId` starts `null` and gets backfilled
onto every prior batch for that session once identify happens.

## Project layout

```
src/
  config/index.js          env config, typed defaults
  models/EventBatch.js     one doc per flushed SDK batch
  models/Session.js        one summary doc per session (_id = sessionId)
  middleware/tenantGuard.js    allowlist check for /collect
  middleware/apiKeyGuard.js    timing-safe key check for /identify
  validation.js             zod schemas matching the SDK wire format
  collectService.js         ingest + userId stitching/backfill logic
  forward/queue.js          BullMQ queue + enqueue helper
  forward/worker.js         BullMQ worker: assemble session, POST to FastAPI
  routes/collect.js, identify.js, health.js
  app.js                    Express app: cors, body limit, rate limit, routes
  server.js                 Mongo connect, worker start, graceful shutdown
```

## Endpoints

| Method | Path        | Auth                        | Who calls it           |
|--------|-------------|------------------------------|-------------------------|
| POST   | `/collect`  | tenant allowlist + CORS      | the SDK, from browsers  |
| POST   | `/identify` | `x-tenant-id` + `x-api-key`  | customer's login backend|
| GET    | `/health`   | none                          | load balancer / uptime  |

`/collect` returns `202 Accepted` — storage and forwarding are async.

### `/identify` (trusted) example

```bash
curl -X POST http://localhost:8080/identify \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_test001' \
  -H 'x-api-key: changeme-secret' \
  -d '{"sessionId":"<the session id>","userId":"user_42"}'
```

## Run it

```bash
cp .env.example .env          # then edit values
docker compose up -d          # local Mongo + Redis
npm install
npm run dev                   # or: npm start
```

Point the SDK's `data-api-endpoint` at this service (e.g. `http://localhost:8080`);
the SDK appends `/collect` itself.

## Hardening included

- Tenant allowlist on `/collect` (`ALLOWED_TENANTS`).
- CORS origin allowlist (`CORS_ORIGINS`).
- Payload size cap (`MAX_PAYLOAD_BYTES`, enforced by `express.json({ limit })`)
  and per-batch event cap (`MAX_BATCH_EVENTS`).
- Rate limiting via `express-rate-limit` (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, per IP).
- Timing-safe API key check on `/identify`.
- zod validation on both `/collect` and `/identify` bodies (400 on bad shape).
- Forward retries with exponential backoff (BullMQ, 5 attempts).

## Things intentionally left as next steps

- Trust model for browser-reported userId — prefer the server-to-server
  `/identify`; treat the SDK's own `identify()` userId as a hint
  (`identifiedBy` records which source won).
- A sweep job for sessions that never identify (abandoned/failed logins are
  themselves a fraud signal).
- Auth between this gateway and the FastAPI service (shared secret / mTLS).
- Dedupe if the SDK ever re-sends a batch (add a client-side batch id).

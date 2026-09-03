const { z } = require('zod');

/**
 * A single captured event. The SDK sets `type`, `t`, `sessionId`, `userId`
 * on every event inside pushEvent(), plus event-specific fields. Unknown
 * extra fields are stripped by default (zod's default .strip() behavior on
 * objects) — same intent as the NestJS whitelist, but we deliberately used
 * .passthrough() here so a new SDK field doesn't get silently dropped and
 * lost forever before anyone notices; the backend can just ignore fields it
 * doesn't understand yet downstream.
 */
const RawEventSchema = z
  .object({
    type: z.string().max(40),
    t: z.number().optional(),
    sessionId: z.string().max(128).optional(),
    userId: z.string().max(256).nullable().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
    key: z.string().max(20).optional(),
    field: z.string().max(128).nullable().optional(),
    name: z.string().max(64).optional(),
    props: z.record(z.unknown()).optional(),
    state: z.string().max(20).optional(),
  })
  .passthrough();

const CollectBatchSchema = z.object({
  tenantId: z.string().max(128),
  appId: z.string().max(128),
  deviceFingerprint: z.string().max(64),
  events: z.array(RawEventSchema).min(1).max(2000),
});

const IdentifySchema = z.object({
  sessionId: z.string().max(128),
  userId: z.string().max(256),
});

module.exports = { CollectBatchSchema, IdentifySchema };

'use strict';

const { CollectBatchSchema, IdentifySchema } = require('../src/validation');

describe('CollectBatchSchema', () => {
  const validBatch = {
    tenantId: 'tenant_test001',
    appId: 'app_test001',
    deviceFingerprint: 'fp_abc123',
    events: [{ type: 'mousemove', t: 100, sessionId: 'sess_1', x: 10, y: 20 }],
  };

  test('accepts a well-formed batch', () => {
    const result = CollectBatchSchema.safeParse(validBatch);
    expect(result.success).toBe(true);
  });

  test('rejects a batch missing tenantId', () => {
    const { tenantId, ...rest } = validBatch;
    const result = CollectBatchSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test('rejects a batch missing appId', () => {
    const { appId, ...rest } = validBatch;
    const result = CollectBatchSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test('rejects a batch missing deviceFingerprint', () => {
    const { deviceFingerprint, ...rest } = validBatch;
    const result = CollectBatchSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test('rejects an empty events array', () => {
    const result = CollectBatchSchema.safeParse({ ...validBatch, events: [] });
    expect(result.success).toBe(false);
  });

  test('rejects more than 2000 events', () => {
    const events = Array.from({ length: 2001 }, () => ({ type: 'mousemove' }));
    const result = CollectBatchSchema.safeParse({ ...validBatch, events });
    expect(result.success).toBe(false);
  });

  test('accepts exactly 2000 events', () => {
    const events = Array.from({ length: 2000 }, () => ({ type: 'mousemove' }));
    const result = CollectBatchSchema.safeParse({ ...validBatch, events });
    expect(result.success).toBe(true);
  });

  test('rejects an event whose type exceeds 40 chars', () => {
    const events = [{ type: 'x'.repeat(41) }];
    const result = CollectBatchSchema.safeParse({ ...validBatch, events });
    expect(result.success).toBe(false);
  });

  test('rejects an event missing type', () => {
    const events = [{ t: 100 }];
    const result = CollectBatchSchema.safeParse({ ...validBatch, events });
    expect(result.success).toBe(false);
  });

  test('passthrough keeps unknown event fields instead of stripping them', () => {
    const events = [{ type: 'custom', brandNewField: 'value' }];
    const result = CollectBatchSchema.safeParse({ ...validBatch, events });
    expect(result.success).toBe(true);
    expect(result.data.events[0].brandNewField).toBe('value');
  });

  test('accepts userId explicitly set to null', () => {
    const events = [{ type: 'mousemove', userId: null }];
    const result = CollectBatchSchema.safeParse({ ...validBatch, events });
    expect(result.success).toBe(true);
  });
});

describe('IdentifySchema', () => {
  test('accepts a well-formed identify payload', () => {
    const result = IdentifySchema.safeParse({ sessionId: 'sess_1', userId: 'user_42' });
    expect(result.success).toBe(true);
  });

  test('rejects a payload missing sessionId', () => {
    const result = IdentifySchema.safeParse({ userId: 'user_42' });
    expect(result.success).toBe(false);
  });

  test('rejects a payload missing userId', () => {
    const result = IdentifySchema.safeParse({ sessionId: 'sess_1' });
    expect(result.success).toBe(false);
  });

  test('rejects sessionId longer than 128 chars', () => {
    const result = IdentifySchema.safeParse({ sessionId: 'x'.repeat(129), userId: 'user_42' });
    expect(result.success).toBe(false);
  });

  test('rejects userId longer than 256 chars', () => {
    const result = IdentifySchema.safeParse({ sessionId: 'sess_1', userId: 'x'.repeat(257) });
    expect(result.success).toBe(false);
  });
});

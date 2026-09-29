'use strict';

jest.mock('../../src/collectService');

const request = require('supertest');
const collectService = require('../../src/collectService');
const createApp = require('../../src/app');

let app;
beforeAll(() => {
  app = createApp();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /health', () => {
  test('returns 200 with status ok and a timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.ts).toBe('string');
  });
});

describe('POST /collect', () => {
  const validBody = {
    tenantId: 'tenant_test001',
    appId: 'app_test001',
    deviceFingerprint: 'fp_abc123',
    events: [{ type: 'mousemove', sessionId: 'sess_1', t: 1, x: 1, y: 2 }],
  };

  test('202s and calls collectService.ingest for a valid, allowed-tenant batch', async () => {
    collectService.ingest = jest.fn().mockResolvedValue(undefined);

    const res = await request(app).post('/collect').send(validBody);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(collectService.ingest).toHaveBeenCalledTimes(1);
    expect(collectService.ingest.mock.calls[0][0]).toMatchObject({ tenantId: 'tenant_test001' });
  });

  test('403s for a tenant not on the allowlist, before ever calling ingest', async () => {
    collectService.ingest = jest.fn();

    const res = await request(app).post('/collect').send({ ...validBody, tenantId: 'tenant_unknown' });

    expect(res.status).toBe(403);
    expect(collectService.ingest).not.toHaveBeenCalled();
  });

  test('400s on a payload that fails schema validation (missing deviceFingerprint)', async () => {
    collectService.ingest = jest.fn();
    const { deviceFingerprint, ...bad } = validBody;

    const res = await request(app).post('/collect').send(bad);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid payload');
    expect(collectService.ingest).not.toHaveBeenCalled();
  });

  test('400s on an empty events array', async () => {
    const res = await request(app).post('/collect').send({ ...validBody, events: [] });
    expect(res.status).toBe(400);
  });

  test("maps a service-thrown BadRequestError's status onto the response", async () => {
    const { BadRequestError } = jest.requireActual('../../src/collectService');
    collectService.ingest = jest.fn().mockRejectedValue(new BadRequestError('inconsistent sessionId within batch'));

    const res = await request(app).post('/collect').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('inconsistent sessionId within batch');
  });

  test('500s and does not leak internals when the service throws an unexpected error', async () => {
    collectService.ingest = jest.fn().mockRejectedValue(new Error('mongo exploded'));

    const res = await request(app).post('/collect').send(validBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });
});

describe('POST /identify', () => {
  const validBody = { sessionId: 'sess_1', userId: 'user_42' };
  const authHeaders = { 'x-tenant-id': 'tenant_test001', 'x-api-key': 'changeme-secret' };

  test('200s and calls attachUserId with source "server" for valid credentials + payload', async () => {
    collectService.attachUserId = jest.fn().mockResolvedValue(undefined);

    const res = await request(app).post('/identify').set(authHeaders).send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(collectService.attachUserId).toHaveBeenCalledWith('sess_1', 'user_42', 'server');
  });

  test('401s with no auth headers at all, before touching the body', async () => {
    collectService.attachUserId = jest.fn();

    const res = await request(app).post('/identify').send(validBody);

    expect(res.status).toBe(401);
    expect(collectService.attachUserId).not.toHaveBeenCalled();
  });

  test('401s for a wrong api key even with a valid tenant + payload', async () => {
    collectService.attachUserId = jest.fn();

    const res = await request(app)
      .post('/identify')
      .set({ 'x-tenant-id': 'tenant_test001', 'x-api-key': 'nope' })
      .send(validBody);

    expect(res.status).toBe(401);
    expect(collectService.attachUserId).not.toHaveBeenCalled();
  });

  test('400s on a payload missing userId, even with valid auth', async () => {
    collectService.attachUserId = jest.fn();

    const res = await request(app).post('/identify').set(authHeaders).send({ sessionId: 'sess_1' });

    expect(res.status).toBe(400);
    expect(collectService.attachUserId).not.toHaveBeenCalled();
  });
});

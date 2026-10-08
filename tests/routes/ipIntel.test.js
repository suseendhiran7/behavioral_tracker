'use strict';

jest.mock('../../src/ipIntelService');

const request = require('supertest');
const ipIntelService = require('../../src/ipIntelService');
const createApp = require('../../src/app');

let app;
beforeAll(() => { app = createApp(); });
beforeEach(() => jest.clearAllMocks());

const okResult = {
  country: 'IN', timezone: 'Asia/Kolkata', is_vpn: false, is_proxy: false,
  is_datacenter: false, is_new_country: null, source: 'provider',
};

describe('GET /ip-intel', () => {
  test('200s with the verdict for an allowed tenant', async () => {
    ipIntelService.lookupForSession.mockResolvedValue(okResult);
    const res = await request(app).get('/ip-intel?tenantId=tenant_test001&appId=app_test001&sessionId=sess_1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(okResult);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(ipIntelService.lookupForSession).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_test001', sessionId: 'sess_1' })
    );
  });

  test('classifies the socket IP, ignoring a spoofed X-Forwarded-For from an untrusted client', async () => {
    ipIntelService.lookupForSession.mockResolvedValue(okResult);
    // express-rate-limit warns (on purpose) about XFF with trust proxy off.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // supertest connects over loopback, which IS trusted by default, so use
    // an app that trusts nothing to prove the header is ignored.
    const config = require('../../src/config');
    const prev = config.trustProxy;
    config.trustProxy = false;
    const strictApp = createApp();
    config.trustProxy = prev;

    await request(strictApp)
      .get('/ip-intel?tenantId=tenant_test001&sessionId=sess_1')
      .set('X-Forwarded-For', '8.8.8.8');
    const ip = ipIntelService.lookupForSession.mock.calls[0][0].ip;
    expect(ip).not.toBe('8.8.8.8');
    errSpy.mockRestore();
  });

  test('403s for an unknown tenant without doing a lookup', async () => {
    const res = await request(app).get('/ip-intel?tenantId=nope&sessionId=sess_1');
    expect(res.status).toBe(403);
    expect(ipIntelService.lookupForSession).not.toHaveBeenCalled();
  });

  test('400s when sessionId is missing', async () => {
    const res = await request(app).get('/ip-intel?tenantId=tenant_test001');
    expect(res.status).toBe(400);
    expect(ipIntelService.lookupForSession).not.toHaveBeenCalled();
  });

  test('502s when the provider failed, still returning the null-shaped body', async () => {
    ipIntelService.lookupForSession.mockResolvedValue({ ...okResult, country: null, is_vpn: null, source: 'error' });
    const res = await request(app).get('/ip-intel?tenantId=tenant_test001&sessionId=sess_1');
    expect(res.status).toBe(502);
    expect(res.body.source).toBe('error');
  });
});

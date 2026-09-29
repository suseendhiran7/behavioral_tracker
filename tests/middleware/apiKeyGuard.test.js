'use strict';

const apiKeyGuard = require('../../src/middleware/apiKeyGuard');

function makeReq(headers) {
  return { header: (name) => headers[name.toLowerCase()] };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Matches TENANT_API_KEYS set in tests/setupEnv.js
describe('apiKeyGuard', () => {
  test('calls next() and sets req.tenantId for valid credentials', () => {
    const req = makeReq({ 'x-tenant-id': 'tenant_test001', 'x-api-key': 'changeme-secret' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyGuard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.tenantId).toBe('tenant_test001');
    expect(res.status).not.toHaveBeenCalled();
  });

  test('401s when x-tenant-id is missing', () => {
    const req = makeReq({ 'x-api-key': 'changeme-secret' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'missing or unknown credentials' });
    expect(next).not.toHaveBeenCalled();
  });

  test('401s when x-api-key is missing', () => {
    const req = makeReq({ 'x-tenant-id': 'tenant_test001' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401s for an unknown tenant', () => {
    const req = makeReq({ 'x-tenant-id': 'tenant_nonexistent', 'x-api-key': 'anything' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'missing or unknown credentials' });
    expect(next).not.toHaveBeenCalled();
  });

  test('401s for a known tenant with the wrong key', () => {
    const req = makeReq({ 'x-tenant-id': 'tenant_test001', 'x-api-key': 'wrong-key' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid api key' });
    expect(next).not.toHaveBeenCalled();
  });

  test('401s (not a thrown error) when key length differs from the stored key', () => {
    // Regression guard: safeEqual must length-check before timingSafeEqual,
    // which throws on mismatched buffer lengths instead of returning false.
    const req = makeReq({ 'x-tenant-id': 'tenant_test001', 'x-api-key': 'short' });
    const res = makeRes();
    const next = jest.fn();

    expect(() => apiKeyGuard(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('a second tenant with its own key also authenticates', () => {
    const req = makeReq({ 'x-tenant-id': 'tenant_abc123', 'x-api-key': 'changeme-secret' });
    const res = makeRes();
    const next = jest.fn();

    apiKeyGuard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.tenantId).toBe('tenant_abc123');
  });
});

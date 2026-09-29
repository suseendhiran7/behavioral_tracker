'use strict';

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('tenantGuard', () => {
  // allowedTenants is non-empty here (see tests/setupEnv.js), so these
  // exercise the normal allowlist-enforcing path.
  describe('with a configured allowlist', () => {
    const tenantGuard = require('../../src/middleware/tenantGuard');

    test('calls next() for an allowed tenant', () => {
      const req = { body: { tenantId: 'tenant_test001' } };
      const res = makeRes();
      const next = jest.fn();

      tenantGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('400s when tenantId is missing from the body', () => {
      const req = { body: {} };
      const res = makeRes();
      const next = jest.fn();

      tenantGuard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'tenantId missing' });
      expect(next).not.toHaveBeenCalled();
    });

    test('400s when req.body itself is undefined (e.g. wrong Content-Type)', () => {
      const req = {}; // no .body at all
      const res = makeRes();
      const next = jest.fn();

      expect(() => tenantGuard(req, res, next)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('403s for a tenant not on the allowlist', () => {
      const req = { body: { tenantId: 'tenant_not_allowed' } };
      const res = makeRes();
      const next = jest.fn();

      tenantGuard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'unknown tenant' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  // Separately test the "no allowlist configured → open gate" branch by
  // mocking config directly, rather than relying on env/module-load order.
  describe('with an empty allowlist (dev mode)', () => {
    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../../src/config', () => ({ allowedTenants: [] }));
    });
    afterEach(() => jest.dontMock('../../src/config'));

    test('calls next() for ANY tenantId, even one never configured', () => {
      const tenantGuard = require('../../src/middleware/tenantGuard');
      const req = { body: { tenantId: 'literally_anything' } };
      const res = makeRes();
      const next = jest.fn();

      tenantGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('calls next() even when tenantId is missing entirely', () => {
      const tenantGuard = require('../../src/middleware/tenantGuard');
      const req = { body: {} };
      const res = makeRes();
      const next = jest.fn();

      tenantGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});

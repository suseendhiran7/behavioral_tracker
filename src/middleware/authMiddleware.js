const { timingSafeEqual } = require('crypto');
const { verifyToken } = require('../utils/token');
const config = require('../config');

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkApiKey(req) {
  const tenantId = req.header('x-tenant-id');
  const apiKey = req.header('x-api-key');
  const keys = config.tenantApiKeys;
  if (tenantId && apiKey && keys[tenantId] && safeCompare(apiKey, keys[tenantId])) {
    return { isApiKey: true, tenantId };
  }
  return null;
}

function extractToken(req) {
  const authHeader = req.header('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const customHeader = req.header('x-access-token');
  if (customHeader) return customHeader.trim();
  return null;
}

function optionalAuth(req, res, next) {
  const apiKeyResult = checkApiKey(req);
  if (apiKeyResult) {
    req.apiKeyAuth = apiKeyResult;
    req.user = { userId: null, role: 'service', tenantId: apiKeyResult.tenantId };
    return next();
  }

  const token = extractToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    } else {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthorized', message: 'Valid authentication required' });
    }
    next();
  });
}

function requireUserOrAdmin(paramKey = 'userId') {
  return (req, res, next) => {
    optionalAuth(req, res, () => {
      if (!req.user) {
        return res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
      }
      if (req.user.role === 'admin' || req.user.role === 'service') {
        return next();
      }
      const targetUserId = req.params[paramKey];
      if (req.user.userId !== targetUserId) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'Access denied: cannot access another user analytics',
        });
      }
      next();
    });
  };
}

function requireServerOrAdmin(req, res, next) {
  optionalAuth(req, res, () => {
    if (req.apiKeyAuth) {
      return next();
    }
    if (req.user && req.user.role === 'admin') {
      return next();
    }
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Server API key or admin authorization required',
    });
  });
}

module.exports = {
  optionalAuth,
  requireAuth,
  requireUserOrAdmin,
  requireServerOrAdmin,
};

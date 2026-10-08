'use strict';

const mongoose = require('mongoose');
const config = require('./config');
const providers = require('./ipIntel/providers');
const { isPrivateIp } = require('./ipIntel/privateIp');
const NetworkIntel = require('./models/NetworkIntel');
const UserGeoHistory = require('./models/UserGeoHistory');
const Session = require('./models/Session');

const EMPTY = { country: null, timezone: null, isVpn: null, isProxy: null, isDatacenter: null, isTor: null };

// ---------- In-memory cache + in-flight de-duplication ----------
// Saves provider quota: the same IP is looked up at most once per TTL, and
// concurrent requests for one IP share a single provider call. Per-process;
// swap for Redis if you run several instances.
const cache = new Map(); // ip -> { data, expiresAt }
const inflight = new Map(); // ip -> Promise

function cacheGet(ip) {
  const hit = cache.get(ip);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(ip); return null; }
  return hit.data;
}
function cacheSet(ip, data) {
  if (cache.size >= config.ipIntel.cacheMax) cache.delete(cache.keys().next().value); // drop oldest
  cache.set(ip, { data, expiresAt: Date.now() + config.ipIntel.cacheTtlMs });
}

function activeProvider() {
  const name = config.ipIntel.provider;
  if (name === 'none') return null;
  if (name === 'ipqs' && !config.ipIntel.apiKey) return null;
  return providers[name] ? { name, fn: providers[name] } : null;
}

/**
 * Classify one IP. Never throws for "expected" failures — returns
 * { data, source } where source is provider | cache | private_ip | disabled | error.
 */
async function classifyIp(ip, ctx = {}) {
  let lookupIp = ip;
  if (!ip || isPrivateIp(ip)) {
    // Local dev: localhost can't be classified. Optionally pretend to be a
    // real public IP (never honoured in production).
    if (config.ipIntel.devIp && config.nodeEnv !== 'production') lookupIp = config.ipIntel.devIp;
    else return { data: { ...EMPTY }, source: 'private_ip', provider: null, lookupIp: ip };
  }

  const provider = activeProvider();
  if (!provider) return { data: { ...EMPTY }, source: 'disabled', provider: null, lookupIp };

  const cached = cacheGet(lookupIp);
  if (cached) return { data: cached, source: 'cache', provider: provider.name, lookupIp };

  if (!inflight.has(lookupIp)) {
    const p = provider
      .fn(lookupIp, { ...ctx, config: config.ipIntel })
      .then((data) => { cacheSet(lookupIp, data); return data; })
      .finally(() => inflight.delete(lookupIp));
    inflight.set(lookupIp, p);
  }

  try {
    const data = await inflight.get(lookupIp);
    return { data, source: 'provider', provider: provider.name, lookupIp };
  } catch (err) {
    console.warn(`[ip-intel] ${provider.name} lookup failed: ${err.message}`);
    return { data: { ...EMPTY }, source: 'error', provider: provider.name, lookupIp };
  }
}

function dbReady() {
  return mongoose.connection.readyState === 1;
}

/**
 * Compare a NetworkIntel record's country against the user's history,
 * store the verdict, then add the country to the history.
 * First-ever observed login for a user has no baseline → isNewCountry stays null.
 */
async function evaluateNewCountry(intelDoc, userId) {
  if (!intelDoc || !intelDoc.country || !userId) return null;
  if (intelDoc.evaluatedForUserId === userId) return intelDoc.isNewCountry; // already done

  const history = await UserGeoHistory.findOne({ tenantId: intelDoc.tenantId, userId }).lean();
  const known = history ? history.countries : [];
  const isNew = known.length > 0 ? !known.includes(intelDoc.country) : null;

  await NetworkIntel.updateOne({ _id: intelDoc._id }, { $set: { userId, isNewCountry: isNew, evaluatedForUserId: userId } });
  await UserGeoHistory.updateOne(
    { tenantId: intelDoc.tenantId, userId },
    { $addToSet: { countries: intelDoc.country } },
    { upsert: true }
  );
  return isNew;
}

/**
 * Entry point for GET /ip-intel. Classifies the caller's IP, records it
 * against the session and, if the session already has a user, evaluates
 * is_new_country.
 */
async function lookupForSession({ tenantId, appId, sessionId, ip, userAgent, userLanguage }) {
  const result = await classifyIp(ip, { userAgent, userLanguage });
  const d = result.data;
  let isNewCountry = null;

  if (sessionId && ip && dbReady()) {
    try {
      const doc = await NetworkIntel.findOneAndUpdate(
        { sessionId, ip },
        {
          $setOnInsert: { tenantId, appId: appId || null, sessionId, ip },
          $set: {
            country: d.country,
            timezone: d.timezone,
            isVpn: d.isVpn,
            isProxy: d.isProxy,
            isDatacenter: d.isDatacenter,
            isTor: d.isTor,
            provider: result.provider,
            source: result.source,
          },
        },
        { upsert: true, new: true, lean: true }
      );

      const session = await Session.findById(sessionId).select('userId tenantId').lean();
      if (session && session.userId && session.tenantId === tenantId) {
        isNewCountry = await evaluateNewCountry(doc, session.userId);
      }
    } catch (err) {
      // Recording is best-effort; the browser still gets its verdict.
      console.warn('[ip-intel] failed to record network intel', err.message);
    }
  }

  return {
    country: d.country,
    timezone: d.timezone,
    is_vpn: d.isVpn,
    is_proxy: d.isProxy,
    is_datacenter: d.isDatacenter,
    is_new_country: isNewCountry,
    source: result.source,
  };
}

/**
 * Called from collectService.attachUserId once a session is linked to a
 * user — fills in isNewCountry for every IP recorded on that session.
 */
async function onUserIdentified(sessionId, userId) {
  if (!dbReady()) return;
  const docs = await NetworkIntel.find({ sessionId, country: { $ne: null } }).lean();
  for (const doc of docs) await evaluateNewCountry(doc, userId);
}

function _resetCacheForTests() {
  cache.clear();
  inflight.clear();
}

module.exports = { classifyIp, lookupForSession, onUserIdentified, evaluateNewCountry, _resetCacheForTests };

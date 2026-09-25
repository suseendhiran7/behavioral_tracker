/**
 * identifyClient.js
 * -------------------------------------------------------------------------
 * This is the ONE piece of logic your login backend needs: after a user
 * logs in successfully, call this function with the browser's sessionId
 * (from XyliumBF.getSessionId()) and the real, verified userId.
 *
 * It sends a server-to-server POST to this ingestion app's /identify
 * endpoint, authenticated with x-tenant-id + x-api-key — never something
 * the browser touches or sees.
 *
 * Usage (see exampleLoginRoute.js for a full example):
 *
 *   const { sendIdentify } = require('./client-integration/identifyClient');
 *
 *   await sendIdentify({ sessionId, userId: user.id });
 */

'use strict';

const IDENTIFY_URL = process.env.XYLIUM_IDENTIFY_URL || 'http://localhost:8080/identify';
const TENANT_ID = process.env.XYLIUM_TENANT_ID;
const API_KEY = process.env.XYLIUM_API_KEY;

/**
 * Sends { sessionId, userId } to the ingestion app's /identify endpoint.
 *
 * @param {Object} params
 * @param {string} params.sessionId - from XyliumBF.getSessionId() on the frontend
 * @param {string} params.userId    - the real, verified user id from your own login
 * @param {number} [params.timeoutMs=3000]
 * @returns {Promise<boolean>} true if the link was accepted
 */
async function sendIdentify({ sessionId, userId, timeoutMs = 3000 }) {
  if (!sessionId || !userId) {
    console.warn('[identifyClient] missing sessionId or userId — skipping call', { sessionId, userId });
    return false;
  }
  if (!TENANT_ID || !API_KEY) {
    console.warn('[identifyClient] XYLIUM_TENANT_ID / XYLIUM_API_KEY not configured — skipping call');
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(IDENTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': TENANT_ID,
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ sessionId: String(sessionId), userId: String(userId) }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[identifyClient] /identify returned ${res.status}: ${text}`);
      return false;
    }

    return true;
  } catch (err) {
    // Never let this block or fail the login flow — identity linking is
    // best-effort. Log it and move on; a missed link just means the
    // session stays "unidentified" until the next successful call.
    console.error('[identifyClient] failed to call /identify:', err.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendIdentify };

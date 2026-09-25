/**
 * exampleLoginRoute.js
 * -------------------------------------------------------------------------
 * Drop-in example of where sendIdentify() belongs in a normal login flow.
 * This is NOT wired into app.js automatically — copy the sendIdentify()
 * call into your real login route, right after login succeeds.
 *
 * The frontend must send `sessionId` in the login request body. It gets
 * that value from the SDK already loaded on the page:
 *
 *   const sessionId = window.XyliumBF.getSessionId();
 *   fetch('/login', {
 *     method: 'POST',
 *     body: JSON.stringify({ email, password, sessionId }),
 *     headers: { 'Content-Type': 'application/json' },
 *   });
 */

'use strict';

const express = require('express');
const { sendIdentify } = require('./identifyClient');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password, sessionId } = req.body || {};

    // 1. Your existing, real login/auth check goes here.
    //    (placeholder — replace with your actual credential verification)
    const user = await verifyCredentials(email, password);
    if (!user) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    // 2. Your existing token/session issuance goes here, unchanged.
    const token = issueSessionToken(user);

    // 3. NEW — the one call this integration adds. Fire-and-forget is
    //    fine: it must never block or fail the login response.
    sendIdentify({ sessionId, userId: user.id }).catch(() => {});

    return res.status(200).json({ token, userId: user.id });
  } catch (err) {
    next(err);
  }
});

// Placeholders standing in for this app's real logic — replace both.
async function verifyCredentials(email, password) {
  throw new Error('verifyCredentials() is a placeholder — wire up your real auth check');
}
function issueSessionToken(user) {
  throw new Error('issueSessionToken() is a placeholder — wire up your real token issuance');
}

module.exports = router;

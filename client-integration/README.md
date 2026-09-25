# client-integration/

This folder is the **one piece of logic your login backend needs** — it is
separate from the rest of this app (which is the ingestion server that
already exposes `/identify`). Don't merge these files into `src/` — copy
the pattern into wherever your real login route lives.

## Files
- **`identifyClient.js`** — the actual function, `sendIdentify({ sessionId, userId })`.
  Call this once, right after your app verifies a login.
- **`exampleLoginRoute.js`** — shows exactly where that call goes in a normal
  login handler. Not wired into `app.js`; it's a copy-paste reference.

## Setup

Add these three environment variables to whichever app calls `sendIdentify`:

```
XYLIUM_IDENTIFY_URL=https://your-ingestion-host.example.com/identify
XYLIUM_TENANT_ID=acme_corp
XYLIUM_API_KEY=<the secret key issued for this tenant>
```

`XYLIUM_TENANT_ID` and `XYLIUM_API_KEY` must match an entry in this
ingestion app's own `TENANT_API_KEYS` (see its `.env.example`) — that's
what `apiKeyGuard.js` checks on the receiving end.

## What it does, in one sentence

After your login route verifies the user, it calls
`sendIdentify({ sessionId, userId })` — `sessionId` comes from the browser
(`XyliumBF.getSessionId()`, passed up in the login request), `userId` is
the real id from your own verified login. That's the whole integration.

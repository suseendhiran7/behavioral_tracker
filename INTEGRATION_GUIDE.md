# Integrating the Xylium SDK into your site

This walks through adding the SDK to a page, wiring up consent, and linking
a logged-in user to the session it collected. It assumes the backend
(`node_app/`) is already deployed and reachable — see the main `README.md`
if not.

## 1. Add the script tags

Load `xylium-core.js` **first**, with your config as `data-*` attributes on
that tag — then the pattern files, in any order:

```html
<script src="https://your-sdk-host/xylium-core.js"
        data-tenant-id="tenant_test001"
        data-app-id="app_test001"
        data-api-endpoint="https://your-backend-host"
        data-capture-geo="false"></script>

<script src="https://your-sdk-host/xylium-mouse.js"></script>
<script src="https://your-sdk-host/xylium-keyboard.js"></script>
<script src="https://your-sdk-host/xylium-touch.js"></script>
<script src="https://your-sdk-host/xylium-scroll.js"></script>
<script src="https://your-sdk-host/xylium-form.js"></script>
<script src="https://your-sdk-host/xylium-clipboard.js"></script>
<script src="https://your-sdk-host/xylium-navigation.js"></script>
<script src="https://your-sdk-host/xylium-device.js"></script>
<script src="https://your-sdk-host/xylium-idle.js"></script>
<script src="https://your-sdk-host/xylium-geo.js"></script>
<script src="https://your-sdk-host/xylium-bot.js"></script>
<script src="https://your-sdk-host/xylium-identity.js"></script>
<!-- <script src="https://your-sdk-host/xylium-custom.js"></script>  -->
<!-- add this line only once a custom pattern has been accepted -->
```

**Config attributes** (all live on the `xylium-core.js` tag only):

| Attribute | Purpose |
|---|---|
| `data-tenant-id` | Your tenant id — must match one in the backend's `ALLOWED_TENANTS` |
| `data-app-id` | An identifier for this specific app/page |
| `data-api-endpoint` | Your `node_app` base URL — the SDK appends `/collect` itself |
| `data-capture-geo` | `"true"` to enable geolocation capture (browser will prompt) |

Drop a pattern's `<script>` line to disable that signal category — nothing
else needs to change.

## 2. Get user consent, then start capture

Capture doesn't begin until `grantConsent()` is called (unless the SDK is
configured with `requireConsent = false`, which isn't recommended for a
production/consumer-facing page). A typical flow:

```html
<script>
  window.addEventListener('load', function () {
    if (!window.XyliumBF) return;

    const consented = confirm('Allow behavioral security monitoring on this page?');
    if (consented) {
      window.XyliumBF.grantConsent();
    }
  });
</script>
```

`revokeConsent()` stops all capture immediately and erases every persisted
identifier (device id, failed-login-attempt log, form-abandon marker) — wire
this to whatever "opt out" / "reject" control your consent UI has.

## 3. Link the session to a real user after login

This is the one piece that goes in **your backend**, not the browser. The
valuable behavioral signal (typing rhythm, mouse movement, paste events)
happens on the login page *before* login succeeds — so the SDK starts
capturing under an anonymous `sessionId`, and you attach the real `userId`
server-to-server once login is verified.

**Frontend** — send the SDK's session id along with the login request:
```js
const sessionId = window.XyliumBF.getSessionId();

fetch('/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, sessionId }),
});
```

**Your login backend** — after verifying credentials, call `node_app`'s
`/identify` endpoint server-to-server:
```js
async function sendIdentify({ sessionId, userId }) {
  await fetch('https://your-backend-host/identify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': 'tenant_test001',
      'x-api-key': process.env.XYLIUM_API_KEY, // from TENANT_API_KEYS in node_app's .env
    },
    body: JSON.stringify({ sessionId, userId }),
  });
}

// after your own credential check succeeds:
await sendIdentify({ sessionId, userId: user.id }).catch(() => {
  // best-effort — never let this block or fail the login response
});
```

This is a fire-and-forget call: if it fails, the session just stays
unidentified until the next successful `/identify` call, and login itself is
never blocked by it.

Keep `x-api-key` server-side only — never send it from the browser.

## 4. Report the login outcome (optional, recommended)

Feeds `xylium-identity.js`'s failed-attempt tracking:
```js
window.XyliumBF.reportLoginResult(true, null);              // success
window.XyliumBF.reportLoginResult(false, 'bad_password');   // failure, with a short reason
```

## 5. Other calls you may need

```js
window.XyliumBF.identify(userId);        // browser-side hint (lower trust than server /identify)
window.XyliumBF.track('checkout_start', { cartValue: 129.99 });  // arbitrary custom event
window.XyliumBF.markFormSubmitted();     // for an SPA form with no native submit event
window.XyliumBF.requestGeo();            // manually (re-)trigger a geolocation capture
window.XyliumBF._debugFlushNow();        // force an immediate flush — useful while testing
```

## 6. Verify it's working

1. Open your browser's Network tab.
2. Load the page, grant consent, interact with it a bit (move the mouse,
   type in a field).
3. You should see periodic `POST` requests to
   `https://your-backend-host/collect` returning `202`.
4. Log in, and confirm a `POST` to `/identify` fires from your **backend**
   (not the browser) and returns `200`.
5. `window.XyliumBF._debugFlushNow()` in the console forces an immediate
   flush instead of waiting for the batch interval, if you want to check
   faster.

## Common gotchas

- **CORS**: `/collect` and `/identify` are called cross-origin from the
  browser if the SDK and backend are on different hosts — make sure
  `CORS_ORIGINS` in `node_app`'s `.env` includes your site's origin (or is
  `*` for development only).
- **Unknown tenant (`403`)**: `data-tenant-id` must exactly match an entry in
  `ALLOWED_TENANTS` on the backend.
- **No events arriving**: check that `grantConsent()` was actually called —
  the SDK silently does nothing before consent (or before `load`, if consent
  was pre-granted via `requireConsent: false`).
- **`data-api-endpoint` should not have a trailing path** — just the base
  URL (e.g. `https://api.example.com`, not `https://api.example.com/collect`)
  — the SDK appends `/collect` itself.
- **Geolocation not firing**: `data-capture-geo="true"` only *allows* it; the
  browser's own permission prompt still has to be accepted by the user.

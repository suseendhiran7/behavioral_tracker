# Xylium BF SDK — modular build

The original single file `xylium-bf-v2.js` has been split into a **core landing
file** plus **one file per behavioural pattern**. The wire format (every event
`type` and its fields) and the runtime behaviour are **identical** to the
original — only the file layout changed.

## Files

| File | Responsibility |
|------|----------------|
| **`xylium-core.js`** | **The landing file.** Session identity (`sessionId`), the backend **API pointer** (`data-api-endpoint` → `/collect`), config from `data-*` attributes, the device fingerprint, the event queue + transport (batching, beacon on unload), shared helpers, the module registry, and the public `window.XyliumBF` API. |
| `xylium-mouse.js` | Mouse move / click / trajectory / overshoot / hover / double-click / entropy / first-move. |
| `xylium-keyboard.js` | Key timing, n-grams, corrections, shortcuts, shift/caps, typing summary. |
| `xylium-touch.js` | Touch pressure and touch gestures. |
| `xylium-scroll.js` | Scroll behaviour. |
| `xylium-form.js` | Focus/blur, form interaction, first-field, clear-and-retype, password toggle, submit/abandon/return, and autofill detection. Exposes `markFormSubmitted()`. |
| `xylium-clipboard.js` | Copy / paste. |
| `xylium-navigation.js` | Visibility/resize, back-button, time context, page-entry method, referrer, window blur/focus. |
| `xylium-device.js` | Device snapshot, plugins, battery, connection, composite/canvas/webgl/font/audio fingerprints, language & privacy signals, network timing + RTT sampler. |
| `xylium-idle.js` | Idle start / end. |
| `xylium-geo.js` | Geolocation + timezone/geo consistency. Exposes `requestGeo()`. |
| `xylium-bot.js` | Automation/headless/CDP detection, media-query anomalies, event-integrity (isTrusted / timestamp precision). |
| `xylium-identity.js` | Cross-session persistent device id and failed-attempt window. Exposes `reportLoginResult()`. |

## How to include it

Load the **core first** with the `data-*` attributes, then the pattern files in
**any order**:

```html
<script src="xylium-core.js"
        data-tenant-id="tenant_test001"
        data-app-id="app_test001"
        data-api-endpoint="http://localhost:8080"
        data-capture-geo="false"></script>

<script src="xylium-mouse.js"></script>
<script src="xylium-keyboard.js"></script>
<!-- …the rest, in any order… -->
<script src="xylium-identity.js"></script>
```

`nexus-bank.html` in this folder is the sample UI wired up this way.

### Bundler / SPA usage

For a real app you can concatenate/bundle these files (core first) or import
them; each pattern file self-registers, so load order between patterns never
matters.

## How the pieces connect

The core exposes a `core` object to every module. Each pattern file registers
itself through a small queue that works **regardless of load order**:

```js
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  // core.pushEvent(...), core.config, core.state, core.onConsent(order, fn), …
});
```

The core drains any modules that loaded before it, then runs later ones as they
arrive. Consent-gated one-shot captures register with an **order number** so the
emission sequence on the wire is byte-for-byte the same as the original.

## Public API (unchanged)

`window.XyliumBF` still exposes: `identify(userId)`, `track(name, props)`,
`grantConsent()`, `revokeConsent()`, `reportLoginResult(success, reason)`,
`markFormSubmitted()`, `requestGeo()`, `getSessionId()`, `_debugFlushNow()`,
plus `use(factory)` for registering a module programmatically.

Public methods provided by a pattern module (`reportLoginResult`,
`markFormSubmitted`, `requestGeo`) fall back to a harmless warning if that
pattern file isn't loaded, so dropping a pattern never throws.

## Removing / adding a pattern

Delete a pattern file's `<script>` line to stop collecting that signal — nothing
else needs to change. Add one back the same way.

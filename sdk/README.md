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
| `xylium-form.js` | Focus/blur, form interaction, first-field, clear-and-retype, password toggle, submit/abandon/return, and autofill detection incl. the `autofill_summary` event (`username_autofilled`, `password_autofilled`, `username_fill_time_ms`, `password_fill_time_ms`). Exposes `markFormSubmitted()`, `getAutofillSummary()`. |
| `xylium-clipboard.js` | Copy / paste. |
| `xylium-navigation.js` | Visibility/resize, back-button, time context, page-entry method, referrer, window blur/focus. |
| `xylium-device.js` | Device snapshot, plugins, battery, connection, composite/canvas/webgl/font/audio fingerprints, language & privacy signals, network timing + RTT sampler. |
| `xylium-idle.js` | Idle start / end. |
| `xylium-geo.js` | Geolocation + timezone/geo consistency + `geo_features` (`geo_lat`, `geo_lon`, `geo_distance_from_home_km`). Exposes `requestGeo()`, `setHomeLocation(lat, lon)`. |
| `xylium-network-risk.js` | `network_risk` event: `is_vpn`, `is_proxy`, `is_datacenter`, `geo_is_new_country`. Needs a backend `GET /ip-intel` endpoint (contract in the file header). Exposes `requestNetworkRisk()`. |
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

## Login risk features

| Feature | Event | Source |
|---|---|---|
| `geo_lat`, `geo_lon` | `geo_features` | Browser geolocation (needs `data-capture-geo="true"` + user permission), 2 dp ≈ 1 km |
| `geo_distance_from_home_km` | `geo_features` | Haversine to home set via `setHomeLocation()`, else first fix seen on the device (null on that first fix) |
| `geo_is_new_country` | `network_risk` | Server verdict if returned by `/ip-intel`, else per-device country history (null on first visit) |
| `is_vpn`, `is_proxy`, `is_datacenter` | `network_risk` | Backend IP-intelligence lookup — cannot be detected reliably in the browser |
| `username_autofilled`, `password_autofilled`, `username_fill_time_ms`, `password_fill_time_ms` | `autofill_summary` | CSS autofill hook + value-injection heuristic; time = ms since navigation start, null if not autofilled. Sent on submit or pagehide |

Optional core attribute: `data-ip-intel-endpoint` (defaults to `<data-api-endpoint>/ip-intel`).

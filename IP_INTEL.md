# /ip-intel — VPN / proxy / datacenter / new-country

Backend for the SDK's `xylium-network-risk.js`.

## Request / response

```
GET /ip-intel?tenantId=tenant_test001&appId=app_test001&sessionId=<uuid>

200 {
  "country": "IN", "timezone": "Asia/Kolkata",
  "is_vpn": false, "is_proxy": false, "is_datacenter": false,
  "is_new_country": null,
  "source": "provider"        // provider | cache | private_ip | disabled | error
}
```

`502` with the same null-shaped body when the provider is down. The IP is
always the request's source IP (via `TRUST_PROXY`) — clients can't choose it.

## What gets stored

| Collection | Contents |
|---|---|
| `network_intel` | One doc per (sessionId, ip): country, isVpn, isProxy, isDatacenter, isTor, isNewCountry |
| `user_geo_history` | Countries each user has logged in from (baseline for isNewCountry) |

**The risk model should read `network_intel`, not the `network_risk` event.**
The event passes through the browser and can be edited by an attacker;
`network_intel` is written only by the server.

## How `is_new_country` works

The SDK calls `/ip-intel` before login, when the user is unknown, so the
response usually has `is_new_country: null` (the SDK then uses its
per-browser fallback). As soon as the session is linked to a user —
`POST /identify` or a browser `identify` event — the server compares each
recorded country with that user's history and stores
`network_intel.isNewCountry`. A user's first-ever login has no baseline,
so it stays `null`.

## Providers (`IP_INTEL_PROVIDER`)

| Value | Use | VPN | Proxy | Datacenter |
|---|---|---|---|---|
| `ipqs` | Production | yes | yes | `connection_type == "Data Center"` |
| `ipapi` | Local dev only (non-commercial terms) | null (merged into proxy) | yes | `hosting` |
| `none` | Disabled | null | null | null |

Lookups are cached per IP (6 h default) and concurrent lookups for one IP
share a single provider call. The cache is per process; use Redis if you
run several instances.

## Local testing

Requests from `localhost` can't be classified. Set
`IP_INTEL_DEV_IP=<some public IP>` to look that IP up instead (ignored when
`NODE_ENV=production`).

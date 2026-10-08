'use strict';

/**
 * IP-intelligence providers. Each provider takes (ip, ctx) and resolves to the
 * normalised shape below, or throws on failure:
 *
 *   { country, timezone, isVpn, isProxy, isDatacenter, isTor }
 *
 * Booleans are null when the provider can't tell. Pick one with
 * IP_INTEL_PROVIDER in .env.
 */

function clean(v) {
  return typeof v === 'string' && v && v !== 'N/A' ? v : null;
}
function bool(v) {
  return typeof v === 'boolean' ? v : null;
}

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
  return res.json();
}

/**
 * IPQualityScore — Proxy & VPN Detection API. Production choice.
 * Free account: 5,000 lookups/month. Distinguishes VPN vs proxy vs Tor and
 * reports connection_type ("Residential", "Mobile", "Data Center", …).
 * https://www.ipqualityscore.com/documentation/proxy-detection/overview
 */
async function ipqs(ip, ctx) {
  const { apiKey, timeoutMs, strictness } = ctx.config;
  const params = new URLSearchParams({
    strictness: String(strictness),
    allow_public_access_points: 'true',
    fast: 'true',
  });
  if (ctx.userAgent) params.set('user_agent', ctx.userAgent);
  if (ctx.userLanguage) params.set('user_language', ctx.userLanguage);

  // NB: the key is part of the URL path — never log this URL.
  const url = `https://ipqualityscore.com/api/json/ip/${encodeURIComponent(apiKey)}/${encodeURIComponent(ip)}?${params}`;
  const d = await getJson(url, timeoutMs);
  if (!d || d.success !== true) throw new Error(`ipqs: ${(d && d.message) || 'lookup failed'}`);

  return {
    country: clean(d.country_code),
    timezone: clean(d.timezone),
    isVpn: bool(d.vpn),
    isProxy: bool(d.proxy),
    isTor: bool(d.tor),
    isDatacenter: typeof d.connection_type === 'string' ? d.connection_type === 'Data Center' : null,
  };
}

/**
 * ip-api.com — zero-config, for LOCAL DEVELOPMENT ONLY.
 * Free tier is non-commercial, HTTP only, ~45 req/min. Its `proxy` flag
 * lumps proxy / VPN / Tor together, so isVpn stays null.
 */
async function ipapi(ip, ctx) {
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,countryCode,timezone,proxy,hosting`;
  const d = await getJson(url, ctx.config.timeoutMs);
  if (!d || d.status !== 'success') throw new Error(`ip-api: ${(d && d.message) || 'lookup failed'}`);
  return {
    country: clean(d.countryCode),
    timezone: clean(d.timezone),
    isVpn: null,
    isProxy: bool(d.proxy),
    isTor: null,
    isDatacenter: bool(d.hosting),
  };
}

module.exports = { ipqs, ipapi };

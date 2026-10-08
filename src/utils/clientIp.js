'use strict';

/**
 * Returns the caller's IP as Express resolved it.
 *
 * req.ip honours the app's `trust proxy` setting (TRUST_PROXY in .env), so
 * X-Forwarded-For is only believed when the request actually arrived through
 * a proxy you trust. Reading X-Forwarded-For directly lets any client spoof
 * its IP with one header — fatal for VPN / proxy detection.
 *
 * IPv4-mapped IPv6 ("::ffff:1.2.3.4") is normalised to plain IPv4.
 */
function getClientIp(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

module.exports = { getClientIp };

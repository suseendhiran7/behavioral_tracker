'use strict';

const net = require('net');

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

const PRIVATE_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['0.0.0.0', 8],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

/** True for loopback / private / link-local / CGNAT — IPs no provider can classify. */
function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return PRIVATE_V4.some(({ base, mask }) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') || // fc00::/7 unique local
      /^fe[89ab]/.test(lower)   // fe80::/10 link-local
    );
  }
  return true; // not a valid IP at all — treat as unclassifiable
}

module.exports = { isPrivateIp };

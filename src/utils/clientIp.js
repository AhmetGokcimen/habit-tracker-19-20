'use strict';

// The client address used for rate limiting and the audit log.
//
// Headers sent by the client are never trusted:
//   - On Vercel, the platform removes any client-supplied X-Forwarded-For and
//     sets x-vercel-forwarded-for / x-real-ip itself (documented spoofing
//     protection), so only those platform headers are read.
//   - Anywhere else (local, tests) all forwarding headers are ignored and the
//     TCP peer address is used.
// IPv6 addresses are reduced to their /64 prefix, because one client usually
// controls a whole /64 and could otherwise rotate through addresses in it.

const net = require('node:net');
const config = require('../config');

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
}

function normalize(address) {
  let ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) {
    // Expand "::" so the first four groups are the /64 network prefix.
    const [head, tail = ''] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const groups = [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts];
    ip = `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
    return ip;
  }
  return 'unknown';
}

function clientIp(req, { onVercel = config.onVercel } = {}) {
  if (onVercel) {
    const fromPlatform = firstHeaderValue(req.headers['x-vercel-forwarded-for']) || firstHeaderValue(req.headers['x-real-ip']);
    if (fromPlatform) return normalize(fromPlatform);
  }
  return normalize(req.socket?.remoteAddress || '');
}

module.exports = { clientIp };

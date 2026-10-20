'use strict';

// The client address used for rate limiting and the audit log.
//
// 1. Find the address that actually connected to us — one the client cannot forge:
//    - On Vercel, the platform removes any client-supplied X-Forwarded-For and
//      sets x-vercel-forwarded-for / x-real-ip itself (documented spoofing
//      protection), so only those platform headers are read.
//    - Anywhere else (local, tests) all forwarding headers are ignored and the
//      TCP peer address is used.
// 2. If that connecting address belongs to Cloudflare's published edge ranges,
//    the request came through the Cloudflare proxy, and CF-Connecting-IP (set
//    by Cloudflare) holds the real visitor. Otherwise CF-Connecting-IP is
//    ignored: a request sent straight to *.vercel.app could carry a forged one.
// 3. IPv6 addresses are reduced to their /64 prefix, because one client usually
//    controls a whole /64 and could otherwise rotate through addresses in it.

const net = require('node:net');
const config = require('../config');
const { isCloudflareIp } = require('./cloudflareIps');

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
}

function stripMapped(address) {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function toBucket(address) {
  const ip = stripMapped(address);
  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) {
    // Expand "::" so the first four groups are the /64 network prefix.
    const [head, tail = ''] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const groups = [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts];
    return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
  }
  return 'unknown';
}

// The address that connected to us (Vercel's edge view, or the TCP peer).
function connectingIp(req, onVercel) {
  if (onVercel) {
    const fromPlatform = firstHeaderValue(req.headers['x-vercel-forwarded-for']) || firstHeaderValue(req.headers['x-real-ip']);
    if (fromPlatform) return stripMapped(fromPlatform);
  }
  return stripMapped(req.socket?.remoteAddress || '');
}

function clientIp(req, { onVercel = config.onVercel } = {}) {
  const peer = connectingIp(req, onVercel);
  if (isCloudflareIp(peer)) {
    const visitor = stripMapped(firstHeaderValue(req.headers['cf-connecting-ip']));
    if (net.isIP(visitor)) return toBucket(visitor);
  }
  return toBucket(peer);
}

module.exports = { clientIp };

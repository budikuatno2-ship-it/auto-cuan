'use strict';

// C1 (22 Oct 2026) — the client IP may only be taken from a TRUSTED proxy chain.
//
// `lib/request-rate-limit.js` used to read the FIRST `x-forwarded-for` entry.
// Any caller could send `X-Forwarded-For: <their guess>` and the FIRST value is
// exactly the one they control, so a rate limit keyed on it bounded nothing:
// every request carried a fresh bucket. Behind Cloudflare the trustworthy signal
// is `CF-Connecting-IP`, which Cloudflare overwrites (a client value cannot
// survive the edge). When a local nginx sits in front, the right value is the
// LAST `x-forwarded-for` entry, because that entry is appended by the trusted
// hop closest to us.
//
// The rule implemented here:
//   1. Resolve the immediate peer (`socket.remoteAddress`).
//   2. If the peer is NOT a trusted proxy, the connection is direct: ignore all
//      forwarding headers and use the peer address (a direct attacker cannot
//      forge their own TCP source).
//   3. If the peer IS trusted, prefer `CF-Connecting-IP` (valid IP only); else
//      fall back to the LAST `x-forwarded-for` entry.
// This is fail-closed: without a trusted peer, headers are never believed.

const CF_V4_RANGES = [
  '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/13',
  '104.24.0.0/14', '108.162.192.0/18', '131.0.72.0/22', '141.101.64.0/18',
  '162.158.0.0/15', '172.64.0.0/13', '173.245.48.0/20', '188.114.96.0/20',
  '190.93.240.0/20', '197.234.240.0/22', '198.41.128.0/17'
];
const CF_V6_PREFIXES = [
  ['2400', 'cb00'], ['2606', '4700'], ['2803', 'f800'], ['2405', 'b500'],
  ['2405', '8100'], ['2a06', '98c0'], ['2c0f', 'f248']
];

function stripControl(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F\s]/g, ' ').trim();
}

// Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1) down to the IPv4 form and strip
// a zone id (fe80::1%eth0).
function normalizeIp(raw) {
  let ip = stripControl(raw).toLowerCase();
  if (!ip) return '';
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  if (ip.startsWith('::ffff:') && ip.indexOf('.', 7) > 0) ip = ip.slice(7);
  return ip;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

const CF_V4_INT = CF_V4_RANGES.map((range) => {
  const [net, bitsRaw] = range.split('/');
  const bits = Number(bitsRaw);
  const base = ipv4ToInt(net);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
});

function isCloudflareIpV4(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return false;
  return CF_V4_INT.some((r) => ((n & r.mask) >>> 0) === r.base);
}

function isCloudflareIpV6(ip) {
  const groups = ip.split(':');
  const g1 = (groups[0] || '').padStart(4, '0');
  const g2 = (groups[1] || '0').padStart(4, '0');
  return CF_V6_PREFIXES.some((pair) => pair[0] === g1 && pair[1] === g2);
}

function isLoopbackOrPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return false;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLoopbackOrPrivateIp(ip) {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  if (norm === '::1') return true;
  if (norm.indexOf(':') === -1) return isLoopbackOrPrivateV4(norm);
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  const first = parseInt(norm.split(':')[0] || '0', 16) || 0;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

function isCloudflareIp(ip) {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  if (norm.indexOf(':') === -1) return isCloudflareIpV4(norm);
  return isCloudflareIpV6(norm);
}

// A trusted proxy is the Cloudflare edge or a same-host / private hop (nginx).
function isTrustedProxyIp(ip) {
  return isCloudflareIp(ip) || isLoopbackOrPrivateIp(ip);
}

function looksLikeIp(value) {
  const norm = normalizeIp(value);
  if (!norm) return false;
  if (norm.indexOf(':') !== -1) return /^[0-9a-f:]+$/.test(norm);
  return ipv4ToInt(norm) != null;
}

// Extract the client address from a request, trusting headers only when the
// immediate peer is a trusted proxy.
function resolveClientAddress(req, options) {
  const opts = options || {};
  const headers = (req && req.headers) || {};
  const socket = (req && (req.socket || req.connection)) || {};
  const peerRaw = socket.remoteAddress || (req && req.ip) || '';
  const peer = normalizeIp(peerRaw);
  const trustedPeer = opts.assumeTrustedPeer === true || isTrustedProxyIp(peer);

  if (!trustedPeer) {
    // Direct connection: the TCP peer is authoritative and cannot be forged.
    return peer || 'unknown';
  }

  const cf = normalizeIp(headers['cf-connecting-ip']);
  if (cf && looksLikeIp(cf)) return cf.slice(0, 100);

  const xffParts = stripControl(headers['x-forwarded-for'])
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const last = xffParts.length ? xffParts[xffParts.length - 1] : '';
  if (last && looksLikeIp(last)) return normalizeIp(last).slice(0, 100);

  // nginx with `proxy_set_header X-Real-IP` sets it to the immediate upstream.
  const real = normalizeIp(headers['x-real-ip']);
  if (real && looksLikeIp(real)) return real.slice(0, 100);

  return peer || 'unknown';
}

module.exports = {
  normalizeIp,
  isCloudflareIp,
  isLoopbackOrPrivateIp,
  isTrustedProxyIp,
  resolveClientAddress,
  looksLikeIp
};

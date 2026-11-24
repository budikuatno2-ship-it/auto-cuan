'use strict';
// Preloaded into every process in the local batch. Only numeric loopback HTTP
// connections are permitted; DNS and external transports fail before I/O.
const net = require('node:net');
const dns = require('node:dns');
const allowed = host => ['127.0.0.1', '::1', 'localhost'].includes(host);
const blocked = host => { throw new Error('LOCAL_E2E_EXTERNAL_NETWORK_BLOCKED:' + String(host)); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const opts = Array.isArray(first) ? first[0] : first;
  const host = opts && typeof opts === 'object' ? opts.host || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!allowed(host)) return blocked(host);
  if (typeof opts === 'string' || opts && opts.path) return blocked('IPC');
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!['127.0.0.1', '::1'].includes(host)) return blocked('DNS:' + host);
  return lookup.call(this, host, ...args);
};
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  dns[name] = host => blocked('DNS:' + host);
  if (dns.promises && dns.promises[name]) dns.promises[name] = async host => blocked('DNS:' + host);
}
if (dns.promises) dns.promises.lookup = async host => {
  if (!['127.0.0.1', '::1'].includes(host)) return blocked('DNS:' + host);
  return { address: host, family: host === '::1' ? 6 : 4 };
};
const originalFetch = global.fetch;
if (originalFetch) global.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname.replace(/^\[|\]$/g, ''))) return blocked(url.hostname);
  return originalFetch(input, init);
};

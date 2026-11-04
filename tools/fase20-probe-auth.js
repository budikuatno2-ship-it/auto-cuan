#!/usr/bin/env node
'use strict';
// FASE 20 probe: verify that a locally-minted signed session authenticates
// against the real local API. Prints status codes only (never secrets).
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*SESSION_SECRET\s*=\s*(.+)$/);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, '');
        if (v) { process.env.SESSION_SECRET = v; return v; }
      }
    }
  } catch (_) {}
  return null;
}

function post(port, pathname, body, cookie, extraHeaders) {
  return new Promise(function (resolve) {
    const payload = JSON.stringify(body);
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }, extraHeaders || {});
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port: port, path: pathname, method: 'POST', headers: headers }, function (res) {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, rawLen: buf.length });
      });
    });
    req.on('error', e => resolve({ status: -1, error: String(e.message) }));
    req.write(payload);
    req.end();
  });
}

function get(port, pathname, cookie) {
  return new Promise(function (resolve) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    http.get({ hostname: '127.0.0.1', port: port, path: pathname, headers: headers }, function (res) {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, rawLen: buf.length, ctype: res.headers['content-type'] });
      });
    }).on('error', e => resolve({ status: -1, error: String(e.message) }));
  });
}

(async function () {
  const secret = loadSecret();
  console.log('session secret loaded:', Boolean(secret), 'len:', secret ? secret.length : 0);
  if (!secret) process.exit(1);

  const session = require(path.join(ROOT, 'lib', 'admin-session.js'));
  const adminToken = session.createSessionToken({ userId: 'audit-fase20-admin', username: 'budi', isAdmin: true });
  const nonAdminToken = session.createSessionToken({ userId: 'audit-fase20-user', username: 'audit_user', isAdmin: false });
  console.log('admin token minted:', Boolean(adminToken), 'len:', adminToken ? adminToken.length : 0);
  console.log('token verify:', JSON.stringify(session.verifySessionToken(adminToken).valid));

  const adminCookie = 'ac_sess=' + adminToken;
  const nonAdminCookie = 'ac_sess=' + nonAdminToken;

  let r;

  r = await post(3000, '/api/reset-password', { action: 'account-profile' }, adminCookie, { Origin: 'http://127.0.0.1:3000', Host: '127.0.0.1:3000' });
  console.log('account-profile [admin  ] ->', r.status, JSON.stringify(r.body || {}).slice(0, 220));

  r = await post(3000, '/api/reset-password', { action: 'account-profile' }, nonAdminCookie, { Origin: 'http://127.0.0.1:3000' });
  console.log('account-profile [nonadmin] ->', r.status, JSON.stringify(r.body || {}).slice(0, 220));

  r = await post(3000, '/api/reset-password', { action: 'account-profile' }, '', { Origin: 'http://127.0.0.1:3000' });
  console.log('account-profile [anon    ] ->', r.status, JSON.stringify(r.body || {}).slice(0, 200));

  r = await post(3000, '/api/admin-users?action=admin_console_stats', { action: 'admin_console_stats' }, adminCookie, { Origin: 'http://127.0.0.1:3000' });
  console.log('admin_console_stats [admin] ->', r.status, JSON.stringify(r.body || {}).slice(0, 200));

  r = await post(3000, '/api/admin-users?action=admin_console_stats', { action: 'admin_console_stats' }, nonAdminCookie, { Origin: 'http://127.0.0.1:3000' });
  console.log('admin_console_stats [nonadmin] ->', r.status, JSON.stringify(r.body || {}).slice(0, 160));

  r = await post(3000, '/api/admin-users?action=pattern_map_access', { action: 'pattern_map_access' }, nonAdminCookie, { Origin: 'http://127.0.0.1:3000' });
  console.log('pattern_map_access [nonadmin] ->', r.status, JSON.stringify(r.body || {}).slice(0, 140));

  r = await get(3000, '/api/sector-hot?action=sectors', '');
  console.log('sector-hot sectors ->', r.status, 'len=' + r.rawLen);

  r = await get(3000, '/api/sector-hot?action=screener', '');
  console.log('sector-hot screener ->', r.status, 'len=' + r.rawLen);

  r = await get(3000, '/api/quote?ticker=BBCA', '');
  console.log('quote BBCA ->', r.status, JSON.stringify(r.body || {}).slice(0, 160));

  r = await get(3000, '/api/candles?ticker=BBCA', '');
  console.log('candles BBCA ->', r.status, 'len=' + r.rawLen);

  r = await get(3000, '/api/sector-hot?action=bandarmologi&ticker=BBCA', '');
  console.log('bandarmologi BBCA ->', r.status, 'len=' + r.rawLen);

  r = await get(3000, '/api/sector-hot?action=track-record', '');
  console.log('track-record ->', r.status, 'len=' + r.rawLen);

  r = await get(3000, '/api/sector-hot?action=watchlist', '');
  console.log('watchlist ->', r.status, 'len=' + r.rawLen);

  r = await get(3000, '/api/sector-hot?action=admin-notes', '');
  console.log('admin-notes ->', r.status, 'len=' + r.rawLen);

  r = await get(3000, '/api/sector-hot?action=landing-snapshot', '');
  console.log('landing-snapshot ->', r.status, 'len=' + r.rawLen);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });

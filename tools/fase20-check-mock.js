#!/usr/bin/env node
'use strict';
// FASE 20 — check env URL sanity (no secret values printed) + confirm the
// documented dev-server preview mock answers the DB-dependent endpoints.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');

const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

function sanity(name) {
  const v = env[name];
  if (v === undefined) return name + ': (absent)';
  if (!v) return name + ': (empty)';
  try {
    const u = new URL(v);
    return name + ': valid URL, protocol=' + u.protocol + ', hostLooksLikeSupabase=' + /\.supabase\.co$/i.test(u.hostname) +
      ', hostLength=' + u.hostname.length;
  } catch (e) {
    return name + ': INVALID URL — ' + e.message.slice(0, 70);
  }
}
['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PORTFOLIO_AI_BASE_URL', 'SCREENER_AI_BASE_URL', 'CODECRAFTERS_BASE_URL']
  .forEach(n => console.log(sanity(n)));

function post(pathname, body, headers) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers || {});
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: pathname, method: 'POST', headers: h }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 200) }));
    });
    req.on('error', e => resolve({ status: -1, body: e.message }));
    req.write(payload); req.end();
  });
}

function get(pathname, headers) {
  return new Promise(resolve => {
    http.get({ hostname: '127.0.0.1', port: 3000, path: pathname, headers: headers || {} }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 200) }));
    }).on('error', e => resolve({ status: -1, body: e.message }));
  });
}

(async () => {
  console.log('');
  console.log('--- WITHOUT preview header (real handler path) ---');
  console.log('account-profile:', JSON.stringify(await post('/api/reset-password', { action: 'account-profile' }, {})));

  const PREVIEW = { 'x-autocuan-preview': '1', referer: 'http://127.0.0.1:3000/dashboard?page=dashboard' };
  console.log('');
  console.log('--- WITH documented dev preview header ---');
  console.log('account-profile:', JSON.stringify(await post('/api/reset-password', { action: 'account-profile' }, PREVIEW)));
  console.log('session-status :', JSON.stringify(await post('/api/reset-password', { action: 'session-status' }, PREVIEW)));
  console.log('portfolio-load :', JSON.stringify(await post('/api/reset-password', { action: 'portfolio-state-load' }, PREVIEW)));
  console.log('admin-notes    :', JSON.stringify(await get('/api/sector-hot?action=admin-notes', PREVIEW)));
  console.log('insider-network:', JSON.stringify(await get('/api/sector-hot?action=insider-network', PREVIEW)));
  console.log('broker-hunter  :', JSON.stringify(await get('/api/sector-hot?action=broker-hunter&broker=AK', PREVIEW)));
  console.log('available-dates:', JSON.stringify(await get('/api/sector-hot?action=available-dates&ticker=BBCA', PREVIEW)));
  console.log('money summary  :', JSON.stringify(await get('/api/money-management?action=summary', PREVIEW)));
  console.log('admin-users 403 :', JSON.stringify(await post('/api/admin-users?action=admin_console_stats', { action: 'admin_console_stats' }, PREVIEW)));
})();

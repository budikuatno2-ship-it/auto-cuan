'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const adminConsoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'admin-console.html'), 'utf8');
const adminUsersHandler = require('../api/admin-users');
const adminConsoleService = require('../lib/admin-console-service');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const localDevServer = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');

const { createSessionToken, buildSessionCookie } = require('../lib/admin-session');

test('Admin Console enforces authentication and 403 Forbidden for non-admin on server endpoints', async () => {
  process.env.SESSION_SECRET = 'test_secret_32_bytes_super_safe_admin_test';
  
  // 1. Unauthenticated request -> 401
  const reqUnauth = {
    method: 'POST',
    headers: { host: 'autocuan.web.id' },
    body: { action: 'admin_console_stats' }
  };
  let codeUnauth = 0;
  let jsonUnauth = null;
  const resUnauth = {
    status(c) { codeUnauth = c; return this; },
    json(j) { jsonUnauth = j; return this; }
  };
  await adminUsersHandler(reqUnauth, resUnauth);
  assert.equal(codeUnauth, 401, 'expected 401 Unauthorized for missing session');
  assert.equal(jsonUnauth.success, false);

  // 2. Authenticated non-admin request -> 403 Forbidden
  const nonAdminToken = createSessionToken({ uid: 'usr_normal', un: 'regular_trader', adm: false });
  const reqNonAdmin = {
    method: 'POST',
    headers: {
      host: 'autocuan.web.id',
      cookie: `ac_sess=${nonAdminToken}`
    },
    body: { action: 'admin_console_stats' }
  };
  let codeForbidden = 0;
  let jsonForbidden = null;
  const resForbidden = {
    status(c) { codeForbidden = c; return this; },
    json(j) { jsonForbidden = j; return this; }
  };
  await adminUsersHandler(reqNonAdmin, resForbidden);
  assert.equal(codeForbidden, 403, 'expected 403 Forbidden for authenticated non-admin');
  assert.equal(jsonForbidden.success, false);
});

test('Client heartbeat updates online session in memory with zero IP exposure', () => {
  adminConsoleService.recordHeartbeat('test_trader', '/screener', 'Safari · iOS');
  const result = adminConsoleService.getOnlineList('all');

  assert.ok(result.summary.online_now >= 1);
  const found = result.rows.find(r => r.username === 'test_trader');
  assert.ok(found, 'expected test_trader in online list');
  assert.equal(found.page, '/screener');
  assert.equal(found.device, 'Safari · iOS');
  assert.equal(found.status_code, 'online');

  // Verify zero IP addresses in data structure
  for (const row of result.rows) {
    assert.equal(row.ip, undefined);
    assert.equal(row.ip_address, undefined);
    assert.equal(row.client_ip, undefined);
  }
});

test('Dataset freshness displays honest data quota and zero internal provider names', () => {
  const freshness = adminConsoleService.getDatasetFreshness();
  assert.equal(freshness.quota.label, 'Kuota API data');
  assert.ok(freshness.quota.limit > 0);
  assert.ok(freshness.datasets.length >= 5);

  // Assert no internal names in UI dataset definitions
  const jsonStr = JSON.stringify(freshness);
  assert.doesNotMatch(jsonStr, /arjum/i, 'forbidden internal provider name in UI');
  assert.doesNotMatch(jsonStr, /vps/i, 'forbidden infrastructure term in UI');
  assert.doesNotMatch(jsonStr, /cron/i, 'forbidden cron term in UI');
});

test('Admin Console markup contains all 7 tabs and strict confirmation dialog', () => {
  assert.match(adminConsoleHtml, /data-admin-tab="0"/);
  assert.match(adminConsoleHtml, /data-admin-tab="1"/);
  assert.match(adminConsoleHtml, /data-admin-tab="2"/);
  assert.match(adminConsoleHtml, /data-admin-tab="3"/);
  assert.match(adminConsoleHtml, /data-admin-tab="4"/);
  assert.match(adminConsoleHtml, /data-admin-tab="5"/);
  assert.match(adminConsoleHtml, /data-admin-tab="6"/);

  // Destructive confirmation requirements
  assert.match(adminConsoleHtml, /id="dialogConfirmInput"/);
  assert.match(adminConsoleHtml, /id="dialogReasonInput"/);
  assert.match(adminConsoleHtml, /id="dialogSubmitBtn"/);

  // Zero user IP address columns
  assert.doesNotMatch(adminConsoleHtml, /<th>Alamat IP<\/th>/i);
  assert.doesNotMatch(adminConsoleHtml, /<th>IP<\/th>/i);
});

test('Admin Console route rewrites are present in vercel.json and local-dev-server.js', () => {
  const vercelRewrite = vercelJson.rewrites.find(r => r.source === '/admin-console');
  assert.ok(vercelRewrite, 'expected rewrite rule for /admin-console');
  assert.equal(vercelRewrite.destination, '/admin-console.html');

  assert.match(localDevServer, /'\/admin-console':\s*'\/admin-console\.html'/);
  assert.match(localDevServer, /'\/admin':\s*'\/admin-console\.html'/);
});

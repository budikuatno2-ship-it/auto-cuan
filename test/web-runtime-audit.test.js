'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function source(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('maintenance OTP watcher sleeps completely outside maintenance UI', function () {
  const ui = source('public/admin-maintenance-code.js');

  assert.match(ui, /function syncWatchState\(\)/);
  assert.match(ui, /MutationObserver/);
  assert.match(ui, /function scheduleStatusCheck\(delay\) \{\s*if \(runtimeStopped \|\| !activeScope\(\)\) return;/);
  assert.match(ui, /if \(!scope\) \{[\s\S]*?stopStatusChecks\(\);[\s\S]*?return;[\s\S]*?\}/);
  assert.doesNotMatch(ui, /scheduleStatusCheck\(document\.hidden \? HIDDEN_POLL_MS : IDLE_POLL_MS\);\s*return;/);
});

test('maintenance OTP network work is bounded and Telegram notice is off login critical path', function () {
  const ui = source('public/admin-maintenance-code.js');
  const browser = source('lib/admin-maintenance-code-browser.js');
  const gateway = source('api/reset-password.js');

  assert.match(ui, /WATCH_TIMEOUT_MS = 2500/);
  assert.match(ui, /ACTION_TIMEOUT_MS = 8000/);
  assert.match(ui, /AbortController/);
  assert.match(ui, /admin-maintenance-code-notify/);
  assert.match(ui, /keepalive: true/);

  const consumeStart = browser.indexOf('async function consume(');
  const notifyStart = browser.indexOf('async function notify(', consumeStart);
  assert.ok(consumeStart >= 0 && notifyStart > consumeStart);
  assert.doesNotMatch(browser.slice(consumeStart, notifyStart), /await notifySuccessfulLogin/);
  assert.match(browser, /state: 'already_notified'/);
  assert.match(gateway, /bodyAction === 'admin-maintenance-code-notify'/);
});

test('fast watcher browser refresh cannot remain stuck forever on a hung fetch', function () {
  const refresh = source('public/fast-watcher-live-refresh.js');

  assert.match(refresh, /REQUEST_TIMEOUT_MS = 8000/);
  assert.match(refresh, /AbortController/);
  assert.match(refresh, /controller\.abort\(\)/);
  assert.match(refresh, /reason: error && error\.name === 'AbortError' \? 'request_timeout' : 'request_failed'/);
  assert.match(refresh, /if \(activeController\) \{[\s\S]*?activeController\.abort\(\)/);
});

test('production loader cache keys point at audited runtimes', function () {
  const loader = source('public/website-approved-access.js');
  assert.match(loader, /admin-maintenance-code\.js\?v=20260822-v8/);
  assert.match(loader, /fast-watcher-live-refresh\.js\?v=20260822-v2/);
});

test('high-frequency maintenance status override is read-only', function () {
  const sql = source('supabase/admin-maintenance-code-readonly-status-migration.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_admin_maintenance_code_status\(\)/);
  assert.match(sql, /g\.expires_at > now\(\)/);
  assert.match(sql, /g\.code_attempts < 5/);
  assert.doesNotMatch(sql, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
});

'use strict';

/**
 * BATCH 8 — Stateful alert deduplication & cooldown tracking.
 *
 * Proves the centralized guard wired into `telegram-notifier.sendTelegramMessage`:
 *   1. First alert for a ticker passes and is recorded.
 *   2. A duplicate alert for the same ticker within the cooldown window is blocked.
 *   3. An alert is allowed again once the cooldown window expires.
 *   4. A significant status change (upgrade/downgrade) bypasses the cooldown.
 *   5. Alerts without an alert_key/ticker are never suppressed (backward compatible).
 *
 * No network, Telegram, or database is touched: global.fetch is stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const notifier = require('../lib/telegram-notifier');

// ------------------------------------------------------------------
// Deterministic environment + fetch stub.
// ------------------------------------------------------------------
process.env.TELEGRAM_ENABLED = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = '12345';

let fetchCalls = [];
const origFetch = global.fetch;
global.fetch = async function (url, init) {
  fetchCalls.push({ url: url, body: init && init.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, text: async function () { return ''; }, headers: { get: function () { return null; } } };
};

// A fixed "now" inside a Monday trading session so the market guard passes.
const SESSION_NOW = new Date('2026-09-14T03:00:00.000Z'); // 10:00 WIB Monday

function reset() {
  fetchCalls = [];
  notifier.clearAlertCooldownCache();
}

// ==================================================================
// 1. First alert passes and is recorded
// ==================================================================
test('first alert for a ticker passes and is recorded in the cooldown store', async function () {
  reset();
  const res = await notifier.sendTelegramMessage('BUY TLKM', {
    alert_key: 'TLKM', status: 'TRADE_CANDIDATE', now: SESSION_NOW
  });
  assert.equal(res.sent, true);
  assert.equal(fetchCalls.length, 1, 'exactly one network send');

  const status = notifier.getAlertCooldownStatus('TLKM', { now: SESSION_NOW });
  assert.ok(status, 'cooldown entry must exist after a successful send');
  assert.equal(status.status, 'TRADE_CANDIDATE');
  assert.equal(status.isExpired, false);
});

// ==================================================================
// 2. Duplicate within cooldown is blocked
// ==================================================================
test('duplicate alert for the same ticker within cooldown is blocked automatically', async function () {
  reset();
  const first = await notifier.sendTelegramMessage('BUY TLKM', {
    alert_key: 'TLKM', status: 'TRADE_CANDIDATE', now: SESSION_NOW
  });
  assert.equal(first.sent, true);

  const second = await notifier.sendTelegramMessage('BUY TLKM AGAIN', {
    alert_key: 'TLKM', status: 'TRADE_CANDIDATE', now: SESSION_NOW
  });
  assert.equal(second.sent, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'duplicate_suppressed');
  assert.ok(second.dedup_reason.includes('in_cooldown'));
  assert.equal(fetchCalls.length, 1, 'the duplicate must not hit the network');
});

// ==================================================================
// 3. Allowed again after cooldown expires
// ==================================================================
test('alert is allowed again once the cooldown window has expired', async function () {
  reset();
  await notifier.sendTelegramMessage('BUY TLKM', {
    alert_key: 'TLKM', status: 'TRADE_CANDIDATE', now: SESSION_NOW, cooldownMs: 60000
  });
  assert.equal(fetchCalls.length, 1);

  const later = new Date(SESSION_NOW.getTime() + 61000); // 61s later > 60s window
  const res = await notifier.sendTelegramMessage('BUY TLKM', {
    alert_key: 'TLKM', status: 'TRADE_CANDIDATE', now: later, cooldownMs: 60000
  });
  assert.equal(res.sent, true, 'expired cooldown must allow the alert');
  assert.equal(fetchCalls.length, 2);
});

// ==================================================================
// 4. Significant status change bypasses cooldown
// ==================================================================
test('status upgrade (Watchlist -> Confirmed Buy) bypasses an active cooldown', async function () {
  reset();
  await notifier.sendTelegramMessage('WATCH TLKM', {
    alert_key: 'TLKM', status: 'WATCHLIST', now: SESSION_NOW
  });
  assert.equal(fetchCalls.length, 1);

  const res = await notifier.sendTelegramMessage('BUY TLKM', {
    alert_key: 'TLKM', status: 'TRADE_CANDIDATE', now: SESSION_NOW
  });
  assert.equal(res.sent, true, 'upgrade to confirmed buy must bypass cooldown');
  assert.equal(fetchCalls.length, 2);
});

test('status downgrade (Normal -> SL_HIT) bypasses an active cooldown', async function () {
  reset();
  await notifier.sendTelegramMessage('BUY TLKM', {
    alert_key: 'TLKM', status: 'TRADE_CANDIDATE', now: SESSION_NOW
  });
  assert.equal(fetchCalls.length, 1);

  const res = await notifier.sendTelegramMessage('SL TLKM', {
    alert_key: 'TLKM', status: 'SL_HIT', now: SESSION_NOW
  });
  assert.equal(res.sent, true, 'downgrade to SL_HIT must bypass cooldown');
  assert.equal(fetchCalls.length, 2);
});

// ==================================================================
// 5. Backward compatibility: no alert_key -> never suppressed
// ==================================================================
test('alerts without an alert_key/ticker are never suppressed', async function () {
  reset();
  const a = await notifier.sendTelegramMessage('generic message', { now: SESSION_NOW });
  const b = await notifier.sendTelegramMessage('generic message', { now: SESSION_NOW });
  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(fetchCalls.length, 2, 'both generic messages must be sent');
});

// ==================================================================
// 6. Pure primitive: checkAlertCooldown / recordAlertCooldown
// ==================================================================
test('checkAlertCooldown reports suppression and remaining time deterministically', function () {
  notifier.clearAlertCooldownCache();
  const t0 = 1000000;
  notifier.recordAlertCooldown('BBCA', 'TRADE_CANDIDATE', { now: t0, cooldownMs: 20000 });

  const blocked = notifier.checkAlertCooldown('BBCA', 'TRADE_CANDIDATE', { now: t0 + 5000 });
  assert.equal(blocked.suppressed, true);
  assert.equal(blocked.remainingMs, 15000);

  const expired = notifier.checkAlertCooldown('BBCA', 'TRADE_CANDIDATE', { now: t0 + 20000 });
  assert.equal(expired.suppressed, false);
  assert.equal(expired.reason, 'cooldown_expired');

  const forced = notifier.checkAlertCooldown('BBCA', 'TRADE_CANDIDATE', { now: t0 + 5000, force: true });
  assert.equal(forced.suppressed, false);
  assert.equal(forced.reason, 'forced_bypass');
});

test('isDrasticAlertStatusChange only fires on meaningful transitions', function () {
  assert.equal(notifier.isDrasticAlertStatusChange('WATCHLIST', 'TRADE_CANDIDATE'), true);
  assert.equal(notifier.isDrasticAlertStatusChange('TRADE_CANDIDATE', 'SL_HIT'), true);
  assert.equal(notifier.isDrasticAlertStatusChange('TRADE_CANDIDATE', 'TRADE_CANDIDATE'), false);
  assert.equal(notifier.isDrasticAlertStatusChange('EARLY_RADAR', 'EARLY_RADAR'), false);
});

// Restore global fetch after the suite.
test.after(function () {
  global.fetch = origFetch;
});
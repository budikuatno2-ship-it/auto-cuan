'use strict';

// DARURAT 23 Oct 2026 — J1 saved 0 files because the market-hours guard in
// lib/arjum-client.js returns HTTP 400 "Di luar jam operasional bursa BEI" for
// any noFallback/forceFresh broker-summary call outside 09:00-16:00 WIB.
//
// J1 is an EOD job (16:30-17:45 and 23:30 WIB) and legitimately fetches
// POST-session data, so it must pass `bypassMarketGuard: true`. The guard itself
// is NOT changed and must keep blocking the web/live paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('J1 passes bypassMarketGuard for BOTH broker-summary calls (ALL and F)', () => {
  const src = read('tools/run-daily-broker-update.js');
  // ALL call
  assert.match(src, /fetchBrokerSummary\(ticker, dateArg, 'all', null, \{[\s\S]{0,400}?bypassMarketGuard: true/);
  // F call
  assert.match(src, /fetchBrokerSummary\(ticker, dateArg, 'F', null, \{[\s\S]{0,400}?bypassMarketGuard: true/);
});

test('the catch-up tool passes bypassMarketGuard for ALL and F', () => {
  const src = read('tools/catchup-missing-dates.js');
  assert.match(src, /fetchBrokerSummary\(ticker, p\.date, 'all', null, \{[^}]*bypassMarketGuard: true/);
  assert.match(src, /fetchBrokerSummary\(ticker, p\.date, 'F', null, \{[^}]*bypassMarketGuard: true/);
});

test('lib/arjum-client.js is NOT modified: the guard still exists and still blocks', () => {
  const src = read('lib/arjum-client.js');
  // The guard and its 400 branch must remain intact.
  assert.match(src, /shouldEnforceMarketHours\(\)/);
  assert.match(src, /Di luar jam operasional bursa BEI\./);
  assert.match(src, /if \(noFallback \|\| forceFresh\) \{/);
  // The bypass must be opt-in per call, never a global default.
  assert.match(src, /!\(options && options\.bypassMarketGuard\)/);
});

test('no ARJUM_DISABLE_MARKET_GUARD is set anywhere in the deploy/cron surface', () => {
  const cron = read('deploy/vps/final-schedule.cron');
  assert.doesNotMatch(cron, /ARJUM_DISABLE_MARKET_GUARD/);
  const eco = read('ecosystem.config.js');
  assert.doesNotMatch(eco, /ARJUM_DISABLE_MARKET_GUARD/);
});

test('the web/live path does NOT pass bypassMarketGuard (guard still protects visitors)', () => {
  // The bandarmologi service is the web-facing live path.
  const src = read('lib/bandarmologi-service.js');
  const liveCalls = src.match(/fetchBrokerSummary\([^)]*\)/g) || [];
  assert.ok(liveCalls.length > 0, 'expected live broker-summary calls in the service');
  for (const call of liveCalls) {
    assert.doesNotMatch(call, /bypassMarketGuard/, 'web path must never bypass the market guard: ' + call);
  }
});

test('the guard is time-based: 16:30 and 23:30 are outside 09:00-16:00', () => {
  // Mirrors isMarketHoursWib(): hour >= 9 && hour < 16.
  const inSession = (h) => h >= 9 && h < 16;
  assert.equal(inSession(16), false, '16:30 is outside the session');
  assert.equal(inSession(23), false, '23:30 is outside the session');
  assert.equal(inSession(10), true, '10:00 is inside the session');
});

test('a zero-saved J1 run is NOT recorded as a success and alarms', () => {
  const src = read('tools/run-daily-market-update.js');
  assert.match(src, /recordZeroSaved\(/);
  assert.match(src, /if\(saved > 0\)\{/);
  const alarm = read('lib/j1-skip-alarm.js');
  assert.match(alarm, /function recordZeroSaved/);
  assert.match(alarm, /last_alert_reason: 'zero_saved'/);
});

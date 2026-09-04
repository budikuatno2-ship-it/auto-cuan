'use strict';

// ===========================================================================
// Regression: getWIBDateString() (public/index.html) double-counted the zone
// offset.
//
//   new Date(now.getTime() + 7h - (now.getTimezoneOffset() * 60000))
//
// getTimezoneOffset() is (UTC - local) in minutes, so a browser already in WIB
// reports -420 and the subtraction added a SECOND seven hours. toISOString()
// then read that in UTC, putting the result 7 hours ahead: from 17:00 WIB
// onwards it returned TOMORROW's date.
//
// It feeds getAIUsageKey() (public/index.html), the localStorage key holding the
// guest 3-per-WIB-day AI quota, so the quota rolled over at 17:00 WIB instead of
// midnight. Not a security control — the premium gate is server-side — but a
// real off-by-a-timezone.
//
// The old form was correct only for a browser running in UTC, which is where CI
// runs. So every case here simulates a WIB browser (getTimezoneOffset() = -420);
// otherwise this file would pass against the buggy code and prove nothing.
//
// LOCAL / STATIC ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

// A Date whose no-arg form is a fixed instant and which reports the given zone,
// so the helper is exercised the way an Indonesian user's browser would run it.
function runAt(instantIso, offsetMinutes) {
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(instantIso); else super(...args);
    }
    getTimezoneOffset() { return offsetMinutes; }
  }
  const sandbox = { Date: FakeDate };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(html, 'function getWIBDateString('), sandbox);
  return sandbox.getWIBDateString();
}

const WIB = -420;   // Asia/Jakarta, UTC+7
const UTC = 0;

test('a WIB browser gets the WIB calendar date after 17:00 local', () => {
  // 11:00Z is 18:00 WIB, the case that used to roll to tomorrow.
  assert.equal(runAt('2026-09-03T11:00:00Z', WIB), '2026-09-03');
});

test('a WIB browser gets the WIB calendar date across the whole day', () => {
  assert.equal(runAt('2026-09-02T17:00:00Z', WIB), '2026-09-03', '00:00 WIB — the day has just rolled');
  assert.equal(runAt('2026-09-03T02:00:00Z', WIB), '2026-09-03', '09:00 WIB');
  assert.equal(runAt('2026-09-03T05:30:00Z', WIB), '2026-09-03', '12:30 WIB');
  assert.equal(runAt('2026-09-03T16:59:59Z', WIB), '2026-09-03', '23:59 WIB — still the same day');
  assert.equal(runAt('2026-09-03T17:00:00Z', WIB), '2026-09-04', '00:00 WIB — the next day begins');
});

test('the date rolls exactly at midnight WIB, not seven hours early', () => {
  const justBefore = runAt('2026-09-03T16:59:59Z', WIB);
  const justAfter = runAt('2026-09-03T17:00:00Z', WIB);
  assert.notEqual(justBefore, justAfter, 'the boundary must exist');
  assert.equal(justBefore, '2026-09-03');
  assert.equal(justAfter, '2026-09-04');

  // The old form rolled here instead. Pin it so a regression is unambiguous.
  assert.equal(runAt('2026-09-03T10:00:00Z', WIB), '2026-09-03', '17:00 WIB must NOT already be tomorrow');
});

test('the result does not depend on the browser zone', () => {
  // The same instant is the same WIB date whether the user sits in Jakarta,
  // London or anywhere else — getTime() is absolute.
  const instant = '2026-09-03T11:00:00Z';
  const fromJakarta = runAt(instant, WIB);
  const fromUtc = runAt(instant, UTC);
  const fromNewYork = runAt(instant, 240);
  const fromTokyo = runAt(instant, -540);
  assert.equal(fromJakarta, '2026-09-03');
  assert.equal(fromUtc, fromJakarta);
  assert.equal(fromNewYork, fromJakarta);
  assert.equal(fromTokyo, fromJakarta);
});

test('the helper returns a plain YYYY-MM-DD date', () => {
  assert.match(runAt('2026-09-03T11:00:00Z', WIB), /^\d{4}-\d{2}-\d{2}$/);
});

test('the guest AI quota key is scoped by that date', () => {
  // Locks the reason this matters: the key must change once per WIB day.
  const source = extractFunction(html, 'function getAIUsageKey(');
  assert.match(source, /getWIBDateString\(\)/,
    'the guest quota key must remain scoped to the WIB date');
});

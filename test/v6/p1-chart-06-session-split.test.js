'use strict';

/**
 * P1-CHART-06 — IDX per-day split session guard regression.
 *
 * Proves that evaluateDayTradeSessionGuard NEVER returns IN_SESSION during:
 *   - Mon-Thu lunch break 12:00-13:29 WIB (inclusive start, exclusive end 13:30)
 *   - Fri lunch break     11:30-13:59 WIB (inclusive start, exclusive end 14:00)
 * and that the boundary minutes just outside each break are classified correctly.
 *
 * WIB = UTC+7. Test timestamps are built as Date.UTC(y, m, d, h-7, min) so the
 * guard's internal `new Date(ms + 7h)` sees the intended WIB wall-clock time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const rt = require(path.join(ROOT, 'public', 'chart-auto-patterns-runtime.js'));

function wibMs(year, monthIndex, day, hour, minute) {
  return Date.UTC(year, monthIndex, day, hour - 7, minute, 0, 0);
}

// 2026-11-16 Mon, 17 Tue, 18 Wed, 19 Thu, 20 Fri (verified calendar week).
const MON_THU = [
  [2026, 10, 16], [2026, 10, 17], [2026, 10, 18], [2026, 10, 19],
];
const FRI = [[2026, 10, 20]];

function assertBreak(ms, label) {
  const g = rt.evaluateDayTradeSessionGuard(ms);
  assert.notEqual(g.code, 'IN_SESSION', label + ' must never be IN_SESSION (got ' + g.code + ')');
  assert.equal(g.ok, false, label + ' must have ok=false');
  assert.equal(g.code, 'SESSION_BREAK', label + ' must be SESSION_BREAK (got ' + g.code + ')');
}

test('P1-CHART-06: Mon-Thu 12:00-13:29 WIB is never IN_SESSION (minute-by-minute)', () => {
  let checked = 0;
  for (const [y, m, d] of MON_THU) {
    for (let mins = 12 * 60; mins < 13 * 60 + 30; mins++) {
      const h = Math.floor(mins / 60), mi = mins % 60;
      assertBreak(wibMs(y, m, d, h, mi), `${y}-${m + 1}-${d} ${h}:${mi} WIB`);
      checked++;
    }
  }
  assert.equal(checked, 4 * 90); // 4 days x 90 minutes
});

test('P1-CHART-06: Fri 11:30-13:59 WIB is never IN_SESSION (minute-by-minute)', () => {
  let checked = 0;
  for (const [y, m, d] of FRI) {
    for (let mins = 11 * 60 + 30; mins < 14 * 60; mins++) {
      const h = Math.floor(mins / 60), mi = mins % 60;
      assertBreak(wibMs(y, m, d, h, mi), `${y}-${m + 1}-${d} ${h}:${mi} WIB`);
      checked++;
    }
  }
  assert.equal(checked, 150); // 1 day x 150 minutes
});

test('P1-CHART-06: Mon-Thu break boundaries (11:59 IN, 12:00 BREAK, 13:29 BREAK, 13:30 IN)', () => {
  const [y, m, d] = MON_THU[0];
  assert.equal(rt.evaluateDayTradeSessionGuard(wibMs(y, m, d, 11, 59)).code, 'IN_SESSION');
  assertBreak(wibMs(y, m, d, 12, 0), 'Mon 12:00');
  assertBreak(wibMs(y, m, d, 13, 29), 'Mon 13:29');
  assert.equal(rt.evaluateDayTradeSessionGuard(wibMs(y, m, d, 13, 30)).code, 'IN_SESSION');
});

test('P1-CHART-06: Fri break boundaries (11:29 IN, 11:30 BREAK, 13:59 BREAK, 14:00 IN)', () => {
  const [y, m, d] = FRI[0];
  assert.equal(rt.evaluateDayTradeSessionGuard(wibMs(y, m, d, 11, 29)).code, 'IN_SESSION');
  assertBreak(wibMs(y, m, d, 11, 30), 'Fri 11:30');
  assertBreak(wibMs(y, m, d, 13, 59), 'Fri 13:59');
  assert.equal(rt.evaluateDayTradeSessionGuard(wibMs(y, m, d, 14, 0)).code, 'IN_SESSION');
});

test('P1-CHART-06: Fri morning 12:00 is BREAK (not the Mon-Thu 12:00 window)', () => {
  // Regression for the original defect: a single global 12:00-13:30 break would
  // wrongly mark Fri 12:00 as IN_SESSION. Fri break starts earlier at 11:30.
  const [y, m, d] = FRI[0];
  assertBreak(wibMs(y, m, d, 12, 0), 'Fri 12:00');
  assertBreak(wibMs(y, m, d, 13, 30), 'Fri 13:30');
});

test('P1-CHART-06: Mon-Thu 11:30 is IN_SESSION (Fri-only early break must not leak)', () => {
  const [y, m, d] = MON_THU[0];
  assert.equal(rt.evaluateDayTradeSessionGuard(wibMs(y, m, d, 11, 30)).code, 'IN_SESSION');
});

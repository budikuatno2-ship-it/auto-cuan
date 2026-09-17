'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getWibComponents, getMarketSession, isMarketOpen } = require('../lib/market-hours-guard');

// Helper to construct deterministic UTC timestamp corresponding to specified WIB time on a target date
function makeWibDate(dateStr, timeStr) {
  // e.g. dateStr='2026-09-17', timeStr='12:45' -> WIB (UTC+7) -> '2026-09-17T12:45:00+07:00'
  return new Date(`${dateStr}T${timeStr}:00+07:00`);
}

test('Market Hours Guard - Senin s/d Kamis Schedule & Boundary Tests', () => {
  const thursday = '2026-09-17'; // Thursday

  // 08:59 WIB - Before open
  assert.equal(isMarketOpen(makeWibDate(thursday, '08:59')), false);
  assert.equal(getMarketSession(makeWibDate(thursday, '08:59')), 'CLOSED');

  // 09:00 WIB - Session 1 Open
  assert.equal(isMarketOpen(makeWibDate(thursday, '09:00')), true);
  assert.equal(getMarketSession(makeWibDate(thursday, '09:00')), 'SESSION_1');

  // 10:30 WIB - Active Session 1
  assert.equal(isMarketOpen(makeWibDate(thursday, '10:30')), true);
  assert.equal(getMarketSession(makeWibDate(thursday, '10:30')), 'SESSION_1');

  // 11:58 WIB - Session 1 Final minute (buffer 2m before 12:00)
  assert.equal(isMarketOpen(makeWibDate(thursday, '11:58')), true);
  assert.equal(getMarketSession(makeWibDate(thursday, '11:58')), 'SESSION_1');

  // 11:59 WIB - Closed before lunch break
  assert.equal(isMarketOpen(makeWibDate(thursday, '11:59')), false);
  assert.equal(getMarketSession(makeWibDate(thursday, '11:59')), 'CLOSED');

  // 12:00 WIB - Lunch break start
  assert.equal(isMarketOpen(makeWibDate(thursday, '12:00')), false);
  assert.equal(getMarketSession(makeWibDate(thursday, '12:00')), 'CLOSED');

  // 12:45 WIB - Real incident case: Telegram broadcast must be strictly blocked!
  assert.equal(isMarketOpen(makeWibDate(thursday, '12:45')), false);
  assert.equal(getMarketSession(makeWibDate(thursday, '12:45')), 'CLOSED');

  // 13:29 WIB - Minute before Session 2
  assert.equal(isMarketOpen(makeWibDate(thursday, '13:29')), false);
  assert.equal(getMarketSession(makeWibDate(thursday, '13:29')), 'CLOSED');

  // 13:30 WIB - Session 2 Open
  assert.equal(isMarketOpen(makeWibDate(thursday, '13:30')), true);
  assert.equal(getMarketSession(makeWibDate(thursday, '13:30')), 'SESSION_2');

  // 14:45 WIB - Active Session 2
  assert.equal(isMarketOpen(makeWibDate(thursday, '14:45')), true);
  assert.equal(getMarketSession(makeWibDate(thursday, '14:45')), 'SESSION_2');

  // 15:45 WIB - Session 2 Final minute
  assert.equal(isMarketOpen(makeWibDate(thursday, '15:45')), true);
  assert.equal(getMarketSession(makeWibDate(thursday, '15:45')), 'SESSION_2');

  // 15:46 WIB - After close / Pre-closing / Cooling period
  assert.equal(isMarketOpen(makeWibDate(thursday, '15:46')), false);
  assert.equal(getMarketSession(makeWibDate(thursday, '15:46')), 'CLOSED');
});

test('Market Hours Guard - Khusus Hari Jumat Schedule & Boundary Tests', () => {
  const friday = '2026-09-18'; // Friday

  // 08:59 WIB - Before open
  assert.equal(isMarketOpen(makeWibDate(friday, '08:59')), false);
  assert.equal(getMarketSession(makeWibDate(friday, '08:59')), 'CLOSED');

  // 09:00 WIB - Session 1 Open
  assert.equal(isMarketOpen(makeWibDate(friday, '09:00')), true);
  assert.equal(getMarketSession(makeWibDate(friday, '09:00')), 'SESSION_1');

  // 11:28 WIB - Session 1 Final minute on Friday (buffer 2m before 11:30)
  assert.equal(isMarketOpen(makeWibDate(friday, '11:28')), true);
  assert.equal(getMarketSession(makeWibDate(friday, '11:28')), 'SESSION_1');

  // 11:29 WIB - Closed before Friday prayer break
  assert.equal(isMarketOpen(makeWibDate(friday, '11:29')), false);
  assert.equal(getMarketSession(makeWibDate(friday, '11:29')), 'CLOSED');

  // 11:35 WIB - Friday prayer break
  assert.equal(isMarketOpen(makeWibDate(friday, '11:35')), false);
  assert.equal(getMarketSession(makeWibDate(friday, '11:35')), 'CLOSED');

  // 13:45 WIB - Still in Friday prayer break
  assert.equal(isMarketOpen(makeWibDate(friday, '13:45')), false);
  assert.equal(getMarketSession(makeWibDate(friday, '13:45')), 'CLOSED');

  // 13:59 WIB - Minute before Session 2 on Friday
  assert.equal(isMarketOpen(makeWibDate(friday, '13:59')), false);
  assert.equal(getMarketSession(makeWibDate(friday, '13:59')), 'CLOSED');

  // 14:00 WIB - Session 2 Open on Friday
  assert.equal(isMarketOpen(makeWibDate(friday, '14:00')), true);
  assert.equal(getMarketSession(makeWibDate(friday, '14:00')), 'SESSION_2');

  // 15:45 WIB - Session 2 Final minute on Friday
  assert.equal(isMarketOpen(makeWibDate(friday, '15:45')), true);
  assert.equal(getMarketSession(makeWibDate(friday, '15:45')), 'SESSION_2');

  // 15:46 WIB - After close on Friday
  assert.equal(isMarketOpen(makeWibDate(friday, '15:46')), false);
  assert.equal(getMarketSession(makeWibDate(friday, '15:46')), 'CLOSED');
});

test('Market Hours Guard - Weekend Tests (Saturday & Sunday)', () => {
  const saturday = '2026-09-19';
  const sunday = '2026-09-20';

  // Saturday daytime & afternoon
  assert.equal(isMarketOpen(makeWibDate(saturday, '10:00')), false);
  assert.equal(getMarketSession(makeWibDate(saturday, '10:00')), 'CLOSED');
  assert.equal(isMarketOpen(makeWibDate(saturday, '14:00')), false);
  assert.equal(getMarketSession(makeWibDate(saturday, '14:00')), 'CLOSED');

  // Sunday daytime & afternoon
  assert.equal(isMarketOpen(makeWibDate(sunday, '10:00')), false);
  assert.equal(getMarketSession(makeWibDate(sunday, '10:00')), 'CLOSED');
  assert.equal(isMarketOpen(makeWibDate(sunday, '14:00')), false);
  assert.equal(getMarketSession(makeWibDate(sunday, '14:00')), 'CLOSED');
});

test('Market Hours Guard - Timezone Robustness (UTC input simulation)', () => {
  // 12:45 WIB corresponds to 05:45 UTC
  const utcDate = new Date('2026-09-17T05:45:00.000Z');
  const wib = getWibComponents(utcDate);

  assert.equal(wib.isValid, true);
  assert.equal(wib.hours, 12);
  assert.equal(wib.minutes, 45);
  assert.equal(wib.timeStr, '12:45');
  assert.equal(wib.totalMinutes, 765);
  assert.equal(isMarketOpen(utcDate), false);
  assert.equal(getMarketSession(utcDate), 'CLOSED');
});

test('Market Hours Guard - Invalid Input Handling', () => {
  assert.equal(isMarketOpen('invalid-date'), false);
  assert.equal(getMarketSession('invalid-date'), 'CLOSED');
  const invalidWib = getWibComponents('invalid-date');
  assert.equal(invalidWib.isValid, false);
});

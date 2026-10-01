'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSeedRows, IDX_HOLIDAYS_2026, SOURCE } = require('../lib/idx-holidays-2026-seed-data');
const calendar = require('../lib/idx-trading-calendar');

function seedHolidaySet() {
  return new Set(IDX_HOLIDAYS_2026.map((h) => h.trade_date));
}

test('seed contains exactly the 22 user-provided dates, no fabricated extras', () => {
  assert.equal(IDX_HOLIDAYS_2026.length, 22);
  const rows = buildSeedRows();
  assert.equal(rows.length, 22);
  rows.forEach((r) => {
    assert.equal(r.status, 'HOLIDAY');
    assert.equal(r.source, SOURCE);
    assert.equal(r.verified_at, null); // unverified until independently confirmed
    assert.equal(r.override_reason, null);
  });
});

test('2026-08-17 (Proklamasi Kemerdekaan) resolves CLOSED', () => {
  assert.equal(calendar.isTradingDay('2026-08-17', seedHolidaySet()), false);
});

test('2026-08-25 (Maulid Nabi Muhammad SAW) resolves CLOSED', () => {
  assert.equal(calendar.isTradingDay('2026-08-25', seedHolidaySet()), false);
});

test('2026-12-31 (Libur Bursa) resolves CLOSED', () => {
  assert.equal(calendar.isTradingDay('2026-12-31', seedHolidaySet()), false);
});

test('2026-08-18 resolves as the next trading day after the Aug 17 holiday', () => {
  assert.equal(calendar.nextTradingDay('2026-08-17', seedHolidaySet()), '2026-08-18');
});

test('last-N-trading-days skips both weekends and seeded holidays around Aug 17', () => {
  // 2026-08-17 (Mon) is a seeded holiday. Anchor on 2026-08-19 (Wed):
  // expected sessions walking back: Wed 08-19, Tue 08-18, [skip Mon 08-17 holiday],
  // [skip Sat/Sun], Fri 08-14, Thu 08-13.
  const days = calendar.getLastTradingDays('2026-08-19', 5, seedHolidaySet());
  assert.deepEqual(days, ['2026-08-19', '2026-08-18', '2026-08-14', '2026-08-13', '2026-08-12']);
  assert.equal(days.includes('2026-08-17'), false);
});

test('last-N-trading-days around the Idul Fitri cluster skips the 5-holiday block plus surrounding weekend', () => {
  // 2026-03-20 (Fri), 03-23 (Mon), 03-24 (Tue) are holidays; 03-21/22 is a weekend.
  // Anchor on 2026-03-25 (Wed): previous trading day should be 2026-03-19 is ALSO
  // a holiday (Nyepi) and 03-18 is a holiday too, so it should land on 2026-03-17 (Tue).
  const holidays = seedHolidaySet();
  const prev = calendar.previousTradingDay('2026-03-25', holidays);
  assert.equal(prev, '2026-03-17');
});

test('July, September, October, November 2026 have no seeded holiday rows (weekends only)', () => {
  const months = IDX_HOLIDAYS_2026.map((h) => h.trade_date.slice(0, 7));
  ['2026-07', '2026-09', '2026-10', '2026-11'].forEach((month) => {
    assert.equal(months.includes(month), false, month + ' should have no seeded holiday rows');
  });
});

test('buildSeedRows output is idempotent (deterministic, no random/time-based fields)', () => {
  const a = JSON.stringify(buildSeedRows());
  const b = JSON.stringify(buildSeedRows());
  assert.equal(a, b);
});

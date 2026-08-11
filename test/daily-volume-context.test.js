'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildVolumeContext, classifyPriceVolume } = require('../lib/daily-volume-context');

function row(trade_date, close, volume, quality) {
  return { trade_date, close, volume, data_quality_status: quality || 'ok' };
}

test('previous-session comparison uses rows[0] as today and rows[1] as previous', () => {
  const rows = [row('2026-08-11', 110, 2000), row('2026-08-10', 100, 1000)];
  const ctx = buildVolumeContext(rows);
  assert.equal(ctx.volume_today, 2000);
  assert.equal(ctx.volume_previous_session, 1000);
  assert.equal(ctx.volume_ratio_vs_previous, 2);
  assert.equal(ctx.volume_change_1d_pct, 100);
});

test('7-session average and median are computed from up to 7 rows', () => {
  const rows = [
    row('2026-08-11', 100, 700),
    row('2026-08-10', 100, 600),
    row('2026-08-07', 100, 500),
    row('2026-08-06', 100, 400),
    row('2026-08-05', 100, 300),
    row('2026-08-04', 100, 200),
    row('2026-08-03', 100, 100)
  ];
  const ctx = buildVolumeContext(rows);
  assert.equal(ctx.volume_avg_7d, 400); // (700+600+500+400+300+200+100)/7
  assert.equal(ctx.volume_median_7d, 400);
});

test('missing session (fewer than 7 rows) does not fabricate zeros', () => {
  const rows = [row('2026-08-11', 100, 700), row('2026-08-10', 100, 600)];
  const ctx = buildVolumeContext(rows);
  assert.equal(ctx.volume_avg_7d, 650);
  assert.equal(ctx.volume_history_7d.length, 2);
});

test('empty history returns all nulls, never zero', () => {
  const ctx = buildVolumeContext([]);
  assert.equal(ctx.volume_today, null);
  assert.equal(ctx.volume_previous_session, null);
  assert.equal(ctx.volume_avg_7d, null);
  assert.equal(ctx.volume_ratio_vs_previous, null);
});

test('partial current session is excluded from the 7-day average and flagged', () => {
  const rows = [
    row('2026-08-11', 100, 50, 'partial'), // today, partial/intraday
    row('2026-08-10', 100, 1000),
    row('2026-08-07', 100, 1000),
    row('2026-08-06', 100, 1000),
    row('2026-08-05', 100, 1000),
    row('2026-08-04', 100, 1000),
    row('2026-08-03', 100, 1000),
    row('2026-08-02', 100, 1000)
  ];
  const ctx = buildVolumeContext(rows);
  assert.equal(ctx.is_today_partial_session, true);
  assert.equal(ctx.volume_avg_7d, 1000); // excludes the 50-volume partial row
});

test('volume_history_7d is ordered oldest-first for chart display', () => {
  const rows = [row('2026-08-11', 100, 700), row('2026-08-10', 100, 600)];
  const ctx = buildVolumeContext(rows);
  assert.equal(ctx.volume_history_7d[0].trade_date, '2026-08-10');
  assert.equal(ctx.volume_history_7d[1].trade_date, '2026-08-11');
});

test('classifyPriceVolume covers all four quadrants plus unclear', () => {
  assert.equal(classifyPriceVolume(1, 1), 'PRICE_UP_VOLUME_UP');
  assert.equal(classifyPriceVolume(1, -1), 'PRICE_UP_VOLUME_DOWN');
  assert.equal(classifyPriceVolume(-1, 1), 'PRICE_DOWN_VOLUME_UP');
  assert.equal(classifyPriceVolume(-1, -1), 'PRICE_DOWN_VOLUME_DOWN');
  assert.equal(classifyPriceVolume(0, 0), 'FLAT_OR_UNCLEAR');
  assert.equal(classifyPriceVolume(null, 1), 'FLAT_OR_UNCLEAR');
});

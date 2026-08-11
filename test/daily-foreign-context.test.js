'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildForeignContext } = require('../lib/daily-foreign-context');

function row(trade_date, foreign_net) {
  return { trade_date, foreign_buy: null, foreign_sell: null, foreign_net };
}

test('correct net aggregation over 3/5/7 sessions', () => {
  const rows = [
    row('d7', 100), row('d6', 200), row('d5', -50), row('d4', 300),
    row('d3', -20), row('d2', 10), row('d1', 40)
  ];
  const ctx = buildForeignContext(rows);
  assert.equal(ctx.foreign_net_today, 100);
  assert.equal(ctx.foreign_net_3d, 100 + 200 - 50);
  assert.equal(ctx.foreign_net_5d, 100 + 200 - 50 + 300 - 20);
  assert.equal(ctx.foreign_net_7d, 100 + 200 - 50 + 300 - 20 + 10 + 40);
});

test('missing data is never converted to zero', () => {
  const rows = [row('d3', 100), row('d2', null), row('d1', 50)];
  const ctx = buildForeignContext(rows);
  // sum should only include the two known values, not treat null as 0
  assert.equal(ctx.foreign_net_3d, 150);
  assert.equal(ctx.foreign_net_7d_data_quality, 'partial');
  assert.equal(ctx.foreign_net_7d_sessions_missing, 1);
});

test('all-missing window returns null sum, not zero', () => {
  const rows = [row('d1', null)];
  const ctx = buildForeignContext(rows);
  assert.equal(ctx.foreign_net_3d, null);
});

test('positive/negative day counting ignores missing days', () => {
  const rows = [row('d5', 10), row('d4', -5), row('d3', null), row('d2', 20), row('d1', -1)];
  const ctx = buildForeignContext(rows);
  assert.equal(ctx.foreign_positive_days_7d, 2);
  assert.equal(ctx.foreign_negative_days_7d, 2);
});

test('foreign_net_streak counts consecutive same-sign sessions from most recent', () => {
  const rows = [row('d4', 10), row('d3', 20), row('d2', -5), row('d1', 30)];
  const ctx = buildForeignContext(rows);
  assert.equal(ctx.foreign_net_streak, 2); // two positive days in a row before the negative
});

test('foreign_net_streak resets to 0 on empty/zero-first data', () => {
  const rows = [row('d1', 0)];
  const ctx = buildForeignContext(rows);
  assert.equal(ctx.foreign_net_streak, 0);
});

test('foreign_history_7d preserves unit and is oldest-first', () => {
  const rows = [row('2026-08-11', 100), row('2026-08-10', -50)];
  const ctx = buildForeignContext(rows);
  assert.equal(ctx.unit, 'IDR_VALUE');
  assert.equal(ctx.foreign_history_7d[0].trade_date, '2026-08-10');
  assert.equal(ctx.foreign_history_7d[0].unit, 'IDR_VALUE');
});

test('empty rows produce nulls, not zeros', () => {
  const ctx = buildForeignContext([]);
  assert.equal(ctx.foreign_net_today, null);
  assert.equal(ctx.foreign_net_today_missing, true);
  assert.equal(ctx.foreign_net_7d, null);
});

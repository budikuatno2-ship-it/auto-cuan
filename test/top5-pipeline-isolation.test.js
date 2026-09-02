'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot');
const { isTop5PickRow, filterSafeDashboardLockedTop5Rows } = sectorHot.__test;

test('isTop5PickRow accurately isolates Top 5 rows from other pipelines', () => {
  assert.equal(isTop5PickRow({ monitor_source: 'daily_top5' }), true);
  assert.equal(isTop5PickRow({ monitor_source: 'top5' }), true);
  assert.equal(isTop5PickRow({ raw_payload: { monitor_source: 'daily_top5' } }), true);
  assert.equal(isTop5PickRow({ raw_payload: { lock_source: 'telegram-daily-picks.lock_only' } }), true);
  assert.equal(isTop5PickRow({ raw_payload: { web_daily_locked_at: '2026-08-10T08:00:00Z' } }), true);
  assert.equal(isTop5PickRow({ category: 'Swing Konglo' }), true);

  assert.equal(isTop5PickRow({ monitor_source: 'daytrade' }), false);
  assert.equal(isTop5PickRow({ monitor_source: 'daytrade_signal' }), false);
  assert.equal(isTop5PickRow({ monitor_source: 'day_trade' }), false);
  assert.equal(isTop5PickRow({ monitor_source: 'swing_nk' }), false);
  assert.equal(isTop5PickRow({ monitor_source: 'swing_non_konglo' }), false);
  assert.equal(isTop5PickRow({ category: 'Day Trade' }), false);
  assert.equal(isTop5PickRow({ category: 'Swing Non-Konglo' }), false);
});

test('filterSafeDashboardLockedTop5Rows drops Day Trade and Swing NK rows from Dashboard Top 5', () => {
  const mixedRows = [
    {
      id: 1,
      ticker: 'BUMI',
      category: 'Day Trade',
      monitor_source: 'daytrade',
      first_sent_at: '2026-08-10T07:45:00Z',
      status: 'WAITING',
      entry1: 150, entry2: 145, tp1: 160, tp2: 170, sl: 140
    },
    {
      id: 2,
      ticker: 'HEAL',
      category: 'Swing Non-Konglo',
      monitor_source: 'swing_nk',
      first_sent_at: '2026-08-10T07:30:00Z',
      status: 'WAITING',
      entry1: 1500, entry2: 1450, tp1: 1650, tp2: 1750, sl: 1400
    },
    {
      id: 3,
      ticker: 'BBCA',
      category: 'Swing Konglo',
      monitor_source: 'daily_top5',
      first_sent_at: '2026-08-10T08:00:00Z',
      status: 'WAITING',
      entry1: 9500, entry2: 9400, tp1: 10000, tp2: 10500, sl: 9200
    }
  ];

  const filtered = filterSafeDashboardLockedTop5Rows(mixedRows);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].ticker, 'BBCA');
});

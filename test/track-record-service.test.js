'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration,
  calculateGainPct,
  buildTrackRecordData
} = require('../lib/track-record-service');

test('formatDuration calculates human-readable duration correctly', () => {
  assert.equal(formatDuration(null, null), '—');
  assert.equal(formatDuration('2026-08-25T01:00:00Z', '2026-08-25T01:15:00Z'), '15 m');
  assert.equal(formatDuration('2026-08-25T01:00:00Z', '2026-08-25T04:30:00Z'), '3.5 jam');
  assert.equal(formatDuration('2026-08-20T01:00:00Z', '2026-08-22T01:00:00Z'), '2 hari');
});

test('calculateGainPct calculates percentage gain or loss from entry', () => {
  const row = { entry1: 1000, tp1: 1050, tp2: 1100, sl: 950 };
  assert.equal(calculateGainPct(row, 'TP1_HIT'), 5);
  assert.equal(calculateGainPct(row, 'TP2_HIT'), 10);
  assert.equal(calculateGainPct(row, 'SL_HIT'), -5);
  assert.equal(calculateGainPct(row, 'WAITING'), null);
});

test('buildTrackRecordData handles empty input gracefully', () => {
  const res = buildTrackRecordData([]);
  assert.equal(res.success, true);
  assert.equal(res.summary.total_signals, 0);
  assert.equal(res.summary.tp1_hits, 0);
  assert.equal(res.summary.win_rate_tp1, '0.0%');
  assert.equal(res.summary.sl_rate, '0.0%');
  assert.equal(res.signals.length, 0);
  assert.equal(res.by_category.daytrade.total, 0);
});

test('buildTrackRecordData aggregates multiple signal types and categories', () => {
  const fixtureRows = [
    {
      id: 1,
      ticker: 'BBCA',
      date: '2026-08-20',
      category: 'Day Trade',
      monitor_source: 'daytrade_signal',
      entry1: 10000,
      tp1: 10400,
      tp2: 10800,
      sl: 9800,
      status: 'TP2_HIT',
      first_sent_at: '2026-08-20T02:00:00Z',
      hit_entry_at: '2026-08-20T02:10:00Z',
      hit_tp1_at: '2026-08-20T02:30:00Z',
      hit_tp2_at: '2026-08-20T03:00:00Z',
      is_final: true
    },
    {
      id: 2,
      ticker: 'BMRI',
      date: '2026-08-21',
      category: 'Swing Konglo',
      monitor_source: 'swing_konglo',
      entry1: 6500,
      tp1: 6900,
      tp2: 7200,
      sl: 6300,
      status: 'TP1_HIT',
      first_sent_at: '2026-08-21T01:00:00Z',
      hit_entry_at: '2026-08-21T02:00:00Z',
      hit_tp1_at: '2026-08-22T04:00:00Z',
      is_final: false
    },
    {
      id: 3,
      ticker: 'BRIS',
      date: '2026-08-22',
      category: 'Swing Non-Konglo',
      monitor_source: 'swing_nk',
      entry1: 3000,
      tp1: 3200,
      tp2: 3400,
      sl: 2900,
      status: 'SL_HIT',
      first_sent_at: '2026-08-22T01:00:00Z',
      hit_entry_at: '2026-08-22T02:00:00Z',
      hit_sl_at: '2026-08-22T03:00:00Z',
      is_final: true
    },
    {
      id: 4,
      ticker: 'ASII',
      date: '2026-08-23',
      category: 'TOP5',
      monitor_source: 'top5',
      entry1: 5000,
      tp1: 5300,
      tp2: 5600,
      sl: 4850,
      status: 'WAITING',
      first_sent_at: '2026-08-23T01:00:00Z',
      is_final: false
    },
    {
      id: 5,
      ticker: 'TLKM',
      date: '2026-08-24',
      category: 'Day Trade',
      monitor_source: 'daytrade_signal',
      entry1: 3100,
      tp1: 3250,
      tp2: 3400,
      sl: 3000,
      status: 'RUNNING',
      first_sent_at: '2026-08-24T02:00:00Z',
      hit_entry_at: '2026-08-24T02:30:00Z',
      is_final: false
    }
  ];

  const res = buildTrackRecordData(fixtureRows);

  assert.equal(res.summary.total_signals, 5);
  assert.equal(res.summary.tp1_hits, 2); // BBCA (TP2_HIT) and BMRI (TP1_HIT)
  assert.equal(res.summary.tp2_hits, 1); // BBCA
  assert.equal(res.summary.sl_hits, 1);  // BRIS
  assert.equal(res.summary.waiting_signals, 1); // ASII
  assert.equal(res.summary.running_signals, 1); // TLKM

  assert.equal(res.summary.win_rate_tp1, '40.0%'); // 2 / 5 = 40.0%
  assert.equal(res.summary.sl_rate, '20.0%');      // 1 / 5 = 20.0%
  assert.equal(res.summary.resolved_win_rate, '66.7%'); // 2 / (2 + 1) = 66.7%

  // Check category breakdowns
  assert.equal(res.by_category.daytrade.total, 2);
  assert.equal(res.by_category.daytrade.tp1_hits, 1);
  assert.equal(res.by_category.daytrade.running, 1);

  assert.equal(res.by_category.swing_konglo.total, 1);
  assert.equal(res.by_category.swing_konglo.tp1_hits, 1);

  assert.equal(res.by_category.swing_nk.total, 1);
  assert.equal(res.by_category.swing_nk.sl_hits, 1);

  assert.equal(res.by_category.top5.total, 1);
  assert.equal(res.by_category.top5.waiting, 1);

  // Check signals formatting
  assert.equal(res.signals.length, 5);
  const bbca = res.signals.find(s => s.ticker === 'BBCA');
  assert.equal(bbca.status_label, 'TP2 Hit');
  assert.equal(bbca.gain_pct, 8); // (10800 - 10000) / 10000 = 8%
});

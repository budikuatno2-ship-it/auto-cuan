'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot').__test;

function row(id, ticker, extra) {
  return Object.assign({
    id,
    date: '2026-08-21',
    ticker,
    category: 'daytrade',
    entry1: 100,
    entry2: 98,
    sl: 95,
    tp1: 105,
    tp2: 110,
    status: 'WAITING',
    first_sent_at: '2026-08-21T01:00:00.000Z',
    raw_payload: {}
  }, extra || {});
}

test('Top5 history fetches live price once per unique ticker instead of once per history row', async () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(row(i + 1, ['AAA', 'BBB', 'CCC'][i % 3]));
  let calls = 0;
  const result = await sectorHot.buildWebTop5HistoryCollections(rows, 100, async () => {
    calls++;
    return { last: 101, open: 100, high: 102, low: 99, at: '2026-08-21T04:00:00.000Z', bestEffort: false };
  });
  assert.equal(calls, 3);
  assert.equal(result.price_fetch_count, 3);
  assert.equal(result.active_history.length, 3);
  assert.deepEqual(result.active_history.map(r => r.ticker), ['AAA', 'BBB', 'CCC']);
});

test('persisted SL history rows do not perform pointless live-price I/O', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(i + 1, 'SL' + i, {
    status: 'SL_HIT',
    hit_sl_at: '2026-08-21T03:00:00.000Z'
  }));
  let calls = 0;
  const result = await sectorHot.buildWebTop5HistoryCollections(rows, 100, async () => {
    calls++;
    return { last: 101, high: 102, low: 99 };
  });
  assert.equal(calls, 0);
  assert.equal(result.active_history.length, 0);
  assert.equal(result.tp_history.length, 0);
});

test('TP history remains newest-first and capped at ten while active history obeys requested limit', async () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(row(i + 1, 'TP' + i, {
    status: 'TP1_HIT',
    hit_tp1_at: '2026-08-21T02:00:00.000Z'
  }));
  rows.push(row(100, 'ACTIVE1'));
  rows.push(row(101, 'ACTIVE2'));
  const result = await sectorHot.buildWebTop5HistoryCollections(rows, 1, async () => ({
    last: 101, open: 100, high: 102, low: 99, at: '2026-08-21T04:00:00.000Z', bestEffort: false
  }));
  assert.equal(result.tp_history.length, 10);
  assert.deepEqual(result.tp_history.map(r => r.ticker), Array.from({ length: 10 }, (_, i) => 'TP' + i));
  assert.equal(result.active_history.length, 1);
  assert.equal(result.active_history[0].ticker, 'ACTIVE1');
  assert.equal(result.active_history[0].rank, 1);
});

test('persisted TP/SL chronology keeps SL-first rows out of TP history', async () => {
  const rows = [row(1, 'RACE', {
    status: 'TP1_HIT',
    hit_tp1_at: '2026-08-21T04:01:00.000Z',
    hit_sl_at: '2026-08-21T04:00:00.000Z'
  })];
  let calls = 0;
  const result = await sectorHot.buildWebTop5HistoryCollections(rows, 100, async () => {
    calls++;
    return { last: 120, high: 120, low: 90 };
  });
  assert.equal(calls, 0);
  assert.equal(result.tp_history.length, 0);
  assert.equal(result.active_history.length, 0);
});

test('duplicate tickers across history rows collapse to a single active entry, keeping the newest', async () => {
  const rows = [row(2, 'DUP'), row(1, 'DUP')];
  const result = await sectorHot.buildWebTop5HistoryCollections(rows, 100, async () => ({
    last: 101, high: 102, low: 99, at: '2026-08-21T04:00:00.000Z', bestEffort: false
  }));
  assert.equal(result.active_history.length, 1);
  assert.equal(result.active_history[0].id, 2);
});

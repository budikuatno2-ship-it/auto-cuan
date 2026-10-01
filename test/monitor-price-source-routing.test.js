'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot');
const { fetchLatestPriceForMonitor, evaluateMonitorStatus } = sectorHot.__test;

test('fetchLatestPriceForMonitor routes to swing_screener_latest for Swing Konglo rows', async () => {
  const queriedTables = [];
  const mockSupabase = {
    from(table) {
      queriedTables.push(table);
      const chain = {
        select() { return chain; },
        eq(col, val) { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() {
          if (table === 'swing_screener_latest') {
            return Promise.resolve({
              data: { last_price: 5200, calculated_at: '2026-08-10T10:00:00Z' },
              error: null
            });
          }
          return Promise.resolve({ data: null, error: null });
        }
      };
      return chain;
    }
  };

  const pick = { ticker: 'BBRI', monitor_source: 'swing_konglo' };
  const px = await fetchLatestPriceForMonitor(mockSupabase, 'BBRI', pick);
  assert.equal(px.last, 5200);
  assert.equal(px.source, 'swing_screener_latest');
  assert.equal(px.bestEffort, false);
  assert.ok(queriedTables.includes('swing_screener_latest'));
});

test('fetchLatestPriceForMonitor routes to swing_screener_non_konglo_latest for Swing Non-Konglo rows', async () => {
  const queriedTables = [];
  const mockSupabase = {
    from(table) {
      queriedTables.push(table);
      const chain = {
        select() { return chain; },
        eq(col, val) { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() {
          if (table === 'swing_screener_non_konglo_latest') {
            return Promise.resolve({
              data: { last_price: 1650, calculated_at: '2026-08-10T10:00:00Z' },
              error: null
            });
          }
          return Promise.resolve({ data: null, error: null });
        }
      };
      return chain;
    }
  };

  const pick = { ticker: 'HEAL', monitor_source: 'swing_nk' };
  const px = await fetchLatestPriceForMonitor(mockSupabase, 'HEAL', pick);
  assert.equal(px.last, 1650);
  assert.equal(px.source, 'swing_screener_non_konglo_latest');
  assert.equal(px.bestEffort, false);
  assert.ok(queriedTables.includes('swing_screener_non_konglo_latest'));
});

test('evaluateMonitorStatus correctly detects TP1/SL/Entry when high/low are null from swing screeners', () => {
  const pick = {
    ticker: 'BBRI',
    status: 'RUNNING',
    entry1: 5000,
    entry2: 4950,
    tp1: 5200,
    tp2: 5400,
    sl: 4800,
    hit_entry_at: '2026-08-10T09:00:00Z',
    monitor_source: 'swing_konglo'
  };

  const pxTp1 = { last: 5200, high: null, low: null, at: new Date().toISOString(), bestEffort: false, source: 'swing_screener_latest' };
  const evTp1 = evaluateMonitorStatus(pick, pxTp1);
  assert.equal(evTp1.status, 'TP1_HIT');

  const pxSl = { last: 4780, high: null, low: null, at: new Date().toISOString(), bestEffort: false, source: 'swing_screener_latest' };
  const evSl = evaluateMonitorStatus(pick, pxSl);
  assert.equal(evSl.status, 'SL_HIT');

  const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const waitingPick = Object.assign({}, pick, { status: 'WAITING', hit_entry_at: null, first_sent_at: recentTimestamp });
  const pxEntry = { last: 4980, high: null, low: null, at: new Date().toISOString(), bestEffort: false, source: 'swing_screener_latest' };
  const evEntry = evaluateMonitorStatus(waitingPick, pxEntry);
  assert.equal(evEntry.status, 'IN_ENTRY_ZONE');
});

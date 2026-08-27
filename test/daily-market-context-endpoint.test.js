'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quoteEndpoint = require('../api/quote');
const { handleDailyMarketContextListAction, normalizeRankingSortKey } = quoteEndpoint.__test;

test('normalizeRankingSortKey maps query aliases to canonical keys correctly', () => {
  assert.equal(normalizeRankingSortKey('high_52w_pct_dist'), 'week52_high_dist_pct');
  assert.equal(normalizeRankingSortKey('52w_high'), 'week52_high_dist_pct');
  assert.equal(normalizeRankingSortKey('week52_high_dist_pct'), 'week52_high_dist_pct');
  assert.equal(normalizeRankingSortKey('rsi14'), 'rsi_14');
  assert.equal(normalizeRankingSortKey('rsi'), 'rsi_14');
  assert.equal(normalizeRankingSortKey('vol_ratio'), 'volume_ratio_vs_7d_avg');
  assert.equal(normalizeRankingSortKey('foreign_net_val'), 'foreign_net_7d');
  assert.equal(normalizeRankingSortKey('change_pct'), 'change_pct');
  assert.equal(normalizeRankingSortKey('ticker'), 'ticker');
  assert.equal(normalizeRankingSortKey('invalid_col'), null);
  assert.equal(normalizeRankingSortKey(null), null);
});

test('handleDailyMarketContextListAction returns method not allowed on non-GET', async () => {
  const req = { method: 'POST', query: { action: 'daily-market-context-list' } };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { responseData = d; return this; }
  };

  await handleDailyMarketContextListAction(req, res);
  assert.equal(statusCode, 405);
  assert.equal(responseData.success, false);
});

test('handleDailyMarketContextListAction returns empty list when no rows in stock_daily_features', async () => {
  const mockSupabase = {
    from(table) {
      assert.equal(table, 'stock_daily_features');
      return {
        select() {
          return {
            order() {
              return {
                limit() {
                  return Promise.resolve({ data: [], error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const req = { method: 'GET', query: { action: 'daily-market-context-list' } };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { responseData = d; return this; }
  };

  await handleDailyMarketContextListAction(req, res, mockSupabase);
  assert.equal(statusCode, 200);
  assert.equal(responseData.success, true);
  assert.equal(responseData.count, 0);
  assert.deepEqual(responseData.rows, []);
});

test('handleDailyMarketContextListAction sorts and limits data accurately', async () => {
  const mockFeatureRows = [
    {
      ticker: 'BBCA',
      as_of_trade_date: '2026-08-27',
      last_price: 10500,
      change_pct: 1.5,
      rsi_14: 65.2,
      week52_high_dist_pct: -1.2,
      volume_ratio_vs_7d_avg: 1.8,
      foreign_net_7d: 50000000000
    },
    {
      ticker: 'BBRI',
      as_of_trade_date: '2026-08-27',
      last_price: 5200,
      change_pct: -0.5,
      rsi_14: 28.4,
      week52_high_dist_pct: -8.5,
      volume_ratio_vs_7d_avg: 0.9,
      foreign_net_7d: -20000000000
    },
    {
      ticker: 'TLKM',
      as_of_trade_date: '2026-08-27',
      last_price: 3100,
      change_pct: 3.2,
      rsi_14: 72.1,
      week52_high_dist_pct: -0.2,
      volume_ratio_vs_7d_avg: 2.4,
      foreign_net_7d: 80000000000
    }
  ];

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'stock_daily_features');
      return {
        select() {
          return {
            order() {
              return {
                limit() {
                  return Promise.resolve({ data: mockFeatureRows, error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  // 1. Sort by 52W High Distance DESC (closest to 0% first: TLKM (-0.2), BBCA (-1.2), BBRI (-8.5))
  const req1 = {
    method: 'GET',
    query: {
      action: 'daily-market-context-list',
      sort_by: 'high_52w_pct_dist',
      order: 'desc'
    }
  };
  let res1Data = null;
  const res1 = {
    status() { return this; },
    json(d) { res1Data = d; return this; }
  };
  await handleDailyMarketContextListAction(req1, res1, mockSupabase);
  assert.equal(res1Data.success, true);
  assert.equal(res1Data.count, 3);
  assert.equal(res1Data.rows[0].ticker, 'TLKM');
  assert.equal(res1Data.rows[1].ticker, 'BBCA');
  assert.equal(res1Data.rows[2].ticker, 'BBRI');

  // 2. Sort by RSI ASC (lowest RSI first: BBRI (28.4), BBCA (65.2), TLKM (72.1)) with limit 2
  const req2 = {
    method: 'GET',
    query: {
      action: 'daily-market-context-list',
      sort_by: 'rsi14',
      order: 'asc',
      limit: '2'
    }
  };
  let res2Data = null;
  const res2 = {
    status() { return this; },
    json(d) { res2Data = d; return this; }
  };
  await handleDailyMarketContextListAction(req2, res2, mockSupabase);
  assert.equal(res2Data.success, true);
  assert.equal(res2Data.count, 2);
  assert.equal(res2Data.rows[0].ticker, 'BBRI');
  assert.equal(res2Data.rows[1].ticker, 'BBCA');
});
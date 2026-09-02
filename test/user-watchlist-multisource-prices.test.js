'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const watchlistService = require('../lib/user-watchlist-service');

test('Finding #5: batchFetchPricesForTickers resolves prices across 4 sources', async () => {
  const daytradeData = [
    { ticker: 'BBCA', last_price: 10500, high_price: 10600, low_price: 10450, change_pct: 1.5, calculated_at: '2026-08-27T04:00:00Z' }
  ];
  const swingKongloData = [
    { ticker: 'ASII', last_price: 5200, change_pct: 2.0, calculated_at: '2026-08-27T04:00:00Z', price_asof: null, price_date: '2026-08-27' }
  ];
  const swingNonKongloData = [
    { ticker: 'MEDC', last_price: 1350, change_pct: -1.0, calculated_at: '2026-08-27T04:00:00Z', price_asof: null, price_date: '2026-08-27' }
  ];
  const foreignData = [
    { ticker: 'BREN', close: 8900, open: 8800, high: 9000, low: 8750, trade_date: '2026-08-27', uploaded_at: '2026-08-27T10:00:00Z' }
  ];

  const mockSupabase = {
    from(table) {
      return {
        select() {
          return {
            in(col, tickers) {
              return {
                order() {
                  if (table === 'foreign_watchlist_daily') {
                    const matched = foreignData.filter(d => tickers.includes(d.ticker));
                    return Promise.resolve({ data: matched, error: null });
                  }
                  return Promise.resolve({ data: [], error: null });
                },
                then(resolve) {
                  if (table === 'daytrade_screener_latest') {
                    const matched = daytradeData.filter(d => tickers.includes(d.ticker));
                    return resolve({ data: matched, error: null });
                  }
                  if (table === 'swing_screener_latest') {
                    const matched = swingKongloData.filter(d => tickers.includes(d.ticker));
                    return resolve({ data: matched, error: null });
                  }
                  if (table === 'swing_screener_non_konglo_latest') {
                    const matched = swingNonKongloData.filter(d => tickers.includes(d.ticker));
                    return resolve({ data: matched, error: null });
                  }
                  if (table === 'foreign_watchlist_daily') {
                    const matched = foreignData.filter(d => tickers.includes(d.ticker));
                    return resolve({ data: matched, error: null });
                  }
                  return resolve({ data: [], error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const prices = await watchlistService.batchFetchPricesForTickers(mockSupabase, ['BBCA', 'ASII', 'MEDC', 'BREN']);

  assert.equal(prices.BBCA.last_price, 10500);
  assert.equal(prices.BBCA.price_source, 'daytrade_screener_latest');
  assert.equal(prices.BBCA.high_price, 10600);

  assert.equal(prices.ASII.last_price, 5200);
  assert.equal(prices.ASII.price_source, 'swing_screener_latest');

  assert.equal(prices.MEDC.last_price, 1350);
  assert.equal(prices.MEDC.price_source, 'swing_screener_non_konglo_latest');

  assert.equal(prices.BREN.last_price, 8900);
  assert.equal(prices.BREN.price_source, 'foreign_watchlist_daily');
});

test('Finding #5: evaluateActiveUserAlerts triggers alerts for non-daytrade tickers via fallback', async () => {
  const activeAlerts = [
    {
      id: 'al-asii',
      user_id: 'u-1',
      ticker: 'ASII',
      condition_type: 'PRICE_ABOVE',
      target_price: 5000,
      notification_chat_id: 123456
    },
    {
      id: 'al-bren',
      user_id: 'u-2',
      ticker: 'BREN',
      condition_type: 'PRICE_BELOW',
      target_price: 9000,
      notification_chat_id: 654321
    }
  ];

  const swingKongloData = [
    { ticker: 'ASII', last_price: 5200, change_pct: 2.0, calculated_at: '2026-08-27T04:00:00Z', price_asof: null, price_date: '2026-08-27' }
  ];
  const foreignData = [
    { ticker: 'BREN', close: 8800, open: 8800, high: 9000, low: 8750, trade_date: '2026-08-27', uploaded_at: '2026-08-27T10:00:00Z' }
  ];

  const mockSupabase = {
    from(table) {
      if (table === 'app_user_alerts') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return Promise.resolve({ data: activeAlerts, error: null });
                  }
                };
              }
            };
          }
        };
      }
      return {
        select() {
          return {
            in(col, tickers) {
              return {
                order() {
                  if (table === 'foreign_watchlist_daily') {
                    const matched = foreignData.filter(d => tickers.includes(d.ticker));
                    return Promise.resolve({ data: matched, error: null });
                  }
                  return Promise.resolve({ data: [], error: null });
                },
                then(resolve) {
                  if (table === 'daytrade_screener_latest') {
                    return resolve({ data: [], error: null });
                  }
                  if (table === 'swing_screener_latest') {
                    const matched = swingKongloData.filter(d => tickers.includes(d.ticker));
                    return resolve({ data: matched, error: null });
                  }
                  if (table === 'swing_screener_non_konglo_latest') {
                    return resolve({ data: [], error: null });
                  }
                  if (table === 'foreign_watchlist_daily') {
                    const matched = foreignData.filter(d => tickers.includes(d.ticker));
                    return resolve({ data: matched, error: null });
                  }
                  return resolve({ data: [], error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const res = await watchlistService.evaluateActiveUserAlerts(mockSupabase, { dryRun: true });
  assert.equal(res.success, true);
  assert.equal(res.evaluated, 2, 'Evaluated 2 active alerts');
  assert.equal(res.triggered, 2, 'Both non-daytrade alerts triggered successfully via fallback tables');
  assert.equal(res.previews.length, 2);
  assert.equal(res.previews[0].ticker, 'ASII');
  assert.equal(res.previews[1].ticker, 'BREN');
});

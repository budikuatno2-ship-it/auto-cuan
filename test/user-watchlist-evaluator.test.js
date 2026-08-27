'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const watchlistService = require('../lib/user-watchlist-service');

test('formatUserAlertMessage formats alert message with target price, last price, and timestamp', () => {
  const alert = {
    ticker: 'BBCA',
    condition_type: 'PRICE_ABOVE',
    target_price: 10500
  };
  const px = {
    last_price: 10550,
    change_pct: 2.3
  };

  const msg = watchlistService.formatUserAlertMessage(alert, px);
  assert.match(msg, /ALERT HARGA PRIBADI: BBCA/);
  assert.match(msg, /Naik Menembus Level Target/);
  assert.match(msg, /Level Target: Rp10\.500/);
  assert.match(msg, /Harga Terkini: Rp10\.550 \(\+2\.3%\)/);
  assert.match(msg, /WIB/);
  assert.match(msg, /Watchlist Pribadi Anda/);
});

test('evaluateActiveUserAlerts returns 0 when no active alerts', async () => {
  const mockSupabase = {
    from(table) {
      assert.equal(table, 'app_user_alerts');
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return Promise.resolve({ data: [], error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const res = await watchlistService.evaluateActiveUserAlerts(mockSupabase);
  assert.equal(res.success, true);
  assert.equal(res.evaluated, 0);
  assert.equal(res.triggered, 0);
  assert.equal(res.sent, 0);
});

test('evaluateActiveUserAlerts evaluates price conditions and respects dry-run mode', async () => {
  const activeAlerts = [
    {
      id: 'al-1',
      user_id: 'u-1',
      ticker: 'BBCA',
      condition_type: 'PRICE_ABOVE',
      target_price: 10500,
      notification_chat_id: 123456
    },
    {
      id: 'al-2',
      user_id: 'u-2',
      ticker: 'TLKM',
      condition_type: 'PRICE_BELOW',
      target_price: 3000,
      notification_chat_id: 654321
    }
  ];

  const priceRows = [
    { ticker: 'BBCA', last_price: 10550, change_pct: 2.5, calculated_at: '2026-08-27T04:00:00Z' },
    { ticker: 'TLKM', last_price: 3200, change_pct: 0.5, calculated_at: '2026-08-27T04:00:00Z' }
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
      if (table === 'daytrade_screener_latest') {
        return {
          select() {
            return {
              in() {
                return Promise.resolve({ data: priceRows, error: null });
              }
            };
          }
        };
      }
    }
  };

  // Dry-run execution
  const res = await watchlistService.evaluateActiveUserAlerts(mockSupabase, { dryRun: true });
  assert.equal(res.success, true);
  assert.equal(res.evaluated, 2);
  assert.equal(res.triggered, 1); // Only BBCA reached >= 10500; TLKM is at 3200 (not <= 3000)
  assert.equal(res.sent, 0); // Dry-run does not send real messages
  assert.equal(res.previews.length, 1);
  assert.equal(res.previews[0].ticker, 'BBCA');
  assert.equal(res.previews[0].chat_id, 123456);
  assert.match(res.previews[0].message, /ALERT HARGA PRIBADI: BBCA/);
});

test('evaluateActiveUserAlerts sends Telegram DM and updates database when triggered in live mode', async () => {
  const activeAlerts = [
    {
      id: 'al-1',
      user_id: 'u-1',
      ticker: 'BBCA',
      condition_type: 'PRICE_ABOVE',
      target_price: 10500,
      notification_chat_id: 123456
    }
  ];

  const priceRows = [
    { ticker: 'BBCA', last_price: 10600, change_pct: 3.0, calculated_at: '2026-08-27T04:00:00Z' }
  ];

  let dbUpdated = false;
  let sentToTelegram = false;

  const mockNotifier = {
    sendTelegramMessage(msg, opts) {
      assert.equal(opts.chat_id, 123456);
      sentToTelegram = true;
      return Promise.resolve({ sent: true });
    }
  };

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
          },
          update(fields) {
            assert.equal(fields.is_triggered, true);
            return {
              eq(col, val) {
                assert.equal(col, 'id');
                assert.equal(val, 'al-1');
                dbUpdated = true;
                return Promise.resolve({ error: null });
              }
            };
          }
        };
      }
      if (table === 'daytrade_screener_latest') {
        return {
          select() {
            return {
              in() {
                return Promise.resolve({ data: priceRows, error: null });
              }
            };
          }
        };
      }
    }
  };

  const res = await watchlistService.evaluateActiveUserAlerts(mockSupabase, {
    dryRun: false,
    telegramNotifier: mockNotifier
  });

  assert.equal(res.success, true);
  assert.equal(res.evaluated, 1);
  assert.equal(res.triggered, 1);
  assert.equal(res.sent, 1);
  assert.equal(sentToTelegram, true);
  assert.equal(dbUpdated, true);
});
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const publisher = require('../lib/intraday-fast-watcher-publisher');

function obs(ticker, time, extra) {
  return {
    ticker,
    scheduled_time: time,
    current_price: 100,
    entry_low: 98,
    entry_high: 103,
    tp1: 119,
    tp2: 130,
    stop_loss: 95,
    current_status: 'EARLY_RADAR',
    volume: 1000,
    average_volume: 700,
    relative_volume: 1.5,
    momentum_component: 14,
    liquidity_component: 16,
    risk_reward: 2,
    high: 103,
    low: 98,
    freshness: { is_stale: false },
    ...(extra || {})
  };
}

test('Finding #6: Fast Watcher registers delivered signals into telegram_daily_picks with daytrade_signal source', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-mon-reg-'));
  const insertedPicks = [];
  const existingPicks = [];

  const storeClient = {
    from(table) {
      if (table === 'daytrade_screener_latest') {
        return {
          upsert(rows) {
            return {
              select: async () => ({ data: rows, error: null })
            };
          }
        };
      }
      if (table === 'telegram_daily_picks') {
        return {
          select() {
            return {
              eq(col, val) {
                return Promise.resolve({ data: existingPicks, error: null });
              }
            };
          },
          insert(rows) {
            insertedPicks.push(...rows);
            return Promise.resolve({ data: rows, error: null });
          }
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };

  const publishable = [
    {
      ticker: 'BBCA',
      setup_id: 'setup-bbca',
      ready_streak: 2,
      watch_score: 85,
      publish_score: 90,
      observation: obs('BBCA', '09:15', {
        current_price: 101,
        entry_low: 98,
        entry_high: 103,
        tp1: 115,
        tp2: 125,
        stop_loss: 94
      })
    }
  ];

  const result = await publisher.publishConfirmed({
    sampleDate: '2026-08-27',
    scheduledTime: '09:15',
    publishedDir: root,
    storeClient,
    notifyFn: async () => ({ sent: true, reason: 'ok' }),
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_CHAT_ID: '-1001'
    },
    publishable
  });

  assert.equal(result.system_published, 1);
  assert.equal(result.telegram_sent, 1);
  assert.equal(result.monitor_registered, 1, 'Must register 1 signal into telegram_daily_picks');
  assert.equal(insertedPicks.length, 1);

  const pick = insertedPicks[0];
  assert.equal(pick.ticker, 'BBCA');
  assert.equal(pick.date, '2026-08-27');
  assert.equal(pick.monitor_source, 'daytrade_signal');
  assert.equal(pick.status, 'WAITING');
  assert.equal(pick.is_final, false);
  assert.equal(pick.entry1, 103);
  assert.equal(pick.entry2, 98);
  assert.equal(pick.tp1, 115);
  assert.equal(pick.tp2, 125);
  assert.equal(pick.sl, 94);
  assert.ok(pick.first_sent_at, 'first_sent_at must be populated for public signal');
  assert.ok(pick.plan_lock_id, 'plan_lock_id must be populated');
});

test('Finding #6: Fast Watcher deduplicates and does not insert duplicate monitor rows', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-mon-dedup-'));
  const insertedPicks = [];
  const existingPicks = [
    {
      ticker: 'BBCA',
      monitor_source: 'daytrade_signal',
      plan_lock_id: 'fw-2026-08-27-BBCA-98-103-115-94'
    }
  ];

  const storeClient = {
    from(table) {
      if (table === 'daytrade_screener_latest') {
        return {
          upsert(rows) {
            return {
              select: async () => ({ data: rows, error: null })
            };
          }
        };
      }
      if (table === 'telegram_daily_picks') {
        return {
          select() {
            return {
              eq(col, val) {
                return Promise.resolve({ data: existingPicks, error: null });
              }
            };
          },
          insert(rows) {
            insertedPicks.push(...rows);
            return Promise.resolve({ data: rows, error: null });
          }
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };

  const publishable = [
    {
      ticker: 'BBCA',
      setup_id: 'setup-bbca-retry',
      ready_streak: 2,
      watch_score: 85,
      publish_score: 90,
      observation: obs('BBCA', '09:18', {
        current_price: 101,
        entry_low: 98,
        entry_high: 103,
        tp1: 115,
        tp2: 125,
        stop_loss: 94
      })
    }
  ];

  const result = await publisher.publishConfirmed({
    sampleDate: '2026-08-27',
    scheduledTime: '09:18',
    publishedDir: root,
    storeClient,
    notifyFn: async () => ({ sent: true, reason: 'ok' }),
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_CHAT_ID: '-1001'
    },
    publishable
  });

  assert.equal(result.system_published, 1);
  assert.equal(result.telegram_sent, 1);
  assert.equal(result.monitor_registered, 0, 'Must skip insertion for already-registered signal');
  assert.equal(insertedPicks.length, 0, 'No duplicate row inserted');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const context = require('../lib/deepscan-context');
const engine = require('../lib/deepscan-engine');

function candle(date, close, volume) {
  return {
    date,
    open: close,
    high: close + 2,
    low: Math.max(1, close - 2),
    close,
    adjusted_close: close,
    volume: volume == null ? 1000000 : volume
  };
}

test('DeepScan full-history cache requires an explicit 2020 request boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscan-history-'));
  const dir = path.join(root, 'data', context.FULL_HISTORY_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const rows = [];
  for (let i = 0; i < 40; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = i < 28 ? '01' : '02';
    rows.push(candle('2020-' + month + '-' + day, 100 + i));
  }

  fs.writeFileSync(path.join(dir, 'BBCA.json'), JSON.stringify({
    requested_from: '2020-01-01',
    requested_to: '2026-09-29',
    source: 'test',
    candles: rows
  }));

  let loaded = context.loadFullHistoryForTicker(root, 'BBCA');
  assert.equal(loaded.complete, true);
  assert.equal(loaded.requested_from, '2020-01-01');
  assert.equal(loaded.candle_count, 40);

  fs.writeFileSync(path.join(dir, 'BBCA.json'), JSON.stringify({
    requested_from: '2024-01-01',
    requested_to: '2026-09-29',
    source: 'test',
    candles: rows
  }));

  loaded = context.loadFullHistoryForTicker(root, 'BBCA');
  assert.equal(loaded.complete, false);
  assert.equal(loaded.reason, 'history_not_requested_from_2020');
});

test('DeepScan full-history metrics use old candles, not only recent 90/180 sessions', () => {
  const rows = [
    candle('2020-01-02', 100),
    candle('2021-01-04', 50),
    candle('2022-01-03', 80),
    candle('2023-01-02', 120),
    candle('2024-01-02', 140),
    candle('2025-01-02', 160),
    candle('2026-09-29', 200)
  ];
  const metrics = context.computeFullHistoryMetrics(rows);
  assert.equal(metrics.first_date, '2020-01-02');
  assert.equal(metrics.last_date, '2026-09-29');
  assert.equal(metrics.all_time_low_since_2020, 48);
  assert.equal(metrics.all_time_high_since_2020, 202);
  assert.ok(metrics.max_drawdown_pct <= -50);
  assert.ok(metrics.total_return_pct >= 99);
  assert.ok(metrics.years_observed > 6);
});

test('DeepScan long-horizon return metrics use adjusted close across stock splits', () => {
  const rows = [
    { ...candle('2020-01-02', 100), adjusted_close: 20 },
    { ...candle('2023-01-02', 120), adjusted_close: 24 },
    // 1:5 split: raw price mechanically drops, adjusted series stays continuous.
    { ...candle('2024-01-02', 24), adjusted_close: 24 },
    { ...candle('2026-09-29', 30), adjusted_close: 30 }
  ];
  const metrics = context.computeFullHistoryMetrics(rows);
  assert.ok(metrics.total_return_pct > 45 && metrics.total_return_pct < 55);
  assert.ok(metrics.max_drawdown_pct > -5);
});

test('DeepScan verified financial context never fabricates missing fundamentals', () => {
  const missing = context.buildFundamentalContext(1000, null);
  assert.equal(missing.data_available, false);
  assert.equal(missing.pbv, null);
  assert.deepEqual(missing.reasons, ['verified_financial_missing']);

  const present = context.buildFundamentalContext(1000, {
    ticker: 'BBCA',
    book_value_per_share: 500,
    fundamental_period: 'FY2025',
    source: 'verified-test',
    updated_at: '2026-09-29T00:00:00Z'
  });
  assert.equal(present.data_available, true);
  assert.equal(present.pbv, 2);
  assert.ok(present.score > 0);
});

test('DeepScan universe loader uses the shared continuous-auction gate', async () => {
  const rows = [
    { ticker: 'BBCA', board: 'UTAMA', is_active: true, is_fca: false, note: null },
    { ticker: 'TLKM', board: 'PENGEMBANGAN', is_active: true, is_fca: false, note: null },
    { ticker: 'TEST', board: 'PEMANTAUAN_KHUSUS', is_active: true, is_fca: true, note: 'FCA' }
  ];

  const db = {
    from(name) {
      assert.equal(name, 'stock_boards');
      return {
        select() {
          return {
            eq() {
              return {
                limit: async () => ({ data: rows, error: null })
              };
            }
          };
        }
      };
    }
  };

  const universe = await context.loadContinuousAuctionUniverse(db, []);
  assert.deepEqual(universe, ['BBCA', 'TLKM']);
});

test('DeepScan broker score distinguishes accumulation and distribution', () => {
  const accumulation = context.scoreBrokerSummary({
    cr3Buy: 65,
    cr5Buy: 78,
    cr3Sell: 40,
    cr5Sell: 55,
    foreignNet: 1000000000,
    retailNet: -500000000
  });
  const distribution = context.scoreBrokerSummary({
    cr3Buy: 35,
    cr5Buy: 50,
    cr3Sell: 70,
    cr5Sell: 82,
    foreignNet: -1000000000,
    retailNet: 500000000
  });
  assert.ok(accumulation.score > 0);
  assert.ok(distribution.score < 0);
  assert.ok(accumulation.score > distribution.score);
});

test('DeepScan weekend freshness requires data requested through Friday', () => {
  const saturday = new Date('2026-10-03T03:00:00Z');
  const sunday = new Date('2026-10-04T03:00:00Z');
  assert.equal(engine.getRequiredHistoryThroughDate(saturday), '2026-10-02');
  assert.equal(engine.getRequiredHistoryThroughDate(sunday), '2026-10-02');
  assert.equal(engine.getRequiredLatestCandleDate(saturday), '2026-10-02');
  assert.equal(engine.getRequiredLatestCandleDate(sunday), '2026-10-02');
  assert.equal(engine.getRequiredHistoryThroughDate(new Date('2026-09-30T03:00:00Z')), null);
});

test('DeepScan weekly lock honors either local or DB state for the active weekend', () => {
  const sunday = new Date('2026-10-04T03:00:00Z');
  const currentKey = '2026-10-03';

  const localWins = engine.resolveDeepScanGuardState(
    sunday,
    { last_weekend_key: currentKey },
    { last_weekend_key: '2026-09-26' }
  );
  assert.equal(localWins.last_weekend_key, currentKey);

  const dbWins = engine.resolveDeepScanGuardState(
    sunday,
    { last_weekend_key: '2026-09-26' },
    { last_weekend_key: currentKey }
  );
  assert.equal(dbWins.last_weekend_key, currentKey);
});

test('DeepScan activation remains one time per WIB weekend', () => {
  const saturday = new Date('2026-10-03T03:00:00Z'); // 10:00 WIB Saturday
  const sunday = new Date('2026-10-04T03:00:00Z');   // same weekend
  const nextSaturday = new Date('2026-10-10T03:00:00Z');

  const first = engine.canRunDeepScan(saturday, {});
  assert.equal(first.allowed, true);

  const state = { last_weekend_key: first.weekendKey };
  assert.equal(engine.canRunDeepScan(sunday, state).allowed, false);
  assert.equal(engine.canRunDeepScan(sunday, state).reason, 'already_ran_this_weekend');
  assert.equal(engine.canRunDeepScan(nextSaturday, state).allowed, true);
});

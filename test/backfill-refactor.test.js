'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const backfillWorker = require('../tools/backfill-broksum');

test('Langkah 4: Refactor backfill-broksum.js unit tests', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-'));
  const candlesDir = path.join(tmpDir, 'candles');
  const targetDir = path.join(tmpDir, 'arjum-data');
  fs.mkdirSync(candlesDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('1. Ticker candle map & zero-volume detection', () => {
    // Seed candle file with 1 trading day (vol > 0) and 1 zero-volume day
    const candleData = {
      ticker: 'DORM',
      candles: [
        { date: '2026-10-15', open: 50, high: 50, low: 50, close: 50, volume: 0 },
        { date: '2026-10-16', open: 50, high: 50, low: 50, close: 50, volume: 0 }
      ]
    };
    fs.writeFileSync(path.join(candlesDir, 'DORM.json'), JSON.stringify(candleData));

    const map = backfillWorker.getTickerCandleMap(candlesDir, 'DORM');
    assert.equal(map.get('2026-10-15'), 0, 'Should detect zero volume');
    assert.equal(map.get('2026-10-16'), 0, 'Should detect zero volume');
  });

  await t.test('2. Zero volume session generates synthetic no-trade ONLY when all file confirms no trades', async () => {
    // Seed existing empty all file for 2026-10-16 and 2026-10-15
    const dormDir = path.join(targetDir, 'broker-summary', 'DORM');
    fs.mkdirSync(dormDir, { recursive: true });
    fs.writeFileSync(path.join(dormDir, '2026-10-16.json'), JSON.stringify({
      stock_code: 'DORM',
      brokers: [],
      broker_levels: [{ buy: null, sell: null }]
    }));
    fs.writeFileSync(path.join(dormDir, '2026-10-15.json'), JSON.stringify({
      stock_code: 'DORM',
      brokers: [],
      broker_levels: []
    }));

    // Run backfill worker with target-dir and candles-dir on DORM ticker where volume=0
    const res = await backfillWorker.run([
      `--target-dir=${targetDir}`,
      `--candles-dir=${candlesDir}`,
      '--tickers=DORM',
      '--limit=5'
    ]);

    assert.ok(res.success);
    const allFile16 = path.join(targetDir, 'broker-summary', 'DORM', '2026-10-16.json');
    const fFile16 = path.join(targetDir, 'broker-summary-F', 'DORM', '2026-10-16.json');

    assert.ok(fs.existsSync(allFile16), 'Synthetic all file (2026-10-16) must exist');
    assert.ok(fs.existsSync(fFile16), 'Synthetic F file (2026-10-16) must exist');

    const fData = JSON.parse(fs.readFileSync(fFile16, 'utf8'));
    assert.equal(fData.derived, 'no-trade');
    assert.equal(fData.flow, 'F');
    assert.deepEqual(fData.brokers, []);

    assert.equal(res.requestsSent, 0, 'Must send 0 API requests for zero volume sessions with empty all');
    assert.ok(res.syntheticCount >= 2, 'Synthetic count should be >= 2');
  });

  await t.test('2b. [BUG FIX C1] Volume 0 in candle BUT All file has trades -> NEVER skip as no-trade', () => {
    const allWithTrades = {
      stock_code: 'SINI',
      brokers: [{ broker_code: 'CC', bval: 83000000000, sval: 0 }]
    };
    const emptyAll = {
      stock_code: 'PACK',
      brokers: [],
      broker_levels: [{ buy: null, sell: null }]
    };
    assert.equal(backfillWorker.brokerSummaryHasTrades(allWithTrades), true, 'Must detect active trades in all file');
    assert.equal(backfillWorker.brokerSummaryHasTrades(emptyAll), false, 'Empty all has no trades');
  });

  await t.test('2c. [BUG FIX C4] Dynamic reserve quota computation handles EOD and weekend rollover', () => {
    // Mode weekend returns 300
    const weekendReserve = backfillWorker.resolveDynamicReserveQuota(targetDir, 'weekend');
    assert.equal(weekendReserve, 300, 'Weekend reserve must be 300');

    // Monday morning (weekday before EOD .done) returns 5100
    const mondayMorning = new Date('2026-10-19T03:00:00.000Z'); // 10:00 WIB
    const weekdayPreEod = backfillWorker.resolveDynamicReserveQuota(targetDir, 'weekday', mondayMorning);
    assert.equal(weekdayPreEod, 5100, 'Weekday pre-EOD reserve must be 5100');

    // Seed .done sentinel for 2026-10-19
    const eodDir = path.join(targetDir, '_eod');
    fs.mkdirSync(eodDir, { recursive: true });
    fs.writeFileSync(path.join(eodDir, '2026-10-19.done'), '{}');

    // Weekday after EOD .done sentinel returns 800
    const weekdayPostEod = backfillWorker.resolveDynamicReserveQuota(targetDir, 'weekday', mondayMorning);
    assert.equal(weekdayPostEod, 800, 'Weekday post-EOD reserve must be 800');
  });

  await t.test('3. Prioritas urutan: likuid duluan, tanggal terbaru ke terlama', () => {
    // Seed candles for 2 tickers: HIGH_LIQ (turnover > 1M) and LOW_LIQ (turnover < 1M)
    const highLiqCandles = {
      ticker: 'HIGH_LIQ',
      candles: [
        { date: '2026-10-14', close: 5000, volume: 1000000 }, // 5 Miliar
        { date: '2026-10-15', close: 5100, volume: 1000000 },
        { date: '2026-10-16', close: 5200, volume: 1000000 }
      ]
    };
    const lowLiqCandles = {
      ticker: 'LOW_LIQ',
      candles: [
        { date: '2026-10-14', close: 50, volume: 100 },
        { date: '2026-10-15', close: 50, volume: 100 },
        { date: '2026-10-16', close: 50, volume: 100 }
      ]
    };
    fs.writeFileSync(path.join(candlesDir, 'HIGH_LIQ.json'), JSON.stringify(highLiqCandles));
    fs.writeFileSync(path.join(candlesDir, 'LOW_LIQ.json'), JSON.stringify(lowLiqCandles));

    const { liquid, regular } = backfillWorker.categorizeTickersByLiquidity(targetDir, candlesDir, ['LOW_LIQ', 'HIGH_LIQ']);
    assert.deepEqual(liquid, ['HIGH_LIQ'], 'HIGH_LIQ must be categorized as liquid');
    assert.deepEqual(regular, ['LOW_LIQ'], 'LOW_LIQ must be categorized as regular');

    // Verify dates are ordered newest to oldest
    const tradingDays = backfillWorker.loadTradingDays(candlesDir);
    if (tradingDays.length > 1) {
      assert.ok(tradingDays[0] > tradingDays[tradingDays.length - 1], 'Dates must be sorted newest to oldest');
    }
  });

  await t.test('4. Dry run execution', async () => {
    const res = await backfillWorker.run([
      `--target-dir=${targetDir}`,
      `--candles-dir=${candlesDir}`,
      '--tickers=HIGH_LIQ',
      '--limit=5',
      '--dry-run'
    ]);
    assert.ok(res.success);
    assert.ok(res.requestsSent > 0, 'Dry run counts simulated requests');
  });
});

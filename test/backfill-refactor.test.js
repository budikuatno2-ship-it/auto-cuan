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

  await t.test('2. Zero volume session generates synthetic no-trade without API calls', async () => {
    // Run backfill worker with target-dir and candles-dir on DORM ticker where volume=0
    const res = await backfillWorker.run([
      `--target-dir=${targetDir}`,
      `--candles-dir=${candlesDir}`,
      '--tickers=DORM',
      '--limit=5'
    ]);

    assert.ok(res.success);
    // 2026-10-16 and 2026-10-15 have volume=0, so both must generate synthetic no-trade
    const allFile16 = path.join(targetDir, 'broker-summary', 'DORM', '2026-10-16.json');
    const fFile16 = path.join(targetDir, 'broker-summary-F', 'DORM', '2026-10-16.json');
    const allFile15 = path.join(targetDir, 'broker-summary', 'DORM', '2026-10-15.json');
    const fFile15 = path.join(targetDir, 'broker-summary-F', 'DORM', '2026-10-15.json');

    assert.ok(fs.existsSync(allFile16), 'Synthetic all file (2026-10-16) must exist');
    assert.ok(fs.existsSync(fFile16), 'Synthetic F file (2026-10-16) must exist');
    assert.ok(fs.existsSync(allFile15), 'Synthetic all file (2026-10-15) must exist');
    assert.ok(fs.existsSync(fFile15), 'Synthetic F file (2026-10-15) must exist');

    const allData = JSON.parse(fs.readFileSync(allFile16, 'utf8'));
    assert.equal(allData.derived, 'no-trade');
    assert.equal(allData.flow, 'all');
    assert.deepEqual(allData.brokers, []);
    assert.deepEqual(allData.broker_levels, []);

    const fData = JSON.parse(fs.readFileSync(fFile16, 'utf8'));
    assert.equal(fData.derived, 'no-trade');
    assert.equal(fData.flow, 'F');
    assert.deepEqual(fData.brokers, []);

    assert.equal(res.requestsSent, 0, 'Must send 0 API requests for zero volume sessions');
    assert.ok(res.syntheticCount >= 2, 'Synthetic count should be >= 2');
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

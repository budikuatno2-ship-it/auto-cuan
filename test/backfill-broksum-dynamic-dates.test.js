'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const backfill = require('../tools/backfill-broksum');

test('BUG-07: Dynamic trading calendar dates in broksum backfill', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-backfill-test-'));
  const candlesDir = path.join(tmpDir, 'candles');
  const baseDir = path.join(tmpDir, 'arjum-data');
  fs.mkdirSync(candlesDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });

  const sampleCandles = {
    candles: [
      { date: '2026-10-15', close: 1000, volume: 1000000 },
      { date: '2026-10-16', close: 1000, volume: 1000000 },
      { date: '2026-10-19', close: 1020, volume: 1200000 },
      { date: '2026-10-20', close: 1030, volume: 1500000 },
      { date: '2026-10-23', close: 1050, volume: 2000000 }
    ]
  };

  fs.writeFileSync(path.join(candlesDir, 'IHSG.json'), JSON.stringify(sampleCandles));
  fs.writeFileSync(path.join(candlesDir, 'BBCA.json'), JSON.stringify(sampleCandles));

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('1. loadTradingDays includes dates past 2026-10-16 dynamically', () => {
    const days = backfill.loadTradingDays(candlesDir, { maxDate: '2026-10-24' });
    assert.ok(days.length > 0, 'Must load trading days');
    assert.ok(days.includes('2026-10-19'), 'Must include 2026-10-19');
    assert.ok(days.includes('2026-10-20'), 'Must include 2026-10-20');
    assert.ok(days.includes('2026-10-23'), 'Must include 2026-10-23');
    assert.equal(days[0], '2026-10-23', 'Newest date must be first');
  });

  await t.test('2. resolveMaxTradingDate returns a valid dynamic date key', () => {
    const maxDate = backfill.resolveMaxTradingDate({ now: new Date('2026-10-20T10:00:00+07:00') });
    assert.equal(maxDate, '2026-10-20', 'Should resolve trading day date key');

    // On weekend (Sunday), should shift to previous trading day
    const weekendDate = backfill.resolveMaxTradingDate({ now: new Date('2026-10-25T10:00:00+07:00') });
    assert.equal(weekendDate, '2026-10-23', 'Sunday should resolve to Friday previous trading day');
  });

  await t.test('3. categorizeTickersByLiquidity evaluates turnover across dynamic dates', () => {
    const highVolCandles = {
      candles: [
        { date: '2026-10-19', close: 5000, volume: 500000 }, // 2.5B turnover
        { date: '2026-10-20', close: 5000, volume: 500000 }, // 2.5B turnover
        { date: '2026-10-23', close: 5000, volume: 500000 }  // 2.5B turnover
      ]
    };
    fs.writeFileSync(path.join(candlesDir, 'TLKM.json'), JSON.stringify(highVolCandles));

    const { liquid, regular } = backfill.categorizeTickersByLiquidity(baseDir, candlesDir, ['TLKM'], { maxDate: '2026-10-24' });
    assert.deepEqual(liquid, ['TLKM'], 'TLKM must be liquid based on post-Oct-16 turnover');
    assert.deepEqual(regular, []);
  });
});

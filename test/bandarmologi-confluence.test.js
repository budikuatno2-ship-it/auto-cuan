'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bandarmologiService = require('../lib/bandarmologi-service');
const confluence = require('../lib/bandarmologi-confluence');

function withTempDataDir(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-confluence-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;
  confluence.clearMemoryCacheForTesting();
  try {
    return fn(tmpBase);
  } finally {
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function writeDay(ticker, date, buyerVal, sellerVal) {
  bandarmologiService.writeDiskCache('broker-summary', ticker, date, {
    stock_code: ticker,
    date,
    top_buyers: buyerVal > 0 ? [{ broker: 'YU', bval: buyerVal, sval: 0, bvol: 10, svol: 0 }] : [],
    top_sellers: sellerVal > 0 ? [{ broker: 'AK', bval: 0, sval: sellerVal, bvol: 0, svol: 10 }] : []
  });
}

test('bandarmologiConfluence: no disk data returns a labelled "unavailable" result, never fabricated numbers', () => {
  withTempDataDir(() => {
    const result = confluence.computeBandarmologiConfluence('NODATA1');
    assert.equal(result.bandar_label, 'Bandar Data Unavailable');
    assert.equal(result.bandar_3d, null);
    assert.equal(result.bandar_7d, null);
    assert.equal(result.bandar_1m, null);
    assert.equal(result.bandar_3m, null);
    assert.deepEqual(result.bandar_consistent_windows, []);
  });
});

test('bandarmologiConfluence: consistent net-buy across 3D/7D is reported as Accumulation with 1M/3M null when under 20 days', () => {
  withTempDataDir(() => {
    const ticker = 'ACCUM1';
    // 10 straight days of net buy -> 3D and 7D agree, 1M/3M null due to minimum threshold
    const dates = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date('2026-09-05T00:00:00Z');
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      dates.push(iso);
      writeDay(ticker, iso, 100, 0);
    }

    const result = confluence.computeBandarmologiConfluence(ticker);
    assert.equal(result.bandar_label, 'Accumulation');
    assert.equal(result.bandar_3d, 300);
    assert.equal(result.bandar_7d, 700);
    assert.equal(result.bandar_1m, null); // only 10 days on disk (< 20 required), nullified
    assert.equal(result.bandar_3m, null); // (< 60 required), nullified
    assert.ok(result.bandar_consistent_windows.includes('3D'));
    assert.ok(result.bandar_consistent_windows.includes('7D'));
    assert.ok(!result.bandar_consistent_windows.includes('1M'));
    assert.ok(!result.bandar_consistent_windows.includes('3M'));
  });
});

test('bandarmologiConfluence: 1M is computed when >= 20 trading days available', () => {
  withTempDataDir(() => {
    const ticker = 'ACCUM20';
    for (let i = 0; i < 22; i++) {
      const d = new Date('2026-09-05T00:00:00Z');
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      writeDay(ticker, iso, 100, 0);
    }

    const result = confluence.computeBandarmologiConfluence(ticker);
    assert.equal(result.bandar_label, 'Accumulation');
    assert.equal(result.bandar_3d, 300);
    assert.equal(result.bandar_7d, 700);
    assert.equal(result.bandar_1m, 2200);
    assert.equal(result.bandar_3m, null); // 22 < 60, still null
    assert.ok(result.bandar_consistent_windows.includes('1M'));
    assert.ok(!result.bandar_consistent_windows.includes('3M'));
  });
});

test('bandarmologiConfluence: mixed direction across windows reports Mixed, not a false Accumulation/Distribution', () => {
  withTempDataDir(() => {
    const ticker = 'MIXED1';
    // Last 3 days net sell, days 4-7 net buy: 3D negative, 7D still positive
    // (buy days dominate the sum) -> signs disagree -> Mixed.
    const plan = [
      ['2026-09-05', 0, 50], ['2026-09-04', 0, 50], ['2026-09-03', 0, 50],
      ['2026-09-02', 500, 0], ['2026-09-01', 500, 0], ['2026-08-31', 500, 0], ['2026-08-28', 500, 0]
    ];
    plan.forEach(([date, buy, sell]) => writeDay(ticker, date, buy, sell));

    const result = confluence.computeBandarmologiConfluence(ticker);
    assert.equal(result.bandar_3d, -150);
    assert.equal(result.bandar_7d, 1850);
    assert.equal(result.bandar_label, 'Mixed');
    // 3D (the anchor) disagrees with 7D, so 7D must not be listed as consistent.
    assert.ok(!result.bandar_consistent_windows.includes('7D'));
  });
});

test('bandarmologiConfluence: enrichBandarmologiConfluenceMap batches multiple tickers and dedupes', () => {
  withTempDataDir(() => {
    writeDay('DUPE1', '2026-09-05', 100, 0);
    writeDay('DUPE2', '2026-09-05', 0, 100);
    const map = confluence.enrichBandarmologiConfluenceMap(['dupe1', 'DUPE1', 'dupe2']);
    assert.equal(Object.keys(map).length, 2, 'must dedupe case-insensitively repeated tickers');
    assert.equal(map.DUPE1.bandar_label, 'Accumulation');
    assert.equal(map.DUPE2.bandar_label, 'Distribution');
  });
});

test('bandarmologiConfluence: getBandarTrendLabel matches the vocabulary already used by foreign-flow confluence', () => {
  assert.equal(confluence.getBandarTrendLabel(100, 100), 'Accumulation');
  assert.equal(confluence.getBandarTrendLabel(-100, -100), 'Distribution');
  assert.equal(confluence.getBandarTrendLabel(100, -100), 'Mixed');
  assert.equal(confluence.getBandarTrendLabel(0, 0), 'Mixed');
});

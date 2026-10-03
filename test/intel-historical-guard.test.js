'use strict';

/**
 * Wave 2 — Historical Intel recompute guards (W2-02/W2-03/W2-11).
 *
 * Proves:
 *  - historical recompute never writes latest.json / catalog.json /
 *    latest_7d.json / catalog_7d.json (byte + mtime identical before/after)
 *  - historical recompute performs ZERO live bridge / SSH / live-price calls
 *  - historical recompute uses the target-date candle
 *  - same fixture twice produces byte-equivalent results (determinism)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const bandarmologiService = require('../lib/bandarmologi-service');
const vpsDataFetcher = require('../lib/vps-data-fetcher');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function withTempEnv(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-guard-'));
  const orig = {
    ARJUM_DATA_DIR: process.env.ARJUM_DATA_DIR,
    INTEL_INDEX_DIR: process.env.INTEL_INDEX_DIR,
    INTEL_CACHE_DIR: process.env.INTEL_CACHE_DIR,
    INTEL_OHLCV_DIR: process.env.INTEL_OHLCV_DIR,
    BROKER_HUNTER_INDEX_DIR: process.env.BROKER_HUNTER_INDEX_DIR
  };
  process.env.ARJUM_DATA_DIR = path.join(tmpBase, 'arjum-data');
  process.env.INTEL_INDEX_DIR = path.join(tmpBase, 'indexes');
  process.env.INTEL_CACHE_DIR = path.join(tmpBase, 'intel-cache');
  process.env.INTEL_OHLCV_DIR = path.join(tmpBase, 'ohlcv');
  process.env.BROKER_HUNTER_INDEX_DIR = path.join(tmpBase, 'hunter');
  fs.mkdirSync(process.env.INTEL_INDEX_DIR, { recursive: true });
  fs.mkdirSync(process.env.INTEL_CACHE_DIR, { recursive: true });
  fs.mkdirSync(process.env.INTEL_OHLCV_DIR, { recursive: true });
  return Promise.resolve()
    .then(() => fn(tmpBase))
    .finally(() => {
      for (const [key, value] of Object.entries(orig)) {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    });
}

function writeOhlcv(ticker, rows) {
  const payload = { ticker, candles: rows.map(r => ({ date: r.date, open: r.close, high: r.close, low: r.close, close: r.close, volume: r.volume })) };
  fs.writeFileSync(path.join(process.env.INTEL_OHLCV_DIR, `${ticker}.json`), JSON.stringify(payload));
}

function seedIndexFiles() {
  const sentinel = JSON.stringify({ sentinel: 'current-index', indexes: {}, tickers: {} });
  const files = ['latest.json', 'catalog.json', 'latest_7d.json', 'catalog_7d.json'];
  const before = {};
  for (const name of files) {
    const p = path.join(process.env.INTEL_INDEX_DIR, name);
    fs.writeFileSync(p, sentinel);
    before[name] = { hash: sha256File(p), mtime: fs.statSync(p).mtimeMs };
  }
  return before;
}

test('W2-02: historical recompute leaves every latest/current index byte-identical', async () => {
  await withTempEnv(async () => {
    // Seed broker summaries for a HISTORICAL date (2026-09-04) and a later
    // "current" date (2026-09-30) so the target date is provably historical.
    bandarmologiService.writeDiskCache('broker-summary', 'GUARD1', '2026-09-04', {
      stock_code: 'GUARD1', date: '2026-09-04',
      top_buyers: [{ broker: 'AK', bval: 10000000, bvol: 10000 }],
      top_sellers: [{ broker: 'YP', sval: 10000000, svol: 10000 }]
    });
    writeOhlcv('GUARD1', [{ date: '2026-09-04', close: 950, volume: 1000 }]);

    const before = seedIndexFiles();
    const intel = require('../lib/bandarmologi-intel-service');
    const payload = intel.computeAndSaveIntel({ tickers: ['GUARD1'], date: '2026-09-04', historical: true });

    assert.equal(payload.historical, true);
    assert.equal(payload.date, '2026-09-04');

    for (const name of ['latest.json', 'catalog.json', 'latest_7d.json', 'catalog_7d.json']) {
      const p = path.join(process.env.INTEL_INDEX_DIR, name);
      assert.equal(sha256File(p), before[name].hash, `${name} content must be untouched by a historical recompute`);
      assert.equal(fs.statSync(p).mtimeMs, before[name].mtime, `${name} mtime must be untouched by a historical recompute`);
    }

    // The only artifact written is the date-scoped cache.
    const datedCache = path.join(process.env.INTEL_CACHE_DIR, '2026-09-04.json');
    assert.equal(fs.existsSync(datedCache), true, 'date-scoped historical cache must exist');
  });
});

test('W2-03: historical recompute performs zero bridge/SSH/live-price calls', async () => {
  await withTempEnv(async () => {
    const calls = { livePrice: 0, ohlcvVps: 0, brokerRangeVps: 0, brokerVps: 0, intelIndexVps: 0 };
    const originals = {
      fetchLivePriceFromVpsSync: vpsDataFetcher.fetchLivePriceFromVpsSync,
      fetchOhlcvFromVpsSync: vpsDataFetcher.fetchOhlcvFromVpsSync,
      fetchBrokerSummaryRangeFromVpsSync: vpsDataFetcher.fetchBrokerSummaryRangeFromVpsSync,
      fetchBrokerSummaryFromVpsSync: vpsDataFetcher.fetchBrokerSummaryFromVpsSync,
      fetchIntelIndexFromVpsSync: vpsDataFetcher.fetchIntelIndexFromVpsSync,
      hasSshKey: vpsDataFetcher.hasSshKey
    };
    vpsDataFetcher.fetchLivePriceFromVpsSync = () => { calls.livePrice++; return null; };
    vpsDataFetcher.fetchOhlcvFromVpsSync = () => { calls.ohlcvVps++; return null; };
    vpsDataFetcher.fetchBrokerSummaryRangeFromVpsSync = () => { calls.brokerRangeVps++; return null; };
    vpsDataFetcher.fetchBrokerSummaryFromVpsSync = () => { calls.brokerVps++; return null; };
    vpsDataFetcher.fetchIntelIndexFromVpsSync = () => { calls.intelIndexVps++; return null; };
    vpsDataFetcher.hasSshKey = () => true;

    try {
      bandarmologiService.writeDiskCache('broker-summary', 'GUARD2', '2026-09-04', {
        stock_code: 'GUARD2', date: '2026-09-04',
        top_buyers: [{ broker: 'AK', bval: 10000000, bvol: 10000 }],
        top_sellers: [{ broker: 'YP', sval: 10000000, svol: 10000 }]
      });
      writeOhlcv('GUARD2', [{ date: '2026-09-04', close: 950, volume: 1000 }]);
      seedIndexFiles();

      const intel = require('../lib/bandarmologi-intel-service');
      intel.computeAndSaveIntel({ tickers: ['GUARD2'], date: '2026-09-04', historical: true });

      assert.equal(calls.livePrice, 0, 'historical recompute must make zero live-price bridge calls');
      assert.equal(calls.ohlcvVps, 0, 'historical recompute must make zero OHLCV VPS/SSH calls');
      assert.equal(calls.brokerRangeVps, 0, 'historical recompute must make zero broker-summary range SSH calls');
      assert.equal(calls.brokerVps, 0, 'historical recompute must make zero broker-summary SSH calls');
      assert.equal(calls.intelIndexVps, 0, 'historical recompute must not consult the live index bridge');
    } finally {
      Object.assign(vpsDataFetcher, originals);
    }
  });
});

test('W2-03: historical recompute uses the target-date candle, not the newest candle', async () => {
  await withTempEnv(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'GUARD3', '2026-09-04', {
      stock_code: 'GUARD3', date: '2026-09-04',
      top_buyers: [{ broker: 'AK', bval: 10000000, bvol: 10000 }],
      top_sellers: [{ broker: 'YP', sval: 10000000, svol: 10000 }]
    });
    // Newest candle is a LATER session with a very different price.
    writeOhlcv('GUARD3', [
      { date: '2026-09-04', close: 950, volume: 1000 },
      { date: '2026-09-30', close: 5000, volume: 99999 }
    ]);
    seedIndexFiles();

    const intel = require('../lib/bandarmologi-intel-service');
    const payload = intel.computeAndSaveIntel({ tickers: ['GUARD3'], date: '2026-09-04', historical: true });
    const evaluation = payload.tickers.GUARD3;
    const s1 = evaluation.signals.harga_di_bawah_modal_bandar;
    assert.equal(s1.current_price, 950, 'historical price must come from the target-date candle');
    assert.notEqual(s1.current_price, 5000, 'the newest candle must not leak into a historical recompute');
  });
});

test('W2-03 review: a historical target with no target-date candle reports NO_CURRENT_PRICE, never the newest candle', async () => {
  await withTempEnv(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'GUARD5', '2026-09-04', {
      stock_code: 'GUARD5', date: '2026-09-04',
      top_buyers: [{ broker: 'AK', bval: 10000000, bvol: 10000 }],
      top_sellers: [{ broker: 'YP', sval: 10000000, svol: 10000 }]
    });
    // The cache holds ONLY a later session — the target date has no candle.
    writeOhlcv('GUARD5', [{ date: '2026-09-30', close: 5000, volume: 99999 }]);
    seedIndexFiles();

    const intel = require('../lib/bandarmologi-intel-service');
    const payload = intel.computeAndSaveIntel({ tickers: ['GUARD5'], date: '2026-09-04', historical: true });
    const s1 = payload.tickers.GUARD5.signals.harga_di_bawah_modal_bandar;
    assert.equal(s1.reason, 'NO_CURRENT_PRICE', 'a missing target-date candle must surface NO_CURRENT_PRICE');
    assert.equal(s1.current_price, null);
    assert.notEqual(s1.current_price, 5000, 'a later session price must never be substituted');
  });
});

test('W2-03 review: historical signal windows exclude broker summaries newer than the target date', async () => {
  await withTempEnv(async () => {
    // Three days of foreign accumulation AT the target window...
    for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) {
      bandarmologiService.writeDiskCache('broker-summary', 'GUARD6', d, {
        stock_code: 'GUARD6', date: d,
        gross_buyers: [
          { broker: 'AK', bval: 5000000, bvol: 5000, sval: 0, svol: 0, net_val: 5000000 },
          { broker: 'BK', bval: 5000000, bvol: 5000, sval: 0, svol: 0, net_val: 5000000 }
        ],
        gross_sellers: [{ broker: 'YP', sval: 10000000, svol: 10000, bval: 0, bvol: 0, net_val: -10000000 }]
      });
    }
    // ...and a LATER session that breaks the streak.
    bandarmologiService.writeDiskCache('broker-summary', 'GUARD6', '2026-09-30', {
      stock_code: 'GUARD6', date: '2026-09-30',
      gross_buyers: [{ broker: 'YP', bval: 100, bvol: 100, net_val: 100 }],
      gross_sellers: [{ broker: 'AK', sval: 500000000, svol: 100000, net_val: -500000000 }]
    });
    writeOhlcv('GUARD6', [
      { date: '2026-09-02', close: 1000, volume: 1000 },
      { date: '2026-09-03', close: 1005, volume: 1000 },
      { date: '2026-09-04', close: 1010, volume: 1000 }
    ]);
    seedIndexFiles();

    const intel = require('../lib/bandarmologi-intel-service');
    const payload = intel.computeAndSaveIntel({ tickers: ['GUARD6'], date: '2026-09-04', historical: true });
    const s2 = payload.tickers.GUARD6.signals.silent_foreign_accumulation;
    assert.equal(s2.consecutive_days, 3, 'the post-target session must not truncate the historical streak');
    assert.equal(s2.triggered, true, 'the historical window must be evaluated without future data');
  });
});

test('W2-11: historical recompute is deterministic — same fixture twice, identical payload', async () => {
  await withTempEnv(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'GUARD4', '2026-09-04', {
      stock_code: 'GUARD4', date: '2026-09-04',
      top_buyers: [{ broker: 'AK', bval: 10000000, bvol: 10000 }],
      top_sellers: [{ broker: 'YP', sval: 10000000, svol: 10000 }]
    });
    writeOhlcv('GUARD4', [{ date: '2026-09-04', close: 950, volume: 1000 }]);
    seedIndexFiles();

    const intel = require('../lib/bandarmologi-intel-service');
    const first = intel.computeAndSaveIntel({ tickers: ['GUARD4'], date: '2026-09-04', historical: true });
    const second = intel.computeAndSaveIntel({ tickers: ['GUARD4'], date: '2026-09-04', historical: true });
    assert.deepEqual(first, second, 'two identical historical recomputes must produce identical payloads');
  });
});

test('W2-02: current-mode recompute still updates the latest indexes where intended', async () => {
  await withTempEnv(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'CURR1', '2026-09-30', {
      stock_code: 'CURR1', date: '2026-09-30',
      top_buyers: [{ broker: 'AK', bval: 10000000, bvol: 10000 }],
      top_sellers: [{ broker: 'YP', sval: 10000000, svol: 10000 }]
    });
    writeOhlcv('CURR1', [{ date: '2026-09-30', close: 950, volume: 1000 }]);
    const before = seedIndexFiles();

    const intel = require('../lib/bandarmologi-intel-service');
    // Explicit current mode: historical=false bypasses the session heuristic.
    intel.computeAndSaveIntel({ tickers: ['CURR1'], date: '2026-09-30', historical: false });

    const latestPath = path.join(process.env.INTEL_INDEX_DIR, 'latest.json');
    assert.notEqual(sha256File(latestPath), before['latest.json'].hash, 'current-mode recompute must update latest.json');
  });
});

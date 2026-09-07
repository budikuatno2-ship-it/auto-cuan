'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');
const backfillWorker = require('../tools/backfill-arjum-data');
const sectorHot = require('../api/sector-hot');

// =================================================================
// 1. BACKFILL RESILIENCE & SMART SKIP TESTS
// =================================================================

test('backfillWorker: isValidCachedJson rejects missing, empty, or corrupt files and accepts valid JSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    const summaryDir = path.join(tmpDir, 'broker-summary', 'TEST');
    fs.mkdirSync(summaryDir, { recursive: true });

    // Missing file
    assert.equal(backfillWorker.isValidCachedJson('broker-summary', 'TEST', '2026-09-01'), false);

    // 0-byte or <= 2 bytes file
    fs.writeFileSync(path.join(summaryDir, '2026-09-02.json'), '{}');
    assert.equal(backfillWorker.isValidCachedJson('broker-summary', 'TEST', '2026-09-02'), false);

    // Corrupt JSON
    fs.writeFileSync(path.join(summaryDir, '2026-09-03.json'), '{ invalid json content !!!');
    assert.equal(backfillWorker.isValidCachedJson('broker-summary', 'TEST', '2026-09-03'), false);

    // Valid JSON with content
    fs.writeFileSync(path.join(summaryDir, '2026-09-04.json'), JSON.stringify({ ok: true, count: 10 }));
    assert.equal(backfillWorker.isValidCachedJson('broker-summary', 'TEST', '2026-09-04'), true);
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backfillWorker: isTickerFullyCached returns true only when series, p1, and all target dates exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-fully-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    const dates = ['2026-09-01', '2026-09-02'];
    assert.equal(backfillWorker.isTickerFullyCached('BBCA', dates), false);

    // Add series
    bandarmologiService.writeDiskCache('broker-accumulation', 'BBCA', 'series', { series: [1, 2] });
    assert.equal(backfillWorker.isTickerFullyCached('BBCA', dates), false);

    // Add p1
    bandarmologiService.writeDiskCache('insiders', 'BBCA', 'p1', [{ name: 'CEO' }]);
    assert.equal(backfillWorker.isTickerFullyCached('BBCA', dates), false);

    // Add date 1 only
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', '2026-09-01', { gross_buyers: [] });
    assert.equal(backfillWorker.isTickerFullyCached('BBCA', dates), false);

    // Add date 2 -> now fully cached!
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', '2026-09-02', { gross_buyers: [] });
    assert.equal(backfillWorker.isTickerFullyCached('BBCA', dates), true);
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =================================================================
// 2. MULTI-DAY AGGREGATION & 100X ANOMALY PROTECTION TESTS
// =================================================================

test('bandarmologiService: aggregateBrokerSummaries sanitizes 100x lot price anomaly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-test-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    // Write summary where bval is in IDR and bvol is in LOTS (1 lot = 100 shares),
    // yielding bval/bvol = 950,000 IDR instead of 9,500 IDR
    bandarmologiService.writeDiskCache('broker-summary', 'ANOM1', '2026-09-04', {
      stock_code: 'ANOM1',
      date: '2026-09-04',
      top_buyers: [
        { broker: 'AK', bval: 9500000000, bvol: 10000, sval: 0, svol: 0 } // 9.5M / 10K = 950,000 -> sanitized to 9,500
      ],
      top_sellers: [
        { broker: 'YP', sval: 9500000000, svol: 10000, bval: 0, bvol: 0 } // sanitized to 9,500
      ]
    });

    const agg = bandarmologiService.aggregateBrokerSummaries('ANOM1', ['2026-09-04']);
    assert.ok(agg);
    const akBuyer = agg.top_buyers.find(b => b.broker === 'AK');
    assert.ok(akBuyer);
    assert.equal(akBuyer.avg_buy, 9500, 'avg_buy must be sanitized from 950,000 to 9,500');

    const ypSeller = agg.top_sellers.find(s => s.broker === 'YP');
    assert.ok(ypSeller);
    assert.equal(ypSeller.avg_sell, 9500, 'avg_sell must be sanitized from 950,000 to 9,500');
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bandarmologiService: getBandarmologiData multi-day range succeeds even if accumulation series is missing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiday-noacc-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    bandarmologiService.writeDiskCache('broker-summary', 'NOACC', '2026-09-03', {
      stock_code: 'NOACC',
      date: '2026-09-03',
      top_buyers: [{ broker: 'AK', bval: 1000000, bvol: 1000 }],
      top_sellers: [{ broker: 'YP', sval: 1000000, svol: 1000 }]
    });
    bandarmologiService.writeDiskCache('broker-summary', 'NOACC', '2026-09-04', {
      stock_code: 'NOACC',
      date: '2026-09-04',
      top_buyers: [{ broker: 'AK', bval: 2000000, bvol: 2000 }],
      top_sellers: [{ broker: 'YP', sval: 2000000, svol: 2000 }]
    });

    const res = await bandarmologiService.getBandarmologiData('NOACC', { range: '7d' });
    assert.equal(res.success, true);
    assert.equal(res.is_demo, false);
    assert.equal(res.broker_summary.range_days, 2);
    assert.equal(res.broker_summary.top_buyers[0].broker, 'AK');
    assert.equal(res.broker_summary.top_buyers[0].buy_val, 3000000);
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =================================================================
// 3. 4 PRE-CALCULATED BANDARMOLOGI INTELLIGENCE SIGNALS TESTS
// =================================================================

test('bandarmologiIntelService: Signal 1 (Harga di Bawah Modal Bandar) detects sweet-spot discount', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-s1-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    // Top 3 buyers: AK, BK, RX with average buy price 1,000 IDR
    bandarmologiService.writeDiskCache('broker-summary', 'S1TEST', '2026-09-04', {
      stock_code: 'S1TEST',
      date: '2026-09-04',
      top_buyers: [
        { broker: 'AK', bval: 10000000, bvol: 10000, sval: 0, svol: 0 }, // 1,000
        { broker: 'BK', bval: 10000000, bvol: 10000, sval: 0, svol: 0 }, // 1,000
        { broker: 'RX', bval: 10000000, bvol: 10000, sval: 0, svol: 0 }  // 1,000
      ],
      top_sellers: []
    });

    // Current price = 950 (5% discount -> sweet-spot 1% to 10%)
    const res = bandarmologiIntelService.detectPriceBelowBandarCost('S1TEST', {
      currentPrice: 950,
      range: '7d'
    });

    assert.equal(res.triggered, true);
    assert.equal(res.in_sweet_spot, true);
    assert.equal(res.bandar_avg_buy, 1000);
    assert.equal(res.current_price, 950);
    assert.equal(res.discount_pct, 5);
    assert.equal(res.top_3_brokers.length, 3);

    // Current price = 1050 (Above modal bandar)
    const resAbove = bandarmologiIntelService.detectPriceBelowBandarCost('S1TEST', {
      currentPrice: 1050,
      range: '7d'
    });
    assert.equal(resAbove.triggered, false);
    assert.equal(resAbove.discount_pct < 0, true);
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bandarmologiIntelService: Signal 2 (Silent Foreign Accumulation) detects positive foreign buy with sideways price', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-s2-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    // 3 consecutive days of net foreign buy (AK + BK) with stable prices (1000, 1005, 1010 -> ~1% change <= 2%)
    const dates = ['2026-09-04', '2026-09-03', '2026-09-02'];
    const prices = { '2026-09-04': 1010, '2026-09-03': 1005, '2026-09-02': 1000 };

    dates.forEach(d => {
      bandarmologiService.writeDiskCache('broker-summary', 'S2TEST', d, {
        stock_code: 'S2TEST',
        date: d,
        gross_buyers: [
          { broker: 'AK', bval: 5000000, bvol: 5000, sval: 0, svol: 0, net_val: 5000000 },
          { broker: 'BK', bval: 5000000, bvol: 5000, sval: 0, svol: 0, net_val: 5000000 }
        ],
        gross_sellers: [
          { broker: 'YP', sval: 10000000, svol: 10000, bval: 0, bvol: 0, net_val: -10000000 }
        ]
      });
    });

    const res = bandarmologiIntelService.detectSilentForeignAccumulation('S2TEST', {
      pricesByDate: prices
    });

    assert.equal(res.triggered, true);
    assert.equal(res.consecutive_days, 3);
    assert.equal(res.is_sideways, true);
    assert.ok(res.price_change_pct <= 2.0);
    assert.ok(res.total_foreign_net > 0);
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bandarmologiIntelService: Signal 3 (Ritel Cutloss vs Bandar Nampung) and reverse (Distribusi ke Ritel)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-s3-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    // Condition A: Bandar Nampung (Top 3 Buyers: AK, BK, RX [institutional] | Top 3 Sellers: YP, PD, XC [retail])
    bandarmologiService.writeDiskCache('broker-summary', 'S3NAMPUNG', '2026-09-04', {
      stock_code: 'S3NAMPUNG',
      date: '2026-09-04',
      top_buyers: [{ broker: 'AK' }, { broker: 'BK' }, { broker: 'RX' }],
      top_sellers: [{ broker: 'YP' }, { broker: 'PD' }, { broker: 'XC' }]
    });

    const resA = bandarmologiIntelService.detectRetailCutlossVsBandar('S3NAMPUNG', { date: '2026-09-04' });
    assert.equal(resA.triggered, true);
    assert.equal(resA.is_bandar_nampung, true);
    assert.equal(resA.sub_type, 'BANDAR_NAMPUNG_RITEL_CUTLOSS');
    assert.equal(resA.inst_buyer_count, 3);
    assert.equal(resA.retail_seller_count, 3);

    // Condition B: Distribusi ke Ritel (Top 3 Buyers: YP, XC, XL [retail] | Top 3 Sellers: AK, CC, KZ [institutional])
    bandarmologiService.writeDiskCache('broker-summary', 'S3DIST', '2026-09-04', {
      stock_code: 'S3DIST',
      date: '2026-09-04',
      top_buyers: [{ broker: 'YP' }, { broker: 'XC' }, { broker: 'XL' }],
      top_sellers: [{ broker: 'AK' }, { broker: 'CC' }, { broker: 'KZ' }]
    });

    const resB = bandarmologiIntelService.detectRetailCutlossVsBandar('S3DIST', { date: '2026-09-04' });
    assert.equal(resB.triggered, true);
    assert.equal(resB.is_distribusi_ke_ritel, true);
    assert.equal(resB.sub_type, 'DISTRIBUSI_KE_RITEL');
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bandarmologiIntelService: Signal 4 (Concentration Ratio CR3 & CR5) classifies massive accumulation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-s4-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    // Total buy volume = 100,000 lots
    // Top 3 buyers: AK (40k), BK (20k), RX (10k) = 70k -> CR3 = 70% (>= 60% Akumulasi Masif)
    // Top 5 buyers: + CC (5k), KZ (5k) = 80k -> CR5 = 80%
    bandarmologiService.writeDiskCache('broker-summary', 'S4MASSIVE', '2026-09-04', {
      stock_code: 'S4MASSIVE',
      date: '2026-09-04',
      gross_buyers: [
        { broker: 'AK', buy_vol: 40000 },
        { broker: 'BK', buy_vol: 20000 },
        { broker: 'RX', buy_vol: 10000 },
        { broker: 'CC', buy_vol: 5000 },
        { broker: 'KZ', buy_vol: 5000 },
        { broker: 'YP', buy_vol: 20000 }
      ]
    });

    const res = bandarmologiIntelService.computeConcentrationRatios('S4MASSIVE', { date: '2026-09-04' });
    assert.equal(res.triggered, true);
    assert.equal(res.is_massive, true);
    assert.equal(res.cr3, 70);
    assert.equal(res.cr5, 80);
    assert.equal(res.status, 'AKUMULASI_MASIF');
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bandarmologiIntelService: evaluateBandarmologiIntelForTicker produces unified confluence score', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-eval-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    bandarmologiService.writeDiskCache('broker-summary', 'UNIFIED', '2026-09-04', {
      stock_code: 'UNIFIED',
      date: '2026-09-04',
      top_buyers: [{ broker: 'AK', buy_val: 70000000, buy_vol: 70000 }, { broker: 'BK', buy_val: 10000000, buy_vol: 10000 }, { broker: 'RX', buy_val: 10000000, buy_vol: 10000 }],
      top_sellers: [{ broker: 'YP', sell_val: 50000000, sell_vol: 50000 }, { broker: 'PD', sell_val: 30000000, sell_vol: 30000 }, { broker: 'XC', sell_val: 10000000, sell_vol: 10000 }],
      gross_buyers: [{ broker: 'AK', buy_vol: 70000 }, { broker: 'BK', buy_vol: 10000 }, { broker: 'RX', buy_vol: 10000 }, { broker: 'YP', buy_vol: 10000 }]
    });

    const evalResult = bandarmologiIntelService.evaluateBandarmologiIntelForTicker('UNIFIED', {
      currentPrice: 950,
      date: '2026-09-04'
    });

    assert.equal(evalResult.ticker, 'UNIFIED');
    assert.ok(evalResult.bullish_signals_count >= 2);
    assert.equal(evalResult.confluence_badge === 'STRONG_ACCUMULATION' || evalResult.confluence_badge === 'ACCUMULATION', true);
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sectorHot: handleBandarmologiIntel responds with status 200 and formatted intelligence output', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-api-'));
  const origDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    bandarmologiService.writeDiskCache('broker-summary', 'APITEST', '2026-09-04', {
      stock_code: 'APITEST',
      date: '2026-09-04',
      top_buyers: [{ broker: 'AK', buy_val: 10000000, buy_vol: 10000 }],
      top_sellers: [{ broker: 'YP', sell_val: 10000000, sell_vol: 10000 }],
      gross_buyers: [{ broker: 'AK', buy_vol: 10000 }]
    });

    let statusCode = 0;
    let jsonBody = null;
    const req = {
      method: 'GET',
      query: { action: 'bandarmologi-intel', ticker: 'APITEST' }
    };
    const res = {
      status(c) { statusCode = c; return this; },
      json(data) { jsonBody = data; return this; }
    };

    const handler = sectorHot.__test.handleBandarmologiIntel;
    await handler(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.success, true);
    assert.equal(jsonBody.ticker, 'APITEST');
    assert.ok(jsonBody.result.signals);

    // Also test through main sectorHot endpoint dispatcher
    statusCode = 0;
    jsonBody = null;
    await sectorHot(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.success, true);
    assert.equal(jsonBody.ticker, 'APITEST');
  } finally {
    if (origDir !== undefined) process.env.ARJUM_DATA_DIR = origDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

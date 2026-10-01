'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const bs = require('../lib/bandarmologi-service');
const intel = require('../lib/bandarmologi-intel-service');
const sectorHot = require('../api/sector-hot');
const cryptoService = require('../lib/crypto-service');
const backtestScreener = require('../tools/backtest-screener');
const dtEngine = require('../lib/daytrade-screener-engine');
const fastWatcher = require('../lib/intraday-fast-watcher-momentum');
const insiderService = require('../lib/insider-network-service');

const TICKERS = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'BREN', 'ESSA', 'IMPC'];
const ITERATIONS = 100;

console.log(`\n======================================================`);
console.log(`🚀 MEMULAI PENGUJIAN DETERMINISTIK: ${ITERATIONS}X LOOP INTEGRITAS`);
console.log(`======================================================\n`);

(async () => {
  let successCount = 0;

  for (let i = 1; i <= ITERATIONS; i++) {
    const ticker = TICKERS[(i - 1) % TICKERS.length];

    // 1. Klaster 1: Uji Broker Summary (Anti-Demo 25 vs 25, Net Flow)
    const brokData = await bs.getBandarmologiData(ticker, { date: '2026-09-11' });
    if (brokData && !brokData.is_empty) {
      assert.strictEqual(brokData.is_demo, false, `[Loop ${i}] ${ticker} masih menggunakan data DEMO!`);
      assert.ok(Array.isArray(brokData.broker_summary?.gross_buyers), `[Loop ${i}] ${ticker} gross_buyers bukan array!`);
      assert.ok(Array.isArray(brokData.broker_summary?.gross_sellers), `[Loop ${i}] ${ticker} gross_sellers bukan array!`);
      assert.notStrictEqual(brokData.net_flow, '-', `[Loop ${i}] ${ticker} Net Flow masih bernilai strip (-)`);
      assert.notStrictEqual(brokData.broker_summary?.net_flow, '-', `[Loop ${i}] ${ticker} BS Net Flow masih bernilai strip (-)`);
    }

    // 2. Klaster 1: Sinyal Intelijen (Anti-Harga Kembar & Anti-CR5 100%)
    if (ticker === 'BBCA') {
      const intelData = await intel.evaluateBandarmologiIntelForTicker('BBCA', { range: '7d' });
      const currentPrice = intelData.signals?.harga_di_bawah_modal_bandar?.current_price;
      const top3 = intelData.signals?.harga_di_bawah_modal_bandar?.top_3_brokers || [];
      const cr5 = intelData.signals?.concentration_ratio?.cr5;

      assert.ok(currentPrice > 0, `[Loop ${i}] Harga sekarang BBCA kosong atau 0!`);
      if (top3.length >= 3) {
        const prices = top3.map(b => b.avg_price);
        const allIdentical = prices.every(p => p === prices[0]);
        assert.strictEqual(allIdentical, false, `[Loop ${i}] Harga Top 3 Broker BBCA kembar identik: ${prices.join(', ')}`);
      }
      assert.ok(cr5 < 100, `[Loop ${i}] CR5 BBCA terkunci 100%! Nilai: ${cr5}%`);
      assert.ok(cr5 > 0, `[Loop ${i}] CR5 BBCA tidak boleh 0%!`);
    }

    // 3. Klaster 2: Screener Scoring & Precision
    assert.equal(typeof dtEngine.safeToFixed, 'function', `[Loop ${i}] dtEngine.safeToFixed missing`);
    assert.equal(typeof fastWatcher.safeToFixed, 'function', `[Loop ${i}] fastWatcher.safeToFixed missing`);
    assert.equal(dtEngine.safeToFixed(i * 1.5), (i * 1.5).toFixed(2));
    assert.equal(dtEngine.isPrespikeRadar({ change_pct: 0.5, volume_ratio_20d: 3.0 }), true);
    assert.equal(dtEngine.isEarlyMomentum({ change_pct: 2.5, volume_ratio_20d: 2.0 }), true);

    // 4. Klaster 3: Backtest MFE and Anomaly Filter
    const testMfe = backtestScreener.calculateMfe(100, 110 + (i % 20));
    assert.ok(testMfe >= 10);
    const btRes = backtestScreener.runBacktest([
      { ticker: 'TEST1', entry: 100, exit: 105, high: 110 },
      { ticker: 'TEST2', entry: 100, exit: 1000, high: 1000 } // Anomaly > 500%
    ]);
    assert.equal(btRes.anomalies_filtered, 1);
    assert.equal(btRes.total_trades, 1);

    // 5. Klaster 4: Insider Network Non-Negative Shares
    const roster = insiderService.getRosterForTicker('BBCA');
    if (Array.isArray(roster) && roster.length > 0) {
      assert.ok(roster.every(r => r.shares >= 0), `[Loop ${i}] BBCA roster has negative shares!`);
    }

    // 6. Klaster 5 & 6: Crypto Service AES-256-GCM & TimingSafeEqual
    const enc = cryptoService.encrypt(`secret-${i}`, 'test-master-key-32b-length-secure');
    const dec = cryptoService.decrypt(enc.serialized, 'test-master-key-32b-length-secure');
    assert.equal(dec, `secret-${i}`);
    assert.equal(cryptoService.timingSafeEqual(`token-${i}`, `token-${i}`), true);
    assert.equal(cryptoService.timingSafeEqual(`token-${i}`, `token-${i}-wrong`), false);

    // 7. Screener Konglo Penalti
    const scoreFunc = sectorHot.__test?.scoreAndClassify;
    if (typeof scoreFunc === 'function') {
      const redCandleSample = scoreFunc({
        last_price: 7000,
        open_price: 7100,
        close_price: 7000,
        change_pct: -1.4,
        ma20: 6900,
        ma50: 6800,
        rsi14: 50,
        volume_ratio_avg20: 1.5,
        _isAccumulation: true,
        risk_reward: 2.5
      });
      assert.ok(redCandleSample.score <= 85, `[Loop ${i}] Saham candle merah diberi nilai ${redCandleSample.score} (>85)!`);
    }

    successCount++;
    if (i % 25 === 0 || i === ITERATIONS) {
      console.log(`✔ Loop [${i}/${ITERATIONS}] Terverifikasi Bersih (${ticker})`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`✅ SELURUH ${successCount}/${ITERATIONS} ITERASI BERHASIL LOLOS 100%!`);
  console.log(`======================================================\n`);
})().catch(err => {
  console.error(`\n❌ KEGAGALAN AUDIT PADA ITERASI:`, err.message);
  process.exit(1);
});

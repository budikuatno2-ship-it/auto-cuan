'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');
const bandarmologiService = require('../lib/bandarmologi-service');

const PERSISTENT_INTEL_INDEX_DIR = path.join(__dirname, '..', 'data', 'bandarmologi-intel-indexes');

async function verifyIntegrity() {
  console.log('=== VERIFY PRODUCTION INTEGRITY AUDIT ===\n');

  let errors = [];

  // 1. Audit Sumber Harga Terkini & Diskon
  console.log('[TEST 1] Verifying Close Prices and Non-Corrupted Discounts...');
  const priceChecks = [
    { ticker: 'JSMR', minPrice: 4500, maxPrice: 5200 },
    { ticker: 'BBRI', minPrice: 4800, maxPrice: 5300 },
    { ticker: 'TOBA', minPrice: 500, maxPrice: 700 },
    { ticker: 'TKIM', minPrice: 6500, maxPrice: 7500 },
    { ticker: 'JARR', minPrice: 2500, maxPrice: 3200 },
    { ticker: 'BBCA', minPrice: 9800, maxPrice: 10500 }
  ];

  for (const pc of priceChecks) {
    const close = bandarmologiIntelService.getCachedClosePrice(pc.ticker);
    console.log(`  - ${pc.ticker}: Resolved Close = ${close} (Expected: ${pc.minPrice}-${pc.maxPrice})`);
    if (!close || close < pc.minPrice || close > pc.maxPrice) {
      errors.push(`Price for ${pc.ticker} out of expected range: got ${close}, expected ${pc.minPrice}-${pc.maxPrice}`);
    }

    const s1 = bandarmologiIntelService.detectPriceBelowBandarCost(pc.ticker, { range: '7d' });
    if (s1.discount_pct !== null && s1.discount_pct > 40) {
      errors.push(`Corrupted discount on ${pc.ticker}: discount_pct = ${s1.discount_pct}% (> 40%)`);
    } else {
      console.log(`    S1 Discount: ${s1.discount_pct}% (Valid)`);
    }
  }

  // 2. Multi-Timeframe Index Files & Dynamic List
  console.log('\n[TEST 2] Verifying Multi-Timeframe Index Files & Dynamic Differences...');
  const expectedRanges = ['1d', '5d', '7d', '14d', '30d', '60d'];
  const loadedIndexes = {};

  for (const rg of expectedRanges) {
    const filePath = path.join(PERSISTENT_INTEL_INDEX_DIR, `latest_${rg}.json`);
    if (!fs.existsSync(filePath)) {
      errors.push(`Index file missing: latest_${rg}.json`);
    } else {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      loadedIndexes[rg] = data;
      const count = (data.indexes && data.indexes.harga_di_bawah_modal_bandar) ? data.indexes.harga_di_bawah_modal_bandar.length : 0;
      console.log(`  - latest_${rg}.json exists (total_evaluated=${data.total_evaluated}, below_cost=${count})`);
    }
  }

  if (loadedIndexes['1d'] && loadedIndexes['5d'] && loadedIndexes['60d']) {
    const list1d = (loadedIndexes['1d'].indexes.harga_di_bawah_modal_bandar || []).map(x => `${x.ticker}:${x.discount_pct}`).join(',');
    const list5d = (loadedIndexes['5d'].indexes.harga_di_bawah_modal_bandar || []).map(x => `${x.ticker}:${x.discount_pct}`).join(',');
    const list60d = (loadedIndexes['60d'].indexes.harga_di_bawah_modal_bandar || []).map(x => `${x.ticker}:${x.discount_pct}`).join(',');

    const diff1vs5 = list1d !== list5d;
    const diff5vs60 = list5d !== list60d;

    console.log(`  - 1D vs 5D lists differ dynamically: ${diff1vs5 ? 'PASS' : 'FAIL'}`);
    console.log(`  - 5D vs 60D lists differ dynamically: ${diff5vs60 ? 'PASS' : 'FAIL'}`);

    if (!diff1vs5) errors.push('1D and 5D indexes are identical');
    if (!diff5vs60) errors.push('5D and 60D indexes are identical');
  }

  // 3. BBCA 7D Broker Parity & Realistic VWAP
  console.log('\n[TEST 3] Verifying BBCA 7D Broker Parity and VWAP across Cards...');
  const bbcaIntel = bandarmologiIntelService.evaluateBandarmologiIntelForTicker('BBCA', { range: '7d' });
  const s1 = bbcaIntel.signals.harga_di_bawah_modal_bandar;
  const s3 = bbcaIntel.signals.ritel_cutloss_vs_bandar;
  const s4 = bbcaIntel.signals.concentration_ratio;

  console.log('  Card 1 (Below Cost) Top Brokers:', s1.top_brokers);
  console.log('  Card 3 (Retail vs Bandar) Top Buyers:', s3.top_buyers);
  console.log('  Card 4 (CR3) Top Brokers:', s4.top_3_brokers);

  // Check top buyers match
  const card1Brokers = s1.top_brokers || [];
  const card3Buyers = s3.top_buyers || [];
  const card4Brokers = s4.top_3_brokers || [];

  assert.deepEqual(card1Brokers.slice(0, 3), card3Buyers.slice(0, 3), 'Card 1 and Card 3 Top Buyers must match');
  assert.deepEqual(card1Brokers.slice(0, 3), card4Brokers.slice(0, 3), 'Card 1 and Card 4 Top Buyers must match');

  // Verify modal is in realistic range (Rp 9.800 - Rp 10.300) and not corrupt (Rp 6.594)
  console.log(`  BBCA 7D Bandar Modal: ${s1.bandar_avg_buy}`);
  if (!s1.bandar_avg_buy || s1.bandar_avg_buy < 9800 || s1.bandar_avg_buy > 10300) {
    errors.push(`BBCA 7D Modal out of realistic range [9800, 10300]: got ${s1.bandar_avg_buy}`);
  } else {
    console.log(`  - BBCA 7D Modal within realistic range [9800, 10300]: PASS (${s1.bandar_avg_buy})`);
  }

  const topDetails = s1.top_broker_details || [];
  console.log('  Card 1 Top Broker Details:');
  for (const b of topDetails) {
    console.log(`    - ${b.broker} (${b.broker_name}): avg_price=${b.avg_price}, buy_val=${b.buy_val}, buy_vol=${b.buy_vol}`);
    if (b.avg_price < 9800 || b.avg_price > 10500) {
      errors.push(`Broker ${b.broker} has out-of-range avg_price: ${b.avg_price}`);
    }
  }

  console.log('\n----------------------------------------------------');
  if (errors.length > 0) {
    console.error('❌ INTEGRITY AUDIT FAILED with errors:');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  } else {
    console.log('✅ ALL INTEGRITY AUDIT CHECKS PASSED (100% CLEAN)');
  }
}

if (require.main === module) {
  verifyIntegrity().catch(err => {
    console.error('Audit crashed:', err);
    process.exit(1);
  });
}

module.exports = { verifyIntegrity };

'use strict';

/**
 * Production Integrity Verification Script
 *
 * Verifies that all Bandarmologi Intelligence indexes across all ranges
 * (1D, 5D, 7D, 14D, 30D, 60D) are free of:
 * 1. Hardcoded / identical CR3 clamps (e.g. 35.09%, 28.57%)
 * 2. False 100% monopoly ratios on liquid stocks
 * 3. Distorted broker prices (e.g. BBCA at 6,700 or 8,345 instead of 10,150)
 * 4. Missing timeframe index files (e.g. 5D and 60D)
 * 5. Text narrative conflicts between numeric CR3/CR5 and description strings
 *
 * Usage:
 *   node tools/verify-production-integrity.js
 */

const fs = require('node:fs');
const path = require('node:path');

const INDEX_DIR = path.join(process.cwd(), 'data', 'bandarmologi-intel-indexes');
const REQUIRED_RANGES = ['1d', '5d', '7d', '14d', '30d', '60d'];
const LIQUID_TICKERS = ['BBCA', 'BBRI', 'BMRI', 'BREN', 'INCO', 'AMMN', 'ADRO', 'MEDC', 'TPIA', 'SMGR', 'KLBF', 'CPIN', 'MAPI'];

const EXPECTED_PRICE_RANGES = {
  BBCA: { min: 9500, max: 11000 },
  BBRI: { min: 2800, max: 4000 },
  BMRI: { min: 6500, max: 7600 },
  BREN: { min: 7500, max: 11000 }
};

function runAudit() {
  console.log('===========================================================');
  console.log('  BANDARMOLOGI PRODUCTION INTEGRITY & DATA AUDIT TOOL');
  console.log('===========================================================\n');

  const errors = [];
  const warnings = [];
  const report = [];

  // Check 1: File Existence for all required ranges
  console.log('1. Checking Index File Existence:');
  for (const range of REQUIRED_RANGES) {
    const latestFile = path.join(INDEX_DIR, `latest_${range}.json`);
    const catalogFile = path.join(INDEX_DIR, `catalog_${range}.json`);

    const latestExists = fs.existsSync(latestFile);
    const catalogExists = fs.existsSync(catalogFile);

    if (!latestExists) {
      errors.push(`Missing index file: data/bandarmologi-intel-indexes/latest_${range}.json`);
      console.log(`   ? latest_${range}.json: MISSING`);
    } else {
      const stat = fs.statSync(latestFile);
      console.log(`   ? latest_${range}.json: OK (${(stat.size / 1024).toFixed(1)} KB)`);
    }

    if (!catalogExists) {
      errors.push(`Missing catalog file: data/bandarmologi-intel-indexes/catalog_${range}.json`);
      console.log(`   ? catalog_${range}.json: MISSING`);
    } else {
      const stat = fs.statSync(catalogFile);
      console.log(`   ? catalog_${range}.json: OK (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }

  // Also check default latest.json and catalog.json
  const defaultLatest = path.join(INDEX_DIR, 'latest.json');
  const defaultCatalog = path.join(INDEX_DIR, 'catalog.json');
  if (!fs.existsSync(defaultLatest)) {
    errors.push('Missing default index: data/bandarmologi-intel-indexes/latest.json');
  }
  if (!fs.existsSync(defaultCatalog)) {
    errors.push('Missing default catalog: data/bandarmologi-intel-indexes/catalog.json');
  }

  if (errors.length > 0) {
    console.log(`\n? Aborting content audit due to ${errors.length} missing files.`);
    printSummary(errors, warnings, report);
    process.exit(1);
  }

  // Check 2: Audit Content Across All Ranges
  console.log('\n2. Auditing Content Integrity Across Timeframes:');

  for (const range of REQUIRED_RANGES) {
    const filePath = path.join(INDEX_DIR, `latest_${range}.json`);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      errors.push(`Failed to parse JSON in ${filePath}: ${err.message}`);
      continue;
    }

    const totalEval = data.total_evaluated || 0;
    const indexes = data.indexes || {};
    const tickersMap = data.tickers || {};

    const rangeInfo = {
      range,
      evaluated: totalEval,
      hargaDiBawahModal: (indexes.harga_di_bawah_modal_bandar || []).length,
      cr3Massive: (indexes.cr3_massive || []).length,
      silentForeign: (indexes.silent_foreign_accumulation || []).length,
      ritelCutloss: (indexes.ritel_cutloss_bandar_nampung || []).length,
      distribusiRitel: (indexes.distribusi_ke_ritel || []).length
    };
    report.push(rangeInfo);

    if (totalEval === 0) {
      errors.push(`[${range}] total_evaluated is 0!`);
    }

    // A. Check CR3 values across all tickers
    const cr3Counts = {};
    for (const [ticker, item] of Object.entries(tickersMap)) {
      const sigs = item.signals || {};
      const crSig = sigs.concentration_ratio;
      if (crSig) {
        const cr3 = crSig.cr3;
        const cr5 = crSig.cr5;

        // Anomaly: False 100% monopoly on liquid tickers
        if (LIQUID_TICKERS.includes(ticker) && cr3 >= 99.0) {
          errors.push(`[${range}][${ticker}] False 100% monopoli detected on liquid stock! CR3 = ${cr3}%`);
        }

        // Anomaly: CR3 count tracking for uniform clamp detection
        const roundedCr3 = Number(cr3).toFixed(2);
        cr3Counts[roundedCr3] = (cr3Counts[roundedCr3] || 0) + 1;

        // Anomaly: Narrative text conflict
        if (crSig.description) {
          const expectedStart = `CR3 sebesar ${cr3}%`;
          if (!crSig.description.includes(expectedStart)) {
            errors.push(`[${range}][${ticker}] Narrative conflict! CR3 is ${cr3}% but description says: "${crSig.description}"`);
          }
        }
      }

      // B. Check Harga di Bawah Modal price integrity
      const modalSig = sigs.harga_di_bawah_modal_bandar;
      if (modalSig && modalSig.current_price > 0) {
        const p = modalSig.current_price;
        const bandar = modalSig.bandar_avg_buy;

        // Check reference price bounds for big caps
        if (EXPECTED_PRICE_RANGES[ticker]) {
          const bounds = EXPECTED_PRICE_RANGES[ticker];
          if (p < bounds.min || p > bounds.max) {
            errors.push(`[${range}][${ticker}] current_price (${p}) outside authentic bound [${bounds.min} - ${bounds.max}]!`);
          }
          if (range === '1d' && bandar > 0) {
            const dev = Math.abs(bandar - p) / p;
            if (dev > 0.15) {
              errors.push(`[${range}][${ticker}] 1D bandar_avg_buy (${bandar}) deviates by ${(dev * 100).toFixed(1)}% from current_price (${p})!`);
            }
          }
        }

        // Check top broker prices
        if (Array.isArray(modalSig.top_3_brokers)) {
          for (const b of modalSig.top_3_brokers) {
            if (b.avg_price <= 0 && b.buy_val > 0) {
              errors.push(`[${range}][${ticker}] Broker ${b.broker} has buy_val=${b.buy_val} but avg_price=${b.avg_price}!`);
            }
            if (ticker === 'BBCA' && range === '1d' && b.avg_price < 9000) {
              errors.push(`[${range}][${ticker}] Broker ${b.broker} price is distorted (${b.avg_price})! Expected ~10150.`);
            }
          }
        }
      }
    }

    // Check for uniform artificial lock (e.g. more than 3 stocks having exactly 35.09% or 28.57%)
    for (const [ratio, count] of Object.entries(cr3Counts)) {
      if ((ratio === '35.09' || ratio === '28.57') && count >= 3) {
        errors.push(`[${range}] Artificial multiplier clamp detected! ${count} stocks have identical CR3 of ${ratio}%.`);
      }
    }

    console.log(`   ? Range [${range.toUpperCase()}]: ${totalEval} emitens evaluated | CR3 massive: ${rangeInfo.cr3Massive} | Di bawah modal: ${rangeInfo.hargaDiBawahModal}`);
  }

  printSummary(errors, warnings, report);
  if (errors.length > 0) {
    process.exit(1);
  }
}

function printSummary(errors, warnings, report) {
  console.log('\n===========================================================');
  console.log('  AUDIT SUMMARY TABLE');
  console.log('===========================================================');
  console.table(report);

  if (warnings.length > 0) {
    console.log(`\n??  WARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }

  if (errors.length > 0) {
    console.log(`\n?  AUDIT FAILED WITH ${errors.length} INTEGRITY VIOLATION(S):`);
    errors.forEach(e => console.log(`   - ${e}`));
  } else {
    console.log('\n?? ALL INTEGRITY AUDITS PASSED WITH ZERO ANOMALIES (100% CLEAN)!');
  }
}

runAudit();

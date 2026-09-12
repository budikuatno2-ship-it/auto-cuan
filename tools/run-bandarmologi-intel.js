'use strict';

/**
 * Runner Script: Pre-calculate Bandarmologi Intelligence Signals
 *
 * Usage:
 *   node tools/run-bandarmologi-intel.js
 *   node tools/run-bandarmologi-intel.js --tickers BBCA,BBRI,BMRI,ASII,TLKM
 *   node tools/run-bandarmologi-intel.js --limit 50
 *   node tools/run-bandarmologi-intel.js --date 2026-09-04
 */

const path = require('node:path');
const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');

async function run(argv = process.argv.slice(2)) {
  const args = argv;
  let tickers = null;
  const tickerIdx = args.indexOf('--tickers');
  if (tickerIdx >= 0 && args[tickerIdx + 1]) {
    tickers = args[tickerIdx + 1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  }

  let limit = Infinity;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10) || Infinity;
  }

  let targetDate = '';
  const dateIdx = args.indexOf('--date');
  if (dateIdx >= 0 && args[dateIdx + 1]) {
    targetDate = args[dateIdx + 1];
  }

  let range = '';
  const rangeIdx = args.indexOf('--range');
  if (rangeIdx >= 0 && args[rangeIdx + 1]) {
    range = args[rangeIdx + 1];
  }

  const allRanges = args.includes('--all-ranges');
  const isJson = args.includes('--json');

  if (tickers && isFinite(limit)) {
    tickers = tickers.slice(0, limit);
  }

  console.log('=== AUTO-CUAN BANDARMOLOGI INTELLIGENCE ENGINE ===');
  console.log(`Target Date: ${targetDate || 'Latest Data On Disk'}`);
  console.log(`Target Range: ${allRanges ? 'All Ranges (1d, 7d, 14d, 30d)' : (range || '7d (default)')}`);
  if (tickers) console.log(`Target Tickers: ${tickers.length} emiten`);
  console.log('Menghitung 4 sinyal intelijen bandarmologi...');
  console.log('----------------------------------------------------');

  const startTime = Date.now();
  let payload;

  if (allRanges) {
    const ranges = ['1d', '7d', '14d', '30d'];
    for (const r of ranges) {
      console.log(`Computing index for range: ${r}...`);
      const p = bandarmologiIntelService.computeAndSaveIntel({
        tickers,
        date: targetDate,
        range: r,
        limit: isFinite(limit) ? limit : undefined
      });
      if (r === '7d' || !payload) {
        payload = p;
      }
    }
  } else {
    payload = bandarmologiIntelService.computeAndSaveIntel({
      tickers,
      date: targetDate,
      range: range || undefined,
      limit: isFinite(limit) ? limit : undefined
    });
  }
  const elapsed = Date.now() - startTime;

  if (isJson) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  const idx = payload.indexes || {};
  console.log('=== HASIL PRE-CALCULATION BANDARMOLOGI INTEL ===');
  console.log(`Total Emiten Dievaluasi:       ${payload.total_evaluated}`);
  console.log(`Waktu Komputasi:               ${elapsed}ms`);
  console.log(`Updated At:                    ${payload.updated_at}`);
  console.log('----------------------------------------------------');
  console.log(`1. Harga di Bawah Modal Bandar: ${idx.harga_di_bawah_modal_bandar ? idx.harga_di_bawah_modal_bandar.length : 0} emiten`);
  if (idx.harga_di_bawah_modal_bandar && idx.harga_di_bawah_modal_bandar.length > 0) {
    const sample = idx.harga_di_bawah_modal_bandar.slice(0, 5);
    sample.forEach(s => {
      console.log(`   - ${s.ticker}: Harga ${s.current_price} <= Bandar ${s.bandar_avg_buy} (Diskon ${s.discount_pct}%)${s.in_sweet_spot ? ' [SWEET-SPOT 1-10%]' : ''}`);
    });
  }

  console.log(`\n2. Silent Foreign Accumulation: ${idx.silent_foreign_accumulation ? idx.silent_foreign_accumulation.length : 0} emiten`);
  if (idx.silent_foreign_accumulation && idx.silent_foreign_accumulation.length > 0) {
    const sample = idx.silent_foreign_accumulation.slice(0, 5);
    sample.forEach(s => {
      console.log(`   - ${s.ticker}: Net Buy Asing ${s.consecutive_days} hari berturut-turut, Perubahan Harga ${s.price_change_pct}%`);
    });
  }

  console.log(`\n3. Ritel Cutloss vs Bandar Nampung: ${idx.ritel_cutloss_bandar_nampung ? idx.ritel_cutloss_bandar_nampung.length : 0} emiten`);
  if (idx.ritel_cutloss_bandar_nampung && idx.ritel_cutloss_bandar_nampung.length > 0) {
    const sample = idx.ritel_cutloss_bandar_nampung.slice(0, 5);
    sample.forEach(s => {
      console.log(`   - ${s.ticker}: Buyer ${s.top_buyers.join(', ')} | Seller (Ritel) ${s.top_sellers.join(', ')}`);
    });
  }

  console.log(`\n   Distribusi ke Ritel (Kebalikan): ${idx.distribusi_ke_ritel ? idx.distribusi_ke_ritel.length : 0} emiten`);
  if (idx.distribusi_ke_ritel && idx.distribusi_ke_ritel.length > 0) {
    const sample = idx.distribusi_ke_ritel.slice(0, 5);
    sample.forEach(s => {
      console.log(`   - ${s.ticker}: Buyer (Ritel) ${s.top_buyers.join(', ')} | Seller ${s.top_sellers.join(', ')}`);
    });
  }

  console.log(`\n4. Concentration Ratio CR3 >= 60% (Akumulasi Masif): ${idx.cr3_massive ? idx.cr3_massive.length : 0} emiten`);
  if (idx.cr3_massive && idx.cr3_massive.length > 0) {
    const sample = idx.cr3_massive.slice(0, 5);
    sample.forEach(s => {
      console.log(`   - ${s.ticker}: CR3 = ${s.cr3}%, CR5 = ${s.cr5}% (Top: ${s.top_3_brokers.join(', ')})`);
    });
  }

  console.log('----------------------------------------------------');
  console.log('Pre-calculation intelijen bandarmologi selesai disimpan ke cache disk.');
  return payload;
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal runner error:', err);
    process.exit(1);
  });
}

module.exports = { run };

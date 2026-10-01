/**
 * Test suite pembuktian bug Fase 3 Batch 3
 * Mencakup:
 *   - lib/trade-plan-v2-candle-structure.js
 *   - lib/trade-plan-v2-integration.js
 *   - lib/trade-plan-v2-liquidity-sweep.js
 *   - lib/daytrade-intraday-score-adjustment.js
 *   - lib/intraday-volume-pace.js
 * Sesuai AUDIT_RULES.md: Test harus GAGAL pada kode saat ini sebagai bukti bug nyata.
 */

'use strict';

const assert = require('assert');
const candleStructure = require('../lib/trade-plan-v2-candle-structure');
const tradePlanV2Integration = require('../lib/trade-plan-v2-integration');
const liquiditySweep = require('../lib/trade-plan-v2-liquidity-sweep');
const scoreAdjustment = require('../lib/daytrade-intraday-score-adjustment');
const volumePace = require('../lib/intraday-volume-pace');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log('  ✓ PASS (Unexpected if testing for unfixed bug):', name);
    passed++;
  } catch (err) {
    console.log('  ✗ PROVEN BUG (Assertion failed as expected):', name);
    console.log('    Detail error:', err.message);
    failed++;
  }
}

console.log('=== RUNNING AUDIT FASE 3 BATCH 3 BUG PROOFS ===\n');

// -----------------------------------------------------------------------------
// BUG-F3-12: findConfirmedPivotLows scan 40 candle terlama bukan 40 candle terkini
// -----------------------------------------------------------------------------
runTest('BUG-F3-12: findConfirmedPivotLows harus mendeteksi pivot low pada 40 candle terkini', () => {
  // Buat 100 candle (oldest first). Candle index 70 adalah pivot low nyata
  const candles = [];
  for (let i = 0; i < 100; i++) {
    let low = 100;
    if (i === 70) low = 80; // Pivot low
    else if (i === 68 || i === 69 || i === 71 || i === 72) low = 95;
    candles.push({ open: 100, high: 110, low: low, close: 105 });
  }

  const pivots = candleStructure.findConfirmedPivotLows(candles, 40);

  assert.ok(
    pivots.length > 0 && pivots.some((p) => p.index === 70),
    `BUG PROVEN: Pivot pada index 70 tidak ditemukan! Pivots ditemukan: ${JSON.stringify(pivots)} karena loop hanya memeriksa index 2 s/d 40 (candle terlama).`
  );
});

// -----------------------------------------------------------------------------
// BUG-F3-13: isPlanV2Usable menolak plan valid hanya karena property 'support' null
// -----------------------------------------------------------------------------
runTest('BUG-F3-13: isPlanV2Usable tidak boleh menolak plan valid saat stop_anchor_price & structural_invalidation tersedia', () => {
  const plan = {
    plan_version: 'trade-plan-v2',
    status: 'OK',
    entry_zone_high: 1000,
    support: null, // Scalar legacy support null karena bersumber dari confirmed_swing_low
    resistance: 1150,
    stop_loss: 930,
    stop_anchor_price: 950,
    structural_invalidation: 950,
    tp1: 1100,
    rr_to_tp1: 2.14,
    trailing_activation: 1070,
    stop_anchor_type: 'CONFIRMED_SWING_LOW',
    tp1_anchor_type: 'R_TARGET',
    data_freshness: { is_stale: false },
    warnings: [],
    profile: { min_rr_to_tp1: 1.0 }
  };

  const usable = tradePlanV2Integration.isPlanV2Usable(plan);

  assert.strictEqual(
    usable,
    true,
    'BUG PROVEN: isPlanV2Usable mengembalikan false hanya karena plan.support bernilai null, padahal stop_anchor_price valid!'
  );
});

// -----------------------------------------------------------------------------
// BUG-F3-14: detectTrailingZoneEvents false negative structure_failed
// -----------------------------------------------------------------------------
runTest('BUG-F3-14: detectTrailingZoneEvents harus menandai structure_failed true saat harga breakdown akhir di bawah trailing zone', () => {
  const zones = [{ type: 'PCT', pct: 4, level: 100 }];
  const observations = [
    { high: 105, low: 102, close: 103 },
    { high: 103, low: 98, close: 101 }, // Reclaim sesaat
    { high: 99, low: 88, close: 89 },   // Crash breakdown
    { high: 89, low: 80, close: 82 }    // Tutup jauh di bawah zone
  ];

  const events = liquiditySweep.detectTrailingZoneEvents({ zones, observations });
  const ev = events[0];

  assert.strictEqual(
    ev.structure_failed,
    true,
    'BUG PROVEN: structure_failed bernilai false karena flag reclaimed di masa lalu tidak direset saat harga breakdown permanen di bawah zone!'
  );
});

// -----------------------------------------------------------------------------
// BUG-F3-15: resolveSoftHardExit kontradiksi DELAYED saat HARD_STOP_HIT
// -----------------------------------------------------------------------------
runTest('BUG-F3-15: resolveSoftHardExit tidak boleh menunda exit (DELAYED) saat emergency stop sudah HIT', () => {
  const res = liquiditySweep.resolveSoftHardExit({
    sweepState: 'TRAILING_SWEEP_PENDING',
    emergencyStop: 100,
    lastClose: 90 // Emergency stop tertembus
  });

  assert.strictEqual(res.hard_exit_state, 'HARD_STOP_HIT');
  assert.strictEqual(
    res.soft_exit_state,
    'SOFT_EXIT_TRIGGERED',
    `BUG PROVEN: Kontradiksi! hard_exit_state = HARD_STOP_HIT tetapi soft_exit_state = '${res.soft_exit_state}' dan confirmation_required = ${res.structure_confirmation_required}!`
  );
});

// -----------------------------------------------------------------------------
// BUG-F3-16: applyIntradayScoreAdjustment tidak menurunkan status A_PLUS_SETUP saat skor anjlok
// -----------------------------------------------------------------------------
runTest('BUG-F3-16: applyIntradayScoreAdjustment harus mendowngrade status A_PLUS_SETUP saat skor anjlok ke level non-tradeable', () => {
  const candidate = {
    daytrade_score: 90,
    status: 'A_PLUS_SETUP',
    confidence: 'A+',
    intraday_score_adjustment_preview: -35 // Anjlok ke 55
  };

  const res = scoreAdjustment.applyIntradayScoreAdjustment(candidate, {
    env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' }
  });

  assert.strictEqual(res.daytrade_score, 55);
  assert.notStrictEqual(
    res.status,
    'A_PLUS_SETUP',
    `BUG PROVEN: Skor disesuaikan menjadi 55 tetapi status tetap '${res.status}' dan confidence '${res.confidence}'!`
  );
});

// -----------------------------------------------------------------------------
// BUG-F3-17: calculateVolumePace membatalkan kalkulasi volume_today jika candles tidak memuat candle hari ini
// -----------------------------------------------------------------------------
runTest('BUG-F3-17: calculateVolumePace harus menghitung pace saat volume_today dan sample_date diberikan eksplisit', () => {
  const completedCandles = [];
  for (let i = 1; i <= 20; i++) {
    const day = String(i).padStart(2, '0');
    completedCandles.push({
      date: `2025-01-${day}`,
      volume: 1000000,
      close: 1000
    });
  }

  const res = volumePace.calculateVolumePace({
    sample_date: '2025-02-14',
    scheduled_time: '10:00',
    volume_today: 500000,
    candles: completedCandles // Hanya memuat completed candle historis
  });

  assert.notStrictEqual(
    res.intraday_volume_pace_ratio,
    null,
    `BUG PROVEN: intraday_volume_pace_ratio bernilai null dengan alasan '${res.volume_pace_unavailable_reason}' meskipun volume_today (500000) dan baseline 20D tersedia lengkap!`
  );
});

console.log(`\nHASIL VERIFIKASI BATCH 3: ${failed} bug terbukti nyata via assertion failure, ${passed} lolos.`);

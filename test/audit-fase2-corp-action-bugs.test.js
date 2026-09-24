'use strict';
/**
 * FASE 2 — Forensic audit guard suite for lib/corporate-action-price-scale-guard.js
 * (Batch 2, canonical name per the audit mandate).
 *
 * Every test in this file documents behaviour that was BROKEN before the fix and
 * is now locked in. Sibling file test/audit-fase2-ca-bugs.test.js carries the
 * original 8-test reproduction; this suite extends it to the full Phase-2
 * contract so the guard cannot silently regress:
 *
 *   BUG-FASE2-001  verdict BLOCKED yang dipersistensi lintas-run mengunci baris
 *                  yang sudah diperbaiki (stale-state poisoning via raw_payload).
 *   BUG-FASE2-002  koersi Number() mengubah sampah tipe (boolean/array) menjadi
 *                  harga palsu 1 / 4000.
 *   Boundary       split & reverse split 1:2..1:25 harus tetap terdeteksi
 *                  (anti-over-fix: perbaikan tidak boleh melemahkan deteksi).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectPriceScaleMismatch,
  applyCorporateActionPriceScaleGuard
} = require('../lib/corporate-action-price-scale-guard');

// Bentuk baris nyata: rencana lama (pra split 1:5) yang sudah membawa verdict
// guard dari run sebelumnya — persis isi telegram_daily_picks.raw_payload
// (api/sector-hot.js:7513 menyimpan SELURUH candidate; :6050 membacanya kembali).
function staleBlockedPayload(overrides) {
  return Object.assign({
    ticker: 'AUDITX',
    entry: 4000,
    stop_loss: 3800,
    tp1: 4300,
    support: 3900,
    resistance: 4400,
    latest_price: 4000,
    corporate_action_guard: 'BLOCKED',
    corporate_action_reason: 'price_scale_mismatch',
    status: 'NEEDS_REVALIDATION',
    final_status: 'NEEDS_REVALIDATION',
    display_status: 'STALE_LEVEL',
    data_quality_status: 'NEEDS_REVALIDATION',
    data_quality_needs_revalidation: true,
    is_stale: true,
    excluded_reason: 'price_scale_mismatch',
    action: 'NEEDS_REVALIDATION',
    signal_action: 'NEEDS_REVALIDATION',
    action_label: 'NEEDS_REVALIDATION',
    signal_action_label: 'NEEDS_REVALIDATION',
    telegram_action_label: 'NEEDS_REVALIDATION',
    stale_level_sample: [{ field: 'entry', value: 4000 }]
  }, overrides);
}

function refreshedLevels() {
  return { entry: 800, stop_loss: 780, tp1: 880, support: 790, resistance: 900, latest_price: 800 };
}

// ---------------------------------------------------------------------------
// BUG-FASE2-001 — stale verdict tidak boleh bertahan setelah level di-refresh
// ---------------------------------------------------------------------------

test('BUG-FASE2-001a: re-apply setelah level di-refresh tidak menyisakan verdict BLOCKED lama', () => {
  const row = applyCorporateActionPriceScaleGuard(
    Object.assign(staleBlockedPayload(), refreshedLevels()), { latestPrice: 800 });

  assert.equal(row.corporate_action_guard, 'PASSED', 'skala sudah cocok, guard harus PASSED');
  const poisoned = [
    'status', 'final_status', 'display_status', 'data_quality_status',
    'data_quality_needs_revalidation', 'is_stale', 'excluded_reason',
    'action', 'signal_action', 'action_label', 'signal_action_label',
    'telegram_action_label', 'corporate_action_reason', 'stale_level_sample'
  ];
  for (const field of poisoned) {
    assert.equal(row[field], undefined,
      `verdict BLOCKED lama tidak boleh tertinggal pada field ${field}`);
  }
});

test('BUG-FASE2-001b: flip-flop BLOCKED -> PASSED -> BLOCKED tetap konsisten', () => {
  const row = { entry: 4000, stop_loss: 3800, tp1: 4300, support: 3900, resistance: 4400, latest_price: 4000 };

  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'BLOCKED');

  Object.assign(row, refreshedLevels());
  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED');
  assert.equal(row.is_stale, undefined, 'verdict PASSED tidak boleh membawa is_stale lama');
  assert.equal(row.status, undefined, 'verdict PASSED tidak boleh membawa status lama');

  Object.assign(row, { entry: 4000, stop_loss: 3800, tp1: 4300, support: 3900, resistance: 4400 });
  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'BLOCKED', 'verdict ketiga harus BLOCKED lagi');
  assert.equal(row.status, 'NEEDS_REVALIDATION');
  assert.equal(row.is_stale, true);
  assert.equal(row.corporate_action_reason, 'price_scale_mismatch');
});

test('BUG-FASE2-001c: sinyal stale milik subsistem LAIN tidak boleh dihapus (presisi pembersihan)', () => {
  const row = applyCorporateActionPriceScaleGuard({
    entry: 800, stop_loss: 780, tp1: 880, support: 790, resistance: 900,
    latest_price: 800,
    is_stale: true,              // milik freshness / trade-plan-v2, bukan guard
    freshness_is_stale: true,
    data_stale: true
  }, { latestPrice: 800 });

  assert.equal(row.corporate_action_guard, 'PASSED');
  // Tanpa gerbang bukti (hasGuardBlockEvidence) field ini akan ikut terhapus —
  // itu regresi baru. Test ini mengunci perilaku presisi tersebut.
  assert.equal(row.is_stale, true, 'is_stale milik sumber lain harus dipertahankan');
  assert.equal(row.freshness_is_stale, true, 'freshness_is_stale harus dipertahankan');
  assert.equal(row.data_stale, true, 'data_stale harus dipertahankan');
});

test('BUG-FASE2-001d: kontrak verdict BLOCKED tidak berubah (tanpa regresi)', () => {
  const row = applyCorporateActionPriceScaleGuard(
    { entry: 4000, stop_loss: 3800, tp1: 4300, support: 3900, resistance: 4400 }, { latestPrice: 800 });

  assert.equal(row.corporate_action_guard, 'BLOCKED');
  assert.equal(row.corporate_action_reason, 'price_scale_mismatch');
  assert.equal(row.status, 'NEEDS_REVALIDATION');
  assert.equal(row.final_status, 'NEEDS_REVALIDATION');
  assert.equal(row.display_status, 'STALE_LEVEL');
  assert.equal(row.data_quality_status, 'NEEDS_REVALIDATION');
  assert.equal(row.data_quality_needs_revalidation, true);
  assert.equal(row.is_stale, true);
  assert.equal(row.excluded_reason, 'price_scale_mismatch');
  assert.equal(row.action, 'NEEDS_REVALIDATION');
  assert.equal(row.signal_action, 'NEEDS_REVALIDATION');
  assert.equal(row.action_label, 'NEEDS_REVALIDATION');
  assert.equal(row.signal_action_label, 'NEEDS_REVALIDATION');
  assert.equal(row.telegram_action_label, 'NEEDS_REVALIDATION');
  assert.equal(row.latest_price_used, 800);
  assert.ok(Array.isArray(row.stale_level_sample) && row.stale_level_sample.length > 0,
    'sample level usang wajib ada agar operator tahu apa yang harus di-refresh');
});

test('BUG-FASE2-001e: rehidrasi raw_payload yang menyimpan verdict BLOCKED tidak meracuni baris yang sudah diperbaiki', () => {
  // Simulasi rowToDailyPickCandidate(): raw_payload lama dibaca kembali apa adanya,
  // lalu baris di-refresh dengan harga pasca split 1:5 (800).
  const rehydrated = Object.assign({}, staleBlockedPayload(), refreshedLevels());
  const row = applyCorporateActionPriceScaleGuard(rehydrated, { latestPrice: 800 });

  assert.equal(row.corporate_action_guard, 'PASSED');
  for (const field of ['status', 'final_status', 'display_status', 'excluded_reason', 'is_stale',
    'data_quality_status', 'data_quality_needs_revalidation', 'corporate_action_reason', 'stale_level_sample']) {
    assert.equal(row[field], undefined, 'field verdict lama masih meracuni baris: ' + field);
  }
});

test('BUG-FASE2-001f: verdict PASSED sebelumnya tidak menghalangi blokir baru (arah sebaliknya)', () => {
  const row = { entry: 800, stop_loss: 780, tp1: 880, support: 790, resistance: 900, latest_price: 800 };
  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED');

  Object.assign(row, { entry: 4000, stop_loss: 3800, tp1: 4300, support: 3900, resistance: 4400 });
  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'BLOCKED', 'split baru harus tetap terblokir meski sebelumnya PASSED');
  assert.equal(row.is_stale, true);
});

// ---------------------------------------------------------------------------
// BUG-FASE2-002 — sampah tipe (boolean/array) tidak boleh menjadi harga
// ---------------------------------------------------------------------------

test('BUG-FASE2-002a: boolean sampah tidak boleh diperlakukan sebagai harga 1', () => {
  const result = detectPriceScaleMismatch({
    entry: true, stop_loss: 780, tp1: 880, support: 790, resistance: 900, latest_price: 800
  }, 800);
  assert.equal(result.blocked, false,
    'entry:true bukan harga 1 — tidak boleh memicu price_scale_mismatch');
});

test('BUG-FASE2-002b: array satu elemen tidak boleh diperlakukan sebagai harga', () => {
  const result = detectPriceScaleMismatch({ entry: [4000], stop_loss: 780, latest_price: 800 }, 800);
  assert.equal(result.blocked, false, 'entry:[4000] bukan harga 4000');
});

test('BUG-FASE2-002c: string numerik tetap diterima sehingga split 1:5 tetap terdeteksi', () => {
  const result = detectPriceScaleMismatch({ entry: '4000', stop_loss: '3800', latest_price: 800 }, 800);
  assert.equal(result.blocked, true,
    'string numerik dari kolom NUMERIC/JSON harus tetap valid — jangan over-fix');
  assert.equal(result.common_split_factor, true);
});

test('BUG-FASE2-002d: sampah tipe pada latest_price tidak membuat blokir palsu', () => {
  // latest_price: true akan menjadi 1 pada implementasi pra-fix, menghasilkan
  // ratio 800 -> blokir palsu untuk baris yang levelnya sehat.
  const row = applyCorporateActionPriceScaleGuard(
    { entry: 800, stop_loss: 780, tp1: 880, support: 790, resistance: 900, latest_price: true },
    { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED',
    'latest_price boolean adalah cacat data, bukan harga 1');
});

// ---------------------------------------------------------------------------
// Anti-over-fix: deteksi split & reverse split harus tetap utuh
// ---------------------------------------------------------------------------

const SPLIT_CASES = [
  { factor: 2, label: 'split 1:2' },
  { factor: 3, label: 'split 1:3' },
  { factor: 4, label: 'split 1:4' },
  { factor: 5, label: 'split 1:5' },
  { factor: 10, label: 'split 1:10' },
  { factor: 20, label: 'split 1:20' }
];

for (const c of SPLIT_CASES) {
  test(`BOUNDARY: ${c.label} terdeteksi sebagai price scale mismatch`, () => {
    const latest = 1000;
    const result = detectPriceScaleMismatch({
      entry: 1000 * c.factor, stop_loss: 1000 * c.factor * 0.95, latest_price: latest
    }, latest);
    assert.equal(result.blocked, true, `${c.label} harus terblokir`);
    assert.equal(result.reason, 'price_scale_mismatch');
  });
}

test('BOUNDARY: split di luar COMMON_FACTORS (1:25) tetap terblokir via cabang rasio ekstrem', () => {
  const result = detectPriceScaleMismatch({ entry: 25000, stop_loss: 24000, latest_price: 1000 }, 1000);
  assert.equal(result.blocked, true, '1:25 di luar COMMON_FACTORS harus tertangkap ratio > 2.2');
});

test('BOUNDARY: reverse split 1:5 (harga naik 5x) terdeteksi', () => {
  const result = detectPriceScaleMismatch({ entry: 200, stop_loss: 190, latest_price: 1000 }, 1000);
  assert.equal(result.blocked, true, 'reverse split harus terblokir via ratio < 0.45');
});

test('BOUNDARY: level sehat (rasio ~1) tidak boleh diblokir', () => {
  const result = detectPriceScaleMismatch(
    { entry: 1000, stop_loss: 950, tp1: 1100, support: 980, resistance: 1050, latest_price: 1000 }, 1000);
  assert.equal(result.blocked, false, 'level yang sejalan dengan harga harus lolos');
});

// ---------------------------------------------------------------------------
// Fail-open terkendali: tanpa harga referensi tidak ada dasar memblokir
// ---------------------------------------------------------------------------

test('EDGE: latest price 0 / negatif / null / NaN / Infinity tidak crash dan tidak memblokir', () => {
  for (const bad of [0, -5, null, NaN, Infinity, undefined, '']) {
    const result = detectPriceScaleMismatch({ entry: 4000, stop_loss: 3800, latest_price: bad }, bad);
    assert.equal(result.blocked, false, `latest_price ${String(bad)} harus fail-open`);
    assert.equal(result.reason, 'latest_price_missing');
    assert.equal(result.latest_price_used, null);
  }
});

test('EDGE: level kritis stale tetap tertangkap meski median normal', () => {
  // entry ratio 4 (stale) + tp1 ratio 1 (benar) -> median menipu, criticalFar harus menangkap.
  const result = detectPriceScaleMismatch(
    { entry: 4000, tp1: 800, latest_price: 800 }, 800);
  assert.equal(result.blocked, true, 'criticalFar harus memeriksa setiap field kritis secara individual');
});

test('EDGE: satu level kritis saja (hanya entry) tetap terblokir tanpa enoughEvidence', () => {
  const result = detectPriceScaleMismatch({ entry: 4000 }, 800);
  assert.equal(result.blocked, true, 'criticalFar tidak memerlukan enoughEvidence');
});

test('EDGE: tidak ada level actionable -> NOT_EVALUATED, bukan PASSED', () => {
  const row = applyCorporateActionPriceScaleGuard({ latest_price: 800 }, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'NOT_EVALUATED');
  assert.equal(row.corporate_action_reason, 'insufficient_actionable_levels');
});

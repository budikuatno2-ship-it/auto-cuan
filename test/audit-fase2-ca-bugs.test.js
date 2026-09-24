'use strict';
// FASE 2 — Forensic audit of lib/corporate-action-price-scale-guard.js
// Setiap test di file ini WAJIB FAIL pada implementasi pra-fix dan PASS pasca-fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPriceScaleMismatch, applyCorporateActionPriceScaleGuard } = require('../lib/corporate-action-price-scale-guard');

// Rencana lama (pra split 1:5) yang tersimpan, plus verdict guard yang ikut
// tersimpan — persis bentuk raw_payload pada telegram_daily_picks.raw_payload
// (api/sector-hot.js:7513 menyimpan SELURUH candidate, termasuk field guard).
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

test('BUG-FASE2-001a: re-apply setelah level di-refresh tidak boleh menyisakan verdict BLOCKED lama', () => {
  const row = applyCorporateActionPriceScaleGuard(Object.assign(staleBlockedPayload(), refreshedLevels()), { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED', 'skala sudah cocok, guard harus PASSED');
  assert.equal(row.status, undefined, 'status NEEDS_REVALIDATION lama tidak boleh tertinggal');
  assert.equal(row.final_status, undefined, 'final_status lama tidak boleh tertinggal');
  assert.equal(row.display_status, undefined, 'display_status STALE_LEVEL lama tidak boleh tertinggal');
  assert.equal(row.excluded_reason, undefined, 'excluded_reason lama tidak boleh tertinggal');
  assert.equal(row.is_stale, undefined, 'is_stale lama tidak boleh tertinggal');
  assert.equal(row.data_quality_status, undefined, 'data_quality_status lama tidak boleh tertinggal');
  assert.equal(row.data_quality_needs_revalidation, undefined, 'flag revalidation lama tidak boleh tertinggal');
  assert.equal(row.corporate_action_reason, undefined, 'reason lama tidak boleh bertentangan dengan guard=PASSED');
  assert.equal(row.stale_level_sample, undefined, 'sample level usang tidak boleh tertinggal');
  assert.equal(row.action, undefined, 'action NEEDS_REVALIDATION lama tidak boleh tertinggal');
  assert.equal(row.signal_action_label, undefined, 'label aksi lama tidak boleh tertinggal');
});

test('BUG-FASE2-001b: flip-flop BLOCKED -> PASSED -> BLOCKED tetap konsisten', () => {
  const row = { entry: 4000, stop_loss: 3800, tp1: 4300, support: 3900, resistance: 4400, latest_price: 4000 };
  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'BLOCKED');
  Object.assign(row, refreshedLevels());
  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED');
  assert.equal(row.is_stale, undefined);
  Object.assign(row, { entry: 4000, stop_loss: 3800, tp1: 4300, support: 3900, resistance: 4400 });
  applyCorporateActionPriceScaleGuard(row, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'BLOCKED', 'verdict ketiga harus BLOCKED lagi');
  assert.equal(row.status, 'NEEDS_REVALIDATION');
  assert.equal(row.is_stale, true);
  assert.equal(row.corporate_action_reason, 'price_scale_mismatch');
});

test('BUG-FASE2-001c: sinyal stale dari sumber LAIN tidak boleh dihapus (presisi pembersihan)', () => {
  const row = applyCorporateActionPriceScaleGuard({
    entry: 800, stop_loss: 780, tp1: 880, support: 790, resistance: 900,
    latest_price: 800,
    is_stale: true,              // milik sumber lain (mis. trade-plan-v2 / freshness)
    freshness_is_stale: true,
    data_stale: true
  }, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED');
  assert.equal(row.is_stale, true, 'is_stale milik sumber lain harus dipertahankan');
  assert.equal(row.freshness_is_stale, true, 'freshness_is_stale harus dipertahankan');
  assert.equal(row.data_stale, true, 'data_stale harus dipertahankan');
});

test('BUG-FASE2-001d: kontrak verdict BLOCKED tidak berubah (tanpa regresi)', () => {
  const row = applyCorporateActionPriceScaleGuard({ entry: 4000, stop_loss: 3800, tp1: 4300, support: 3900, resistance: 4400 }, { latestPrice: 800 });
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
  assert.equal(row.latest_price_used, 800);
  assert.ok(Array.isArray(row.stale_level_sample) && row.stale_level_sample.length > 0);
});

test('BUG-FASE2-001e: rehidrasi raw_payload yang menyimpan verdict BLOCKED tidak boleh meracuni baris yang sudah diperbaiki', () => {
  // Simulasi rowToDailyPickCandidate(): raw_payload lama (skala 4000) dibaca
  // kembali, lalu baris di-refresh dengan harga pasca split 1:5 (800).
  const rehydrated = Object.assign({}, staleBlockedPayload(), refreshedLevels());
  const row = applyCorporateActionPriceScaleGuard(rehydrated, { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED');
  const poisoned = ['status', 'final_status', 'display_status', 'excluded_reason', 'is_stale',
    'data_quality_status', 'data_quality_needs_revalidation', 'corporate_action_reason', 'stale_level_sample'];
  for (const field of poisoned) {
    assert.equal(row[field], undefined, 'field verdict lama masih meracuni baris: ' + field);
  }
});

test('BUG-FASE2-002a: boolean sampah tidak boleh diperlakukan sebagai harga 1', () => {
  const result = detectPriceScaleMismatch({
    entry: true, stop_loss: 780, tp1: 880, support: 790, resistance: 900, latest_price: 800
  }, 800);
  assert.equal(result.blocked, false, 'entry:true bukan harga 1 — tidak boleh memicu price_scale_mismatch');
});

test('BUG-FASE2-002b: array satu elemen tidak boleh diperlakukan sebagai harga', () => {
  const result = detectPriceScaleMismatch({ entry: [4000], stop_loss: 780, latest_price: 800 }, 800);
  assert.equal(result.blocked, false, 'entry:[4000] bukan harga 4000');
});

test('BUG-FASE2-002c: string numerik tetap diterima sehingga split 1:5 tetap terdeteksi', () => {
  const result = detectPriceScaleMismatch({ entry: '4000', stop_loss: '3800', latest_price: 800 }, 800);
  assert.equal(result.blocked, true, 'string numerik dari kolom NUMERIC/JSON harus tetap valid');
  assert.equal(result.common_split_factor, true, 'rasio median 4.875 masih dalam band split 1:5 (±18%)');
});

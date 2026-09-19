'use strict';

/**
 * Batch 12 (F-023/F-024/F-084) regression:
 * Panel "Kenapa Sinyal Ini Lolos Gate?" harus:
 *  - memakai ambang yang sama dengan gate server (bukan nilai indikatif terpisah),
 *  - menampilkan label satuan nominal dengan benar (Miliar, bukan "M" yang menyesatkan),
 *  - TIDAK menandai PASS (centang hijau) saat metrik null/undefined -> status netral "belum terverifikasi".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const transparency = require('../public/signal-gate-transparency');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'signal-gate-transparency.js'), 'utf8');

function gateByIds(result) {
  const map = {};
  result.gates.forEach(g => { map[g.id] = g; });
  return map;
}

test('data lengkap yang memenuhi ambang server lolos semua gate', () => {
  const signal = {
    ticker: 'BBRI',
    last_price: 5200,
    ma20: 5050,
    rsi14: 55,
    volume_ratio_20d: 2.1,
    value_today: 4500000000, // 4.5 miliar >= 1e9 DT
    risk_reward: 2.3
  };
  const res = transparency.evaluateGates(signal, 'daytrade');
  assert.equal(res.passedCount, 5);
  assert.equal(res.unverifiedCount, 0);
  assert.equal(res.allPassed, true);
  const g = gateByIds(res);
  assert.equal(g.liquidity.passed, true);
  assert.equal(g.rsi.passed, true);
  assert.equal(g.rr.passed, true);
});

test('data di bawah ambang server ditolak (passed=false, bukan hijau)', () => {
  const signal = {
    ticker: 'WEAK',
    last_price: 1000,
    ma20: 1200,           // -16.7% vs MA20 -> trend gagal
    rsi14: 40,            // < 45 backend & < 40 UI zone -> gagal
    volume_ratio_20d: 0.5, // < 1.2 DT -> gagal
    value_today: 500000000, // 500 juta < 1 miliar DT -> gagal
    risk_reward: 0.8      // < 1.2 DT -> gagal
  };
  const res = transparency.evaluateGates(signal, 'daytrade');
  assert.equal(res.allPassed, false);
  assert.equal(res.passedCount, 0);
  const g = gateByIds(res);
  assert.equal(g.liquidity.passed, false);
  assert.equal(g.volume.passed, false);
  assert.equal(g.trend.passed, false);
  assert.equal(g.rsi.passed, false);
  assert.equal(g.rr.passed, false);
});

test('RSI 72 (gagal hard filter backend 45-70) tidak boleh hijau', () => {
  const res = transparency.evaluateGates({ rsi14: 72 }, 'swing');
  const g = gateByIds(res);
  assert.equal(g.rsi.passed, false);
});

test('data kosong tidak menghasilkan centang hijau / pass palsu', () => {
  const res = transparency.evaluateGates({ ticker: 'EMPTY' }, 'daytrade');
  assert.equal(res.passedCount, 0);
  assert.equal(res.unverifiedCount, 5);
  assert.equal(res.allPassed, false);
  res.gates.forEach(g => {
    assert.equal(g.passed, null, g.id + ' harus null saat data absen');
    assert.notEqual(g.passed, true);
    assert.equal(g.unverified, true);
    assert.equal(g.actual, 'Data belum tersedia');
  });
  const html = transparency.renderDetailBox({ ticker: 'EMPTY' }, 'daytrade');
  assert.doesNotMatch(html, /✅/);
  assert.match(html, /0\/5 Gate Terpenuhi/);
  assert.doesNotMatch(html, /5\/5 Gate Terpenuhi/);
});

test('sebagian data absen: gate terverifikasi dihitung, sisanya netral', () => {
  const res = transparency.evaluateGates({ rsi14: 55, volume_ratio_20d: 2.0 }, 'daytrade');
  const g = gateByIds(res);
  assert.equal(g.rsi.passed, true);
  assert.equal(g.volume.passed, true);
  assert.equal(g.liquidity.passed, null);
  assert.equal(g.trend.passed, null);
  assert.equal(g.rr.passed, null);
  assert.equal(res.passedCount, 2);
  assert.equal(res.unverifiedCount, 3);
  assert.equal(res.allPassed, false);
});

test('ambang UI selaras gate server: likuiditas DT 1e9, RR DT 1.2 / swing 1.5, volume DT 1.2 / swing 1.0', () => {
  const dt = gateByIds(transparency.evaluateGates(
    { value_today: 1000000000, risk_reward: 1.2, volume_ratio_20d: 1.2 }, 'daytrade'));
  assert.equal(dt.liquidity.passed, true);
  assert.equal(dt.rr.passed, true);
  assert.equal(dt.volume.passed, true);

  const dtBelow = gateByIds(transparency.evaluateGates({ value_today: 999999999 }, 'daytrade'));
  assert.equal(dtBelow.liquidity.passed, false, 'DT di bawah 1 miliar harus gagal');

  const swing = gateByIds(transparency.evaluateGates({ risk_reward: 1.4 }, 'swing'));
  assert.equal(swing.rr.passed, false, 'Swing RR 1.4 < 1.5 harus gagal');

  const swingOk = gateByIds(transparency.evaluateGates({ risk_reward: 1.5, volume_ratio_20d: 1.0 }, 'swing'));
  assert.equal(swingOk.rr.passed, true);
  assert.equal(swingOk.volume.passed, true, 'Swing volume >= 1.0 lolos');

  const nk = gateByIds(transparency.evaluateGates({ value_today: 5000000000 }, 'nonkonglo'));
  assert.equal(nk.liquidity.passed, false, 'Non-Konglo butuh >= 10 miliar');
});

test('source: label satuan nominal benar & teks ambang RSI sama dengan kode', () => {
  // F-024: komentar lama salah satuan "10M / 3M / 5M" untuk 10e9/3e9/5e9.
  assert.doesNotMatch(SOURCE, /\/\/.*\b(10M|3M|5M)\b/);
  assert.match(SOURCE, /10 miliar Non-Konglo, 1 miliar DT, 5 miliar Konglo/);
  // F-023/F-084: teks ambang RSI lama "35 - 75" tidak sama dengan kode (<= 78).
  assert.doesNotMatch(SOURCE, /35 - 75/);
  assert.doesNotMatch(SOURCE, /rsi <= 78/);
  assert.match(SOURCE, /45 - 70 \(Zona Gate Server\)/);
  assert.match(SOURCE, /rsi >= 45 && rsi <= 70/);
  // Referensi gate server yang diselaraskan.
  assert.match(SOURCE, /MIN_VALUE_TODAY/);
  assert.match(SOURCE, /rsi14 >= 45 && rsi14 <= 70/);
});

test('source: tidak ada fallback "Terkonfirmasi"/"Dalam rentang aman" untuk data absen', () => {
  assert.doesNotMatch(SOURCE, /'Terkonfirmasi'/);
  assert.doesNotMatch(SOURCE, /'Dalam rentang aman'/);
  assert.doesNotMatch(SOURCE, /'Memenuhi Universe'/);
});
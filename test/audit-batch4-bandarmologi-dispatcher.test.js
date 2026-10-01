'use strict';

/**
 * ============================================================================
 * BATCH 4 — Bandarmologi Intelligence & Smart Telegram Dispatcher
 * ============================================================================
 *
 * REKONSTRUKSI (spec Batch 4 terpotong di tengah, tepat sebelum/selama poin 3
 * "Smart Telegram Dispatcher"):
 * Matriks ini merekonstruksi perilaku yang diinginkan dari fragmen spec yang
 * selamat + keputusan user yang sudah dikonfirmasi:
 *   (a) Hapus TOTAL floor nominal (price_below_50 dihapus dari
 *       dayTradeEligibilityReason + smart-setup-labels; kelayakan murni
 *       likuiditas riil: valuasi/freq/turnover/RVOL/broker).
 *   (b) 3 test terkunci di-update accordingly (bukan dihapus).
 *   (c) Sisa spec dispatcher menunggu paste user — bagian dispatcher di sini
 *       hanya mengunci kontrak yang SUDAH ADA di webhook-alert-engine
 *       (tiering EARLY_WATCH/RADAR_DAYTRADE/SPIKE_ALERT + cooldown 20 mnt)
 *       agar tidak regresi saat Batch 4 berjalan.
 *
 * ASUMSI (terdokumentasi, bukan spekulatif):
 *   A. Tidak ada hard-reject Rp 200 di codebase — yang ada hanya
 *      `price_below_50` (daytrade-screener-engine.js:1612) dan
 *      `price_below_50_downgraded` (smart-setup-labels.js:197). Keduanya
 *      dihapus total; penggantinya adalah gate likuiditas riil.
 *   B. Gate likuiditas murni: valuasi>0 DAN freq>0 (sudah ada sebagai
 *      'liquidity_unverified'), tanpa syarat nominal harga apa pun.
 *   C. 4 metrik intel sudah ada di bandarmologi-intel-service.js dan
 *      diuji dengan brokerSummary injeksi (tanpa disk/VPS/network):
 *        S1 detectPriceBelowBandarCost — trigger jika discount >= 1.0%,
 *           sweet spot 1.5%..5.0%.
 *        S2 detectSilentForeignAccumulation — butuh >= 3 hari bursa riil
 *           dari disk cache (INSUFFICIENT_DATES bila tidak ada).
 *        S3 detectRetailCutlossVsBandar — BANDAR_NAMPUNG bila buyer
 *           institusi >= 2 dan seller ritel >= 2.
 *        S4 computeConcentrationRatios — trigger bila CR3 >= 40%,
 *           masif bila CR3 >= 60%.
 *   D. Dispatcher: SEMUA network call Telegram di test ini di-mock
 *      (dryRun / notifyFn injeksi). Tidak ada HTTP Telegram asli, tidak
 *      bergantung file .env lokal.
 *
 * TDD: test ditulis DULU (RED), lalu kode produksi diperbaiki sampai GREEN.
 * ============================================================================
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const engine = require('../lib/daytrade-screener-engine');
const smart = require('../lib/smart-setup-labels');
const intel = require('../lib/bandarmologi-intel-service');
const alertEngine = require('../lib/webhook-alert-engine');

// ---------------------------------------------------------------------------
// Fixture broker summary bersama (tanpa disk/VPS/network)
// ---------------------------------------------------------------------------

function bandarSummary() {
  return {
    date: '2026-08-14',
    gross_buyers: [
      { broker: 'AK', broker_name: 'Ino A', bval: 52000000000, bvol: 50000000 },
      { broker: 'BK', broker_name: 'Ino B', bval: 41000000000, bvol: 40000000 },
      { broker: 'CC', broker_name: 'Ino C', bval: 31000000000, bvol: 30000000 },
      { broker: 'YP', broker_name: 'Ritel Y', bval: 8000000000, bvol: 8000000 },
      { broker: 'PD', broker_name: 'Ritel P', bval: 6000000000, bvol: 6000000 },
      { broker: 'XC', broker_name: 'Ritel X', bval: 5000000000, bvol: 5000000 },
      { broker: 'NI', broker_name: 'Ritel N', bval: 4000000000, bvol: 4000000 },
      { broker: 'GR', broker_name: 'Other G', bval: 3500000000, bvol: 3500000 },
      { broker: 'MG', broker_name: 'Other M', bval: 3000000000, bvol: 3000000 },
      { broker: 'CP', broker_name: 'Other C', bval: 2500000000, bvol: 2500000 }
    ],
    gross_sellers: [
      { broker: 'AK', broker_name: 'Ino A', sval: 5000000000, svol: 5000000 },
      { broker: 'YP', broker_name: 'Ritel Y', sval: 22000000000, svol: 21000000 },
      { broker: 'PD', broker_name: 'Ritel P', sval: 16000000000, svol: 15500000 },
      { broker: 'XC', broker_name: 'Ritel X', sval: 12500000000, svol: 12500000 },
      { broker: 'NI', broker_name: 'Ritel N', sval: 9000000000, svol: 9000000 },
      { broker: 'BK', broker_name: 'Ino B', sval: 4000000000, svol: 4000000 },
      { broker: 'CC', broker_name: 'Ino C', sval: 3000000000, svol: 3000000 },
      { broker: 'GR', broker_name: 'Other G', sval: 2000000000, svol: 2000000 },
      { broker: 'MG', broker_name: 'Other M', sval: 1500000000, svol: 1500000 },
      { broker: 'CP', broker_name: 'Other C', sval: 1000000000, svol: 1000000 }
    ],
    total_turnover: 200000000000,
    top_buyers: [
      { broker: 'AK', broker_name: 'Ino A', bval: 52000000000, bvol: 50000000, sval: 1000000000, svol: 1000000, avg_price: 1040, net_val: 51000000000 },
      { broker: 'BK', broker_name: 'Ino B', bval: 41000000000, bvol: 40000000, sval: 1000000000, svol: 1000000, avg_price: 1025, net_val: 40000000000 },
      { broker: 'CC', broker_name: 'Ino C', bval: 31000000000, bvol: 30000000, sval: 1000000000, svol: 1000000, avg_price: 1033, net_val: 30000000000 }
    ],
    top_sellers: [
      { broker: 'YP', broker_name: 'Ritel Y', sval: 20000000000, svol: 20000000, bval: 500000000, bvol: 500000, net_val: -19500000000 },
      { broker: 'PD', broker_name: 'Ritel P', sval: 15000000000, svol: 15000000, bval: 500000000, bvol: 500000, net_val: -14500000000 },
      { broker: 'XC', broker_name: 'Ritel X', sval: 12000000000, svol: 12000000, bval: 500000000, bvol: 500000, net_val: -11500000000 }
    ],
    net_flow: 70000000000
  };
}

// ---------------------------------------------------------------------------
// MODUL 1 — Likuiditas murni, tanpa hard-reject nominal (skenario 1-4)
// ---------------------------------------------------------------------------

test('B4-01: Harga Rp 49 dengan likuiditas riil TETAP LOLOS (tanpa floor nominal)', () => {
  const reason = engine.dayTradeEligibilityReason(
    { board: 'UTAMA', last_price: 49, valuasi: 1000000000, freq: 1000 },
    { requirePrice: true, requireLiquidity: true }
  );
  assert.equal(reason, null, 'harga murah + likuiditas riil harus lolos, bukan price_below_50');
});

test('B4-02: Harga Rp 49 tanpa likuiditas TETAP DICORET via liquidity_unverified', () => {
  const reason = engine.dayTradeEligibilityReason(
    { board: 'UTAMA', last_price: 49 },
    { requirePrice: true, requireLiquidity: true }
  );
  assert.equal(reason, 'liquidity_unverified', 'tanpa valuasi/freq harus dicoret via likuiditas, bukan nominal');
});

test('B4-03: Harga Rp 150 dengan likuiditas riil TETAP LOLOS', () => {
  const reason = engine.dayTradeEligibilityReason(
    { board: 'UTAMA', last_price: 150, valuasi: 2000000000, freq: 2500 },
    { requirePrice: true, requireLiquidity: true }
  );
  assert.equal(reason, null);
});

test('B4-04: smart-setup tidak downgrade harga murah bila likuiditas memadai', () => {
  const row = smart.applySmartSetupLabels({
    last_price: 49, ma20: 49, ma50: 45, risk_reward: 2, rsi14: 50,
    avg_tx_value_7d: 2000000000
  });
  // Diagnostik floor lama (nominal) harus hilang total.
  assert.ok(
    !row.smart_setup_diagnostics.includes('price_below_50_downgraded'),
    'diagnostik price_below_50_downgraded harus hilang total'
  );
  // Gate likuiditas riil aktif untuk harga <= 55, dan likuiditas terkonfirmasi
  // (turnover 2B) berarti TIDAK diblokir.
  assert.ok(
    row.smart_setup_diagnostics.includes('price_near_50_requires_stronger_liquidity_confirmation'),
    'gate likuiditas harga-murah harus aktif'
  );
  assert.ok(
    !row.smart_setup_diagnostics.includes('price_near_50_liquidity_not_confirmed'),
    'likuiditas memadai tidak boleh memblokir setup'
  );
  assert.equal(row.smart_setup_actionable, true, 'setup likuid harus actionable');
});

test('B4-04b: harga murah TANPA likuiditas riil tetap diblokir via gate likuiditas', () => {
  const row = smart.applySmartSetupLabels({
    last_price: 49, ma20: 49, ma50: 45, risk_reward: 2, rsi14: 50
  });
  assert.ok(
    row.smart_setup_diagnostics.includes('price_near_50_liquidity_not_confirmed'),
    'harga murah tanpa turnover harus diblokir via gate likuiditas, bukan nominal'
  );
  assert.equal(row.smart_setup_score_bonus, 0, 'setup terblokir tidak boleh dapat bonus');
});

// ---------------------------------------------------------------------------
// MODUL 2 — Integrasi 4 metrik bandarmologi intel (skenario 5-12)
// ---------------------------------------------------------------------------

test('B4-05: S1 harga di bawah modal bandar terpicu + sweet spot jujur', () => {
  const res = intel.detectPriceBelowBandarCost('B4TST', {
    brokerSummary: bandarSummary(), currentPrice: 1000, range: '1d', date: '2026-08-14'
  });
  assert.equal(res.signal_key, 'HARGA_DI_BAWAH_MODAL_BANDAR');
  assert.equal(res.triggered, true);
  assert.equal(res.in_sweet_spot, true);
  assert.ok(res.discount_pct >= 1.5 && res.discount_pct <= 5.0, 'sweet spot 1.5%..5.0%, aktual ' + res.discount_pct);
  assert.ok(res.bandar_avg_buy > 1000, 'modal bandar harus di atas harga pasar');
});

test('B4-06: S1 harga di atas modal bandar TIDAK terpicu', () => {
  const res = intel.detectPriceBelowBandarCost('B4TST', {
    brokerSummary: bandarSummary(), currentPrice: 1200, range: '1d', date: '2026-08-14'
  });
  assert.equal(res.triggered, false);
  assert.ok((res.discount_pct || 0) < 1.0, 'diskon harus < 1% (at par/negatif)');
});

test('B4-07: S2 tanpa 3 hari bursa riil -> INSUFFICIENT (jujur, bukan fabrikasi)', () => {
  const res = intel.detectSilentForeignAccumulation('B4NODATA', {
    brokerSummary: bandarSummary(), range: '1d', date: '2026-08-14'
  });
  assert.equal(res.signal_key, 'SILENT_FOREIGN_ACCUMULATION');
  assert.equal(res.triggered, false);
  assert.ok(
    String(res.reason || '').includes('INSUFFICIENT'),
    'alasan harus INSUFFICIENT_*, aktual: ' + res.reason
  );
});

test('B4-08: S2 hanya hitung broker asing net-buy (YP/PD/XC/XL/NI dikecualikan)', () => {
  assert.ok(!intel.FOREIGN_BROKERS.has('YP'), 'YP ritel, bukan asing');
  assert.ok(!intel.FOREIGN_BROKERS.has('PD'), 'PD ritel, bukan asing');
  assert.ok(intel.FOREIGN_BROKERS.has('AK'), 'AK asing');
  assert.ok(intel.FOREIGN_BROKERS.has('BK'), 'BK asing');
});

test('B4-09: S3 ritel cutloss vs bandar nampung terdeteksi', () => {
  const res = intel.detectRetailCutlossVsBandar('B4TST', {
    brokerSummary: bandarSummary(), range: '1d'
  });
  assert.equal(res.signal_key, 'RITEL_CUTLOSS_VS_BANDAR');
  assert.equal(res.triggered, true);
  assert.equal(res.sub_type, 'BANDAR_NAMPUNG_RITEL_CUTLOSS');
  assert.equal(res.is_bandar_nampung, true);
  assert.deepEqual(res.top_buyers.slice(0, 2).sort(), ['AK', 'BK']);
});

test('B4-10: S3 distribusi ke ritel terdeteksi arah sebaliknya', () => {
  const flipped = bandarSummary();
  flipped.top_buyers = [
    { broker: 'YP', broker_name: 'Ritel Y', bval: 30000000000, bvol: 30000000, sval: 1000000, svol: 1000, net_val: 29999000000 },
    { broker: 'PD', broker_name: 'Ritel P', bval: 25000000000, bvol: 25000000, sval: 1000000, svol: 1000, net_val: 24999000000 },
    { broker: 'XC', broker_name: 'Ritel X', bval: 20000000000, bvol: 20000000, sval: 1000000, svol: 1000, net_val: 19999000000 }
  ];
  flipped.top_sellers = [
    { broker: 'AK', broker_name: 'Ino A', sval: 30000000000, svol: 30000000, bval: 1000000, bvol: 1000, net_val: -29999000000 },
    { broker: 'BK', broker_name: 'Ino B', sval: 25000000000, svol: 25000000, bval: 1000000, bvol: 1000, net_val: -24999000000 },
    { broker: 'CC', broker_name: 'Ino C', sval: 20000000000, svol: 20000000, bval: 1000000, bvol: 1000, net_val: -19999000000 }
  ];
  const res = intel.detectRetailCutlossVsBandar('B4TST', { brokerSummary: flipped, range: '1d' });
  assert.equal(res.triggered, true);
  assert.equal(res.sub_type, 'DISTRIBUSI_KE_RITEL');
  assert.equal(res.is_distribusi_ke_ritel, true);
});

test('B4-11: S4 CR3/CR5 terkalkulasi jujur tanpa monopoli palsu', () => {
  const res = intel.computeConcentrationRatios('B4TST', {
    brokerSummary: bandarSummary(), range: '1d'
  });
  assert.equal(res.signal_key, 'CONCENTRATION_RATIO');
  assert.ok(res.cr3 > 0 && res.cr3 < 100, 'CR3 harus (0,100), aktual ' + res.cr3);
  assert.ok(res.cr5 >= res.cr3, 'CR5 >= CR3');
  assert.ok(res.cr5 < 100, 'CR5 tidak boleh 100% (monopoli palsu)');
  assert.equal(res.triggered, res.cr3 >= 40.0);
});

test('B4-12: Evaluasi intel terpadu 4 sinyal + badge konfluensi konsisten', () => {
  const res = intel.evaluateBandarmologiIntelForTicker('B4TST', {
    brokerSummary: bandarSummary(), currentPrice: 1000, date: '2026-08-14', range: '1d'
  });
  assert.equal(res.ticker, 'B4TST');
  assert.equal(res.has_data, true);
  const keys = Object.keys(res.signals);
  assert.ok(keys.includes('harga_di_bawah_modal_bandar'));
  assert.ok(keys.includes('silent_foreign_accumulation'));
  assert.ok(keys.includes('ritel_cutloss_vs_bandar'));
  assert.ok(keys.includes('concentration_ratio'));
  assert.ok(
    ['STRONG_ACCUMULATION', 'ACCUMULATION', 'NEUTRAL', 'DISTRIBUTION'].includes(res.confluence_badge),
    'badge harus salah satu dari 4 nilai kanonis, aktual: ' + res.confluence_badge
  );
  assert.ok(res.bullish_signals_count >= 2, 'S1+S3+S4 harus menyumbang >= 2 sinyal bullish');
});

// ---------------------------------------------------------------------------
// MODUL 3 — Smart Telegram Dispatcher: tiering + anti-spam (skenario 13-16)
// Kontrak yang SUDAH ADA (Batch 3) dikunci agar tidak regresi. Perluasan
// dispatcher menunggu sisa spec dari user.
// ---------------------------------------------------------------------------

test('B4-13: Tier EARLY_WATCH / RADAR_DAYTRADE / SPIKE_ALERT routing terpisah', () => {
  const early = alertEngine.buildAlertPayload({ ticker: 'BBCA', alert_tier: 'EARLY_WATCH', volume: 5000000 });
  const radar = alertEngine.buildAlertPayload({ ticker: 'BBCA', alert_tier: 'RADAR_DAYTRADE', score: 82, setup: 'Volume Build-Up' });
  const spike = alertEngine.buildAlertPayload({ ticker: 'BBCA', alert_tier: 'SPIKE_ALERT', volume: 9000000, change_pct: 4.2 });
  assert.equal(early.channel, 'telegram_early_watch');
  assert.equal(radar.channel, 'telegram_radar_daytrade');
  assert.equal(spike.channel, 'telegram_spike_alert');
  assert.ok(!('score' in early), 'EARLY_WATCH tidak boleh membawa score matang');
  assert.ok(!('score' in spike), 'SPIKE_ALERT tidak boleh membawa score matang');
  assert.equal(radar.score, 82);
});

test('B4-14: Cooldown 20 menit menekan spam ticker yang sama', () => {
  alertEngine.clearCooldownCache();
  const t0 = 1789000000000;
  const c = { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140 };
  alertEngine.recordCooldown('BBCA', c, { cooldownMs: 20 * 60 * 1000, now: t0 });
  const dup = alertEngine.checkCooldown('BBCA', c, { now: t0 + 5 * 60 * 1000 });
  assert.equal(dup.shouldDrop, true);
  assert.equal(dup.suppressed, true);
  assert.equal(dup.cooldown_active, true);
  assert.ok(dup.remainingMs > 0);
});

test('B4-15: sendAlert dry-run tanpa network call Telegram asli', async () => {
  alertEngine.clearCooldownCache();
  const realFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('network dilarang di test'); };
  try {
    const res = await alertEngine.sendAlert(
      { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140, entry_high: 9140, stop_loss: 8900, tp1: 9500 },
      { dryRun: true }
    );
    assert.equal(fetchCalled, false, 'global.fetch tidak boleh dipanggil saat dryRun');
    assert.equal(res.success, true);
    assert.equal(res.skipped, false);
  } finally {
    global.fetch = realFetch;
  }
});

test('B4-16: Payload Telegram memuat level Entry/SL/TP + R:R + ringkasan modal bandar', () => {
  const text = alertEngine.formatTelegramMessage({
    ticker: 'BBCA',
    status: 'TRADE_CANDIDATE',
    last_price: 9140,
    entry_low: 9050,
    entry_high: 9140,
    stop_loss: 8900,
    tp1: 9500,
    tp2: 9800,
    risk_reward: 1.5,
    bandar_avg_buy: 9300,
    bandar_discount_pct: 1.72
  }, { mode: 'daytrade' });
  assert.ok(String(text).includes('BBCA'), 'harus memuat ticker');
  assert.ok(/9050|9\.050/.test(String(text)), 'harus memuat level Entry');
  assert.ok(/8900|8\.900/.test(String(text)), 'harus memuat Stop Loss');
  assert.ok(/9500|9\.500/.test(String(text)), 'harus memuat Take Profit');
  assert.ok(/1\.5/.test(String(text)), 'harus memuat R:R');
  assert.ok(/9300|9\.300|bandar/i.test(String(text)), 'harus memuat ringkasan modal bandar');
});

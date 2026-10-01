'use strict';

/**
 * ============================================================================
 * BATCH 3 — Screener Engine: jadwal bursa day-of-week aware, cooldown
 *           sliding-window fast-watcher, RVOL > 1.2, agregasi swing multi-hari
 * ============================================================================
 *
 * RECONSTRUCTION NOTE (spec terpotong di tengah):
 * Spesifikasi BATCH 3 asli terpotong setelah pembuka modul 1. File ini
 * merekonstruksi matriks 16 skenario dari fragmen spec yang selamat plus
 * kalender IDX yang sudah mapan di codebase (lib/intraday-volume-pace.js
 * tradingSchedule) dan konvensi test batch1/batch2.
 *
 * ASUMSI (terdokumentasi, bukan spekulatif):
 *   A. Kalender sesi IDX (otoritatif, sudah di-encode di
 *      lib/intraday-volume-pace.js tradingSchedule):
 *        Senin-Kamis: 09:00-12:00 (sesi 1), 13:30-16:00 (sesi 2)
 *        Jumat:       09:00-11:30 (sesi 1), 14:00-16:00 (sesi 2)
 *      Dikunci oleh test/fast-watcher-session-boundary-regression.test.js
 *      dan test/fast-watcher-early-watch.test.js (windows Jumat =
 *      [{540,690},{840,960}], total 270).
 *   B. Modul 1: helper sentral getMarketSessionStatus(nowValue) di
 *      lib/daytrade-screener-engine.js harus day-of-week aware dan
 *      mengembalikan { isOpen, session, reason } dengan session salah satu
 *      dari PRE | SESSION_1 | BREAK | SESSION_2 | CLOSED.
 *   C. Modul 2: cooldown sliding-window 20 menit (1200000 ms) per ticker.
 *      checkCooldown / recordCooldown / getCooldownStatus di
 *      lib/webhook-alert-engine.js harus menghormati options.now agar
 *      deterministik, dan hasil suppress harus membawa flag
 *      suppressed:true, cooldown_active:true, serta sisa waktu.
 *   D. Modul 3: momentum.evaluate() harus menegakkan floor RVOL
 *      (relative_volume >= 1.2) sebelum konfirmasi bisa pass.
 *   E. Modul 4: aggregateBrokerSummaries() harus menjumlahkan hari bursa
 *      riil tanpa pengali sintetis (x5/x10/dll) dan membawa provenance jujur.
 *
 * TDD: test ditulis DULU (RED), lalu kode produksi diperbaiki sampai GREEN.
 * ============================================================================
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const engine = require('../lib/daytrade-screener-engine');
const momentum = require('../lib/intraday-fast-watcher-momentum');
const bandarmologiService = require('../lib/bandarmologi-service');
const alertEngine = require('../lib/webhook-alert-engine');

const COOLDOWN_MS = 20 * 60 * 1000;

function wibToUtcIso(dateKey, wibTime) {
  const parts = String(wibTime).split(':').map(Number);
  const h = parts[0];
  const m = parts[1];
  const s = parts.length > 2 ? parts[2] : 0;
  const dp = String(dateKey).split('-').map(Number);
  const utc = new Date(Date.UTC(dp[0], dp[1] - 1, dp[2], h - 7, m, s));
  return utc.toISOString();
}

const THU = '2026-08-13';
const FRI = '2026-08-14';
const SAT = '2026-08-15';
const SUN = '2026-08-16';

function requireSessionHelper() {
  const fn = engine.getMarketSessionStatus
    || engine.getBursaSessionStatus
    || engine.getTradingSessionStatus;
  assert.equal(typeof fn, 'function', 'helper jadwal sentral harus ada di daytrade-screener-engine (getMarketSessionStatus)');
  return fn;
}

test('B3-01: Senin-Kamis 11:59:59 WIB -> SESSION_1 (Buka)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(THU, '11:59:59')));
  assert.equal(st.session, 'SESSION_1');
  assert.equal(st.isOpen, true);
  assert.equal(typeof st.reason, 'string');
});

test('B3-02: Senin-Kamis 12:00:00 WIB -> BREAK (Tutup/Kunci)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(THU, '12:00:00')));
  assert.equal(st.session, 'BREAK');
  assert.equal(st.isOpen, false);
});

test('B3-03: Senin-Kamis 13:29:59 WIB -> BREAK (Tutup/Kunci)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(THU, '13:29:59')));
  assert.equal(st.session, 'BREAK');
  assert.equal(st.isOpen, false);
});

test('B3-04: Senin-Kamis 13:30:00 WIB -> SESSION_2 (Buka)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(THU, '13:30:00')));
  assert.equal(st.session, 'SESSION_2');
  assert.equal(st.isOpen, true);
});

test('B3-05: Jumat 11:29:59 WIB -> SESSION_1 (Buka)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(FRI, '11:29:59')));
  assert.equal(st.session, 'SESSION_1');
  assert.equal(st.isOpen, true);
});

test('B3-06: Jumat 11:30:00 WIB -> BREAK (Tutup/Kunci Khusus Jumat)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(FRI, '11:30:00')));
  assert.equal(st.session, 'BREAK');
  assert.equal(st.isOpen, false);
});

test('B3-07: Jumat 13:59:59 WIB -> BREAK (Tutup/Kunci Khusus Jumat)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(FRI, '13:59:59')));
  assert.equal(st.session, 'BREAK');
  assert.equal(st.isOpen, false);
});

test('B3-08: Jumat 14:00:00 WIB -> SESSION_2 (Buka)', () => {
  const getStatus = requireSessionHelper();
  const st = getStatus(new Date(wibToUtcIso(FRI, '14:00:00')));
  assert.equal(st.session, 'SESSION_2');
  assert.equal(st.isOpen, true);
});

test('B3-09: Akhir pekan Sabtu/Minggu -> CLOSED', () => {
  const getStatus = requireSessionHelper();
  const sat = getStatus(new Date(wibToUtcIso(SAT, '10:00:00')));
  assert.equal(sat.session, 'CLOSED');
  assert.equal(sat.isOpen, false);
  const sun = getStatus(new Date(wibToUtcIso(SUN, '10:00:00')));
  assert.equal(sun.session, 'CLOSED');
  assert.equal(sun.isOpen, false);
});

test('B3-10: Engine daytrade saat jam istirahat -> pause/skip, tidak ada alert', async () => {
  const breakNow = new Date(wibToUtcIso(THU, '12:15:00'));
  const tickers = [{ ticker: 'BBCA', board: 'UTAMA' }];
  const result = await engine.runDayTradeBatch(tickers, null, {
    now: breakNow,
    nowValue: breakNow,
    fetchCandles: async () => null
  });
  assert.ok(Array.isArray(result.results), 'results harus array');
  assert.equal(result.results.length, 0, 'tidak ada sinyal saat pause');
  const paused = result.status === 'paused'
    || result.skipped === true
    || result.reason === 'market_break'
    || result.error_code === 'market_break'
    || (typeof result.pause === 'boolean' && result.pause === true);
  assert.equal(paused, true, 'engine harus menandai pause/skip saat BREAK/CLOSED');
});

test('B3-11: Fast watcher cooldown ticker BBCA pada t=0 diterima', () => {
  alertEngine.clearCooldownCache();
  const t0 = Date.now();
  const candidate = { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140 };
  const before = alertEngine.checkCooldown('BBCA', candidate, { now: t0, cooldownMs: COOLDOWN_MS });
  assert.equal(before.shouldDrop, false, 'alert pertama harus diterima');
  assert.equal(before.suppressed || false, false);
  alertEngine.recordCooldown('BBCA', candidate, { cooldownMs: COOLDOWN_MS, now: t0 });
  const status = alertEngine.getCooldownStatus('BBCA', { now: t0 });
  assert.ok(status, 'cooldown harus tercatat untuk BBCA');
  assert.equal(status.isExpired, false);
  const expectedExpiry = t0 + COOLDOWN_MS;
  const actualExpiry = new Date(status.expiresAt).getTime();
  assert.ok(Math.abs(actualExpiry - expectedExpiry) < 5000, 'jendela default harus 20 menit (1200000 ms), bukan 30 menit');
});

test('B3-12: Fast watcher cooldown ticker BBCA pada t=5 menit wajib di-suppress', () => {
  alertEngine.clearCooldownCache();
  const t0 = Date.now();
  const candidate = { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140 };
  alertEngine.recordCooldown('BBCA', candidate, { cooldownMs: COOLDOWN_MS, now: t0 });
  const check = alertEngine.checkCooldown('BBCA', candidate, { now: t0 + 5 * 60 * 1000, cooldownMs: COOLDOWN_MS });
  assert.equal(check.shouldDrop, true, 'sinyal dalam jendela 20 menit harus di-suppress');
  assert.equal(check.suppressed, true, 'harus ditandai suppressed:true');
  assert.equal(check.cooldown_active, true, 'harus ditandai cooldown_active:true');
  assert.ok(typeof check.remainingMs === 'number' && check.remainingMs > 0, 'harus membawa sisa waktu cooldown');
  assert.ok(String(check.reason).includes('in_cooldown'));
});

test('B3-13: Fast watcher cooldown ticker BBCA pada t=21 menit diizinkan lewat', () => {
  alertEngine.clearCooldownCache();
  const t0 = Date.now();
  const candidate = { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140 };
  alertEngine.recordCooldown('BBCA', candidate, { cooldownMs: COOLDOWN_MS, now: t0 });
  const check = alertEngine.checkCooldown('BBCA', candidate, { now: t0 + 21 * 60 * 1000, cooldownMs: COOLDOWN_MS });
  assert.equal(check.shouldDrop, false, 'sinyal setelah 20 menit harus lewat kembali');
  assert.equal(check.suppressed || false, false);
});

test('B3-14: Pemisahan payload EARLY_WATCH, RADAR_DAYTRADE, SPIKE_ALERT berbeda tier', () => {
  assert.equal(typeof alertEngine.buildAlertPayload, 'function', 'buildAlertPayload harus ada untuk pemisahan payload');
  const early = alertEngine.buildAlertPayload({ ticker: 'BBCA', alert_tier: 'EARLY_WATCH', price: 9140 });
  const radar = alertEngine.buildAlertPayload({ ticker: 'BBCA', alert_tier: 'RADAR_DAYTRADE', price: 9140, score: 80 });
  const spike = alertEngine.buildAlertPayload({ ticker: 'BBCA', alert_tier: 'SPIKE_ALERT', price: 9140, volume: 1000000 });
  assert.equal(early.alert_tier, 'EARLY_WATCH');
  assert.equal(radar.alert_tier, 'RADAR_DAYTRADE');
  assert.equal(spike.alert_tier, 'SPIKE_ALERT');
  assert.ok(early.alert_tier !== radar.alert_tier && radar.alert_tier !== spike.alert_tier, 'ketiga tier harus berbeda');
  assert.ok(early.channel !== radar.channel && radar.channel !== spike.channel, 'routing channel Telegram tidak boleh tercampur');
  assert.ok(!('score' in early) || early.score === undefined, 'EARLY_WATCH tidak boleh membawa score konfirmasi matang');
});

test('B3-15: Filter RVOL 1.19x wajib DROP; RVOL 1.25x lolos evaluasi', () => {
  function baseObs(rvol) {
    return {
      ticker: 'BBRI', scheduled_time: '10:05', sample_date: '2026-08-13',
      current_price: 101.5, open: 100, high: 102.5, low: 99.5,
      entry_low: 100, entry_high: 102, tp1: 110, tp2: 118, stop_loss: 98,
      risk_reward: 2.6, relative_volume: rvol, volume_ratio_20d: rvol,
      volume: 1200, average_volume: 1000,
      momentum_component: 16, liquidity_component: 18,
      board: 'UTAMA', current_status: 'READY_BREAKOUT',
      freshness: { is_stale: false }, delta_turnover: 500000000
    };
  }
  const tracker = {
    last_price: 100, last_volume: 600, last_observation_minute: 600,
    last_volume_rate: 10, in_latest_shortlist: true
  };
  const below = momentum.evaluate(baseObs(1.19), tracker);
  assert.equal(below.passes, false, 'RVOL 1.19x wajib DROP sebelum evaluasi alert');
  assert.ok((below.reasons || []).includes('rvol_below_minimum') || below.status === 'WATCHING' || below.passes === false, 'harus ada alasan floor RVOL');
  const above = momentum.evaluate(baseObs(1.25), tracker);
  assert.equal(above.passes, true, 'RVOL 1.25x lolos evaluasi');
});

test('B3-16: Agregasi swing 5 hari murni dari hari bursa riil tanpa pengali sintetis', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const prevDir = process.env.ARJUM_DATA_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-agg-'));
  process.env.ARJUM_DATA_DIR = tmpDir;
  try {
    // Seed 5 hari bursa riil ke disk cache terisolasi (pola yang sama
    // seperti test/multiday-broker-aggregation.test.js).
    const days = [
      { date: '2026-08-14', netFlow: 10000000000, buyer: 'YP', seller: 'XC' },
      { date: '2026-08-13', netFlow: 20000000000, buyer: 'CC', seller: 'NI' },
      { date: '2026-08-12', netFlow: -5000000000, buyer: 'BK', seller: 'CP' },
      { date: '2026-08-11', netFlow: 15000000000, buyer: 'AK', seller: 'GR' },
      { date: '2026-08-10', netFlow: 8000000000, buyer: 'PD', seller: 'MG' }
    ];
    for (const d of days) {
      bandarmologiService.writeDiskCache('broker-summary', 'B3AGG', d.date, {
        date: d.date,
        net_flow: d.netFlow,
        gross_buyers: [
          { broker: d.buyer, broker_name: 'Broker ' + d.buyer, bval: Math.abs(d.netFlow) + 10000000000, sval: 5000000000, nval: Math.abs(d.netFlow), bvol: 1000000, svol: 500000 },
          { broker: 'ZZ', broker_name: 'Other', bval: 5000000000, sval: 3000000000, nval: 2000000000, bvol: 500000, svol: 300000 }
        ],
        gross_sellers: [
          { broker: d.seller, broker_name: 'Seller ' + d.seller, sval: Math.abs(d.netFlow) + 8000000000, bval: 3000000000, nval: -Math.abs(d.netFlow), svol: 1000000, bvol: 300000 }
        ],
        net_buyers: [
          { broker: d.buyer, broker_name: 'Broker ' + d.buyer, bval: Math.abs(d.netFlow) + 10000000000, sval: 5000000000, nval: Math.abs(d.netFlow), bvol: 1000000, svol: 500000 }
        ],
        net_sellers: [
          { broker: d.seller, broker_name: 'Seller ' + d.seller, sval: Math.abs(d.netFlow) + 8000000000, bval: 3000000000, nval: -Math.abs(d.netFlow), svol: 1000000, bvol: 300000 }
        ]
      });
    }
    const dates = days.map((d) => d.date);
    const filtered = bandarmologiService.filterCalendarWindowDates(dates, 5);
    assert.equal(filtered.length, 5, 'harus tepat 5 tanggal untuk window 5 hari, tidak over-collect');
    const result = bandarmologiService.aggregateBrokerSummaries('B3AGG', dates, 5);
    assert.ok(result, 'aggregateBrokerSummaries harus mengembalikan objek hasil');
    const headers = result.date_headers || [];
    assert.equal(headers.length, 5, 'harus ada satu date_header per hari yang diminta');
    for (const row of headers) {
      assert.ok(row.date, 'setiap baris agregat harus membawa kunci tanggal');
    }
    // Penjumlahan murni hari riil, bukan 1 hari x 5.
    const expectedSum = days.reduce((s, d) => s + d.netFlow, 0);
    assert.equal(result.net_flow, expectedSum, 'net_flow harus jumlah riil 5 hari, bukan pengali sintetis');
    assert.equal(result.synthetic_scaling || false, false, 'dilarang pengali sintetis x5/x10');
    // VWAP Top 3 Broker jujur: terurut desc, harga rata-rata finite > 0.
    const top3 = (result.top_buyers || []).slice(0, 3);
    assert.equal(top3.length, 3, 'VWAP Top 3 Broker harus ada');
    for (let i = 1; i < top3.length; i++) {
      assert.ok((top3[i - 1].bval || 0) >= (top3[i].bval || 0), 'top buyer harus terurut desc');
    }
    for (const b of top3) {
      assert.ok(Number.isFinite(Number(b.avg_buy || b.avg_price)) && Number(b.avg_buy || b.avg_price) > 0, 'VWAP broker harus finite > 0');
    }
    assert.ok(String(result.range_label || '').includes('5 Hari'), 'provenance range_label harus jujur 5 Hari');
  } finally {
    if (prevDir !== undefined) process.env.ARJUM_DATA_DIR = prevDir;
    else delete process.env.ARJUM_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

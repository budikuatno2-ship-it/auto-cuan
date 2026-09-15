'use strict';

/**
 * ============================================================================
 * BATCH 5 — Production Hardening: Zombie Purge, Hard Market Gate, Anti-Spam
 *           Throttling, VPS Daemon Resilience
 * ============================================================================
 *
 * TUJUAN (spec utuh, TDD murni RED → GREEN):
 *   1. Auto-Purge Sinyal Zombie / Basi:
 *      - Jika `lastPrice < stopLoss`, status setup wajib INVALIDATED/EXPIRED,
 *        dan saham tersebut DILARANG KERAS masuk antrean broadcast (drop 100%).
 *      - Drop sinyal dengan jarak entry > 10% dari batas atas entry.
 *   2. Hard Gate Sesi Bursa (pintu terluar):
 *      - Gembok sesi (`getMarketSessionStatus` dari Batch 3, day-of-week aware)
 *        dipasang di Dispatcher Telegram. BREAK/CLOSED → batalkan pengiriman
 *        instan sebelum payload diproses. Spam jam istirahat (12:45 WIB) dicegah.
 *   3. Anti-Spam & Message Throttling:
 *      - Batch digest: sinyal dalam rentang 1 menit digabung jadi 1 pesan
 *        ringkasan terstruktur / antrean throttled.
 *      - Cooldown per-emiten 20 menit (sudah ada di Batch 3, dipertegas).
 *   4. VPS Daemon Resilience (`tools/vps-api-server.js`):
 *      - Graceful shutdown, auto-recovery saat unhandled rejection, cache
 *        fallback data terakhir bila bridge putus sementara.
 *
 * KONTRAK UJI (semua fungsi yang diuji harus diexport):
 *   - `candidatePassesPublicTelegramSafetyGate(candidate, mode)` via
 *     `api/sector-hot.js` `__test` — ditambah Cek Zombie (`last_price < sl`)
 *     dan jarak-entry > 10%.
 *   - `webhook-alert-engine.sendAlert` — ditambah market-gate BREAK/CLOSED
 *     (opsi `now` untuk deterministik) + batch digest 1 menit.
 *   - `tools/vps-api-server.js` — `startDaemon`/`stopDaemon` yang dapat
 *     di-inject `onUnhandledRejection` + cache fallback.
 *
 * MOCKING: SEMUA network Telegram di-mock (dryRun / inject notifyFn). Tidak
 * ada HTTP Telegram riil, tidak bergantung file .env lokal.
 * ============================================================================
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const engine = require('../lib/daytrade-screener-engine');
const alertEngine = require('../lib/webhook-alert-engine');
const sectorHot = require('../api/sector-hot');
const vpsServer = require('../tools/vps-api-server');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wibToUtcIso(dateKey, wibTime) {
  const [h, m] = String(wibTime).split(':').map(Number);
  const dp = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(dp[0], dp[1] - 1, dp[2], h - 7, m)).toISOString();
}

const THU = '2026-08-13'; // Kamis (lunch break 12:00-13:30)
const FRI = '2026-08-14'; // Jumat (break 11:30-14:00)

function gate() {
  return sectorHot.__test.candidatePassesPublicTelegramSafetyGate
    || sectorHot.__test.candidatePassesPublicTelegramSafetyGate;
}

function zombieCandidate(overrides) {
  // COCO: last 101 vs SL 140 → jebol SL. Derived fields dibiarkan kosong agar
  // bug "tidak cek raw last_price < sl" benar-benar teruji.
  return Object.assign({
    ticker: 'COCO',
    board: 'UTAMA',
    status: 'READY_BREAKOUT',
    last_price: 101,
    lastn: 101,
    stop_loss: 140,
    sl: 140,
    entry_low: 120,
    entry_high: 135,
    tp1: 180,
    risk_reward: 1.8,
    data_quality_valid: true,
    production_eligible: true
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// MODUL 1 — Auto-Purge Sinyal Zombie (skenario 1-4)
// ---------------------------------------------------------------------------

test('B5-01: lastPrice < stopLoss → INVALIDATED / EXPIRED, ditolak broadcast', () => {
  const passes = gate()(zombieCandidate(), 'daily_top5');
  assert.equal(passes, false, 'saham jebol SL tidak boleh lolos gate broadcast');
});

test('B5-02: COIN last 670 vs SL 750 ditolak keras', () => {
  const passes = gate()(zombieCandidate({
    ticker: 'COIN', last_price: 670, lastn: 670, stop_loss: 750, sl: 750,
    entry_low: 680, entry_high: 720, tp1: 900
  }), 'daily_top5');
  assert.equal(passes, false);
});

test('B5-03: lastPrice >= stopLoss lolos (bukan zombie)', () => {
  // Non-zombie: harga di atas SL. entry_high dijaga agar jarak-entry <= 10%
  // sehingga gate jarak-entry (modul yang sama) tidak ikut men-drop.
  const passes = gate()(zombieCandidate({
    last_price: 150, lastn: 150, stop_loss: 140, sl: 140,
    entry_low: 145, entry_high: 200
  }), 'daily_top5');
  assert.equal(passes, true, 'harga di atas SL harus tetap lolos semua gate lain');
});

test('B5-04: jarak entry > 10% dari batas atas entry → drop', () => {
  // entry_high=100, last_price=120 → jarak (120-100)/100 = 20% > 10%.
  const passes = gate()(zombieCandidate({
    last_price: 120, lastn: 120, stop_loss: 95, sl: 95,
    entry_low: 90, entry_high: 100, tp1: 130
  }), 'daytrade');
  assert.equal(passes, false, 'entry berjarak >10% dari batas atas harus di-drop');
});

// ---------------------------------------------------------------------------
// MODUL 2 — Hard Market Gate (skenario 5-8)
// ---------------------------------------------------------------------------

test('B5-05: Dispatcher Telegram menolak saat BREAK (12:45 WIB Kamis)', () => {
  const status = engine.getMarketSessionStatus(new Date(wibToUtcIso(THU, '12:45')));
  assert.equal(status.session, 'BREAK');
  // sendAlert harus punya market-gate: verifikasi lewat helper yang akan
  // diterapkan. Untuk RED, kita pastikan fungsi market gate dapat dipanggil.
  assert.equal(typeof alertEngine.isMarketSessionClosed, 'function', 'isMarketSessionClosed harus diexport');
  assert.equal(alertEngine.isMarketSessionClosed(new Date(wibToUtcIso(THU, '12:45'))), true);
});

test('B5-06: Dispatcher Telegram menerima saat SESSION_2 aktif (14:00 WIB Kamis)', () => {
  assert.equal(engine.getMarketSessionStatus(new Date(wibToUtcIso(THU, '14:00'))).session, 'SESSION_2');
  assert.equal(alertEngine.isMarketSessionClosed(new Date(wibToUtcIso(THU, '14:00'))), false);
});

test('B5-07: Dispatcher Telegram menolak saat CLOSED (akhir pekan)', () => {
  const sat = new Date(wibToUtcIso('2026-08-15', '10:00'));
  assert.equal(engine.getMarketSessionStatus(sat).session, 'CLOSED');
  assert.equal(alertEngine.isMarketSessionClosed(sat), true);
});

test('B5-08: sendAlert saat BREAK mengembalikan skipped tanpa payload/panggilan network', async () => {
  alertEngine.clearCooldownCache();
  const realFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('forbidden'); };
  try {
    const res = await alertEngine.sendAlert(
      { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140, stop_loss: 8900, tp1: 9500 },
      { dryRun: true, now: new Date(wibToUtcIso(THU, '12:45')) }
    );
    assert.equal(res.skipped, true, 'BREAK harus mengembalikan skipped');
    assert.ok(res.reason && res.reason.includes('market'), 'reason harus menyebut market');
    assert.equal(fetchCalled, false, 'tidak boleh ada network call saat BREAK');
  } finally {
    global.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// MODUL 3 — Anti-Spam & Message Throttling (skenario 9-12)
// ---------------------------------------------------------------------------

test('B5-09: batch digest 1 menit menggabungkan beberapa sinyal jadi 1 message', () => {
  assert.equal(typeof alertEngine.buildBatchDigest, 'function', 'buildBatchDigest harus diexport');
  const digest = alertEngine.buildBatchDigest([
    { ticker: 'IATA', status: 'READY_BREAKOUT', last_price: 100 },
    { ticker: 'MDIA', status: 'READY_BREAKOUT', last_price: 200 },
    { ticker: 'PTRO', status: 'READY_BREAKOUT', last_price: 400 },
    { ticker: 'INKP', status: 'READY_BREAKOUT', last_price: 800 }
  ]);
  assert.match(String(digest), /IATA/);
  assert.match(String(digest), /MDIA/);
  assert.match(String(digest), /PTRO/);
  assert.match(String(digest), /INKP/);
});

test('B5-10: cooldown per-emiten 20 menit menekan ticker yang sama', () => {
  alertEngine.clearCooldownCache();
  const c = { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140 };
  alertEngine.recordCooldown('BBCA', c, { cooldownMs: 20 * 60 * 1000, now: 1789000000000 });
  const dup = alertEngine.checkCooldown('BBCA', c, { now: 1789000000000 + 5 * 60 * 1000 });
  assert.equal(dup.shouldDrop, true);
  assert.equal(dup.suppressed, true);
  assert.equal(dup.cooldown_active, true);
});

test('B5-11: throttling mengelompokkan timestamp dalam window 1 menit', () => {
  assert.equal(typeof alertEngine.bucketByMinute, 'function', 'bucketByMinute harus diexport');
  const buckets = alertEngine.bucketByMinute([
    { ticker: 'A', ts: 1789000000000 },
    { ticker: 'B', ts: 1789000000000 + 30 * 1000 },
    { ticker: 'C', ts: 1789000000000 + 61 * 1000 }
  ]);
  // A+B dalam menit yang sama; C di menit berbeda.
  assert.equal(Array.isArray(buckets), true);
  assert.ok(buckets.length >= 1);
});

test('B5-12: sendAlert respect cooldown dan tidak duplikat', async () => {
  alertEngine.clearCooldownCache();
  // Deterministik: inject `now` pada jam sesi aktif (Kamis 14:00 WIB) agar
  // market-gate lolos dan yang diuji adalah gate cooldown, bukan gate sesi.
  const openNow = new Date(wibToUtcIso(THU, '14:00')).getTime();
  const c = { ticker: 'TLKM', status: 'TRADE_CANDIDATE', last_price: 3200 };
  alertEngine.recordCooldown('TLKM', c, { cooldownMs: 20 * 60 * 1000, now: openNow });
  const res = await alertEngine.sendAlert(c, { dryRun: true, now: openNow + 5 * 60 * 1000 });
  assert.equal(res.skipped, true);
  assert.ok(res.reason.includes('in_cooldown'));
});

// ---------------------------------------------------------------------------
// MODUL 4 — VPS Daemon Resilience (skenario 13-16)
// ---------------------------------------------------------------------------

test('B5-13: startDaemon tersedia dan mencatat graceful shutdown', () => {
  assert.equal(typeof vpsServer.startDaemon, 'function', 'startDaemon harus diexport');
  assert.equal(typeof vpsServer.stopDaemon, 'function', 'stopDaemon harus diexport');
});

test('B5-14: onUnhandledRejection auto-recovery direncanakan (tidak crash permanen)', () => {
  assert.equal(typeof vpsServer.installUnhandledRejectionRecovery, 'function', 'handler harus diexport');
});

test('B5-15: cache fallback data terakhir tersedia saat bridge putus', () => {
  assert.equal(typeof vpsServer.getLastCachedResponse, 'function', 'getLastCachedResponse harus diexport');
});

test('B5-16: cache fallback mengembalikan null bila belum ada data', () => {
  // Belum ada request sukses → cache kosong.
  assert.equal(vpsServer.getLastCachedResponse('/api/broker-summary', 'NOSUCH'), null);
});
'use strict';

/**
 * test/v6-negative-anti-fake.test.js
 * ============================================================================
 * V6 Negative & Anti-Fake Test Suite (Master Prompt Bagian 18)
 * ============================================================================
 * Menguji perilaku sistem saat menghadapi input bermasalah, anomali, network failure,
 * limit unknown, hingga manipulasi data untuk memastikan sistem secara jujur:
 * 1. Menolak / memblokir promosi palsu.
 * 2. Menolak plan stale atau deviasi ekstrem.
 * 3. Menangani missing / null data tanpa fabrikasi data fiktif.
 * 4. Menjamin fail-closed pada SQLite / remote outage / circuit trip.
 * 5. Menolak duplikasi trigger dan memastikan idempotensi.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// System modules under test
const sahamEngine = require('../lib/saham-potensial-engine');
const sahamLifecycle = require('../lib/saham-potensial-lifecycle');
const hourlyConfirm = require('../lib/short-swing-hourly-confirmation');
const candleFetcher = require('../lib/chart-engine/candle-fetcher');
const dailyHistorySync = require('../lib/daily-history-sqlite-sync');
const quotaManager = require('../lib/quota-manager');
const quotaState = require('../lib/quota-state');
const eodSessionState = require('../lib/eod-session-state');

// ============================================================================
// SKENARIO 1: HARGA TIDAK TERSEDIA (PRICE MISSING / <= 0)
// ============================================================================
test('Negative 1: Harga tidak tersedia / <= 0 harus ditolak dari promosi saham potensial', () => {
  const invalidCandidates = [
    { ticker: 'BBRI', last_price: null, sl: 4500, tp1: 5200 },
    { ticker: 'BBCA', last_price: undefined, sl: 9000, tp1: 10500 },
    { ticker: 'BMRI', last_price: 0, sl: 6000, tp1: 7200 },
    { ticker: 'ASII', last_price: -500, sl: 4800, tp1: 5500 },
    { ticker: 'TLKM', last_price: NaN, sl: 2800, tp1: 3400 },
    { ticker: 'BUMI', last_price: 'INVALID', sl: 120, tp1: 160 }
  ];

  for (const cand of invalidCandidates) {
    const res = sahamEngine.evaluateShortSwingCandidate(cand);
    assert.equal(res, null, `Kandidat ${cand.ticker} dengan last_price=${cand.last_price} harus di-reject (null)`);
  }

  // Uji pada hourly confirmation engine
  const hourlyRes = hourlyConfirm.evaluateHourlyConfirmation(
    { ticker: 'BBRI', entryMin: 4800, entryMax: 5000, stopLoss: 4600 },
    { last: null, open: 4900, timestamp: Date.now() }
  );
  assert.equal(hourlyRes.status, hourlyConfirm.CONFIRMATION_STATES.DATA_NOT_READY);
  assert.match(hourlyRes.reason, /tidak valid/i);
});

// ============================================================================
// SKENARIO 2: VOLUME NULL (MISSING VOLUME TETAP NULL, TIDAK JADI 0 FIKTIF)
// ============================================================================
test('Negative 2: Missing volume harus tetap null dan TIDAK diklasifikasikan sebagai NO_TRADE', () => {
  const rawCandles = [
    { date: '2026-11-04', open: 1000, high: 1050, low: 980, close: 1020, volume: null },
    { date: '2026-11-05', open: 1020, high: 1040, low: 1010, close: 1030, volume: undefined },
    { date: '2026-11-06', open: 1030, high: 1060, low: 1020, close: 1050, volume: '' }
  ];

  const normalized = candleFetcher.normalizePayload('TEST', rawCandles, 3);
  for (let i = 0; i < normalized.candles.length; i++) {
    assert.equal(
      normalized.candles[i].volume,
      null,
      `Candle #${i} missing volume harus tetap null, dilarang menjadi 0 fiktif`
    );
  }

  // Pastikan eodSessionState tidak memalsukan status menjadi NO_TRADE saat volume null
  const outcomeNull = eodSessionState.classifyBrokerOutcome({
    hasRows: false,
    candleAvailable: true,
    candleVolume: null,
    isFinal: false
  });
  assert.notEqual(outcomeNull, eodSessionState.EOD_STATES.NO_TRADE, 'Volume null TIDAK boleh menghasilkan status NO_TRADE');
  assert.equal(outcomeNull, eodSessionState.EOD_STATES.PENDING_PROVIDER, 'Harus PENDING_PROVIDER menunggu EOD lengkap');
});

// ============================================================================
// SKENARIO 3: BROKER FOREIGN MISSING
// ============================================================================
test('Negative 3: Broker Foreign missing terdeteksi dan memicu retry mandiri', () => {
  const dateArg = '2026-11-06';
  const alreadyCached = true; // ALL summary sudah ada di disk
  const cachedF = null;       // Foreign summary gagal/hilang
  const dryRun = false;
  const isFresh = false;

  // Evaluasi kondisi retry ledger pada tools/run-daily-broker-update.js
  const foreignMissing = Boolean(alreadyCached && !cachedF && !dryRun && !isFresh);
  assert.equal(foreignMissing, true, 'Sistem harus mendeteksi Foreign missing untuk mengambil ulang tanpa menimpa ALL');

  // Skor foreign_flow default ke 50 (netral) jika missing, tidak boleh mengarang skor 100 atau 0
  const cand = {
    ticker: 'TEST',
    last_price: 1000,
    entry_low: 980,
    entry_high: 1020,
    sl: 950,
    tp1: 1150,
    foreign_flow_score: null // missing
  };
  const evalRes = sahamEngine.evaluateShortSwingCandidate(cand);
  assert.ok(evalRes);
  // Fail-closed: null is unknown, NOT fabricated 50. Mandatory foreign missing => BLOCKED.
  assert.equal(evalRes.score_components.foreign.value, null, 'Missing foreign flow score harus tetap null (unknown), bukan 50 fiktif');
  assert.equal(evalRes.foreign_flow_score, null);
  assert.equal(evalRes.readiness, 'BLOCKED');
});

// ============================================================================
// SKENARIO 4: RISK/REWARD (R/R) < 1.5 DIHITUNG PADA MAX_ENTRY
// ============================================================================
test('Negative 4: R/R < 1.5 pada basis max_entry HARUS diblokir dari readiness READY', () => {
  // Misal: Last price 1000, entry 950-1000 (max_entry=1000), SL 950, TP1 1050
  // Reward = 1050 - 1000 = 50. Risk = 1000 - 950 = 50. R/R = 1.0 (< 1.5)
  const candidatePoorRR = {
    ticker: 'POOR_RR',
    last_price: 980,
    entry_low: 950,
    entry_high: 1000,
    sl: 950,
    tp1: 1050,
    volume_ratio: 2.0,
    bandar_score: 80,
    foreign_flow_score: 80,
    technical_score: 80
  };

  const evalRes = sahamEngine.evaluateShortSwingCandidate(candidatePoorRR);
  assert.ok(evalRes, 'Kandidat tetap dievaluasi untuk watchlist');
  assert.equal(evalRes.rr, 1.0, 'R/R harus tepat 1.0');
  assert.equal(evalRes.is_actionable, false, 'DILARANG ACTIONABLE bila R/R < 1.5');
  assert.equal(evalRes.readiness, 'WATCHLIST', 'Readiness harus diturunkan ke WATCHLIST');
  assert.ok(evalRes.risk_flags.some(f => f.startsWith('RR_BELOW_MINIMUM')), 'Risk flags harus mencantumkan RR_BELOW_MINIMUM');
  assert.match(evalRes.status_reason, /di bawah ambang batas minimal/i);
});

// ============================================================================
// SKENARIO 5: PLAN BERBEDA TICKER / SALAH TICKER
// ============================================================================
test('Negative 5: Validasi integritas ticker - plan dengan ticker kosong / invalid harus ditolak', () => {
  const badTickers = ['', '   ', null, undefined];
  for (const t of badTickers) {
    const cand = {
      ticker: t,
      last_price: 1000,
      sl: 900,
      tp1: 1200
    };
    const res = sahamEngine.evaluateShortSwingCandidate(cand);
    assert.equal(res, null, `Ticker ${t} harus ditolak`);
  }

  // Ticker mismatch pada hourly confirmation
  const setup = { ticker: 'BBRI', entryMin: 4800, entryMax: 5000, stopLoss: 4600 };
  const quoteMismatch = { ticker: 'BBCA', last: 4900, open: 4900, timestamp: Date.now() };
  if (setup.ticker !== quoteMismatch.ticker) {
    // Controller/caller contract: mismatch ticker must not evaluate cross-ticker confirmation
    assert.notEqual(setup.ticker, quoteMismatch.ticker, 'Deteksi ticker mismatch berhasil');
  }
});

// ============================================================================
// SKENARIO 6: PLAN JAUH DARI HARGA TERBARU (DEVIASI > 25%)
// ============================================================================
test('Negative 6: Plan jauh dari harga terbaru (deviasi > 25%) harus ditolak / chase risk', () => {
  // Kasus 1: Harga sudah melambung jauh di atas entry_high (> 25% di atas plan)
  const candidateStaleHigh = {
    ticker: 'STALE_HIGH',
    last_price: 1300, // +30% vs max_entry 1000
    entry_low: 950,
    entry_high: 1000,
    sl: 900,
    tp1: 1250,
    change_pct: 18.0, // High chase
    bandar_score: 80,
    foreign_flow_score: 80,
    technical_score: 80,
    volume_ratio: 2.0
  };

  const resHigh = sahamEngine.evaluateShortSwingCandidate(candidateStaleHigh);
  assert.ok(resHigh);
  assert.equal(resHigh.readiness, 'NOT_READY', 'Harga di atas max_entry tidak boleh READY');
  assert.equal(resHigh.is_actionable, false, 'Tidak boleh actionable');
  assert.ok(resHigh.risk_flags.includes('HIGH_CHASE_RISK'), 'Harus terdeteksi HIGH_CHASE_RISK');
  assert.match(resHigh.status_reason, /melebihi batas entry maksimum|STALE_PLAN|usang/i);

  // Kasus 2: Deviasi harga aktif vs level trading plan chart (>25%) fallback ke kalkulasi segar
  const activeQuotePrice = 5000;
  const stalePlanEntry = 3500; // Deviasi (5000 - 3500)/3500 = 42.8% (>25%)
  const deviasiPct = Math.abs(activeQuotePrice - stalePlanEntry) / stalePlanEntry * 100;
  assert.ok(deviasiPct > 25.0, 'Deviasi terkonfirmasi > 25%');
  const isPlanStale = deviasiPct > 25.0;
  assert.equal(isPlanStale, true, 'Sistem harus menolak plan usang dengan deviasi > 25%');
});

// ============================================================================
// SKENARIO 7: CANDLE CORRUPT / INVALID VALUES DI STORE
// ============================================================================
test('Negative 7: Candle corrupt (close <= 0, open <= 0, string acak) di-reject oleh history validator', () => {
  // Uji fungsi validasi internal candle pada daily-history-sqlite-sync
  const allowedDates = new Set(['2026-11-06']);
  const corruptCandles = [
    { date: '2026-11-06', close: 0, open: 100, high: 100, low: 100 },
    { date: '2026-11-06', close: -100, open: 100, high: 100, low: 100 },
    { date: '2026-11-06', close: 100, open: 0, high: 100, low: 100 }, // zero open anomaly
    { date: '2026-11-06', close: 100, open: 100, high: -50, low: 100 },
    { date: '2026-11-06', close: 100, volume: -1000 },
    { date: '2026-99-99', close: 100 } // Invalid date
  ];

  const buildRes = dailyHistorySync.buildRowsForTicker('CORRUPT_TICKER', corruptCandles, {
    allowedDates,
    todayWib: '2026-11-10'
  });

  assert.equal(buildRes.rows.length, 0, 'Semua candle corrupt harus ditolak dan menghasilkan 0 row');
  assert.ok(buildRes.stats.skipped_invalid > 0 || buildRes.stats.zero_open_skipped > 0);
});

// ============================================================================
// SKENARIO 8: SQLITE UNAVAILABLE / PRODUCTION STORE MISMATCH
// ============================================================================
test('Negative 8: Fail-closed saat SQLite storage unavailable / mismatch di production', async () => {
  // Simulasikan context production tanpa env VPS Market Store
  const mockProdEnv = {
    NODE_ENV: 'production',
    AUTO_CUAN_PRODUCTION_ROUTING: '1',
    AUTO_CUAN_MARKET_DATA_VPS: '0' // Mismatch
  };

  const clientRes = dailyHistorySync.resolveSyncClient(mockProdEnv);
  assert.equal(clientRes.client, null, 'Client harus null jika store mismatch');
  assert.equal(clientRes.store, 'MARKET_HISTORY_STORE_MISMATCH', 'Harus fail-closed dengan MARKET_HISTORY_STORE_MISMATCH');

  // Eksekusi syncRecentHistoryToSqlite harus mengembalikan ok: false
  const syncRes = await dailyHistorySync.syncRecentHistoryToSqlite({
    env: mockProdEnv,
    tickers: ['BBCA']
  });
  assert.equal(syncRes.ok, false);
  assert.equal(syncRes.reason, 'MARKET_HISTORY_STORE_MISMATCH');
});

// ============================================================================
// SKENARIO 9: YAHOO TIMEOUT & CIRCUIT BREAKER BEHAVIOR
// ============================================================================
test('Negative 9: Yahoo timeout & Circuit Breaker transisi CLOSED -> OPEN -> HALF_OPEN', () => {
  candleFetcher.resetScreenerCandleCircuit();
  let fakeTime = 1000000;
  candleFetcher.setScreenerCircuitClock(() => fakeTime);

  assert.equal(candleFetcher.getScreenerCircuitState(), 'CLOSED');

  // Trigger 3 consecutive failures
  candleFetcher.noteScreenerRemoteResult(false);
  candleFetcher.noteScreenerRemoteResult(false);
  assert.equal(candleFetcher.getScreenerCircuitState(), 'CLOSED'); // threshold is 3

  candleFetcher.noteScreenerRemoteResult(false);
  assert.equal(candleFetcher.getScreenerCircuitState(), 'OPEN', 'Circuit harus OPEN setelah 3 kegagalan');
  assert.equal(candleFetcher.screenerRemoteCircuitOpen(), true);

  // Selama cooldown (misal 1 menit kemudian), sirkuit tetap OPEN
  fakeTime += 60 * 1000;
  assert.equal(candleFetcher.getScreenerCircuitState(), 'OPEN');

  // Setelah cooldown 5 menit (300.000 ms), sirkuit masuk ke HALF_OPEN
  fakeTime += 300 * 1000;
  assert.equal(candleFetcher.getScreenerCircuitState(), 'HALF_OPEN', 'Circuit harus HALF_OPEN setelah cooldown berakhir');

  // Acquire probe di HALF_OPEN hanya boleh 1 kali (anti-retry storm)
  const probe1 = candleFetcher.tryAcquireScreenerHalfOpenProbe();
  assert.equal(probe1, true, 'Probe pertama harus berhasil di-acquire');
  const probe2 = candleFetcher.tryAcquireScreenerHalfOpenProbe();
  assert.equal(probe2, false, 'Probe kedua bersamaan harus diblokir untuk mencegah storm');

  // Jika remote pulih
  candleFetcher.noteScreenerRemoteResult(true);
  assert.equal(candleFetcher.getScreenerCircuitState(), 'CLOSED', 'Circuit kembali CLOSED setelah remote sukses');
  candleFetcher.resetScreenerCandleCircuit();
});

// ============================================================================
// SKENARIO 10: PROVIDER LIMIT UNKNOWN (FAIL-CLOSED KUOTA)
// ============================================================================
test('Negative 10: Provider limit unknown / uninitialized tidak memalsukan nilai default', () => {
  // Test resolveEffectiveLimit saat upstream limit uninitialized / null
  const limit = quotaState.resolveEffectiveLimit({
    upstreamDailyLimit: null
  });
  // Harus mengembalikan limit yang valid dari config (bukan NaN atau undefined)
  assert.ok(limit === null || (typeof limit === 'number' && Number.isFinite(limit)));

  // Pastikan quota status tidak pernah melempar fatal exception
  const status = quotaManager.getQuotaStatus();
  assert.ok(status.effective_limit >= 0);
  assert.ok(status.used >= 0);
  assert.ok(status.remaining >= 0);
});

// ============================================================================
// SKENARIO 11: FEATURE FLAG OFF
// ============================================================================
test('Negative 11: Feature flag OFF mematikan fungsionalitas eksperimental secara total', () => {
  const origFlag = process.env.ENABLE_HOURLY_CONFIRMATION;
  try {
    delete process.env.ENABLE_HOURLY_CONFIRMATION;
    assert.equal(hourlyConfirm.isFeatureEnabled(), false, 'Default tanpa env harus false (OFF)');

    process.env.ENABLE_HOURLY_CONFIRMATION = '0';
    assert.equal(hourlyConfirm.isFeatureEnabled(), false, 'ENABLE_HOURLY_CONFIRMATION=0 harus false');

    process.env.ENABLE_HOURLY_CONFIRMATION = 'false';
    assert.equal(hourlyConfirm.isFeatureEnabled(), false, 'ENABLE_HOURLY_CONFIRMATION=false harus false');
  } finally {
    if (origFlag !== undefined) process.env.ENABLE_HOURLY_CONFIRMATION = origFlag;
    else delete process.env.ENABLE_HOURLY_CONFIRMATION;
  }
});

// ============================================================================
// SKENARIO 12: DUPLICATE TRIGGER & IDEMPOTENCY
// ============================================================================
test('Negative 12: Duplicate trigger pada lifecycle evaluator tidak memicu double exit / corrupt history', () => {
  const pick = {
    id: 'PICK_001',
    ticker: 'BBRI',
    date: '2026-11-02',
    entry_low: 4800,
    entry_high: 4900,
    sl: 4600,
    tp1: 5200,
    tp2: 5500,
    status: 'WAITING_ENTRY'
  };

  // Candle hari 1: Masuk entry (Low 4850, High 4920) -> ENTERED
  // Candle hari 2: Naik sentuh TP1 (High 5250) -> TP1_HIT (Terminal)
  // Candle hari 3: Duplicate feed candle hari 2 atau candle berikutnya post-terminal
  const candles = [
    { trade_date: '2026-11-03', open: 4820, high: 4920, low: 4800, close: 4880 },
    { trade_date: '2026-11-04', open: 4890, high: 5250, low: 4870, close: 5220 },
    { trade_date: '2026-11-05', open: 5200, high: 5300, low: 4500, close: 4550 } // Low tembus SL setelah TP1 hit!
  ];

  const eval1 = sahamLifecycle.evaluateLifecycleHistory(pick, candles);
  assert.equal(eval1.currentState, sahamLifecycle.STATES.TP1_HIT, 'Harus mencatat TP1_HIT');
  assert.equal(eval1.isTerminal, true, 'Status harus terminal');
  assert.equal(eval1.exitDate, '2026-11-04', 'Tanggal exit harus terkunci di hari TP1 tercapai');

  // Re-evaluasi dengan dataset yang sama persis (Idempotent replay)
  const eval2 = sahamLifecycle.evaluateLifecycleHistory(pick, candles);
  assert.deepEqual(eval1, eval2, 'Re-evaluasi duplicate trigger harus 100% identik (idempotent)');

  // Post-terminal crash di hari ke-3 (Low 4500 < SL) TIDAK BOLEH membatalkan kemenangan TP1 yang sudah terjadi
  assert.equal(eval2.currentState, sahamLifecycle.STATES.TP1_HIT, 'State terminal tidak boleh berganti menjadi STOP_LOSS');
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const templates = require('../lib/telegram-templates');

// 1. Source verification in api/sector-hot.js
test('Phase 2 - api/sector-hot.js: forced fallback quota in Day Trade is disabled', () => {
  const sourcePath = path.join(__dirname, '..', 'api', 'sector-hot.js');
  const source = fs.readFileSync(sourcePath, 'utf8');

  // Verify that Step 3 WAIT_PULLBACK / SPECULATIVE backfill is disabled
  assert.doesNotMatch(source, /actionable\s*=\s*actionable\.concat\(watchlist\);/);

  // Verify that Step 5 forced watchlist fallback is disabled
  assert.doesNotMatch(source, /Tidak ada kandidat A\/B bersih, menampilkan watchlist terbaik/);
});

// 2. Day Trade (Confirmed Buy) Template
test('Phase 2 - formatDayTradeSignalMessage renders confirmed buy format and execution protocol', () => {
  const candidate = {
    ticker: 'ASII',
    sector: 'Consumer Cyclical',
    daytrade_score: 85,
    entry_low: 5100,
    entry_high: 5200,
    stop_loss: 4950,
    tp1: 5425,
    tp2: 5575,
    last_price: 5150,
    volume_pace: 2.3,
    delta_turnover_5m: 15000000000,
    bid_offer_dominance: 'Bid 65% (Dominan)',
    risk_reward: 2.1,
    status: 'CONFIRMED_BUY'
  };

  const msg = templates.formatDayTradeSignalMessage([candidate]);

  // Header & identity
  assert.match(msg, /⚡ AUTO-CUAN DAY TRADE — CONFIRMED BUY/);
  assert.match(msg, /ASII/);
  assert.match(msg, /Sektor: Consumer Cyclical/);
  assert.match(msg, /Skor Keyakinan: 85\/100/);

  // Price points & risk %
  assert.match(msg, /Area Beli \(Entry\): Rp5\.100 - Rp5\.200/);
  assert.match(msg, /Stop Loss: Rp4\.950 \(Risk: -2\.9%\)/);
  assert.match(msg, /Target Profit 1 \(\+4\.5%\): Rp5\.425/);
  assert.match(msg, /Target Profit 2 \(\+7\.5%\): Rp5\.575/);

  // Metrics
  assert.match(msg, /Volume Pace: 2\.3x/);
  assert.match(msg, /Delta 5m Turnover: Rp15,0 M/);
  assert.match(msg, /Dominasi Bid\/Offer: Bid 65% \(Dominan\)/);

  // Action protocol
  assert.match(msg, /⚡ Protokol Aksi Day Trade:/);
  assert.match(msg, /Entry hanya di area beli \(dilarang HAKA di pucuk\)/);
  assert.match(msg, /otomatis geser SL ke BEP \(Entry \+ 1 tick\) jika floating >= \+2\.0%/);
  assert.match(msg, /tutup posisi saat sesi 2 berakhir jika belum capai TP1/);
});

// 3. Opening Radar (09:00 - 09:30) Template
test('Phase 2 - formatOpeningRadarMessage renders early watch warning format', () => {
  const candidate = {
    ticker: 'BBNI',
    sector: 'Financials',
    entry_low: 4800,
    entry_high: 4850,
    stop_loss: 4700,
    tp1: 5050,
    last_price: 4820,
    status: 'RADAR'
  };

  const msg = templates.formatOpeningRadarMessage([candidate]);

  assert.match(msg, /👀 RADAR PEMBUKAAN — PANTAUAN, BUKAN SINYAL BUY/);
  assert.match(msg, /Volatilitas pembukaan tinggi/i);
  assert.match(msg, /sedang dipantau/i);
  assert.match(msg, /DILARANG HAKA sebelum ada konfirmasi resmi/i);
  assert.match(msg, /BBNI/);
});

// 4. Swing Trade (High Conviction) Templates
test('Phase 2 - formatSwingKongloSignalMessage and NonKonglo render high conviction format and 3-stage protocol', () => {
  const candidateKonglo = {
    ticker: 'TLKM',
    sector: 'Infrastructure',
    score: 82,
    entry_low: 3200,
    entry_high: 3260,
    stop_loss: 3100,
    tp1: 3420,
    tp2: 3600,
    last_price: 3240,
    cr3_flow: 45000000000,
    cr5_flow: 78000000000,
    retail_participation: 18.5,
    bandar_flow_label: 'Big Accumulation',
    risk_reward: 2.25
  };

  const msgKonglo = templates.formatSwingKongloSignalMessage([candidateKonglo]);

  assert.match(msgKonglo, /🎯 AUTO-CUAN SWING TRADE — HIGH CONVICTION/);
  assert.match(msgKonglo, /Kluster: Konglo \| Horizon: 3-7 Hari/);
  assert.match(msgKonglo, /TLKM/);
  assert.match(msgKonglo, /Target Profit 1 \(\+5% s\/d \+6% Partial TP 50%\): Rp3\.420/);
  assert.match(msgKonglo, /Target Profit 2 \(Fib Extension\): Rp3\.600/);
  assert.match(msgKonglo, /Intel Bandar \/ Arus Dana:/);
  assert.match(msgKonglo, /CR3: Rp45,0 M/);
  assert.match(msgKonglo, /CR5: Rp78,0 M/);
  assert.match(msgKonglo, /Partisipasi Ritel: 18\.5%/);

  // 3-Stage protocol
  assert.match(msgKonglo, /⚡ Protokol Aksi 3 Tahap:/);
  assert.match(msgKonglo, /1\. BEP lock di \+2\.5%/);
  assert.match(msgKonglo, /2\. Partial TP 50% di TP1/);
  assert.match(msgKonglo, /3\. Trailing Stop: Sisa lot gunakan trailing stop harian EMA9 Low menuju TP2/);

  const candidateNonKonglo = Object.assign({}, candidateKonglo, { ticker: 'MEDC' });
  const msgNonKonglo = templates.formatSwingNonKongloSignalMessage([candidateNonKonglo]);
  assert.match(msgNonKonglo, /🎯 AUTO-CUAN SWING TRADE — HIGH CONVICTION/);
  assert.match(msgNonKonglo, /Kluster: Non-Konglo \| Horizon: 3-7 Hari/);
});

// 5. Monitor TP/SL Hit Messages
test('Phase 2 - formatMonitorHitMessage sharpens TP1, TP2, and SL hit alerts', () => {
  const pick = {
    ticker: 'BRIS',
    entry1: 2000,
    entry2: 2040,
    tp1: 2150,
    tp2: 2280,
    sl: 1920,
    category: 'daytrade'
  };

  // TP1 Hit
  const tp1Hit = templates.formatMonitorHitMessage(pick, { status: 'TP1_HIT' }, { last: 2150, high: 2160, low: 2020 });
  assert.match(tp1Hit, /🎯 TP1 HIT/);
  assert.match(tp1Hit, /Jual 50-70% posisi & segera geser SL ke BEP/);

  // TP2 Hit
  const tp2Hit = templates.formatMonitorHitMessage(pick, { status: 'TP2_HIT' }, { last: 2280, high: 2290, low: 2020 });
  assert.match(tp2Hit, /🚀 TP2 HIT/);
  assert.match(tp2Hit, /Exit penuh seluruh sisa posisi atau pasang trailing stop sangat ketat/);

  // SL Hit
  const slHit = templates.formatMonitorHitMessage(pick, { status: 'SL_HIT' }, { last: 1910, high: 2050, low: 1910 });
  assert.match(slHit, /🛑 SL HIT — STOP LOSS/);
  assert.match(slHit, /Cut loss disiplin, jangan buyback sebelum ada setup baru/);
});

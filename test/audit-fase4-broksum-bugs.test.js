'use strict';

/**
 * AUDIT FASE 4 — Broker Summary & Bandarmologi Engine (23 Sep 2026)
 * Zero-trust reproduction suite. Setiap test di file ini MENGGAMBARKAN
 * kelemahan logika riil yang direproduksi lebih dulu (FAIL) sebelum patch.
 *
 * Target dependency (dipetakan dari import/export riil, bukan asumsi nama file):
 *   - lib/bandarmologi-service.js      (core engine: normalisasi + agregasi)
 *   - lib/bandarmologi-intel-service.js(CR3/CR5, sinyal intelijen)
 *   - public/bandarmologi-runtime.js   (normalisasi nilai & klasifikasi harian)
 *   - lib/arjum-client.js              (feed broker summary Arjum / VPS)
 *   - lib/vps-data-fetcher.js          (payload VPS bridge)
 *
 * Temuan:
 *   AUDIT-F4-10  String numerik ribuan ("1.500.000.000") memusnahkan nilai rupiah
 *   AUDIT-F4-11  enrichBrokerItem ikut hancur pada feed string numerik
 *   AUDIT-F4-12  Phantom net -1 pada baris broker tanpa nilai
 *   AUDIT-F4-13  Cross trade (broker sama, lot identik) => CR3 100% / AKUMULASI_MASIF palsu
 *   AUDIT-F4-14  runtime.normalizeBrokerValue membuang string numerik menjadi 0
 *   AUDIT-F4-15  Klasifikasi harian: net 0 / NaN dijatuhkan ke "Normal Dist"
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

// ---------------------------------------------------------------------------
// AUDIT-F4-10: feed Arjum/VPS dapat mengirim angka sebagai string ribuan.
// Number("1.500.000.000") === NaN, sehingga bval menjadi NaN dan setiap angka
// rupiah di baris itu hilang — broker bahkan keluar dari top_buyers, dan
// net_flow jatuh ke nilai volume (lot) sebagai pengganti rupiah.
// ---------------------------------------------------------------------------
test('AUDIT-F4-10: normalizeBrokerSummary mempertahankan nilai rupiah dari string numerik ribuan', () => {
  const norm = bandarmologiService.normalizeBrokerSummary({
    stock_code: 'STRINGFEED',
    date: '2026-09-22',
    gross_buyers: [{ broker: 'AK', bval: '1.500.000.000', bvol: '15000000' }],
    gross_sellers: [{ broker: 'XC', sval: '500.000.000', svol: '5000000' }]
  }, '2026-09-22', 'STRINGFEED');

  assert.ok(norm, 'normalized summary must exist');
  assert.equal(norm.gross_buyers.length, 1, 'AK must stay in gross_buyers');
  assert.equal(norm.gross_buyers[0].bval, 1500000000, 'bval must be parsed as Rp 1.5 Miliar, not NaN');
  assert.equal(norm.gross_buyers[0].sval, 0);
  assert.equal(norm.gross_sellers[0].sval, 500000000, 'sval must be parsed as Rp 500 Juta');
  assert.equal(norm.total_buy_val, 1500000000, 'total_buy_val must be the real rupiah figure');
  // Net flow riil = +1.5M (AK) - 0.5M (XC) = +1.0M ... AK adalah broker asing,
  // sehingga net flow asing (+1.5M) yang dipakai sebagai net flow hari itu.
  assert.equal(norm.net_flow, 1500000000, 'net_flow must be the real rupiah net, never the lot count');
  assert.equal(norm.net_status, 'BIG_ACCUMULATION');
  assert.equal(norm.foreign_buy, 1500000000, 'foreign_buy must not collapse to NaN');
});

// ---------------------------------------------------------------------------
// AUDIT-F4-11: jalur enrichBrokerItem (dipakai broker-hunter & skoring) juga
// memakai Number() mentah, sehingga payload string numerik menghasilkan 0.
// ---------------------------------------------------------------------------
test('AUDIT-F4-11: enrichBrokerItem mempertahankan nilai dari string numerik ribuan', () => {
  const enriched = bandarmologiService.enrichBrokerItem({
    broker: 'AK',
    bval: '1.500.000.000',
    sval: '200.000.000',
    bvol: '15000000',
    svol: '2000000'
  }, true, 0);

  assert.ok(enriched, 'enriched row must exist');
  assert.equal(enriched.bval, 1500000000, 'bval must be parsed, not 0');
  assert.equal(enriched.sval, 200000000, 'sval must be parsed, not 0');
  assert.equal(enriched.bvol, 15000000);
  assert.equal(enriched.nval, 1300000000, 'nval must be the real net rupiah');
  assert.equal(enriched.net_val, 1300000000);
});

// ---------------------------------------------------------------------------
// AUDIT-F4-12: `|| 1` pada jalur fallback net membuat baris broker tanpa nilai
// apa pun berubah menjadi "net seller -1". Akibatnya hari tanpa transaksi tetap
// melaporkan distribusi dan tabel menampilkan penjual hantu dengan magnitudo
// yang dikarang. Kontrak yang benar: identitas broker boleh tetap muncul (feed
// kadang hanya mengirim daftar kode — dipakai sinyal berbasis broker code),
// tetapi MAGNITUDO tidak boleh dikarang dan net flow wajib 0.
// ---------------------------------------------------------------------------
test('AUDIT-F4-12: baris broker tanpa nilai tidak boleh menghasilkan magnitudo -1 hantu', () => {
  const norm = bandarmologiService.normalizeBrokerSummary({
    stock_code: 'NOVALUE',
    date: '2026-09-22',
    gross_sellers: [{ broker: 'XC', broker_name: 'Ajaib Sekuritas Asia' }]
  }, '2026-09-22', 'NOVALUE');

  assert.ok(norm, 'normalized summary must exist');
  // Identitas boleh dipertahankan...
  assert.equal(norm.top_sellers.length, 1, 'the seller identity may survive for broker-code signals');
  assert.equal(norm.top_sellers[0].broker, 'XC');
  // ...tetapi tidak ada satu pun angka yang boleh dikarang.
  assert.equal(norm.top_sellers[0].net_val, 0, 'net_val must be 0, never a phantom -1');
  assert.equal(norm.top_sellers[0].sval, 0, 'sval must be 0, never a phantom 1');
  assert.equal(norm.top_sellers[0].svol, 0, 'svol must be 0, never a phantom 1');
  assert.equal(norm.net_flow, 0, 'net_flow must be 0, never a phantom -1');
  assert.equal(norm.net_status, 'NEUTRAL', 'an empty day must read NEUTRAL, not BIG_DISTRIBUTION');
  assert.equal(norm.net_sellers.length, 0, 'net_sellers must not contain phantom rows');

  // Broker tanpa nilai sama sekali tidak boleh dianggap cross trade.
  assert.equal(norm.has_cross_trade, false);
});

// ---------------------------------------------------------------------------
// AUDIT-F4-13: cross trade / tukar barang — broker pembeli terbesar SEKALIGUS
// penjual terbesar dengan lot identik. Sebelum patch, fallback
// `top_buyers = gross_buyers.slice()` memasukkan broker net-0 ke basis
// konsentrasi sehingga CR3 = 100% dan status melompat ke AKUMULASI_MASIF
// walau tidak ada akumulasi riil sama sekali.
// ---------------------------------------------------------------------------
test('AUDIT-F4-13: cross trade broker yang sama (lot identik) tidak boleh jadi AKUMULASI_MASIF palsu', () => {
  const raw = {
    stock_code: 'CROSSTRD',
    date: '2026-09-22',
    gross_buyers: [
      { broker: 'AK', bval: 100e9, bvol: 100e6 },
      { broker: 'BK', bval: 1e9, bvol: 1e6 }
    ],
    gross_sellers: [
      { broker: 'AK', sval: 100e9, svol: 100e6 },
      { broker: 'XC', sval: 1e9, svol: 1e6 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(raw, '2026-09-22', 'CROSSTRD');
  assert.ok(norm, 'normalized summary must exist');

  // Cross-trade harus disurface eksplisit, bukan dibiarkan menyamar sebagai akumulasi.
  assert.ok(Array.isArray(norm.cross_trade_brokers), 'cross_trade_brokers must be surfaced as an array');
  assert.ok(norm.cross_trade_brokers.includes('AK'), 'AK is a cross-trade broker (identical buy/sell lots)');
  assert.equal(norm.has_cross_trade, true);

  // Broker net 0 (churn) tidak boleh masuk basis konsentrasi pembelian.
  const topBuyerCodes = norm.top_buyers.map(b => b.broker);
  assert.ok(!topBuyerCodes.includes('AK'), 'a net-zero churning broker must not be listed as a top buyer');
  assert.deepEqual(topBuyerCodes, ['BK']);

  const cr = bandarmologiIntelService.computeConcentrationRatios('CROSSTRD', {
    brokerSummary: norm,
    range: '1d',
    days: 1
  });
  assert.ok(cr.cr3 < 5, `CR3 must reflect the real (tiny) net accumulation, got ${cr.cr3}`);
  assert.notEqual(cr.status, 'AKUMULASI_MASIF', 'churn must never be labelled massive accumulation');
  assert.equal(cr.triggered, false, 'churn must not trigger the accumulation signal');
  assert.deepEqual(cr.top_3_brokers, ['BK'], 'only the genuine net accumulator may lead the CR list');
});

// ---------------------------------------------------------------------------
// AUDIT-F4-14: runtime.normalizeBrokerValue membuang setiap string numerik
// (isNaN("1.500.000.000") === true) sehingga kolom nilai dirender 0.
// ---------------------------------------------------------------------------
test('AUDIT-F4-14: runtime normalizeBrokerValue membaca string numerik, bukan membuangnya', () => {
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('1.500.000.000'), 1500000000, 'thousand-dotted string must parse');
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('1500000000'), 1500000000, 'plain numeric string must parse');
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('5000000000000'), 50000000000, '5 T string must parse then normalise to Miliar scale');
  assert.equal(bandarmologiRuntime.normalizeBrokerValue(null), 0);
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('—'), 0);
});

// ---------------------------------------------------------------------------
// AUDIT-F4-15: klasifikasi harian (Big Acc / Normal Acc / Netral / Normal Dist
// / Big Dist). Nilai 0 dan NaN sebelumnya dijatuhkan ke cabang terakhir
// ("Normal Dist"), sehingga hari tanpa net flow apa pun tampil sebagai
// distribusi dan mendistorsi tabel konsistensi.
// ---------------------------------------------------------------------------
test('AUDIT-F4-15: klasifikasi harian menempatkan net 0 / NaN pada Netral', () => {
  const classify = bandarmologiRuntime.classifyDailyNetCategory;
  assert.equal(typeof classify, 'function', 'classifyDailyNetCategory must be exported for verification');

  assert.equal(classify(0), 'Netral');
  assert.equal(classify(-0), 'Netral');
  assert.equal(classify(NaN), 'Netral');
  assert.equal(classify(null), 'Netral');
  assert.equal(classify(undefined), 'Netral');
  assert.equal(classify(5e9), 'Big Acc');
  assert.equal(classify(4.99e9), 'Normal Acc');
  assert.equal(classify(-5e9), 'Big Dist');
  assert.equal(classify(-4.99e9), 'Normal Dist');
});

// ---------------------------------------------------------------------------
// AUDIT-F4-16: ambang batas CR3 tidak konsisten antar modul.
// lib/bandarmologi-intel-service.js memakai `cr3 >= 60` (Akumulasi Masif),
// sedangkan lib/bandarmologi-screener-scoring.js memakai `cr3 > 0.60` sehingga
// CR3 tepat 60,00% TIDAK dianggap terkonstrasi masif — saham yang sama dapat
// dua label berbeda. Ambang harus inklusif (>=) di kedua modul.
// ---------------------------------------------------------------------------
test('AUDIT-F4-16: ambang CR3 60% inklusif dan konsisten dengan intel-service', () => {
  const screenerScoring = require('../lib/bandarmologi-screener-scoring');

  // 5 broker dengan nilai beli identik: CR3 = 60/100 = 0.60 persis, CR5 = 100%.
  const brokerData = [20, 20, 20, 20, 20].map((v, i) => ({
    broker_code: 'B' + i,
    bval: v,
    sval: 0,
    bvol: v * 100,
    nval: v
  }));

  const scored = screenerScoring.calculateBandarmologiScore(brokerData, { mode: 'swing' });
  assert.equal(scored.metrics.cr3, 0.6, 'CR3 must be exactly 0.60 in this fixture');
  const cr3Rule = scored.breakdown.find(b => b.rule === 'CR3_CONCENTRATION');
  assert.ok(cr3Rule, 'CR3 exactly 60% must earn the CR3_CONCENTRATION rule, not fall through to CR5');
  assert.equal(cr3Rule.points, 25);

  // Threshold parity: the intel service already treats 60% as massive.
  const intel = bandarmologiIntelService.computeConcentrationRatios('CRBOUNDARY', {
    brokerSummary: {
      top_buyers: brokerData.map(b => ({ broker: b.broker_code, bval: b.bval, bvol: b.bvol })),
      gross_buyers: brokerData.map(b => ({ broker: b.broker_code, bval: b.bval, bvol: b.bvol })),
      brokers: brokerData.map(b => ({ broker: b.broker_code, bval: b.bval, bvol: b.bvol, sval: 0 })),
      total_turnover: 100
    },
    range: '1d',
    days: 1
  });
  assert.equal(intel.cr3, 60, 'intel CR3 must be exactly 60');
  assert.equal(intel.status, 'AKUMULASI_MASIF', 'intel service treats 60% as massive — the screener must agree');
});

// ---------------------------------------------------------------------------
// AUDIT-F4-17: saham suspend / FCA tanpa transaksi broker tidak boleh
// menghasilkan status akumulasi palsu. Payload kosong harus tetap NEUTRAL dan
// tidak mengklaim cross trade apa pun.
// ---------------------------------------------------------------------------
test('AUDIT-F4-17: payload broksum kosong (suspend/FCA) tidak menghasilkan akumulasi palsu', () => {
  const empty = bandarmologiService.normalizeBrokerSummary({
    stock_code: 'SUSPEND',
    date: '2026-09-22',
    brokers: []
  }, '2026-09-22', 'SUSPEND');

  assert.ok(empty, 'an explicitly empty payload must still normalise to an empty summary');
  assert.equal(empty.net_flow, 0);
  assert.equal(empty.net_status, 'NEUTRAL');
  assert.equal(empty.top_buyers.length, 0);
  assert.equal(empty.top_sellers.length, 0);
  assert.equal(empty.has_cross_trade, false, 'no trades means no cross trade');
  assert.deepEqual(empty.cross_trade_brokers, []);

  const cr = bandarmologiIntelService.computeConcentrationRatios('SUSPEND', {
    brokerSummary: empty,
    range: '1d',
    days: 1
  });
  assert.equal(cr.triggered, false, 'a suspended ticker must never trigger accumulation');
  assert.equal(cr.cr3, null);
  assert.equal(cr.reason, 'NO_DATA');
});

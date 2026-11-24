'use strict';

/**
 * test/v6-market-parity.test.js
 * ============================================================================
 * V6 Subtask G — Yahoo/SQLite/IHSG market parity (source -> storage -> reader).
 *
 * Setiap asersi memanggil FUNGSI NYATA:
 *   - tools/v6-market-parity-audit.js  (runAudit, classifyParity, computeReadiness,
 *                                       normalizeSeries, auditOhlcIntegrity)
 *   - api/chart.js                     (buildChartResponse — handler yang sama
 *                                       yang dipasang local-dev-server)
 *   - lib/local-market-subset-store.js (getCandles — lapisan chart-consumed)
 *
 * Kasus yang ditutup:
 *   G-1  PARITY_OK: 4 lapisan sepakat tanggal & close.
 *   G-2  STALE_CONSUMER: chart/consumer tertahan tanggal lama padahal source
 *        lebih baru => terdeteksi + gerbang READY terblok (fail-closed).
 *   G-3  MISMATCH_VALUE: tanggal sama, close beda antar lapisan.
 *   G-4  IHSG unavailable => UNAVAILABLE eksplisit, BUKAN bar sintetis
 *        (regresi fallback 7480.25/7505.5 yang dihapus dari api/chart.js).
 *   G-5  IHSG stale => data_status STALE + tanggal data terakhir yang sah.
 *   G-6  Volume null vs 0 tidak dikolaps menjadi satu makna.
 *   G-7  OHLC integrity: bar high<low ditolak, tidak pernah "diperbaiki".
 *   G-8  MISSING_LAYER fail-closed: lapisan tanpa data tidak dianggap paritas.
 *   G-9  Data riil repo: IHSG tidak lagi memuat angka sintetis; CNTX (dorman,
 *        0 candle) => UNAVAILABLE.
 *  G-10  Consumer layer (local-market-subset-store) tidak lagi menyuntik
 *        override sintetis BBCA 5950.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('../tools/v6-market-parity-audit');
const chartApi = require('../api/chart.js');

const NOW = new Date('2026-11-11T05:00:00Z'); // 12:00 WIB, Selasa

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-parity-'));
  fs.mkdirSync(path.join(root, 'data', 'daily-candles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'ohlcv'), { recursive: true });
  return root;
}

function writeFlatFile(root, ticker, candles, extra) {
  const payload = Object.assign({
    ticker, source: 'yahoo', range: candles.length + 'd', interval: 'daily', candles
  }, extra || {});
  fs.writeFileSync(
    path.join(root, 'data', 'daily-candles', ticker + '.json'),
    JSON.stringify(payload)
  );
}

function bar(date, close, extra) {
  return Object.assign({
    date,
    open: close - 10,
    high: close + 20,
    low: close - 20,
    close,
    volume: 1000000
  }, extra || {});
}

function sqliteLayer(date, close, extra) {
  return Object.assign({
    present: true, reason: null, last_date: date, last_close: close,
    last_volume: 1000000, candles: null, row_count: 10
  }, extra || {});
}

function fakeConsumerStore(map) {
  return {
    getCandles(ticker) {
      const entry = map[ticker];
      if (!entry) return null;
      return {
        success: true,
        ticker,
        source: 'fixture-consumer',
        totalCandles: entry.candles.length,
        latest: entry.candles[entry.candles.length - 1],
        candles: entry.candles
      };
    }
  };
}

function consumerCandle(time, close) {
  return { time, open: close - 10, high: close + 20, low: close - 20, close, volume: 1000000 };
}

function runFixtureAudit(root, tickers, overrides) {
  return audit.runAudit(Object.assign({
    root,
    tickers,
    now: NOW,
    chartApi,
    write: false
  }, overrides || {}));
}

// ---------------------------------------------------------------------------
// G-1: PARITY_OK — semua lapisan sepakat.
// ---------------------------------------------------------------------------
test('V6G-1: 4 lapisan dengan tanggal & close identik => PARITY_OK dan gerbang READY lolos', () => {
  const root = makeFixtureRoot();
  try {
    writeFlatFile(root, 'AAAA', [bar('2026-11-07', 1000), bar('2026-11-10', 1050)]);

    const sqliteMap = new Map([['AAAA', sqliteLayer('2026-11-10', 1050)]]);
    const subsetStore = fakeConsumerStore({
      AAAA: { candles: [consumerCandle('2026-11-07', 1000), consumerCandle('2026-11-10', 1050)] }
    });

    const { rows, summary } = runFixtureAudit(root, ['AAAA'], { sqliteMap, subsetStore });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.parity_status, 'PARITY_OK', 'evidence: ' + row.evidence);
    assert.equal(row.yahoo_last_date, '2026-11-10');
    assert.equal(row.sqlite_last_date, '2026-11-10');
    assert.equal(row.api_last_date, '2026-11-10');
    assert.equal(row.chart_consumed_date, '2026-11-10');
    assert.equal(row.yahoo_last_close, 1050);
    assert.equal(row.api_last_close, 1050);
    assert.equal(row.ohlc_integrity, 'OK');

    const readiness = audit.computeReadiness(summary);
    assert.equal(readiness.ready, true, 'semua lapisan paritas => READY');
    assert.deepEqual(readiness.blockers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-2: STALE_CONSUMER — source baru, consumer lama => terdeteksi + blok READY.
//      Replikasi temuan produksi: flat-file 2026-11-09 vs SQLite 2026-11-02.
// ---------------------------------------------------------------------------
test('V6G-2: consumer tertahan tanggal lama vs source baru => STALE_CONSUMER dan READY terblok', () => {
  const root = makeFixtureRoot();
  try {
    writeFlatFile(root, 'BBBB', [bar('2026-11-06', 500), bar('2026-11-09', 520)]);

    // Storage & consumer tertahan di 2026-11-02 (pola nyata VPS: sync stall).
    const sqliteMap = new Map([['BBBB', sqliteLayer('2026-11-02', 480)]]);
    const subsetStore = fakeConsumerStore({
      BBBB: { candles: [consumerCandle('2026-10-30', 470), consumerCandle('2026-11-02', 480)] }
    });

    const { rows, summary } = runFixtureAudit(root, ['BBBB'], { sqliteMap, subsetStore });
    const row = rows[0];
    assert.equal(row.parity_status, 'STALE_CONSUMER');
    assert.equal(row.yahoo_last_date, '2026-11-09');
    assert.equal(row.sqlite_last_date, '2026-11-02');
    assert.equal(row.chart_consumed_date, '2026-11-02');
    assert.match(row.evidence, /sqlite:stale\(2026-11-02<2026-11-09\)/);
    assert.match(row.evidence, /chart_consumed:stale\(2026-11-02<2026-11-09\)/);

    // Gerbang READY fail-closed: stale consumer harus memblokir.
    const readiness = audit.computeReadiness(summary);
    assert.equal(readiness.ready, false, 'STALE_CONSUMER wajib memblokir READY');
    assert.ok(readiness.blockers.some((b) => b.startsWith('STALE_CONSUMER=')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-3: MISMATCH_VALUE — tanggal sama, close beda antar lapisan.
// ---------------------------------------------------------------------------
test('V6G-3: tanggal sama tetapi close beda antar lapisan => MISMATCH_VALUE', () => {
  const root = makeFixtureRoot();
  try {
    writeFlatFile(root, 'CCCC', [bar('2026-11-10', 1050)]);

    const sqliteMap = new Map([['CCCC', sqliteLayer('2026-11-10', 9999)]]);
    const subsetStore = fakeConsumerStore({
      CCCC: { candles: [consumerCandle('2026-11-10', 1050)] }
    });

    const { rows, summary } = runFixtureAudit(root, ['CCCC'], { sqliteMap, subsetStore });
    const row = rows[0];
    assert.equal(row.parity_status, 'MISMATCH_VALUE');
    assert.match(row.evidence, /sqlite:close_mismatch\(1050 vs 9999@2026-11-10\)/);

    const readiness = audit.computeReadiness(summary);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.some((b) => b.startsWith('MISMATCH_VALUE=')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-4: IHSG UNAVAILABLE => respons eksplisit, BUKAN angka sintetis.
//      Replikasi kondisi VPS nyata: data/daily-candles/IHSG.json 0 candle
//      (observed 2026-11-11T19:19 WIB). Handler lama menyuntik 7480.25.
// ---------------------------------------------------------------------------
test('V6G-4: IHSG unavailable has no synthesis; accepted rows retain date/source and invalid OHLC is rejected', () => {
  const root = makeFixtureRoot();
  try {
    // (a) Empty and missing storage remain explicitly unavailable.
    writeFlatFile(root, 'IHSG', []);
    let r = chartApi.buildChartResponse('IHSG', NOW, { root });
    assert.equal(r.payload.success, false);
    assert.equal(r.payload.data_status, 'unavailable');
    assert.equal(r.payload.actual_data_date, null);
    assert.equal(r.payload.candles.length, 0, 'no replacement candle');
    const body = JSON.stringify(r.payload);
    for (const synthetic of ['7480.25', '7505.5', '7460.5', '24500000000', '26000000000', '2026-11-04']) {
      assert.ok(!body.includes(synthetic), 'synthetic value must not appear: ' + synthetic);
    }

    fs.rmSync(path.join(root, 'data', 'daily-candles', 'IHSG.json'));
    r = chartApi.buildChartResponse('IHSG', NOW, { root });
    assert.equal(r.statusCode, 404);
    assert.equal(r.payload.data_status, 'unavailable');
    assert.equal(r.payload.candles.length, 0);

    // A valid low close is retained with its source and actual trading date.
    writeFlatFile(root, 'IHSG', [Object.assign(bar('2026-10-27', 5266.13), {
      source: 'fixture-yahoo', source_sha256: 'low-close-fixture-digest', source_as_of: '2026-10-27'
    })]);
    r = chartApi.buildChartResponse('IHSG', NOW, { root });
    assert.equal(r.payload.success, true);
    assert.equal(r.payload.data_status, 'stale');
    assert.equal(r.payload.actual_data_date, '2026-10-27');
    assert.equal(r.payload.candles.length, 1);
    assert.equal(r.payload.candles[0].close, 5266.13);
    assert.equal(r.payload.candles[0].provenance.source, 'fixture-yahoo');
    assert.equal(r.payload.candles[0].provenance.source_sha256, 'low-close-fixture-digest');

    // Invalid OHLC is rejected without changing or replacing the source value.
    writeFlatFile(root, 'IHSG', [{ ...bar('2026-10-28', 5267), high: 5200 }]);
    r = chartApi.buildChartResponse('IHSG', NOW, { root });
    assert.equal(r.payload.success, false);
    assert.equal(r.payload.data_status, 'unavailable');
    assert.equal(r.payload.actual_data_date, null);
    assert.equal(r.payload.candles.length, 0, 'invalid OHLC is rejected without synthesis');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-5: IHSG stale => stale + tanggal data sah terakhir, bukan label "hari ini".
// ---------------------------------------------------------------------------
test('V6G-5: IHSG basi => data_status stale dengan actual_data_date eksplisit', () => {
  const root = makeFixtureRoot();
  try {
    writeFlatFile(root, 'IHSG', [
      bar('2026-10-08', 6031.28),
      bar('2026-10-09', 6093.76)
    ]);
    const r = chartApi.buildChartResponse('IHSG', NOW, { root });
    assert.equal(r.payload.success, true);
    assert.equal(r.payload.data_status, 'stale', 'data 10 Okt vs hari Jakarta 11 Nov wajib stale');
    assert.equal(r.payload.actual_data_date, '2026-10-09');
    assert.equal(r.payload.last_valid_date, '2026-10-09');
    assert.equal(r.payload.jakarta_today, '2026-11-11');
    assert.equal(r.payload.latest.close, 6093.76);
    assert.equal(r.payload.metrics.bandarAccumulation, null, 'tidak ada metrik bandar fabrikasi');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-6: volume null (tidak diketahui) vs 0 (tidak ada transaksi) tidak dikolaps.
// ---------------------------------------------------------------------------
test('V6G-6: volume null tetap null dan volume 0 tetap 0 di semua lapisan audit', () => {
  const root = makeFixtureRoot();
  try {
    writeFlatFile(root, 'DDDD', [
      bar('2026-11-07', 300, { volume: null }),
      bar('2026-11-10', 310, { volume: 0 })
    ]);

    // L1: normalizer audit memisahkan null vs zero.
    const layer = audit.readFlatFileLayer(path.join(root, 'data', 'daily-candles'), 'DDDD');
    assert.equal(layer.volume_null, 1, 'volume null dihitung terpisah');
    assert.equal(layer.volume_zero, 1, 'volume 0 dihitung terpisah');
    assert.equal(layer.last_volume, 0, 'bar terakhir volume 0 dipertahankan sebagai 0');

    // L3: api/chart.js meneruskan null sebagai null, 0 sebagai 0.
    const r = chartApi.buildChartResponse('DDDD', NOW, { root });
    assert.equal(r.payload.success, true);
    assert.equal(r.payload.candles[0].volume, null, 'null tidak boleh menjadi 0');
    assert.equal(r.payload.candles[1].volume, 0, '0 asli tidak boleh menjadi null');

    // Baris audit membawa semantik keduanya.
    const { rows } = runFixtureAudit(root, ['DDDD'], {
      sqliteMap: new Map(), subsetStore: null
    });
    assert.match(rows[0].volume_null_vs_zero, /source\[null=1,zero=1\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-7: OHLC integrity — bar high<low / close di luar [low,high] ditolak.
// ---------------------------------------------------------------------------
test('V6G-7: bar melanggar invariant OHLC ditolak (tidak pernah "diperbaiki")', () => {
  const root = makeFixtureRoot();
  try {
    writeFlatFile(root, 'EEEE', [
      bar('2026-11-07', 400),
      { date: '2026-11-10', open: 410, high: 390, low: 405, close: 408, volume: 10 }, // high<low
      { date: '2026-11-11', open: 410, high: 420, low: 405, close: 430, volume: 10 } // close>high
    ]);

    const layer = audit.readFlatFileLayer(path.join(root, 'data', 'daily-candles'), 'EEEE');
    assert.equal(layer.ohlc_violations.length, 2);
    assert.equal(layer.last_date, '2026-11-07', 'bar rusak tidak ikut menjadi bar terakhir');

    const r = chartApi.buildChartResponse('EEEE', NOW, { root });
    assert.equal(r.payload.total_candles, 1, 'api/chart.js juga menolak bar rusak');
    assert.equal(r.payload.candles[0].time, '2026-11-07');

    const { rows } = runFixtureAudit(root, ['EEEE'], { sqliteMap: new Map(), subsetStore: null });
    assert.notEqual(rows[0].ohlc_integrity, 'OK', 'audit menandai VIOLATION, bukan diam');
    assert.match(rows[0].ohlc_integrity, /VIOLATION/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-8: MISSING_LAYER fail-closed — lapisan kosong tidak dianggap paritas.
//      Replikasi CNTX: flat-file 500 candle dorman @2026-07-29, SQLite 0 baris.
// ---------------------------------------------------------------------------
test('V6G-8: lapisan storage tanpa baris => MISSING_LAYER (bukan PARITY_OK)', () => {
  const root = makeFixtureRoot();
  try {
    writeFlatFile(root, 'FFFF', [bar('2026-07-29', 142, { volume: 0 })]);

    const { rows, summary } = runFixtureAudit(root, ['FFFF'], {
      sqliteMap: new Map(), // storage tidak punya baris FFFF
      subsetStore: fakeConsumerStore({}) // consumer juga kosong
    });
    assert.equal(rows[0].parity_status, 'MISSING_LAYER');
    assert.match(rows[0].evidence, /sqlite:missing/);
    assert.match(rows[0].evidence, /chart_consumed:missing/);

    const readiness = audit.computeReadiness(summary);
    assert.equal(readiness.ready, false, 'MISSING_LAYER ikut memblokir READY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G-9: Data riil repo — tidak ada lagi angka sintetis IHSG; CNTX => UNAVAILABLE.
// ---------------------------------------------------------------------------
test('V6G-9: data riil repo bebas bar sintetis IHSG; CNTX dorman => UNAVAILABLE', () => {
  const repoRoot = path.resolve(__dirname, '..');

  // (a) Flat-file IHSG lokal tidak boleh lagi memuat bar bertanda sintetis
  //     (value/frequency adalah marker bar fabrikasi Arjum-era yang dihapus).
  const ihsgPath = path.join(repoRoot, 'data', 'daily-candles', 'IHSG.json');
  if (fs.existsSync(ihsgPath)) {
    const parsed = JSON.parse(fs.readFileSync(ihsgPath, 'utf8'));
    const candles = parsed.candles || [];
    const synthetic = candles.filter((c) => c.value !== undefined || c.frequency !== undefined);
    assert.equal(synthetic.length, 0, 'flat-file IHSG harus bebas bar sintetis value/frequency');
    for (const c of candles) {
      assert.notEqual(Number(c.close), 7480.25, 'close sintetis 7480.25 harus hilang');
      assert.notEqual(Number(c.close), 7505.5, 'close sintetis 7505.5 harus hilang');
    }
  }

  // (b) Handler NYATA di atas data riil tidak pernah mengeluarkan angka sintetis.
  const r = chartApi.buildChartResponse('IHSG', NOW, { root: repoRoot });
  const body = JSON.stringify(r.payload);
  assert.ok(!body.includes('7480.25'), 'api/chart.js tidak boleh memuat 7480.25');
  assert.ok(!body.includes('7505.5'), 'api/chart.js tidak boleh memuat 7505.5');
  assert.equal(r.payload.metrics.bandarAccumulation, null);
  if (r.payload.success) {
    // actual_data_date harus sama dengan bar sah terakhir di berkas (paritas reader).
    const parsed = JSON.parse(fs.readFileSync(ihsgPath, 'utf8'));
    const validDates = (parsed.candles || [])
      .filter((c) => Number(c.close) >= chartApi.IHSG_MIN_VALID_CLOSE)
      .map((c) => String(c.date).slice(0, 10))
      .sort();
    assert.equal(r.payload.actual_data_date, validDates[validDates.length - 1]);
    assert.equal(r.payload.data_status, 'stale', 'bar terakhir IHSG riil (Okt) vs hari ini wajib stale');
  }

  // (c) CNTX dorman (0 candle di flat-file lokal) => UNAVAILABLE, bukan 404 sintetis.
  const cntx = chartApi.buildChartResponse('CNTX', NOW, { root: repoRoot });
  assert.equal(cntx.payload.success, false);
  assert.equal(cntx.payload.data_status, 'unavailable');
  assert.equal(cntx.payload.candles.length, 0);
});

// ---------------------------------------------------------------------------
// G-10: Lapisan chart-consumed (local-market-subset-store) tidak lagi menyuntik
//       override sintetis BBCA {close:5950, volume:122716900}.
// ---------------------------------------------------------------------------
test('V6G-10: getCandles tidak menyuntik bar sintetis BBCA 5950', () => {
  const store = require('../lib/local-market-subset-store');
  const data = store.getCandles('BBCA');
  if (!data || !Array.isArray(data.candles) || data.candles.length === 0) {
    // Tanpa subset SQLite/JSON di lingkungan ini: tidak ada data => tidak ada bar.
    // Justru inilah perilaku fail-closed yang diharapkan (dulu: 25 bar fabrikasi).
    return;
  }
  // Sidik jari override sintetis yang dihapus adalah tuple LIMA nilai persis
  // {5925, 5975, 5850, 5950, 122716900}. Catatan forensik: SQLite subset
  // memuat bar RIIL 2026-10-13 {o:5925, h:5950, l:5850, c:5950, v:122716900}
  // (source daily_candles_flat_file) — high 5950, bukan 5975. Jadi pencocokan
  // harus memakai tuple lengkap agar bar riil tidak dituduh sintetis.
  const isSyntheticTuple = (c) =>
    Number(c.open) === 5925 && Number(c.high) === 5975 && Number(c.low) === 5850 &&
    Number(c.close) === 5950 && Number(c.volume) === 122716900;

  const last = data.candles[data.candles.length - 1];
  assert.equal(isSyntheticTuple(last), false,
    'bar terakhir BBCA harus nilai storage riil, bukan override sintetis 5950');

  // Tidak ada bar di seluruh seri yang persis sama dengan tuple override lama.
  const anySynthetic = data.candles.some(isSyntheticTuple);
  assert.equal(anySynthetic, false, 'tidak boleh ada bar override sintetis di seri consumer');

  // Tanggal bar terakhir harus tanggal storage yang sah (bukan tanggal karangan
  // hasil fabrikasi baseline 2026-09-01..25 yang dulu disuntik saat data kosong).
  assert.match(String(last.time || ''), /^\d{4}-\d{2}-\d{2}$/, 'bar terakhir bertanggal sah');
  const fabricatedBaseline = data.candles.filter(
    (c) => String(c.time || '').startsWith('2026-09') && c.volume >= 50000000 && c.volume <= 75000000 &&
      (c.volume - 50000000) % 1000000 === 0
  );
  // Pola volume 50jt+i*1jt adalah sidik jari baseline fabrikasi yang dihapus.
  assert.ok(fabricatedBaseline.length < 5, 'sisa baseline fabrikasi tidak boleh mendominasi seri');
});

// ---------------------------------------------------------------------------
// G-11: classifyParity — unit langsung untuk matriks status (fungsi nyata).
// ---------------------------------------------------------------------------
test('V6G-11: classifyParity menetapkan status sesuai matriks fail-closed', () => {
  const src = (date, close) => ({ present: true, last_date: date, last_close: close });

  // Source hilang => MISSING_LAYER (tidak ada pembanding).
  assert.equal(audit.classifyParity({
    source: { present: false, reason: 'file_missing' },
    sqlite: src('2026-11-10', 100), api: src('2026-11-10', 100), chart_consumed: src('2026-11-10', 100)
  }).status, 'MISSING_LAYER');

  // Semua sama => PARITY_OK.
  assert.equal(audit.classifyParity({
    source: src('2026-11-10', 100),
    sqlite: src('2026-11-10', 100), api: src('2026-11-10', 100), chart_consumed: src('2026-11-10', 100)
  }).status, 'PARITY_OK');

  // API lebih tua dari source => STALE_CONSUMER (pola "chart tertahan 13/14 Okt").
  assert.equal(audit.classifyParity({
    source: src('2026-11-09', 100),
    sqlite: src('2026-11-09', 100), api: src('2026-10-14', 95), chart_consumed: src('2026-10-14', 95)
  }).status, 'STALE_CONSUMER');

  // Selisih close di atas toleransi => MISMATCH_VALUE.
  assert.equal(audit.classifyParity({
    source: src('2026-11-10', 100),
    sqlite: src('2026-11-10', 100.5), api: src('2026-11-10', 100), chart_consumed: src('2026-11-10', 100)
  }).status, 'MISMATCH_VALUE');

  // Selisih pembulatan <= 0.01 tetap PARITY_OK (bukan mismatch palsu).
  assert.equal(audit.classifyParity({
    source: src('2026-11-10', 100),
    sqlite: src('2026-11-10', 100.005), api: src('2026-11-10', 100), chart_consumed: src('2026-11-10', 100)
  }).status, 'PARITY_OK');

  // Lapisan downstream tidak dievaluasi sama sekali => MISSING_LAYER, bukan OK.
  assert.equal(audit.classifyParity({
    source: src('2026-11-10', 100),
    sqlite: null, api: null, chart_consumed: null
  }).status, 'MISSING_LAYER');
});

'use strict';

/**
 * tools/gates/gate-V4-F13.js
 * ============================================================================
 * Gate Penguji Anti-Bohong FASE V4-F13:
 * Kompilasi Fast-Bundle Penuh 964 Ticker (< 15 ms) & Audit Kecepatan Seluruh Endpoint API.
 *
 * 1. Kompilasi Fast-Bundle Penuh:
 *    - Menjalankan scripts/build-fast-bundle.js mencakup 964 ticker (963 emiten BEI + IHSG).
 *    - 0 gagal, data/fast-bundle.json dan berkas per-ticker terkompilasi lengkap:
 *      OHLCV, indikator teknikal (ATR-14, RSI Wilder RMA, LPM, CMF, MA), level Fibonacci 9 baris,
 *      struktur SMC + Harmonic XABCD + Zig-Zag, ringkasan Bandarmologi & Foreign Flow (1H..20H),
 *      Free Float & KSEI, serta data pemenang backtest individual.
 * 2. Audit Kecepatan Seluruh Endpoint API (10 Endpoint Utama):
 *    1. /api/fast-bundle
 *    2. /api/screener
 *    3. /api/top5-radar
 *    4. /api/chart?ticker=BBCA
 *    5. /api/bandarmologi?ticker=BBCA
 *    6. /api/intel
 *    7. /api/ranking
 *    8. /api/struktur-pasar
 *    9. /api/sektor
 *    10. /api/pattern-radar
 *    - Seluruh endpoint mengembalikan status HTTP 200 OK.
 *    - Seluruh endpoint mengembalikan data JSON valid dengan data nyata (bukan array kosong).
 *    - Rata-rata latency seluruh 10 endpoint < 25 ms.
 *    - Endpoint /api/fast-bundle latency < 15 ms (standar pbakaus/impeccable).
 * 3. Kontrol Negatif (Negative Control Validator) anti-gate-gaming.
 * 4. Simpan bukti ke bukti-verifikasi-final/gates-v4/F13.json dan cetak "PASS: Gate V4-F13 LULUS".
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F13.json');

const result = lib.newResult(
  'V4-F13',
  'Kompilasi Fast-Bundle Penuh 964 Ticker (< 15 ms) & Audit Kecepatan Seluruh Endpoint API'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f13Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.totalTickers !== 'number' || sample.totalTickers < 964) return false;
  if (typeof sample.buildFailures !== 'number' || sample.buildFailures > 0) return false;
  if (typeof sample.allEndpointsOk !== 'boolean' || sample.allEndpointsOk !== true) return false;
  if (typeof sample.allEndpointsHaveData !== 'boolean' || sample.allEndpointsHaveData !== true) return false;
  if (typeof sample.overallAvgMs !== 'number' || sample.overallAvgMs >= 25.0) return false;
  if (typeof sample.fastBundleAvgMs !== 'number' || sample.fastBundleAvgMs >= 15.0) return false;
  if (typeof sample.bundleHasIndicators !== 'boolean' || sample.bundleHasIndicators !== true) return false;
  if (typeof sample.bundleHasFib9 !== 'boolean' || sample.bundleHasFib9 !== true) return false;
  if (typeof sample.bundleHasFreeFloat !== 'boolean' || sample.bundleHasFreeFloat !== true) return false;
  if (typeof sample.bundleHasBacktest !== 'boolean' || sample.bundleHasBacktest !== true) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: Ticker kurang dari 964
  {
    totalTickers: 800,
    buildFailures: 0,
    allEndpointsOk: true,
    allEndpointsHaveData: true,
    overallAvgMs: 8.5,
    fastBundleAvgMs: 3.2,
    bundleHasIndicators: true,
    bundleHasFib9: true,
    bundleHasFreeFloat: true,
    bundleHasBacktest: true
  },
  // Sampel korup 2: Ada build failure
  {
    totalTickers: 964,
    buildFailures: 5,
    allEndpointsOk: true,
    allEndpointsHaveData: true,
    overallAvgMs: 8.5,
    fastBundleAvgMs: 3.2,
    bundleHasIndicators: true,
    bundleHasFib9: true,
    bundleHasFreeFloat: true,
    bundleHasBacktest: true
  },
  // Sampel korup 3: Latency rata-rata melampaui 25 ms
  {
    totalTickers: 964,
    buildFailures: 0,
    allEndpointsOk: true,
    allEndpointsHaveData: true,
    overallAvgMs: 32.4,
    fastBundleAvgMs: 4.1,
    bundleHasIndicators: true,
    bundleHasFib9: true,
    bundleHasFreeFloat: true,
    bundleHasBacktest: true
  },
  // Sampel korup 4: Fast-bundle melampaui 15 ms
  {
    totalTickers: 964,
    buildFailures: 0,
    allEndpointsOk: true,
    allEndpointsHaveData: true,
    overallAvgMs: 14.2,
    fastBundleAvgMs: 18.5,
    bundleHasIndicators: true,
    bundleHasFib9: true,
    bundleHasFreeFloat: true,
    bundleHasBacktest: true
  },
  // Sampel korup 5: Salah satu endpoint gagal / tanpa data
  {
    totalTickers: 964,
    buildFailures: 0,
    allEndpointsOk: false,
    allEndpointsHaveData: false,
    overallAvgMs: 6.2,
    fastBundleAvgMs: 2.1,
    bundleHasIndicators: true,
    bundleHasFib9: true,
    bundleHasFreeFloat: true,
    bundleHasBacktest: true
  },
  // Sampel korup 6: Bundle tidak memiliki indikator teknikal lengkap
  {
    totalTickers: 964,
    buildFailures: 0,
    allEndpointsOk: true,
    allEndpointsHaveData: true,
    overallAvgMs: 7.0,
    fastBundleAvgMs: 2.5,
    bundleHasIndicators: false,
    bundleHasFib9: true,
    bundleHasFreeFloat: true,
    bundleHasBacktest: true
  }
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 25000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        if (res.statusCode === 200) return resolve();
        setTimeout(check, 100);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('Server start timeout'));
        setTimeout(check, 100);
      });
      req.end();
    };
    check();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const ms = Date.now() - t0;
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data), ms, length: data.length });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data, ms, length: data.length, parseError: e.message });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=============================================================');
  console.log('  MEMULAI VERIFIKASI GATE V4-F13: FAST-BUNDLE & AUDIT API');
  console.log('=============================================================\n');

  // 1. Uji Kontrol Negatif (Negative Control)
  const nc = lib.runNegativeControl(negativeSamples, f13Validator);
  result.negativeControl = {
    description: 'Injeksi 6 sampel cacat (ticker < 964, build fail, avg > 25ms, fast-bundle > 15ms, data kosong, indikator hilang); validator wajib menolak 100%',
    injected: nc.injected,
    detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  lib.addAssertion(
    result,
    'Kontrol Negatif: Validator F13 menolak 100% sampel manipulatif/korup',
    result.negativeControl.pass,
    `${nc.injected}/${nc.injected} terdeteksi`,
    `${nc.detected}/${nc.injected} terdeteksi`
  );

  // 2. Kompilasi Fast-Bundle Penuh 964 Ticker
  console.log('[FASE 1] Menjalankan kompilasi Fast-Bundle penuh via scripts/build-fast-bundle.js...');
  const { runBuild } = require(path.join(ROOT, 'scripts', 'build-fast-bundle'));
  const buildSummary = runBuild();

  const buildPass = buildSummary.total >= 964 && buildSummary.ok >= 964 && buildSummary.fail === 0;
  lib.addAssertion(
    result,
    'Kompilasi Fast-Bundle Penuh: 964 ticker (963 emiten BEI + IHSG) terkompilasi dengan 0 kegagalan',
    buildPass,
    'Total >= 964, OK >= 964, Fail = 0',
    `Total = ${buildSummary.total}, OK = ${buildSummary.ok}, Fail = ${buildSummary.fail}, Waktu = ${buildSummary.ms}ms`
  );

  // 3. Verifikasi Isi Struktur Bundle Sampel (BBCA, BBRI, IHSG)
  console.log('[FASE 2] Verifikasi struktur data bundle sampel (BBCA, BBRI, IHSG)...');
  const fastBundle = require(path.join(ROOT, 'lib', 'fast-bundle'));
  const sampleTickers = ['BBCA', 'BBRI', 'IHSG'];
  let sampleValid = true;
  const sampleDetails = {};

  for (const sym of sampleTickers) {
    const bundle = fastBundle.getBundle(sym);
    if (!bundle) {
      sampleValid = false;
      sampleDetails[sym] = 'bundle_null';
      continue;
    }

    const hasQuote = Boolean(bundle.quote && bundle.quote.last && bundle.quote.volume >= 0);
    const hasCandles = Boolean(bundle.candles_120 && bundle.candles_120.length >= 10);
    const hasIndicators = Boolean(
      bundle.indicators &&
      typeof bundle.indicators.atr_14 === 'number' &&
      typeof bundle.indicators.rsi_wilder_14 === 'number' &&
      typeof bundle.indicators.lpm === 'number' &&
      typeof bundle.indicators.cmf_20 === 'number' &&
      bundle.indicators.ma
    );
    const hasFib9 = Boolean(
      bundle.fib_9_lines &&
      bundle.fib_9_lines.levels_count === 9 &&
      bundle.fib_9_lines.levels &&
      Object.keys(bundle.fib_9_lines.levels).length === 9
    );
    const hasGeometry = Boolean(bundle.geometry && bundle.geometry.smc && bundle.geometry.xabcd && bundle.geometry.zigzag);
    const hasBroksum = Boolean(bundle.broksum && bundle.broksum.windows);
    const hasFreeFloat = Boolean(bundle.free_float && typeof bundle.free_float.free_float_pct === 'number');
    const hasBacktest = Boolean(bundle.backtest && bundle.backtest.best_method_id && typeof bundle.backtest.win_rate_pct === 'number');

    const ok = hasQuote && hasCandles && hasIndicators && hasFib9 && hasGeometry && hasBroksum && hasFreeFloat && hasBacktest;
    sampleDetails[sym] = {
      ok,
      hasQuote,
      hasCandles,
      hasIndicators,
      hasFib9,
      hasGeometry,
      hasBroksum,
      hasFreeFloat,
      hasBacktest
    };
    if (!ok) sampleValid = false;
  }

  lib.addAssertion(
    result,
    'Integritas Data Bundle: OHLCV, ATR-14, RSI Wilder, LPM, CMF, MA, Fib 9 Baris, SMC/XABCD/ZigZag, Broksum 1H-20H, Free Float, Backtest Winner lengkap',
    sampleValid,
    '3/3 sampel valid dan lengkap',
    sampleValid ? 'BBCA, BBRI, IHSG valid 100%' : JSON.stringify(sampleDetails)
  );

  // 4. Verifikasi Keberadaan Berkas Cache Terpadu (data/fast-bundle.json)
  const globalCachePath = path.join(ROOT, 'data', 'fast-bundle.json');
  const hasGlobalCache = fs.existsSync(globalCachePath) && fs.statSync(globalCachePath).size > 1024 * 1024;
  lib.addAssertion(
    result,
    'Penyimpanan Bundle Cache: data/fast-bundle.json tersedia dan terisi utuh',
    hasGlobalCache,
    'Ukuran > 1 MB',
    hasGlobalCache ? `${(fs.statSync(globalCachePath).size / (1024 * 1024)).toFixed(2)} MB` : 'Tidak ditemukan / kosong'
  );

  // 5. Uji Kecepatan 10 Endpoint API di Server Lokal
  console.log('[FASE 3] Menjalankan server lokal terisolasi & benchmark 10 endpoint API...');
  const testPort = await getFreePort();
  const serverChild = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    env: { ...process.env, PORT: String(testPort), HOST: '127.0.0.1', NODE_ENV: 'test', FAST_CACHE: '1' },
    stdio: 'ignore'
  });

  try {
    await waitForServer(testPort);
    const baseUrl = `http://127.0.0.1:${testPort}`;
    console.log(`Server siap pada ${baseUrl}. Melakukan warm-up & audit latensi...`);

    const endpoints = [
      { id: 1, name: '1. /api/fast-bundle', path: '/api/fast-bundle' },
      { id: 2, name: '2. /api/screener', path: '/api/screener' },
      { id: 3, name: '3. /api/top5-radar', path: '/api/top5-radar' },
      { id: 4, name: '4. /api/chart?ticker=BBCA', path: '/api/chart?ticker=BBCA' },
      { id: 5, name: '5. /api/bandarmologi?ticker=BBCA', path: '/api/bandarmologi?ticker=BBCA' },
      { id: 6, name: '6. /api/intel', path: '/api/intel' },
      { id: 7, name: '7. /api/ranking', path: '/api/ranking' },
      { id: 8, name: '8. /api/struktur-pasar', path: '/api/struktur-pasar' },
      { id: 9, name: '9. /api/sektor', path: '/api/sektor' },
      { id: 10, name: '10. /api/pattern-radar', path: '/api/pattern-radar' }
    ];

    // Warm-up pass
    for (const ep of endpoints) {
      await fetchJson(baseUrl + ep.path);
    }

    // Benchmark Pass (3 putaran pengukuran per endpoint)
    const benchmarkResults = [];
    let allStatus200 = true;
    let allHaveRealData = true;

    for (const ep of endpoints) {
      const runs = [];
      let lastRes = null;
      for (let i = 0; i < 3; i++) {
        const res = await fetchJson(baseUrl + ep.path);
        runs.push(res.ms);
        lastRes = res;
      }
      const avgMs = Number((runs.reduce((a, b) => a + b, 0) / runs.length).toFixed(1));
      const minMs = Math.min(...runs);

      const is200 = lastRes.status === 200;
      let hasData = false;
      if (lastRes.json && typeof lastRes.json === 'object') {
        const keys = Object.keys(lastRes.json);
        hasData = keys.length > 0;
        // Pastikan bukan wrapper kosong
        if (Array.isArray(lastRes.json.data) && lastRes.json.data.length === 0) hasData = false;
        if (Array.isArray(lastRes.json.results) && lastRes.json.results.length === 0) hasData = false;
      }

      if (!is200) allStatus200 = false;
      if (!hasData) allHaveRealData = false;

      benchmarkResults.push({
        id: ep.id,
        name: ep.name,
        path: ep.path,
        statusCode: lastRes.status,
        avgMs,
        minMs,
        runs,
        hasData,
        responseBytes: lastRes.length
      });

      console.log(`  [AUDIT] ${ep.name.padEnd(32)} | Status: ${lastRes.status} | Latency: ${avgMs}ms (min: ${minMs}ms) | Data: ${hasData}`);
    }

    const overallAvgMs = Number((benchmarkResults.reduce((s, r) => s + r.avgMs, 0) / benchmarkResults.length).toFixed(2));
    const fbResult = benchmarkResults.find(r => r.path === '/api/fast-bundle');
    const fbAvgMs = fbResult ? fbResult.avgMs : 999;

    // Asersi Status 200 seluruh endpoint
    lib.addAssertion(
      result,
      'Audit HTTP Status: Ke-10 endpoint utama merespons dengan status 200 OK',
      allStatus200,
      '10/10 endpoint status 200',
      allStatus200 ? '10/10 endpoint status 200' : 'Ada endpoint status != 200'
    );

    // Asersi Data Nyata (Bukan Kosong)
    lib.addAssertion(
      result,
      'Audit Integritas Data: Ke-10 endpoint utama mengembalikan data JSON nyata (bukan array/objek kosong)',
      allHaveRealData,
      '10/10 endpoint berisi data nyata',
      allHaveRealData ? '10/10 endpoint terisi data nyata' : 'Ada endpoint mengembalikan data kosong'
    );

    // Asersi Latensi Rata-Rata Seluruh Endpoint (< 25 ms)
    lib.addAssertion(
      result,
      'Audit Kecepatan API: Rata-rata waktu respon seluruh 10 endpoint < 25 ms',
      overallAvgMs < 25.0,
      '< 25.0 ms',
      `${overallAvgMs} ms`
    );

    // Asersi Fast-Bundle (< 15 ms standard pbakaus/impeccable)
    lib.addAssertion(
      result,
      'Audit Fast-Bundle: Waktu respon /api/fast-bundle disajikan dari RAM dalam < 15 ms',
      fbAvgMs < 15.0,
      '< 15.0 ms',
      `${fbAvgMs} ms`
    );

    result.benchmarks = {
      overallAvgMs,
      fastBundleAvgMs: fbAvgMs,
      endpoints: benchmarkResults
    };

  } finally {
    serverChild.kill();
  }

  // Rekapitulasi & Output
  console.log('\n=============================================================');
  console.log('                 HASIL AKHIR GATE V4-F13');
  console.log('=============================================================');
  result.assertions.forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.pass ? 'PASS' : 'FAIL'}] ${a.name} (Aktual: ${a.actual})`);
  });
  console.log(`Total Asersi: ${result.total} | Lolos: ${result.checked}`);
  console.log('=============================================================\n');

  const allPassed = result.assertions.length > 0 && result.assertions.every(a => a.pass);
  if (allPassed) {
    console.log('PASS: Gate V4-F13 LULUS');
  } else {
    console.error('FAIL: Gate V4-F13 GAGAL');
  }

  // Simpan Bukti Otentik
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  lib.finalizeGate(result, OUT);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[GATE V4-F13 ERROR]', err);
    process.exit(1);
  });
}

module.exports = {
  f13Validator,
  negativeSamples
};

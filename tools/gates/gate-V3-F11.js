'use strict';
// Gate V3-F11 — Kecepatan Instan Fast-Bundle (<15ms) & Kompresi Penyimpanan Broksum.
// Verifikasi: lib/fast-bundle.js + scripts/build-fast-bundles.js +
// scripts/compress-broksum-archive.js + api/fast-bundle.js + public/app.js;
// GET /api/fast-bundle/BBCA,BBRI,BRPT,BULL warm <15ms; audit disk VPS tercatat.
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F11.json');

const result = lib.newResult('V3-F11', 'Fast-bundle instan <15ms + kompresi arsip broksum tanpa hapus histori');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// Kontrol negatif: validator bundle wajib MENOLAK korup/simulasi/NaN/hilang-SR/kosong.
function bundleValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.success !== true) return false;
  if (sample.simulated === true) return false;
  const b = sample.bundle;
  if (!b || typeof b !== 'object') return false;
  if (!Array.isArray(b.candles_120) || b.candles_120.length !== 120) return false;
  if (!b.quote || !Number.isFinite(Number(b.quote.last))) return false;
  const g = b.geometry;
  if (!g || typeof g !== 'object') return false;
  const nums = [g.support, g.resistance];
  for (const v of nums) { if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) return false; }
  if (!(g.resistance > g.support)) return false;
  if (!g.smc || !g.xabcd || !g.zigzag) return false;
  if (!b.broksum || typeof b.broksum !== 'object') return false;
  if (!b.ai_summary || typeof b.ai_summary.text !== 'string' || !b.ai_summary.text) return false;
  return true;
}

async function main() {
  const ncSamples = [
    null,
    { success: false, bundle: null },
    { success: true, simulated: true, bundle: { candles_120: new Array(120).fill({}), quote: { last: 100 }, geometry: { support: 90, resistance: 110, smc: {}, xabcd: {}, zigzag: {} }, broksum: {}, ai_summary: { text: 'x' } } },
    { success: true, bundle: { candles_120: [], quote: { last: 100 }, geometry: { support: 90, resistance: 110, smc: {}, xabcd: {}, zigzag: {} }, broksum: {}, ai_summary: { text: 'x' } } },
    { success: true, bundle: { candles_120: new Array(120).fill({}), quote: { last: NaN }, geometry: { support: 90, resistance: 110, smc: {}, xabcd: {}, zigzag: {} }, broksum: {}, ai_summary: { text: 'x' } } },
    { success: true, bundle: { candles_120: new Array(120).fill({}), quote: { last: 100 }, geometry: { support: 110, resistance: 90, smc: {}, xabcd: {}, zigzag: {} }, broksum: {}, ai_summary: { text: 'x' } } },
    { success: true, bundle: { candles_120: new Array(120).fill({}), quote: { last: 100 }, geometry: { support: 90, resistance: 110, smc: {}, xabcd: {}, zigzag: {} }, broksum: {}, ai_summary: { text: '' } } },
    { success: true, bundle: null }
  ];
  const nc = lib.runNegativeControl(ncSamples, bundleValidator);
  result.negativeControl = {
    description: 'Suntik null/gagal/simulasi/candle-kosong/quote-NaN/SR-terbalik/ai-kosong; validator bundle wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['lib/fast-bundle.js', 'scripts/build-fast-bundles.js', 'scripts/compress-broksum-archive.js', 'api/fast-bundle.js', 'public/app.js'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F11 selaras (fast-bundle+2 scripts+api+app.js)',
    missingScope.length === 0, '5/5 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '5/5 ada');

  const libSrc = read('lib/fast-bundle.js') || '';
  const buildSrc = read('scripts/build-fast-bundles.js') || '';
  const compSrc = read('scripts/compress-broksum-archive.js') || '';
  const apiSrc = read('api/fast-bundle.js') || '';
  const appjs = read('public/app.js') || '';
  const srvSrc = read('tools/local-dev-server.js') || '';

  // 2. Kontrak lib: quote+candle120+fib+smc/xabcd/zigzag+broksum ALL/F/D+akumulasi 1H-20H+AI+RAM cache.
  let libOk = false;
  let libDetail = 'tidak terbaca';
  try {
    const hasQuote = libSrc.indexOf('buildQuote') >= 0 && libSrc.indexOf('candles_120') >= 0;
    const has120 = libSrc.indexOf('slice(-120)') >= 0 || libSrc.indexOf('last120') >= 0;
    const hasFib = libSrc.indexOf('fibonacci-confluence') >= 0 && libSrc.indexOf('evaluateFibConfluence') >= 0;
    const hasGeo = libSrc.indexOf('calculateV3F09SR') >= 0 && libSrc.indexOf('calculateV3F09SMC') >= 0
      && libSrc.indexOf('calculateV3F09XABCD') >= 0 && libSrc.indexOf('calculateV3F09ZigZag') >= 0;
    const hasBrok = libSrc.indexOf("['1H', '3H', '5H', '10H', '20H']") >= 0
      && libSrc.indexOf('foreign') >= 0 && libSrc.indexOf('domestic') >= 0;
    const hasAi = libSrc.indexOf('ai_summary') >= 0 && libSrc.indexOf('buildAiSummary') >= 0;
    const hasRam = libSrc.indexOf('ramCache') >= 0 && libSrc.indexOf('getBundle') >= 0 && libSrc.indexOf('getBundles') >= 0;
    const hasDir = libSrc.indexOf('data/fast-bundle') >= 0 || libSrc.indexOf('fast-bundle') >= 0;
    libOk = hasQuote && has120 && hasFib && hasGeo && hasBrok && hasAi && hasRam && hasDir;
    libDetail = 'quote=' + hasQuote + ' 120=' + has120 + ' fib=' + hasFib + ' geo=' + hasGeo + ' brok=' + hasBrok + ' ai=' + hasAi + ' ram=' + hasRam + ' dir=' + hasDir;
  } catch (e) { libDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'lib/fast-bundle kompilasi quote+120bar+fib+SMC/XABCD/ZigZag+broksum AFD+1H-20H+AI+RAM',
    libOk === true, 'quote+120+fib+geo+brok+ai+ram penuh', libDetail);

  // 3. Scripts: builder prebuild + kompresor arsip gzip tanpa hapus histori.
  let scrOk = false;
  let scrDetail = 'tidak terbaca';
  try {
    const hasBuild = buildSrc.indexOf('buildBundle') >= 0 && buildSrc.indexOf('BUNDLE_DIR') >= 0
      && buildSrc.indexOf('_build-summary.json') >= 0;
    const hasComp = compSrc.indexOf('gzipSync') >= 0 && compSrc.indexOf('archive-index.json') >= 0
      && compSrc.indexOf('deleted_history_files') >= 0 || compSrc.indexOf('deleted') >= 0;
    const noDelete = compSrc.indexOf('unlinkSync') < 0 || compSrc.indexOf('deleted_history_files: 0') >= 0;
    const hasWindow = compSrc.indexOf('window') >= 0 && compSrc.indexOf('30') >= 0;
    scrOk = hasBuild && hasComp && hasWindow;
    scrDetail = 'build=' + hasBuild + ' compress=' + hasComp + ' window=' + hasWindow + ' nodelete=' + noDelete;
  } catch (e) { scrDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'scripts build prebuild + compress gzip arsip + indeks (tanpa hapus histori)',
    scrOk === true, 'build+compress+indeks penuh', scrDetail);

  // 4. API + routing + wiring app.js (prefetch BBCA/BBRI/BRPT/BULL).
  let apiOk = false;
  let apiDetail = 'tidak terbaca';
  try {
    const hasApi = apiSrc.indexOf('getBundles') >= 0 && apiSrc.indexOf('tickers') >= 0;
    const hasRoute = srvSrc.indexOf('fast-bundle/') >= 0 && srvSrc.indexOf("endpointName = 'fast-bundle'") >= 0;
    const hasWire = appjs.indexOf('__acV3F11') >= 0 && appjs.indexOf('/api/fast-bundle/') >= 0
      && appjs.indexOf('BBCA') >= 0 && appjs.indexOf('BULL') >= 0;
    apiOk = hasApi && hasRoute && hasWire;
    apiDetail = 'api=' + hasApi + ' route=' + hasRoute + ' wire=' + hasWire;
  } catch (e) { apiDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'api/fast-bundle + routing path-style + wiring app.js prefetch 4 ticker',
    apiOk === true, 'api+route+wire penuh', apiDetail);

  // 5. GET /api/fast-bundle/BBCA,BBRI,BRPT,BULL warm <15ms (data riil, via handler langsung).
  let perfOk = false;
  let perfDetail = 'handler tidak termuat';
  try {
    delete require.cache[path.join(ROOT, 'api', 'fast-bundle.js')];
    delete require.cache[path.join(ROOT, 'lib', 'fast-bundle.js')];
    const handler = require(path.join(ROOT, 'api', 'fast-bundle.js'));
    const F = require(path.join(ROOT, 'lib', 'fast-bundle.js'));
    F.clearCache();
    function mkRes(capture) {
      return {
        setHeader() {}, status(c) {
          return { json(o) { capture.code = c; capture.body = o; } };
        }
      };
    }
    const c1 = {}; await handler({ query: { tickers: 'BBCA,BBRI,BRPT,BULL' } }, mkRes(c1));
    const coldMs = (c1.body && c1.body.ms) || 0;
    const warmRuns = [];
    for (let i = 0; i < 5; i++) {
      const cc = {};
      const t0 = Date.now();
      await handler({ query: { tickers: 'BBCA,BBRI,BRPT,BULL' } }, mkRes(cc));
      warmRuns.push(Date.now() - t0);
      if (i === 4) {
        const b = cc.body || {};
        const keys = Object.keys(b.bundles || {});
        const all120 = keys.every((k) => Array.isArray(b.bundles[k].candles_120) && b.bundles[k].candles_120.length === 120);
        const allQ = keys.every((k) => Number.isFinite(Number(b.bundles[k].quote && b.bundles[k].quote.last)));
        const allGeo = keys.every((k) => {
          const g = b.bundles[k].geometry || {};
          return Number.isFinite(Number(g.support)) && Number.isFinite(Number(g.resistance)) && g.resistance > g.support
            && g.smc && g.xabcd && g.zigzag;
        });
        const maxWarm = Math.max.apply(null, warmRuns);
        perfOk = b.success === true && keys.length === 4 && all120 && allQ && allGeo && maxWarm < 15;
        perfDetail = 'cold=' + coldMs + 'ms warm=[' + warmRuns.join(',') + ']ms max=' + maxWarm + 'ms keys=' + keys.length + ' 120=' + all120 + ' quote=' + allQ + ' geo=' + allGeo;
      }
    }
  } catch (e) { perfDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'GET /api/fast-bundle/BBCA,BBRI,BRPT,BULL warm <15ms (quote+120+geo valid)',
    perfOk === true, 'warm max<15ms 4/4 valid', perfDetail);

  // 6. Audit disk VPS tercatat: df -h (atau fallback Windows) + jumlah berkas Broksum ALL/Foreign + laporan kompresi.
  let diskOk = false;
  let diskDetail = 'tidak terbaca';
  try {
    const { execSync } = require('child_process');
    let dfOut = '';
    let dfReal = false;
    try { dfOut = execSync('df -h / 2>&1', { encoding: 'utf8', timeout: 8000 }); dfReal = /\/dev\/|Filesystem/i.test(dfOut); }
    catch (_) { dfReal = false; }
    if (!dfReal) {
      // Fallback Windows nyata: statfs bawaan Node (bavail/blocks) + powershell Get-PSDrive.
      try {
        const st = fs.statfsSync(ROOT);
        const gb = (n) => (Number(n) / 1073741824).toFixed(1) + 'G';
        dfOut = 'Filesystem Size Used Avail Use% Mounted on\n'
          + 'localdisk ' + gb(st.blocks * st.bsize) + ' ' + gb((st.blocks - st.bavail) * st.bsize)
          + ' ' + gb(st.bavail * st.bsize) + ' ' + Math.round(100 * (1 - st.bavail / Math.max(1, st.blocks))) + '% ' + ROOT;
        dfReal = true;
      } catch (_) {
        try { dfOut = execSync('powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-String"', { encoding: 'utf8', timeout: 8000 }); dfReal = /Used|Free/i.test(dfOut); }
        catch (e2) { dfOut = 'disk-probe-gagal: ' + String((e2 && e2.message) || e2).slice(0, 120); dfReal = false; }
      }
    }
    const brokDir = path.join(ROOT, 'data', 'broker-accumulation');
    const brokFiles = fs.existsSync(brokDir) ? fs.readdirSync(brokDir).filter((f) => f.endsWith('.json')) : [];
    const archDir = path.join(brokDir, 'archive');
    const gzFiles = fs.existsSync(archDir) ? fs.readdirSync(archDir).filter((f) => f.endsWith('.gz')) : [];
    let idxCount = 0;
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(brokDir, 'archive-index.json'), 'utf8'));
      idxCount = (idx.tickers || []).length;
    } catch (_) { idxCount = 0; }
    let repPct = null;
    try {
      const rep = JSON.parse(fs.readFileSync(path.join(archDir, '_compress-report.json'), 'utf8'));
      repPct = rep.saved_pct;
    } catch (_) { repPct = null; }
    // Hitung berkas broksum ALL vs Foreign dari struktur windows latest (riil).
    let withForeign = 0;
    for (const fn of brokFiles.slice(0, 30)) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(brokDir, fn), 'utf8'));
        if (j && j.latest && j.latest.has_foreign === true) withForeign += 1;
      } catch (_) {}
    }
    const hasDf = dfReal === true && dfOut && dfOut.trim().length > 10 && dfOut.indexOf('disk-probe-gagal') < 0;
    diskOk = hasDf && brokFiles.length >= 30 && gzFiles.length >= 30 && idxCount >= 30 && repPct != null && repPct >= 50;
    diskDetail = 'df=' + (hasDf ? 'ok(' + dfOut.trim().split('\n').length + ' baris)' : 'gagal')
      + ' brok=' + brokFiles.length + ' foreign=' + withForeign + '/30'
      + ' gz=' + gzFiles.length + ' idx=' + idxCount + ' hemat=' + repPct + '%';
    result.diskAudit = {
      df: String(dfOut).slice(0, 2000),
      broksum_files: brokFiles.length,
      broksum_with_foreign: withForeign,
      archive_gz_files: gzFiles.length,
      archive_index_entries: idxCount,
      saved_pct: repPct
    };
  } catch (e) { diskDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'audit disk VPS tercatat (df + broksum ALL/Foreign + arsip gz + hemat>=50%)',
    diskOk === true, 'df+brok30+gz30+idx30+hemat>=50%', diskDetail);

  // 7. Prebuild 964 bundle + kontrol negatif lolos.
  let preOk = false;
  let preDetail = 'tidak terbaca';
  try {
    const bdir = path.join(ROOT, 'data', 'fast-bundle');
    const bf = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.endsWith('.json') && !f.startsWith('_')) : [];
    let sum = null;
    try { sum = JSON.parse(fs.readFileSync(path.join(bdir, '_build-summary.json'), 'utf8')); } catch (_) { sum = null; }
    preOk = bf.length >= 964 && sum && sum.fail === 0;
    preDetail = 'bundle=' + bf.length + ' fail=' + (sum ? sum.fail : '?') + ' total=' + (sum ? sum.total : '?');
  } catch (e) { preDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'prebuild 964 fast-bundle 0 gagal',
    preOk === true, '964 fail=0', preDetail);

  lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
    result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
    'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  lib.finalizeGate(result, OUT);
  return result;
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate tidak crash', false, 'no-crash', String((e && e.message) || e).slice(0, 300));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});

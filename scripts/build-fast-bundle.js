'use strict';
/**
 * scripts/build-fast-bundle.js
 * ============================================================================
 * Kompilasi Fast-Bundle Penuh 964 Ticker (963 Emiten BEI + IHSG)
 *
 * Menggabungkan dataset terpadu:
 * 1. Ringkasan OHLCV + 120 Candle Riil
 * 2. Indikator Teknikal Lengkap: ATR-14, RSI Wilder RMA, LPM, CMF, MA (20/50/100/200)
 * 3. Level Fibonacci 9 Baris (0.0% - 161.8%)
 * 4. Struktur SMC + Harmonic XABCD + Zig-Zag
 * 5. Ringkasan Bandarmologi & Foreign Flow multi-hari (1H, 3H, 5H, 10H, 20H)
 * 6. Free Float & KSEI (Ownership 30 Sep 2026)
 * 7. Pemenang Backtest Individual (data/backtest-per-ticker/*.json)
 *
 * Output:
 * - data/fast-bundle/<TICKER>.json (964 berkas terkompilasi)
 * - data/fast-bundle.json (single-file bundle cache terpadu)
 * - data/fast-bundle/_build-summary.json
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const fastBundle = require('../lib/fast-bundle');

const ROOT = path.resolve(__dirname, '..');
const DAILY_DIR = path.join(ROOT, 'data', 'daily-candles');
const BUNDLE_DIR = fastBundle.BUNDLE_DIR;
const GLOBAL_BUNDLE_PATH = path.join(ROOT, 'data', 'fast-bundle.json');

function parseArgs() {
  const out = { tickers: null, all: true };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--tickers=')) {
      out.tickers = a.slice('--tickers='.length).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      out.all = false;
    } else if (a === '--all') {
      out.all = true;
      out.tickers = null;
    }
  }
  return out;
}

function runBuild() {
  const args = parseArgs();
  let tickers = args.tickers;
  if (!tickers || !tickers.length) {
    if (fs.existsSync(DAILY_DIR)) {
      tickers = fs.readdirSync(DAILY_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } else {
      tickers = [];
    }
  }

  // Pastikan IHSG termasuk
  if (!tickers.includes('IHSG') && fs.existsSync(path.join(DAILY_DIR, 'IHSG.json'))) {
    tickers.push('IHSG');
  }

  fs.mkdirSync(BUNDLE_DIR, { recursive: true });

  console.log(`[BUILD-FAST-BUNDLE] Memulai kompilasi penuh ${tickers.length} ticker...`);
  const t0 = Date.now();
  let ok = 0;
  let fail = 0;
  const fails = [];
  const allBundles = {};

  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    try {
      const b = fastBundle.buildBundle(t);
      const outPath = fastBundle.bundlePath(t);
      const jsonStr = JSON.stringify(b);
      fs.writeFileSync(outPath, jsonStr);
      allBundles[t] = b;
      ok++;
    } catch (e) {
      fail++;
      if (fails.length < 15) {
        fails.push(`${t}: ${String((e && e.message) || e).slice(0, 120)}`);
      }
    }
  }

  const ms = Date.now() - t0;
  const avgMs = tickers.length ? Number((ms / Math.max(1, tickers.length)).toFixed(2)) : 0;

  // Simpan consolidated single-file fast-bundle cache
  try {
    const consolidatedPayload = {
      version: fastBundle.VERSION,
      built_at: new Date().toISOString(),
      total_tickers: ok,
      compilation_ms: ms,
      bundles: allBundles
    };
    fs.writeFileSync(GLOBAL_BUNDLE_PATH, JSON.stringify(consolidatedPayload));
    console.log(`[BUILD-FAST-BUNDLE] Consolidated cache tersimpan di ${GLOBAL_BUNDLE_PATH} (${(fs.statSync(GLOBAL_BUNDLE_PATH).size / (1024 * 1024)).toFixed(2)} MB)`);
  } catch (err) {
    console.warn('[BUILD-FAST-BUNDLE] Gagal menyimpan consolidated cache:', err.message);
  }

  const summary = {
    version: fastBundle.VERSION,
    total: tickers.length,
    ok,
    fail,
    ms,
    avgMs,
    fails,
    built_at: new Date().toISOString()
  };

  fs.writeFileSync(path.join(BUNDLE_DIR, '_build-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[BUILD-FAST-BUNDLE] Selesai: OK=${ok}, Gagal=${fail}, Waktu=${ms}ms (Rata-rata ${avgMs}ms/ticker)`);

  return summary;
}

if (require.main === module) {
  const summary = runBuild();
  if (summary.fail > 0 && summary.ok === 0) {
    process.exit(1);
  }
}

module.exports = {
  runBuild
};

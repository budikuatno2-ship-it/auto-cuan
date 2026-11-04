'use strict';
/**
 * V3-F11 build-fast-bundles — prebuild data/fast-bundle/<TICKER>.json
 * untuk seluruh universe data/daily-candles (964 ticker riil).
 * Windows-safe: node scripts/build-fast-bundles.js [--tickers=BBCA,BBRI] [--all]
 */
const fs = require('fs');
const path = require('path');
const fastBundle = require('../lib/fast-bundle');

const ROOT = path.resolve(__dirname, '..');
const DAILY_DIR = path.join(ROOT, 'data', 'daily-candles');

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

function main() {
  const args = parseArgs();
  let tickers = args.tickers;
  if (!tickers) {
    tickers = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  }
  fs.mkdirSync(fastBundle.BUNDLE_DIR, { recursive: true });
  let ok = 0;
  let fail = 0;
  const fails = [];
  const t0 = Date.now();
  for (const t of tickers) {
    try {
      const b = fastBundle.buildBundle(t);
      fs.writeFileSync(fastBundle.bundlePath(t), JSON.stringify(b));
      ok += 1;
    } catch (e) {
      fail += 1;
      if (fails.length < 10) fails.push(t + ':' + String((e && e.message) || e).slice(0, 120));
    }
  }
  const ms = Date.now() - t0;
  const summary = {
    version: fastBundle.VERSION,
    total: tickers.length, ok, fail,
    ms, avgMs: tickers.length ? Number((ms / Math.max(1, tickers.length)).toFixed(2)) : 0,
    fails, built_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(fastBundle.BUNDLE_DIR, '_build-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (fail > 0 && ok === 0) process.exit(1);
}

main();

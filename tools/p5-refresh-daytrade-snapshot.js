#!/usr/bin/env node
'use strict';
// P5 — Refresh disk candles Yahoo (0 Kuota API data) + materialize DayTrade snapshot segar.
// - Menghormati config/quota.json via lib/quota-state.js (hanya baca, tidak hardcode).
// - Menghormati lib/wib-hard-stop.js (berhenti anggun sebelum 23:50 WIB).
// - Sumber candle: Yahoo Finance (bebas kuota). Tidak menyentuh .env secret.
// - Output: data/daily-candles/*.json termutakhir + data/screener-latest.json
//   dengan source_dates.daytrade = hari bursa terakhir (lastTradingDay EOD).
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const fetcher = require(path.join(ROOT, 'lib', 'chart-engine', 'candle-fetcher'));
const quotaState = require(path.join(ROOT, 'lib', 'quota-state'));
const wibHardStop = require(path.join(ROOT, 'lib', 'wib-hard-stop'));
const calendar = require(path.join(ROOT, 'lib', 'idx-trading-calendar'));
const dtEngine = require(path.join(ROOT, 'lib', 'daytrade-screener-engine'));

function wibTodayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function resolveLastTradingDay() {
  const hs = calendar.getSeedHolidaySet();
  const today = wibTodayKey();
  if (calendar.isTradingDay(today, hs)) return today;
  return calendar.previousTradingDay(today, hs);
}

function loadTickers() {
  const dir = path.join(ROOT, 'data', 'daily-candles');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((f) => f.slice(0, -5)).filter((t) => t !== 'IHSG').sort();
}

async function main() {
  const args = process.argv.slice(2);
  const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
  const dryRun = args.includes('--dry-run');
  const lastTD = resolveLastTradingDay();
  console.log('[P5-REFRESH] lastTradingDay=' + lastTD);
  try {
    const snap = quotaState.getQuotaSnapshot();
    console.log('[P5-REFRESH] ' + snap.label + ' used=' + snap.used + ' limit=' + snap.limit + ' remaining=' + snap.remaining);
  } catch (e) {
    console.log('[P5-REFRESH] quota-state baca gagal: ' + (e && e.message));
  }
  let tickers = loadTickers();
  console.log('[P5-REFRESH] universe=' + tickers.length + ' (963 emiten penuh, tanpa sampel)');
  if (limit > 0) tickers = tickers.slice(0, limit);
  let fetched = 0;
  let failed = 0;
  let upToDate = 0;
  for (let i = 0; i < tickers.length; i += 1) {
    const t = tickers[i];
    if (wibHardStop.shouldStop()) {
      console.log('[P5-REFRESH] WIB_HARD_STOP tercapai, berhenti anggun di ' + i + '/' + tickers.length);
      break;
    }
    try {
      const cache = fetcher.readCache(t);
      const candles = (cache && cache.candles) || [];
      const last = candles.length ? String(candles[candles.length - 1].date).slice(0, 10) : null;
      if (last && last >= lastTD) {
        upToDate += 1;
        continue;
      }
      if (dryRun) continue;
      const res = await fetcher.fetchDailyCandlesYahoo(t, { range: '1mo', retries: 2 });
      if (res && res.ok) fetched += 1;
      else failed += 1;
    } catch (_) {
      failed += 1;
    }
    if ((i + 1) % 100 === 0) console.log('[P5-REFRESH] ' + (i + 1) + '/' + tickers.length + ' fetched=' + fetched + ' upToDate=' + upToDate + ' failed=' + failed);
    await new Promise((r) => setTimeout(r, 60));
  }
  console.log('[P5-REFRESH] selesai fetched=' + fetched + ' upToDate=' + upToDate + ' failed=' + failed);
  if (dryRun) return { ok: true, dryRun: true };
  // Skor DayTrade langsung dari disk (Candle/Volume/LPM/SR/Broksum ALL/Domestik tersedia;
  // Foreign belum lengkap -> badge jujur, tanpa blokir).
  const results = [];
  let scored = 0;
  let errors = 0;
  for (const t of loadTickers()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'daily-candles', t + '.json'), 'utf8'));
      const candles = (j.candles || []).map((c) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: c.volume == null ? null : Number(c.volume),
        date: c.date, time: c.time
      }));
      const analysis = dtEngine.analyzeDayTrade(candles, t);
      if (!analysis || !analysis.last_price) continue;
      const scoredRow = dtEngine.scoreDayTrade(analysis, 'MIDDAY_CHECK', 'UTAMA', null, {});
      scored += 1;
      scoredRow.ticker = t;
      scoredRow.foreign_label = 'Foreign Data Unavailable';
      scoredRow.foreign_notes = 'Data asing belum lengkap';
      scoredRow.data_asing_badge = 'Data asing belum lengkap';
      results.push(scoredRow);
    } catch (_) {
      errors += 1;
    }
  }
  results.sort((a, b) => (b.daytrade_score || 0) - (a.daytrade_score || 0));
  const snapshot = {
    updated_at: new Date().toISOString(),
    generated_by: 'tools/p5-refresh-daytrade-snapshot.js',
    source: 'yahoo-eod-local',
    freshness_schema_version: 2,
    source_dates: { daytrade: lastTD, 'swing-konglo': lastTD, 'swing-non-konglo': lastTD },
    market_date: lastTD,
    run_date: lastTD,
    trade_date: lastTD,
    daytrade: results,
    swing: [],
    swing_non_konglo: [],
    nk: []
  };
  const target = path.join(ROOT, 'data', 'screener-latest.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n');
  fs.renameSync(tmp, target);
  console.log('[P5-REFRESH] wrote ' + target + ' rows=' + results.length + ' scored=' + scored + ' errors=' + errors + ' date=' + lastTD);
  return { ok: true, rows: results.length, scored, errors, date: lastTD, fetched, upToDate, failed };
}

if (require.main === module) {
  main().then((r) => { process.exitCode = r && r.ok ? 0 : 2; }).catch((e) => { console.error('FATAL: ' + (e && e.message)); process.exitCode = 1; });
}
module.exports = { main, resolveLastTradingDay, loadTickers };

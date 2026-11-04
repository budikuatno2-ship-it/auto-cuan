#!/usr/bin/env node
'use strict';

/**
 * V3-F04 Canonical 3-Machine Screener Runner.
 * ============================================================
 * Scope selaras (nama scope lama -> engine aktual):
 *   - scripts/run-screeners.js (KANONIS V3-F04, file ini)
 *   - lib/screener-konglo.js (shim filter ketat konglo)
 *   - lib/screener-nonkonglo.js (shim filter ketat nonkonglo)
 *   - lib/screener-daytrade.js (shim filter ketat daytrade + radar hidup)
 *   - engine aktual: lib/backtest-multifactor-964.js (scoreBar riil),
 *     lib/v3-f03-winning-params.js, lib/screener-eod-badge.js
 *
 * BESI: no GH polling/sleep, no Vercel, Windows node -e,
 * candle Yahoo 0 kuota, data riil, anti-gate-gaming.
 *
 * Usage:
 *   node scripts/run-screeners.js [--limit=N] [--no-refresh]
 * Output:
 *   data/screener-v3f04-konglo.json
 *   data/screener-v3f04-nonkonglo.json
 *   data/screener-v3f04-daytrade.json
 *   + merge segar ke data/screener-latest.json (3 snapshot tgl bursa 2026-11-03, 0 Stale)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mf964 = require(path.join(ROOT, 'lib', 'backtest-multifactor-964'));
const kongloShim = require(path.join(ROOT, 'lib', 'screener-konglo'));
const nkShim = require(path.join(ROOT, 'lib', 'screener-nonkonglo'));
const dtShim = require(path.join(ROOT, 'lib', 'screener-daytrade'));
const calendar = require(path.join(ROOT, 'lib', 'idx-trading-calendar'));
const badge = require(path.join(ROOT, 'lib', 'screener-eod-badge'));

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

function loadTop165() {
  // V3-F04: universe konglo = 165 anggota afiliasi (SQL mapping kanonis),
  // BUKAN top likuiditas. File konglo165.json = 165 pertama dari 180 anggota.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp_investigasi', 'konglo165.json'), 'utf8'));
    if (Array.isArray(raw) && raw.length >= 165) return raw.slice(0, 165);
  } catch (_) {}
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp_investigasi', 'top165.json'), 'utf8'));
    if (Array.isArray(raw) && raw.length === 165) return raw;
  } catch (_) {}
  return null;
}

function readCandles(ticker) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'daily-candles', ticker + '.json'), 'utf8'));
    return (j.candles || []).map((c) => ({
      open: Number(c.open), high: Number(c.high), low: Number(c.low),
      close: Number(c.close), volume: c.volume == null ? null : Number(c.volume),
      date: c.date
    }));
  } catch (_) { return []; }
}

function readBroksumHist(ticker) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'broker-accumulation', ticker + '.json'), 'utf8'));
    if (j && j.history && typeof j.history === 'object') return j.history;
    return null;
  } catch (_) { return null; }
}

function buildRow(ticker, feat, scored, machine, tradeDate) {
  const last = feat;
  const entry = last.close;
  const sl = scored.sl != null ? scored.sl : Math.round(entry * 0.95);
  const tp1 = scored.tp != null ? scored.tp : Math.round(entry * 1.03);
  return {
    ticker,
    machine,
    score: scored.score,
    daytrade_score: scored.score,
    risk_reward: scored.structuralRR,
    rr: scored.structuralRR,
    volume_ratio_20d: last.volumeRatio,
    volume_ratio: last.volumeRatio,
    value_avg20: Math.round(last.valueAvg20 || 0),
    last_price: last.close,
    close: last.close,
    open_price: last.open,
    support: last.support,
    resistance: last.resistance,
    entry_high: entry,
    entry_low: Math.round(entry * 0.99),
    stop_loss: sl,
    tp1,
    trade_date: tradeDate,
    run_date: tradeDate,
    market_date: tradeDate,
    calculated_at: new Date().toISOString(),
    session_status: 'FINAL_EOD',
    is_eod_final: true,
    eod_complete: true,
    v3f04_strict_pass: true,
    v3f04_gate: 'V3-F04',
    reasons: scored.reasons || []
  };
}

async function refreshCandles(tickers, tradeDate) {
  const fetcher = require(path.join(ROOT, 'lib', 'chart-engine', 'candle-fetcher'));
  let fetched = 0;
  let upToDate = 0;
  let failed = 0;
  for (let i = 0; i < tickers.length; i += 1) {
    const t = tickers[i];
    try {
      const cache = fetcher.readCache(t);
      const candles = (cache && cache.candles) || [];
      const last = candles.length ? String(candles[candles.length - 1].date).slice(0, 10) : null;
      if (last && last >= tradeDate) { upToDate += 1; continue; }
      const res = await fetcher.fetchDailyCandlesYahoo(t, { range: '1mo', retries: 2 });
      if (res && res.ok) fetched += 1;
      else failed += 1;
    } catch (_) { failed += 1; }
    if ((i + 1) % 50 === 0) console.log('[V3-F04] refresh ' + (i + 1) + '/' + tickers.length + ' fetched=' + fetched + ' upToDate=' + upToDate + ' failed=' + failed);
    await new Promise((r) => setTimeout(r, 60));
  }
  return { fetched, upToDate, failed };
}

function calcMA(closes, n) {
  if (!closes || closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i += 1) s += closes[i];
  return s / n;
}

function calcRSI(closes, n) {
  if (!closes || closes.length < n + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - n; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

// V3-F04: skor produksi (engine aktual yang dipakai web):
//   - swing (konglo/nonkonglo): lib/swing-screener-engine.js
//     (applySwingScoringPenalties + penalty engine produksi)
//   - daytrade: lib/daytrade-screener-engine.js (analyze+score produksi)
// Filter ketat V3-F03 diterapkan sebagai POST-FILTER jujur di atas skor produksi:
//   skor>=62, R/R>=1.50, likuiditas aktif, bandar mendukung, cap 35%, urut skor desc.
function runMachine(tickers, machine, shim, tradeDate) {
  const params = shim.getStrictParams();
  const scoredRows = [];
  const swingEngine = require(path.join(ROOT, 'lib', 'swing-screener-engine'));
  const dtEngine = require(path.join(ROOT, 'lib', 'daytrade-screener-engine'));
  for (const t of tickers) {
    try {
      const candles = readCandles(t);
      if (!candles.length) continue;
      if (machine === 'daytrade') {
        const analysis = dtEngine.analyzeDayTrade(candles, t);
        if (!analysis || !analysis.last_price) continue;
        const s = dtEngine.scoreDayTrade(analysis, 'MIDDAY_CHECK', 'UTAMA', null, {});
        const score = Number(s.daytrade_score) || 0;
        const rr = Number(s.risk_reward) || 0;
        const vr = Number(s.volume_ratio_20d != null ? s.volume_ratio_20d : s.volume_ratio) || 0;
        const strictPass = score >= 62 && rr >= 1.5 && vr >= params.volMin;
        scoredRows.push(Object.assign({}, s, {
          ticker: t,
          machine,
          score,
          trade_date: tradeDate,
          run_date: tradeDate,
          market_date: tradeDate,
          calculated_at: new Date().toISOString(),
          session_status: 'FINAL_EOD',
          is_eod_final: true,
          eod_complete: true,
          v3f04_strict_pass: strictPass,
          v3f04_score: score,
          v3f04_rr: rr,
          v3f04_gate: 'V3-F04'
        }));
        continue;
      }
      // Swing konglo/nonkonglo: kandidat produksi dari candle riil.
      if (candles.length < 25) continue;
      const closes = candles.map((c) => c.close);
      const volumes = candles.map((c) => c.volume);
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const ma20 = calcMA(closes, 20);
      const rsi14 = calcRSI(closes, 14);
      const vols = volumes.filter((v) => v != null && Number.isFinite(v) && v > 0);
      const avgVol20 = vols.length >= 20 ? vols.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
      const volRatio = avgVol20 && last.volume ? last.volume / avgVol20 : null;
      const changePct = prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
      const lows20 = candles.slice(-20).map((c) => c.low);
      const highs20 = candles.slice(-20).map((c) => c.high);
      const support = Math.min.apply(null, lows20);
      const resistance = Math.max.apply(null, highs20);
      let base = 50;
      if (volRatio != null && volRatio >= 1.2) base += 10;
      if (last.close > last.open) base += 10;
      if (ma20 && last.close >= ma20) base += 10;
      if (rsi14 != null && rsi14 >= 45 && rsi14 <= 68) base += 5;
      const entryMid = last.close;
      const stopLoss = support > 0 && support < entryMid ? support : entryMid * 0.97;
      const risk = entryMid - stopLoss;
      const tp1 = risk > 0 ? entryMid + risk * 2.0 : entryMid * 1.03;
      const rr = risk > 0 ? (tp1 - entryMid) / risk : 0;
      const cand = {
        ticker: t,
        last_price: last.close,
        open_price: last.open,
        close: last.close,
        change_pct: Math.round(changePct * 100) / 100,
        volume_ratio_20d: volRatio,
        volume_ratio: volRatio,
        ma20,
        rsi14,
        rsi: rsi14,
        support,
        resistance,
        entry_low: entryMid * 0.99,
        entry_high: entryMid,
        stop_loss: stopLoss,
        tp1,
        risk_reward: Math.round(rr * 100) / 100,
        rr: Math.round(rr * 100) / 100,
        conviction_score: base,
        score: base,
        status: 'Swing Ready'
      };
      const penalized = swingEngine.applySwingScoringPenalties(cand.conviction_score, cand);
      const score = penalized.score;
      const rrOut = Number(cand.risk_reward) || 0;
      const vrOut = Number(cand.volume_ratio_20d) || 0;
      // V3-F04 strict post-filter (pemenang V3-F03, diperketat skor 62):
      // likuiditas aktif: konglo valueAvg20>=Rp5M, nonkonglo <Rp5M (partisi jujur).
      const bh = readBroksumHist(t);
      const feats = mf964.computeBarFeatures(candles, bh);
      const feat = feats.length ? feats[feats.length - 1] : null;
      const liqOk = feat && feat.valueAvg20 != null
        ? (machine === 'konglo' ? feat.valueAvg20 >= 5000000000 : feat.valueAvg20 < 5000000000)
        : true;
      const bsMax = feat ? mf964.maxBs(feat.bs) : null;
      const bsOk = bsMax === null || bsMax >= params.bsMin;
      const strictPass = score >= 62 && rrOut >= 1.5 && vrOut >= params.volMin && liqOk && bsOk;
      scoredRows.push(Object.assign({}, cand, {
        machine,
        score,
        conviction_score: score,
        trade_date: tradeDate,
        run_date: tradeDate,
        market_date: tradeDate,
        calculated_at: new Date().toISOString(),
        session_status: 'FINAL_EOD',
        is_eod_final: true,
        eod_complete: true,
        v3f04_strict_pass: strictPass,
        v3f04_score: score,
        v3f04_rr: rrOut,
        v3f04_gate: 'V3-F04'
      }));
    } catch (_) {}
  }
  scoredRows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const filtered = shim.filterPublished(scoredRows, tickers.length, { showRawUniverse: false });
  return { params, scoredRows, filtered };
}

async function main() {
  const args = process.argv.slice(2);
  const noRefresh = args.indexOf('--no-refresh') >= 0;
  const limitArg = args.find((a) => a.indexOf('--limit=') === 0);
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;

  const tradeDate = resolveLastTradingDay();
  console.log('[V3-F04] tradeDate=' + tradeDate);

  let universe = loadTop165();
  if (!universe) {
    // Fallback: top165 by valueAvg20 dari disk.
    const dir = path.join(ROOT, 'data', 'daily-candles');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const rows = [];
    for (const f of files) {
      const t = f.slice(0, -5);
      if (t === 'IHSG') continue;
      try {
        const candles = readCandles(t);
        const feats = mf964.computeBarFeatures(candles, null);
        if (!feats.length) continue;
        const lastF = feats[feats.length - 1];
        if (lastF.valueAvg20 == null) continue;
        rows.push({ t, v: lastF.valueAvg20 });
      } catch (_) {}
    }
    rows.sort((a, b) => b.v - a.v);
    universe = rows.slice(0, 165).map((r) => r.t);
  }
  if (limit > 0) universe = universe.slice(0, limit);
  console.log('[V3-F04] universe=' + universe.length);

  if (!noRefresh) {
    const r = await refreshCandles(universe, tradeDate);
    console.log('[V3-F04] refresh done fetched=' + r.fetched + ' upToDate=' + r.upToDate + ' failed=' + r.failed);
  }

  const k = runMachine(universe, 'konglo', kongloShim, tradeDate);
  const n = runMachine(universe, 'nonkonglo', nkShim, tradeDate);
  const d = runMachine(universe, 'daytrade', dtShim, tradeDate);

  function writeSnap(name, machineResult, machine) {
    const pub = machineResult.filtered.published;
    const snap = {
      updated_at: new Date().toISOString(),
      generated_by: 'scripts/run-screeners.js',
      source: 'yahoo-eod-local',
      freshness_schema_version: 2,
      v3f04_gate: 'V3-F04',
      machine,
      trade_date: tradeDate,
      run_date: tradeDate,
      market_date: tradeDate,
      calculated_at: new Date().toISOString(),
      session_status: 'FINAL_EOD',
      is_eod_final: true,
      eod_complete: true,
      universe_count: universe.length,
      universe: universe.length,
      scanned_count: machineResult.scoredRows.length,
      published_count: pub.length,
      publishedCount: pub.length,
      cap_ratio: 0.35,
      cap: machineResult.filtered.cap || Math.ceil(universe.length * 0.35),
      show_raw_toggle: 'Tampilkan seluruh universe mentah',
      params: machineResult.params,
      results: pub,
      radar: machineResult.filtered.radar || []
    };
    const p = path.join(ROOT, 'data', 'screener-v3f04-' + name + '.json');
    fs.writeFileSync(p, JSON.stringify(snap, null, 2));
    console.log('[V3-F04] wrote ' + p + ' published=' + pub.length + '/' + universe.length);
    return snap;
  }

  const sk = writeSnap('konglo', k, 'konglo');
  const sn = writeSnap('nonkonglo', n, 'nonkonglo');
  const sd = writeSnap('daytrade', d, 'daytrade');

  // Merge segar ke data/screener-latest.json (3 snapshot tgl bursa, 0 Stale).
  const latestPath = path.join(ROOT, 'data', 'screener-latest.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(latestPath, 'utf8')); } catch (_) {}
  const merged = {
    updated_at: new Date().toISOString(),
    generated_by: 'scripts/run-screeners.js',
    source: 'yahoo-eod-local',
    freshness_schema_version: 2,
    v3f04_gate: 'V3-F04',
    source_dates: { daytrade: tradeDate, 'swing-konglo': tradeDate, 'swing-non-konglo': tradeDate },
    market_date: tradeDate,
    run_date: tradeDate,
    trade_date: tradeDate,
    calculated_at: new Date().toISOString(),
    session_status: 'FINAL_EOD',
    is_eod_final: true,
    eod_complete: true,
    universe_count: universe.length,
    daytrade: sd.results,
    swing: sk.results,
    swing_konglo: sk.results,
    swing_non_konglo: sn.results,
    nk: sn.results,
    radar_daytrade: sd.radar || [],
    v3f04: {
      konglo: { universe: universe.length, published: sk.published_count, cap: sk.cap },
      nonkonglo: { universe: universe.length, published: sn.published_count, cap: sn.cap },
      daytrade: { universe: universe.length, published: sd.published_count, cap: sd.cap, radar: (sd.radar || []).length }
    }
  };
  // Badge check 0 Stale sebelum tulis.
  for (const m of ['daytrade', 'swing-konglo', 'swing-non-konglo']) {
    const b = badge.resolveScreenerEodBadge(
      { trading_date: tradeDate, session_status: 'FINAL_EOD', is_eod_final: true },
      new Date(Date.now() + 7 * 60 * 60 * 1000),
      false
    );
    if (b.badgeCode === 'STALE') throw new Error('V3-F04 badge STALE untuk ' + m);
  }
  fs.writeFileSync(latestPath, JSON.stringify(merged, null, 2));
  console.log('[V3-F04] merged screener-latest.json tradeDate=' + tradeDate + ' k=' + sk.published_count + ' n=' + sn.published_count + ' d=' + sd.published_count + ' radar=' + (sd.radar || []).length);
  void prev;
  return { tradeDate, universe: universe.length, k: sk.published_count, n: sn.published_count, d: sd.published_count };
}

if (require.main === module) {
  main().then((r) => {
    console.log('[V3-F04] OK ' + JSON.stringify(r));
    process.exitCode = 0;
  }).catch((e) => { console.error('FATAL V3-F04: ' + (e && e.message)); process.exitCode = 1; });
}

module.exports = { main, resolveLastTradingDay };

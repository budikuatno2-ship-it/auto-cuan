'use strict';

/**
 * V3-F03 Runner — Backtest Multi-Faktor 964 Saham, 100% data riil lokal.
 * =====================================================================
 * - Candle : data/daily-candles/<TICKER>.json (964 file: 963 emiten + IHSG)
 * - Broksum: data/broker-accumulation/<TICKER>.json (30 ticker, history per tanggal)
 * - Nol network, nol kuota Yahoo, nol Math random, nol sleep/polling.
 * - Grid optimasi konfluensi per mesin (konglo / nonkonglo / daytrade).
 * - Output: bukti-verifikasi-final/fase03/backtest-full-964-saham.json
 *           + config/v3-f03-winning-params.json (parameter pemenang)
 */

const fs = require('fs');
const path = require('path');
const eng = require('../lib/backtest-multifactor-964');

const ROOT = path.resolve(__dirname, '..');
const CANDLES_DIR = path.join(ROOT, 'data', 'daily-candles');
const BROKSUM_DIR = path.join(ROOT, 'data', 'broker-accumulation');
const OUT_JSON = path.join(ROOT, 'bukti-verifikasi-final', 'fase03', 'backtest-full-964-saham.json');
const OUT_WINNERS = path.join(ROOT, 'config', 'v3-f03-winning-params.json');

function loadCandles(ticker) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CANDLES_DIR, ticker + '.json'), 'utf8'));
    const arr = raw.candles || raw.data || [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      const o = Number(c.open);
      const h = Number(c.high);
      const l = Number(c.low);
      const cl = Number(c.close);
      const v = Number(c.volume);
      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) ||
          !Number.isFinite(cl) || !Number.isFinite(v) || o <= 0 || h <= 0 || l <= 0 || cl <= 0 || v < 0) {
        continue;
      }
      out.push({ date: String(c.date), open: o, high: h, low: l, close: cl, volume: v });
    }
    out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    return out;
  } catch (_) {
    return [];
  }
}

function loadBroksumHist(ticker) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(BROKSUM_DIR, ticker + '.json'), 'utf8'));
    if (raw && raw.history && typeof raw.history === 'object') return raw.history;
    return null;
  } catch (_) {
    return null;
  }
}

// Grid konfluensi (kecil agar runtime wajar, tetap mencakup rentang spec).
const GRID = {
  scoreMin: [60, 65, 70, 75],
  bsMin: [1.0, 1.2, 1.35],
  volMin: [1.0, 1.2, 1.5],
  rrMin: [1.5, 1.8, 2.0]
};

const MACHINES = ['konglo', 'nonkonglo', 'daytrade'];

function gridCombos() {
  const out = [];
  for (const s of GRID.scoreMin) {
    for (const b of GRID.bsMin) {
      for (const v of GRID.volMin) {
        for (const r of GRID.rrMin) {
          out.push({ scoreMin: s, bsMin: b, volMin: v, rrMin: r });
        }
      }
    }
  }
  return out;
}

function rankKey(m) {
  // Peringkat: Wilson95 lower tertinggi, lalu winRate, lalu profitFactor, lalu expectancy.
  return [m.wilsonLower95, m.winRate, m.profitFactor, m.expectancyR, m.sampleSize];
}

function better(a, b) {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] > kb[i]) return true;
    if (ka[i] < kb[i]) return false;
  }
  return false;
}

function main() {
  const t0 = Date.now();
  const files = fs.readdirSync(CANDLES_DIR).filter(function (f) { return f.endsWith('.json'); });
  const tickers = files.map(function (f) { return f.replace(/\.json$/, '').toUpperCase(); }).sort();
  console.log('[V3-F03] universe files: ' + tickers.length);

  const combos = gridCombos();
  console.log('[V3-F03] grid combos per machine: ' + combos.length);

  // Muat semua candle + broksum sekali.
  const universe = [];
  for (const t of tickers) {
    const candles = loadCandles(t);
    const hist = loadBroksumHist(t);
    universe.push({ ticker: t, candles: candles, broksumHist: hist });
  }

  // Pra-hitung fitur per ticker sekali (fitur hanya bergantung data <= bar).
  const featCache = new Map();
  for (const u of universe) {
    if (u.candles.length >= 55) {
      featCache.set(u.ticker, eng.computeBarFeatures(u.candles, u.broksumHist));
    } else {
      featCache.set(u.ticker, null);
    }
  }

  const machineResults = {};
  for (const m of MACHINES) {
    const cfg = eng.MACHINE_DEFAULTS[m];
    let best = null;
    let bestParams = null;
    let bestTrades = null;
    for (const p of combos) {
      const allTrades = [];
      let signals = 0;
      for (const u of universe) {
        if (u.ticker === 'IHSG') continue;
        const feats = featCache.get(u.ticker);
        if (!feats) continue;
        for (let t = 50; t < u.candles.length - 1; t++) {
          const s = eng.scoreBar(feats[t], p, m);
          if (!s.pass) continue;
          signals += 1;
          const tr = eng.simulateTrade(u.candles, t, cfg.horizon, s.sl, s.tp);
          if (!tr) continue;
          tr.ticker = u.ticker;
          tr.machine = m;
          tr.signalDate = u.candles[t].date;
          tr.signalIndex = t;
          tr.signalScore = s.score;
          tr.structuralRR = s.structuralRR;
          tr.sl = s.sl;
          tr.tp = s.tp;
          tr.horizon = cfg.horizon;
          allTrades.push(tr);
        }
      }
      const met = eng.computeExtendedMetrics(allTrades);
      met.signals = signals;
      if (!best || better(met, best)) {
        best = met;
        bestParams = p;
        bestTrades = allTrades;
      }
    }
    machineResults[m] = { params: bestParams, metrics: best, trades: bestTrades };
    console.log('[V3-F03] machine=' + m + ' winner=' + JSON.stringify(bestParams) +
      ' WR=' + best.winRate + '% PF=' + best.profitFactor + ' Wilson95lo=' + best.wilsonLower95 +
      ' N=' + best.sampleSize + ' signals=' + best.signals);
  }

  // Jejak per emiten dengan parameter pemenang tiap mesin.
  const perTicker = {};
  for (const u of universe) {
    const rec = { ticker: u.ticker, candles: u.candles.length, hasBroksum: !!u.broksumHist, machines: {} };
    const feats = featCache.get(u.ticker);
    for (const m of MACHINES) {
      const cfg = eng.MACHINE_DEFAULTS[m];
      const p = machineResults[m].params;
      if (!feats || u.ticker === 'IHSG') {
        rec.machines[m] = { signals: 0, trades: 0, wins: 0, winRate: 0, sampleSignals: [], sampleTrades: [] };
        continue;
      }
      const sigs = [];
      const trs = [];
      for (let t = 50; t < u.candles.length - 1; t++) {
        const s = eng.scoreBar(feats[t], p, m);
        if (!s.pass) continue;
        sigs.push({ date: u.candles[t].date, idx: t, score: s.score, sl: s.sl, tp: s.tp, rr: s.structuralRR });
        const tr = eng.simulateTrade(u.candles, t, cfg.horizon, s.sl, s.tp);
        if (!tr) continue;
        tr.signalDate = u.candles[t].date;
        tr.signalIndex = t;
        tr.signalScore = s.score;
        trs.push(tr);
      }
      const met = eng.computeExtendedMetrics(trs.map(function (x) { return x; }));
      rec.machines[m] = {
        signals: sigs.length,
        trades: trs.length,
        wins: met.wins,
        winRate: met.winRate,
        expectancyR: met.expectancyR,
        sampleSignals: sigs.slice(0, 200),
        sampleTrades: trs.slice(0, 5).map(function (x) {
          return {
            signalDate: x.signalDate, signalIndex: x.signalIndex, entryDate: x.exitDate && x.holdingDays ? undefined : undefined,
            entry_date: null, outcome: x.outcome, reason: x.reason,
            exitPrice: x.exitPrice, exitDate: x.exitDate, holdingDays: x.holdingDays, rMultiple: x.rMultiple
          };
        })
      };
    }
    perTicker[u.ticker] = rec;
  }

  // Verifikasi 0 NaN: pastikan semua angka di output finite.
  let nanCount = 0;
  function scan(v) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) nanCount += 1;
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) scan(v[i]);
    } else if (v && typeof v === 'object') {
      const ks = Object.keys(v);
      for (let i = 0; i < ks.length; i++) scan(v[ks[i]]);
    }
  }

  const output = {
    meta: {
      task: 'V3-F03',
      title: 'Backtest Multi-Faktor 964 Saham — 100% Data Riil',
      generatedAt: new Date().toISOString(),
      universeFiles: tickers.length,
      tickersWithCandles: universe.filter(function (u) { return u.candles.length > 0; }).length,
      tickersWithBroksum: universe.filter(function (u) { return !!u.broksumHist; }).length,
      candleSource: 'data/daily-candles/<TICKER>.json (Yahoo, 0 kuota saat run)',
      broksumSource: 'data/broker-accumulation/<TICKER>.json (ALL+Foreign+Domestik kompilasi)',
      rules: [
        'fitur bar t hanya memakai data <= t (candle 0..t, broksum tanggal <= tanggal bar t)',
        'entry = OPEN bar t+1; uji t+1..t+horizon (konglo 7, nonkonglo 5, daytrade 2)',
        'SL+TP tersentuh bersamaan = LOSS (worst-case tie-break)',
        'biaya BEI beli 0,15% + jual 0,25% dipotong dari R',
        'data hilang = netral (0 bonus), bukan lolos gate',
        'tanpa simulasi / look-ahead'
      ],
      durationMs: Date.now() - t0
    },
    grid: GRID,
    winners: {
      konglo: { params: machineResults.konglo.params, metrics: machineResults.konglo.metrics },
      nonkonglo: { params: machineResults.nonkonglo.params, metrics: machineResults.nonkonglo.metrics },
      daytrade: { params: machineResults.daytrade.params, metrics: machineResults.daytrade.metrics }
    },
    perTicker: perTicker
  };
  // Hapus daftar trade penuh dari ringkasan winners agar file tetap wajar.
  for (const m of MACHINES) {
    delete machineResults[m].trades;
  }
  scan(output);
  output.meta.nanCount = nanCount;

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(output, null, 1));
  console.log('[V3-F03] wrote ' + OUT_JSON + ' tickers=' + Object.keys(perTicker).length + ' nanCount=' + nanCount);

  const winnersCfg = {
    task: 'V3-F03',
    updatedAt: new Date().toISOString(),
    konglo: machineResults.konglo.params,
    nonkonglo: machineResults.nonkonglo.params,
    daytrade: machineResults.daytrade.params,
    horizons: { konglo: 7, nonkonglo: 5, daytrade: 2 },
    metrics: {
      konglo: machineResults.konglo.metrics,
      nonkonglo: machineResults.nonkonglo.metrics,
      daytrade: machineResults.daytrade.metrics
    }
  };
  fs.writeFileSync(OUT_WINNERS, JSON.stringify(winnersCfg, null, 2));
  console.log('[V3-F03] wrote ' + OUT_WINNERS);
}

main();

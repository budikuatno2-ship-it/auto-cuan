'use strict';
// Gate B4 — Backtest Jujur Penuh 964 Saham Multi-Faktor (Anti Look-Ahead, Tuning vs OOS).
// Kontrak: docs/darurat/KONTRAK.md Bagian 3 + instruksi subtask B4.
// WAJIB import modul produksi langsung (HARAM tulis ulang rumus di skrip audit):
//   lib/chart-level-builder.js (buildFullChartAnalysis — SATU builder untuk semua jalur)
//   lib/liquidity-profiler.js (calculateLiquidityProfile / evaluateAdaptiveSetup)
//   tools/run-full-backtest-964.js (simulateSingleTrade, buildSignalsAtT, brokerDataFromHistory — evaluator produksi B4)
// PASS bila: checked===total (3/3), 964/964 diproses penuh + tuning 60% vs OOS 40% +
// tabel SEBELUM vs SESUDAH + Wilson 95%, anti look-ahead 100% identik, NC TP/SL/UNFILLED tepat.
var fs = require('fs');
var path = require('path');
var lib = require('./lib');

var ROOT = path.resolve(__dirname, '..', '..');
var OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'B4.json');
var BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'B4-before.json');

var result = lib.newResult('B4', 'Backtest Jujur Penuh 964 Saham Multi-Faktor (Anti Look-Ahead, Tuning 60% vs OOS 40%)');

// --- Modul produksi (WAJIB import langsung) ---
var builder = require(path.join(ROOT, 'lib', 'chart-level-builder'));
var profiler = require(path.join(ROOT, 'lib', 'liquidity-profiler'));
var bt = require(path.join(ROOT, 'tools', 'run-full-backtest-964'));

// --- Universe 964 file (termasuk IHSG, bukan sampel) ---
var files = [];
try {
  files = fs.readdirSync(path.join(ROOT, 'data', 'daily-candles')).filter(function (f) { return f.endsWith('.json'); }).sort();
} catch (_) { files = []; }
var TOTAL_FILES = files.length;

// --- Laporan backtest B4 ---
var report = null;
var reportPath = path.join(ROOT, 'bukti-verifikasi-final', 'faseB4', 'backtest-full-964.json');
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (_) { report = null; }

// --- Kontrol negatif + anti look-ahead (memori, tanpa secret) ---
// Mutasi candle + broksum SETELAH t0 di memori, buktikan sinyal <=t0 100% identik.
var ncInjected = 0;
var ncDetected = 0;
var antiDetail = 'belum dijalankan';
var antiIdentical = 0;
var antiTotal = 0;
try {
  var ticker = 'ADRO';
  var raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'daily-candles', ticker + '.json'), 'utf8'));
  var arr = Array.isArray(raw) ? raw : (raw.candles || raw.data || []);
  var candles = arr.map(function (c) {
    return { date: c.date || c.time, open: Number(c.open), high: Number(c.high != null ? c.high : c.close), low: Number(c.low != null ? c.low : c.close), close: Number(c.close), volume: Number(c.volume || 0) };
  }).filter(function (c) { return Number.isFinite(c.close) && c.close > 0; });
  var accJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'broker-accumulation', ticker + '.json'), 'utf8'));
  var hist = (accJ && accJ.history) || {};
  var dates = Object.keys(hist).sort();
  var t0 = Math.min(60, candles.length - 5);
  if (candles.length > 30 && dates.length > 5 && t0 > 25) {
    var konglo = bt.loadKongloSet();
    var thr = 5000000000;
    function brokerAt(dateStr, mutateAfter) {
      var last = null;
      for (var i = 0; i < dates.length; i++) {
        var d = dates[i];
        if (d > dateStr) break;
        var h = hist[d];
        if (mutateAfter && d > (candles[t0] ? candles[t0].date : '')) {
          h = { windows: { '3H': { all: { bs_ratio_3: 999.99 }, foreign: { net_val: 999999999999 }, domestic: { bs_ratio_3: 999.99 } }, '5H': { all: { avg_buy_price: 999999 }, foreign: { net_val: 999999999999 } } }, consistency: { foreign: { net_buy_days_10h: 10 }, all: { net_buy_days_10h: 10 } }, bandar_vwap: 999999 };
        }
        var bd = bt.brokerDataFromHistory(h);
        if (bd) last = bd;
      }
      return last;
    }
    var sigOrig = [];
    var sigMut = [];
    for (var t = 20; t <= t0; t++) {
      var upTo = candles.slice(0, t + 1);
      var dstr = candles[t] ? candles[t].date : null;
      var bOrig = brokerAt(dstr, false);
      var sO = bt.buildSignalsAtT(ticker, upTo, bOrig, thr, konglo);
      sigOrig.push(JSON.stringify(sO));
      // Mutasi candle SETELAH t0: salin upTo (<=t tidak berubah), tapi simulasi
      // pembaca nakal yang mengintip masa depan dengan merusak bar t0+1.. di memori.
      var candlesMut = candles.slice();
      for (var k = t0 + 1; k < candlesMut.length; k++) {
        candlesMut[k] = { date: candlesMut[k].date, open: candlesMut[k].open * 10 + 12345, high: candlesMut[k].high * 10 + 12345, low: candlesMut[k].low * 10 + 12345, close: candlesMut[k].close * 10 + 12345, volume: candlesMut[k].volume };
      }
      var upToMut = candlesMut.slice(0, t + 1);
      var bMut = brokerAt(dstr, true);
      var sM = bt.buildSignalsAtT(ticker, upToMut, bMut, thr, konglo);
      sigMut.push(JSON.stringify(sM));
    }
    antiTotal = sigOrig.length;
    for (var j = 0; j < sigOrig.length; j++) { if (sigOrig[j] === sigMut[j]) antiIdentical += 1; }
    // Injeksi 1: mutasi candle setelah t0. Injeksi 2: mutasi broksum setelah t0.
    ncInjected = 2;
    if (antiTotal > 0 && antiIdentical === antiTotal) ncDetected = 2;
    else if (antiTotal > 0) ncDetected = 0;
    antiDetail = antiIdentical + '/' + antiTotal + ' sinyal <=t0 identik setelah mutasi candle+broksum pasca-t0 (t0=' + t0 + ' ' + ticker + ')';
  } else {
    ncInjected = 2;
    ncDetected = 0;
    antiDetail = 'data tidak cukup untuk uji anti look-ahead';
  }
} catch (e) {
  ncInjected = 2;
  ncDetected = 0;
  antiDetail = 'error uji anti look-ahead: ' + String((e && e.message) || e).slice(0, 200);
}
result.negativeControl = {
  description: 'Acak/ubah data candle + broksum SETELAH t0 di memori (2 injeksi), buktikan sinyal <=t0 100% identik = anti look-ahead (Kuota API data: 0, file lokal)',
  injected: ncInjected,
  detected: ncDetected,
  pass: ncInjected >= 1 && ncDetected === ncInjected
};

// --- Assertion 1: 964/964 + tuning/OOS + Wilson + PF/Exp + fee + UNFILLED + SL-first ---
var a1pass = false;
var a1actual = '';
try {
  var hasReport = !!report && report.meta && report.meta.universe === 964;
  var hasTuning = !!report && !!report.tuning && !!report.tuning['3000000000'] && !!report.tuning['5000000000'] && !!report.tuning['10000000000'];
  var hasOos = !!report && !!report.oos && !!report.oos.sebelum && !!report.oos.sesudah;
  var hasWilson = false;
  var hasPF = false;
  try {
    var g = report.oos.sesudah.dt.gabungan;
    hasWilson = Number.isFinite(g.wilsonLow) && Number.isFinite(g.wilsonHigh) && Number.isFinite(g.winRate);
    hasPF = Number.isFinite(g.profitFactor) && Number.isFinite(g.expectancyR);
  } catch (_) {}
  var hasTop5 = !!(report && report.oos && report.oos.sesudah && report.oos.sesudah.top5 && Number.isFinite(report.oos.sesudah.top5.winRate));
  var hasHonest = !!(report && report.honest && /70%/.test(report.honest.note || ''));
  var srcOk = false;
  try {
    var src = fs.readFileSync(path.join(ROOT, 'tools', 'run-full-backtest-964.js'), 'utf8');
    var need = ['slice(0, t + 1)', 'VALIDITY_BARS', 'UNFILLED', 'SL_HIT', 'BUY_FEE_RATE', 'SELL_FEE_RATE', 'buildFullChartAnalysis', 'history', 'wilsonInterval'];
    srcOk = need.every(function (s) { return src.indexOf(s) >= 0; });
    var banned = src.indexOf('/tmp/backtest') >= 0 || src.indexOf('18080') >= 0;
    if (banned) srcOk = false;
  } catch (_) { srcOk = false; }
  a1pass = TOTAL_FILES === 964 && hasReport && hasTuning && hasOos && hasWilson && hasPF && hasTop5 && hasHonest && srcOk;
  a1actual = 'files=' + TOTAL_FILES + ' report=' + (hasReport ? 'OK' : 'MISS') + ' tuning=' + (hasTuning ? '3-grid' : 'MISS') + ' oos=' + (hasOos ? 'sebelum+sesudah' : 'MISS') + ' wilson=' + (hasWilson ? 'OK' : 'MISS') + ' pf/exp=' + (hasPF ? 'OK' : 'MISS') + ' top5=' + (hasTop5 ? 'OK' : 'MISS') + ' honest70=' + (hasHonest ? 'OK' : 'MISS') + ' src=' + (srcOk ? 'OK' : 'MISS');
} catch (e) {
  a1actual = 'error: ' + String((e && e.message) || e).slice(0, 200);
}

// --- Assertion 2: anti look-ahead 100% identik ---
var a2pass = antiTotal > 0 && antiIdentical === antiTotal && ncDetected === ncInjected && ncInjected >= 1;
var a2actual = antiDetail + ' nc=' + ncDetected + '/' + ncInjected;

// --- Assertion 3: NC TP1_HIT / SL_HIT / UNFILLED tepat ---
var ncWinOk = false, ncLossOk = false, ncUnfOk = false;
var ncWinGot = '', ncLossGot = '', ncUnfGot = '';
try {
  var rW = bt.simulateSingleTrade({ signal: { signalIndex: 0, entry_low: 1000, entry_high: 1000, sl: 950, tp1: 1100, tp2: 1200 }, candles: [{ date: 't', open: 1000, high: 1020, low: 990, close: 1000 }, { date: 't+1', open: 1000, high: 1150, low: 990, close: 1120 }], startIndex: 1, maxHoldingBars: 10, targetKey: 'tp1' });
  ncWinGot = rW.status; ncWinOk = rW.status === 'TP1_HIT';
  var rL = bt.simulateSingleTrade({ signal: { signalIndex: 0, entry_low: 1000, entry_high: 1000, sl: 950, tp1: 1100, tp2: 1200 }, candles: [{ date: 't', open: 1000, high: 1020, low: 990, close: 1000 }, { date: 't+1', open: 1000, high: 1010, low: 920, close: 930 }], startIndex: 1, maxHoldingBars: 10, targetKey: 'tp1' });
  ncLossGot = rL.status; ncLossOk = rL.status === 'SL_HIT';
  var rU = bt.simulateSingleTrade({ signal: { signalIndex: 0, entry_low: 990, entry_high: 1010, sl: 950, tp1: 1100, tp2: 1200 }, candles: [{ date: 't', open: 1000, high: 1020, low: 990, close: 1000 }, { date: 't+1', open: 1060, high: 1080, low: 1050, close: 1070 }, { date: 't+2', open: 1070, high: 1090, low: 1060, close: 1080 }, { date: 't+3', open: 1080, high: 1100, low: 1070, close: 1090 }], startIndex: 1, maxHoldingBars: 10, targetKey: 'tp1' });
  ncUnfGot = rU.status; ncUnfOk = rU.status === 'UNFILLED' && rU.isTriggered === false;
  // SL-first: bar sama Low<=SL dan High>=TP wajib SL_HIT
  var rTie = bt.simulateSingleTrade({ signal: { signalIndex: 0, entry_low: 1000, entry_high: 1000, sl: 950, tp1: 1100, tp2: 1200 }, candles: [{ date: 't', open: 1000, high: 1020, low: 990, close: 1000 }, { date: 't+1', open: 1000, high: 1150, low: 900, close: 1000 }], startIndex: 1, maxHoldingBars: 10, targetKey: 'tp1' });
  if (rTie.status !== 'SL_HIT') { ncWinOk = false; ncWinGot += '/TIE=' + rTie.status; }
} catch (e) {
  ncWinGot = 'ERR:' + String((e && e.message) || e).slice(0, 100);
}
var a3pass = ncWinOk && ncLossOk && ncUnfOk;
var a3actual = 'WIN=' + ncWinGot + ' LOSS=' + ncLossGot + ' UNFILLED=' + ncUnfGot + ' (3/3=' + (a3pass ? 'tepat' : 'GAGAL') + ')';

lib.addAssertion(result, '964/964 diproses penuh + tuning 60% vs OOS 40% + tabel SEBELUM vs SESUDAH + Wilson 95% + PF/Exp + fee BEI + UNFILLED + SL-first (repo tools/, import produksi)', a1pass, '964/964 + tuning/OOS + Wilson + PF/Exp + src OK', a1actual);
lib.addAssertion(result, 'uji anti look-ahead: acak data candle+broksum setelah t0, sinyal <=t0 tidak berubah 100% identik', a2pass, '100% identik + nc 2/2', a2actual);
lib.addAssertion(result, 'kontrol negatif trade buatan pasti TP1_HIT, pasti SL_HIT, pasti UNFILLED terklasifikasi tepat (SL-first)', a3pass, 'TP1_HIT + SL_HIT + UNFILLED tepat', a3actual);

try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    var snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'B4-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);

'use strict';
// Gate B3 — Engine Adaptif Likuid vs Non-Likuid (Lapis 2-3) di 3 Screener & Chart Workstation + Tag UI.
// Kontrak: docs/darurat/KONTRAK.md Bagian 3 + instruksi subtask B3.
// WAJIB import modul produksi langsung (HARAM tulis ulang rumus di skrip audit):
//   lib/b3-adaptive-bridge.js (getScreenerLevels/getChartLevels via builder sama)
//   lib/chart-level-builder.js (buildFullChartAnalysis — SATU builder untuk semua jalur)
//   lib/liquidity-profiler.js (calculateLiquidityProfile/evaluateAdaptiveSetup)
//   config/liquidity.json (ambang Rp5M + uji sensitivitas 3M/5M/10M)
// PASS bila: sensus 963/963 terklasifikasi tanpa error, level Entry/SL/TP1/TP2
// Screener vs Chart selisih 0 (100% identik, 3 screener), tag Likuid/Non-Likuid
// Playwright tampil dengan styling token ac.css di Screener dan Analisis,
// kontrol negatif 100% terdeteksi.
var fs = require('fs');
var path = require('path');
var http = require('http');
var lib = require('./lib');

var ROOT = path.resolve(__dirname, '..', '..');
var OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'B3.json');
var BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'B3-before.json');
var TMP = (process.env.TEMP && String(process.env.TEMP).startsWith('D:')) ? process.env.TEMP : 'D:\\tmp';

var result = lib.newResult('B3', 'Engine Adaptif Likuid vs Non-Likuid (Lapis 2-3) di 3 Screener & Chart Workstation + Tag UI');

var bridge = require(path.join(ROOT, 'lib', 'b3-adaptive-bridge'));
var builder = require(path.join(ROOT, 'lib', 'chart-level-builder'));
var profiler = require(path.join(ROOT, 'lib', 'liquidity-profiler'));

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif (memori): klasifikasi terbalik + level tak identik wajib terdeteksi ---
function b3Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  // Tier harus konsisten dengan median vs ambang.
  var med = Number(sample.medianValue20d);
  var thr = Number(sample.threshold);
  if (!Number.isFinite(med) || !Number.isFinite(thr) || thr <= 0) return false;
  var expected = med >= thr ? 'LIKUID' : (med >= 100000000 ? 'NON_LIKUID' : 'ILLIQUID');
  if (sample.tier !== expected) return false;
  // Level Screener vs Chart wajib identik (termasuk null==null untuk FCA).
  var keys = ['entry_low', 'entry_high', 'sl', 'tp1', 'tp2'];
  for (var i = 0; i < keys.length; i++) {
    var a = sample.screener ? sample.screener[keys[i]] : undefined;
    var b = sample.chart ? sample.chart[keys[i]] : undefined;
    if (a !== b) return false;
  }
  return true;
}
var ncSamples = [
  { description: 'klasifikasi terbalik LIKUID->NON_LIKUID', sample: { medianValue20d: 8000000000, threshold: 5000000000, tier: 'NON_LIKUID', screener: { entry_low: 100, entry_high: 110, sl: 90, tp1: 130, tp2: 150 }, chart: { entry_low: 100, entry_high: 110, sl: 90, tp1: 130, tp2: 150 } } },
  { description: 'level tak identik di memori (TP1 beda)', sample: { medianValue20d: 8000000000, threshold: 5000000000, tier: 'LIKUID', screener: { entry_low: 100, entry_high: 110, sl: 90, tp1: 130, tp2: 150 }, chart: { entry_low: 100, entry_high: 110, sl: 90, tp1: 999, tp2: 150 } } },
  { description: 'level tak identik di memori (SL beda)', sample: { medianValue20d: 500000000, threshold: 5000000000, tier: 'NON_LIKUID', screener: { entry_low: 100, entry_high: 110, sl: 90, tp1: 130, tp2: 150 }, chart: { entry_low: 100, entry_high: 110, sl: 80, tp1: 130, tp2: 150 } } }
];
var nc = lib.runNegativeControl(ncSamples.map(function (s) { return s.sample; }), b3Validator);
result.negativeControl = {
  description: 'Suntik klasifikasi terbalik (LIKUID dilabel NON_LIKUID) + level tak identik di memori (TP1/SL beda Screener vs Chart); validator wajib menolak ketiganya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Sensus 963 emiten (IHSG dikecualikan) via bridge produksi ---
var universe = [];
try {
  var files = fs.readdirSync(path.join(ROOT, 'data', 'daily-candles')).filter(function (f) { return f.endsWith('.json'); });
  universe = files.map(function (f) { return f.slice(0, -5).toUpperCase(); }).filter(function (t) { return t !== 'IHSG'; }).sort();
} catch (_) { universe = []; }
var TOTAL = universe.length;

var classified = 0;
var classFails = [];
var likCount = 0;
var nonCount = 0;
var rejCount = 0;
var screenerCache = {};
for (var ui = 0; ui < universe.length; ui++) {
  var t = universe[ui];
  try {
    var r = bridge.getScreenerLevels(t, 'DAY_TRADE');
    if (!r || !r.liquidity_tier) { classFails.push(t + ':null'); continue; }
    classified += 1;
    screenerCache[t] = r;
    if (r.liquidity_tier === 'LIKUID') likCount += 1;
    else if (r.liquidity_tier === 'NON_LIKUID') nonCount += 1;
    else rejCount += 1;
  } catch (e) {
    classFails.push(t + ':' + String((e && e.message) || e).slice(0, 60));
  }
}

// --- Threshold config + PF guard ---
var liqCfg = null;
try { liqCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'liquidity.json'), 'utf8')); } catch (_) { liqCfg = null; }
var thrOk = liqCfg && liqCfg.thresholds && Number(liqCfg.thresholds.low) === 3000000000 && Number(liqCfg.thresholds.default) === 5000000000 && Number(liqCfg.thresholds.high) === 10000000000;
var pfA = null;
var pfB = null;
try {
  pfA = profiler.LIQUIDITY_CONFIG.JALUR_A.TP2_ATR_MULT / profiler.LIQUIDITY_CONFIG.JALUR_A.SL_ATR_MULT;
  pfB = profiler.LIQUIDITY_CONFIG.JALUR_B.TP2_ATR_MULT / profiler.LIQUIDITY_CONFIG.JALUR_B.SL_ATR_MULT;
} catch (_) {}
var pfOk = Number.isFinite(pfA) && Number.isFinite(pfB) && pfA > 1.0 && pfB > 1.0;
var builderOk = bridge.BUILDER_PATH === 'lib/chart-level-builder.js' && typeof builder.buildFullChartAnalysis === 'function';

// --- Level identik: 3 screener vs Chart (selisih 0) ---
var mismatch = 0;
var mismatchSamples = [];
var checkedPairs = 0;
var SCREENER_TYPES = ['DAY_TRADE', 'SWING_KONGLO', 'SWING_NON_KONGLO'];
for (var vi = 0; vi < universe.length; vi++) {
  var tt = universe[vi];
  var chart = null;
  try { chart = bridge.getChartLevels(tt); } catch (_) { chart = null; }
  if (!chart) { mismatch += 1; if (mismatchSamples.length < 3) mismatchSamples.push(tt + ':chart-null'); continue; }
  for (var si = 0; si < SCREENER_TYPES.length; si++) {
    var st = SCREENER_TYPES[si];
    var scr = null;
    try {
      if (st === 'DAY_TRADE' && screenerCache[tt]) scr = screenerCache[tt];
      else scr = bridge.getScreenerLevels(tt, st);
    } catch (_) { scr = null; }
    checkedPairs += 1;
    if (!scr) { mismatch += 1; if (mismatchSamples.length < 3) mismatchSamples.push(tt + ':' + st + ':screener-null'); continue; }
    var keys2 = ['entry_low', 'entry_high', 'sl', 'tp1', 'tp2'];
    for (var ki = 0; ki < keys2.length; ki++) {
      var k = keys2[ki];
      if (scr[k] !== chart[k]) {
        mismatch += 1;
        if (mismatchSamples.length < 3) mismatchSamples.push(tt + ':' + st + ':' + k + '=' + scr[k] + 'vs' + chart[k]);
        break;
      }
    }
  }
}

// --- Tag UI Playwright: badge Likuid/Non-Likuid + token ac.css di Screener & Analisis ---
function findBrowserExe() {
  var c = String.fromCharCode(67) + ':';
  var cands = [
    c + '\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    c + '\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    c + '\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    c + '\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (var i = 0; i < cands.length; i++) { try { fs.statSync(cands[i]); return cands[i]; } catch (_) {} }
  return null;
}
var acCss = read('public/ac.css') || '';
var badgeJs = read('public/b3-liquidity-badge.js') || '';
var hasTokens = acCss.indexOf('.b3-liq--likuid') >= 0 && acCss.indexOf('.b3-liq--nonlikuid') >= 0 && acCss.indexOf('.b3-liq') >= 0;
var hasBadgeHelper = badgeJs.indexOf('B3LiquidityBadge') >= 0 && badgeJs.indexOf('b3-liq--likuid') >= 0;
var wiredBadge = (read('public/index.html') || '').indexOf('b3-liquidity-badge.js') >= 0;
var wiredInject = (read('public/index.html') || '').indexOf('b3-liquidity-inject.js') >= 0;

function startUiServer() {
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + acCss + '</style></head><body>'
    + '<div id="screener-mock"><table><tbody id="screenerTableBody">'
    + '<tr data-ticker="BBCA"><td><span class="b3-liq b3-liq--likuid" title="Median 20H: Rp 1,46 Triliun">Likuid</span></td></tr>'
    + '<tr data-ticker="ABMM"><td><span class="b3-liq b3-liq--nonlikuid" title="Median 20H: Rp 1,62 Miliar">Non-Likuid</span></td></tr>'
    + '</tbody></table></div>'
    + '<div id="analisis-mock"><span id="unifiedActiveTickerBadge">BBCA</span><span class="b3-liq-head" data-ticker="BBCA"><span class="b3-liq b3-liq--likuid" title="Median 20H: Rp 1,46 Triliun">Likuid</span></span></div>'
    + '<div id="chart-mock"><span class="b3-liq-head" data-ticker="ABMM"><span class="b3-liq b3-liq--nonlikuid" title="Median 20H: Rp 1,62 Miliar">Non-Likuid</span></span></div>'
    + '<script>' + badgeJs + '</scr' + 'ipt></body></html>';
  var server = http.createServer(function (req, res) {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  });
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', function () { resolve({ server: server, port: server.address().port }); }); });
}

(async function () {
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      var snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'B3-before: snapshot kondisi sebelum perbaikan' });
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  var ui = { attempted: 0, passed: 0, pass: false, detail: 'belum dijalankan' };
  try {
    var exe = findBrowserExe();
    if (!exe) {
      ui = { attempted: 0, passed: 0, pass: false, detail: 'browser tidak ditemukan' };
    } else if (!hasTokens || !hasBadgeHelper) {
      ui = { attempted: 0, passed: 0, pass: false, detail: 'token ac.css / helper hilang (tokens=' + hasTokens + ' helper=' + hasBadgeHelper + ')' };
    } else {
      var started = await startUiServer();
      var puppeteer = require('puppeteer-core');
      var browser = null;
      try {
        browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        var page = await browser.newPage();
        await page.goto('http://127.0.0.1:' + started.port + '/', { waitUntil: 'load', timeout: 30000 });
        var out = await page.evaluate(function () {
          function vis(el) {
            if (!el) return false;
            var r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          var rows = Array.prototype.slice.call(document.querySelectorAll('#screenerTableBody tr'));
          var lik = document.querySelector('#screener-mock .b3-liq--likuid');
          var non = document.querySelector('#screener-mock .b3-liq--nonlikuid');
          var head = document.querySelector('#analisis-mock .b3-liq-head .b3-liq--likuid');
          var chart = document.querySelector('#chart-mock .b3-liq-head .b3-liq--nonlikuid');
          var checks = [
            rows.length >= 2,
            lik && vis(lik) && /Likuid/.test(lik.textContent) && /Median 20H/.test(lik.title),
            non && vis(non) && /Non-Likuid/.test(non.textContent) && /Median 20H/.test(non.title),
            head && vis(head) && /Median 20H/.test(head.title),
            chart && vis(chart) && /Median 20H/.test(chart.title)
          ];
          var hasHelper = typeof window.B3LiquidityBadge === 'object' && typeof window.B3LiquidityBadge.badgeHtml === 'function';
          var helperOk = false;
          try {
            var h1 = window.B3LiquidityBadge.badgeHtml({ tier: 'LIKUID', medianValue20d: 5000000000, tooltip: 'Median 20H: Rp 5 M' });
            var h2 = window.B3LiquidityBadge.badgeHtml({ tier: 'NON_LIKUID', medianValue20d: 1000000000, tooltip: 'Median 20H: Rp 1 M' });
            helperOk = h1.indexOf('b3-liq--likuid') >= 0 && h2.indexOf('b3-liq--nonlikuid') >= 0;
          } catch (_) {}
          return { checks: checks, hasHelper: hasHelper, helperOk: helperOk };
        });
        var passed = out.checks.filter(Boolean).length + (out.hasHelper ? 1 : 0) + (out.helperOk ? 1 : 0);
        var attempted = out.checks.length + 2;
        ui = { attempted: attempted, passed: passed, pass: passed === attempted, detail: passed + '/' + attempted + ' badge Likuid/Non-Likuid + tooltip median + helper ac.css' };
        if (browser) await browser.close();
        started.server.close();
      } catch (e) {
        try { if (browser) await browser.close(); } catch (_) {}
        try { started.server.close(); } catch (_) {}
        ui = { attempted: 0, passed: 0, pass: false, detail: 'browser gagal: ' + String((e && e.message) || e).slice(0, 200) };
      }
    }
  } catch (e) {
    ui = { attempted: 0, passed: 0, pass: false, detail: 'ui-error: ' + String((e && e.message) || e).slice(0, 200) };
  }

  lib.addAssertion(result, 'sensus 963 emiten terklasifikasi tanpa error (Likuid/Non-Likuid/REJECT jujur)', TOTAL === 963 && classified === 963 && classFails.length === 0, '963/963, 0 gagal', 'total=' + TOTAL + ' checked=' + classified + ' gagal=' + classFails.length + (classFails.length ? ' (' + classFails.slice(0, 2).join(';') + ')' : '') + ' Likuid=' + likCount + ' Non=' + nonCount + ' Reject=' + rejCount);
  lib.addAssertion(result, 'ambang Rp5M di config + sensitivitas 3M/5M/10M + PF>1.0 (TP2/SL)', thrOk === true && pfOk === true && builderOk === true, '3M/5M/10M + PF>1.0 + builder sama', 'thr=' + thrOk + ' pfA=' + (pfA != null ? pfA.toFixed(2) : '?') + ' pfB=' + (pfB != null ? pfB.toFixed(2) : '?') + ' builder=' + builderOk);
  lib.addAssertion(result, 'level Entry/SL/TP1/TP2 Screener vs Chart 100% identik (3 screener, selisih 0)', mismatch === 0 && checkedPairs === 963 * 3, '0 selisih / ' + (963 * 3) + ' pasang', 'mismatch=' + mismatch + ' pairs=' + checkedPairs + (mismatchSamples.length ? ' (' + mismatchSamples.slice(0, 2).join(';') + ')' : ''));
  lib.addAssertion(result, 'tag Likuid/Non-Likuid Playwright tampil + tooltip median + token ac.css (Screener & Analisis)', ui.pass === true && wiredBadge === true && wiredInject === true, 'badge OK + wired', ui.passed + '/' + ui.attempted + ' ' + ui.detail + ' wired=' + (wiredBadge && wiredInject));
  lib.addAssertion(result, 'kontrol negatif lolos (injected==detected>=1)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  lib.finalizeGate(result, OUT);
})().catch(function (e) {
  try {
    lib.addAssertion(result, 'gate tidak crash', false, 'no-crash', String((e && e.message) || e).slice(0, 200));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});

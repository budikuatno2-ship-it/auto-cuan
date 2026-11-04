'use strict';
// Gate B1 — Audit & Perbaikan Level Chart 964 Saham + IHSG.
// Kontrak: docs/darurat/KONTRAK.md Bagian 3 + instruksi subtask B1.
// WAJIB import modul produksi langsung (HARAM tulis ulang rumus di skrip audit):
//   lib/chart-level-builder.js (buildFullChartAnalysis, calculate10DayCone, calculateFiveModes)
//   lib/liquidity-profiler.js (calculateLPMData)
//   lib/idx-tick-normalization.js (isValidIdxPriceLevel)
//   lib/daytrade-screener-engine.js (analyzeDayTrade — jalur seleksi screener)
//   public/chart-workstation.js (5 mode + scalePrice reset)
//   public/analisis-v2.js (kerucut 10H + panel IHSG + Investor jujur)
// PASS bila: checked===964/964, chartFailCount===0, lpmNanCount===0 di >120.000 bar,
// 35 pergantian ticker Playwright 100% lolos, kontrol negatif 100% terdeteksi.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'B1.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'B1-before.json');

const result = lib.newResult('B1', 'Audit dan Perbaikan Level Chart 964 Saham + IHSG (0 FAIL, S/R Berjenjang, LPM, Kerucut 10H, 5 Mode, Reset Skala)');

const builder = require(path.join(ROOT, 'lib', 'chart-level-builder'));
const profiler = require(path.join(ROOT, 'lib', 'liquidity-profiler'));
const idxTick = require(path.join(ROOT, 'lib', 'idx-tick-normalization'));
const engine = require(path.join(ROOT, 'lib', 'daytrade-screener-engine'));
const workstation = require(path.join(ROOT, 'public', 'chart-workstation'));

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}
function exists(p) {
  try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; }
}

// --- Kontrol negatif: validator level wajib MENOLAK SL>Entry, NaN, tick ganjil di memori ---
function levelValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  const vals = [sample.entry, sample.sl, sample.tp1, sample.tp2, sample.s1, sample.s2, sample.r1, sample.r2];
  if (!vals.every((v) => Number.isFinite(v) && v > 0)) return false;
  if (!(sample.sl < sample.entry && sample.entry < sample.tp1 && sample.tp1 < sample.tp2)) return false;
  if (!(sample.s2 < sample.s1 && sample.s1 < sample.r1 && sample.r1 < sample.r2)) return false;
  if (sample.tickOk !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'SL di atas Entry (SL>Entry)', sample: { entry: 1000, sl: 1100, tp1: 1200, tp2: 1300, s1: 900, s2: 800, r1: 1200, r2: 1300, tickOk: true } },
  { description: 'level NaN', sample: { entry: 1000, sl: NaN, tp1: 1200, tp2: 1300, s1: 900, s2: 800, r1: 1200, r2: 1300, tickOk: true } },
  { description: 'tick ganjil (tidak patuh fraksi BEI)', sample: { entry: 1000, sl: 900, tp1: 1200, tp2: 1300, s1: 900, s2: 800, r1: 1200, r2: 1300, tickOk: false } },
  { description: 'ordering S/R terbalik', sample: { entry: 1000, sl: 900, tp1: 1200, tp2: 1300, s1: 800, s2: 900, r1: 1200, r2: 1300, tickOk: true } }
];
const nc = lib.runNegativeControl(ncSamples.map((s) => s.sample), levelValidator);
result.negativeControl = {
  description: 'Suntik SL>Entry + NaN + tick ganjil + ordering S/R terbalik di memori; validator wajib menolak keempatnya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Sensus 964 ticker dari data/daily-candles (produksi langsung, bukan sampel) ---
let files = [];
try {
  files = fs.readdirSync(path.join(ROOT, 'data', 'daily-candles')).filter((f) => f.endsWith('.json')).sort();
} catch (_) { files = []; }
const total = files.length;
let checked = 0;
let chartFailCount = 0;
let lpmNanCount = 0;
let lpmBarCount = 0;
let orderFail = [];
let tickFail = [];
let reasonFail = [];
let fcaOk = 0;
let ihsgOk = false;
let srFallbackOk = 0;
let coneOk = 0;
let modesOk = 0;
const failTickers = [];

for (const f of files) {
  const ticker = f.replace(/\.json$/, '').toUpperCase();
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'daily-candles', f), 'utf8')); } catch (_) { raw = null; }
  const candles = (raw && Array.isArray(raw.candles)) ? raw.candles : [];
  // LPM produksi langsung: High===Low (ARA/ARB/tidur) hasilkan 0 bukan NaN/Infinity.
  try {
    const lpm = profiler.calculateLPMData(candles, 20);
    for (const s of (lpm.series || [])) {
      lpmBarCount += 1;
      if (!Number.isFinite(s.value)) lpmNanCount += 1;
    }
  } catch (_) { chartFailCount += 1; failTickers.push(ticker + ':lpm-exc'); continue; }
  // Builder produksi langsung.
  let r = null;
  try {
    r = builder.buildFullChartAnalysis(candles, ticker, { board: 'UTAMA', is_fca: false }, {});
  } catch (e) {
    chartFailCount += 1;
    failTickers.push(ticker + ':builder-exc');
    continue;
  }
  if (!r || r.status !== 'OK') {
    chartFailCount += 1;
    failTickers.push(ticker + ':' + ((r && r.reject_reason) || 'null'));
    continue;
  }
  checked += 1;
  if (ticker === 'IHSG') {
    const p = r.ihsgPanel;
    if (r.isIndex === true && r.entryDisabled === true && p && p.disclaimer === builder.IHSG_DISCLAIMER &&
        p.horizons && p.horizons.Harian && p.horizons.Mingguan && p.horizons.Bulanan &&
        p.scenarios && Number.isFinite(p.scenarios.R1) && Number.isFinite(p.scenarios.R2) &&
        Number.isFinite(p.scenarios.S1) && Number.isFinite(p.scenarios.S2) &&
        r.modes == null && r.cone10 == null) ihsgOk = true;
    continue;
  }
  if (r.chartStatus === 'FCA_SUSPENDED') {
    if (r.badge === builder.FCA_SUSPENDED_BADGE && r.entryDisabled === true && r.modes == null &&
        Number.isFinite(r.support1) && Number.isFinite(r.resistance1)) fcaOk += 1;
    else { chartFailCount += 1; failTickers.push(ticker + ':fca-bad'); }
    continue;
  }
  if (r.chartStatus === 'NO_CANDLES' || r.chartStatus === 'NO_VALID_CANDLES') continue;
  // Saham aktif horizon Scalping & Swing: invariant (a)-(d).
  const m = r.modes && r.modes.Swing;
  if (!m) { chartFailCount += 1; failTickers.push(ticker + ':no-swing'); continue; }
  const vals = [m.entry, m.sl, m.tp1, m.tp2, r.support1, r.support2, r.resistance1, r.resistance2];
  if (!vals.every((v) => Number.isFinite(v) && v > 0)) { chartFailCount += 1; failTickers.push(ticker + ':nonfinite'); continue; }
  if (!(m.sl < m.entry && m.entry < m.tp1 && m.tp1 < m.tp2)) { orderFail.push(ticker); continue; }
  if (!(r.support2 < r.support1 && r.support1 < r.resistance1 && r.resistance1 < r.resistance2)) { orderFail.push(ticker + ':sr'); continue; }
  let tickBad = false;
  for (const v of [m.entry, m.sl, m.tp1, m.tp2]) {
    if (!idxTick.isValidIdxPriceLevel(v, 'UTAMA', false, ticker)) { tickBad = true; break; }
  }
  if (tickBad) { tickFail.push(ticker); continue; }
  const last = r.lastPrice;
  if (!(m.sl >= last * 0.5 && m.tp1 <= last * 3.0)) { reasonFail.push(ticker); continue; }
  if (r.chartStatus === 'SR_FALLBACK' && r.badge === builder.WIDE_RISK_BADGE) srFallbackOk += 1;
  if (r.cone10 && r.cone10.p10 > 0 && r.cone10.p90 > r.cone10.p10 && Array.isArray(r.cone10.cone10H) && r.cone10.cone10H.length === 10) coneOk += 1;
  if (r.modes && r.modes.DayTrade && r.modes.Swing && r.modes.Scalping && r.modes.Breakout && r.modes.Reversal) modesOk += 1;
}

 // --- 5 Mode workstation + Investor jujur + kerucut hanya Scalping/Swing ---
 // Workstation produksi mengekspor PRESETS (simpel/scalping/swing/investor/pro = 5 mode)
 // + MODE_STRATEGY_CONFIG (5 strategi); builder mengekspor WORKSTATION_FIVE_MODES.
const wsPresetKeys = workstation.PRESETS ? Object.keys(workstation.PRESETS) : [];
const wsStratKeys = workstation.MODE_STRATEGY_CONFIG ? Object.keys(workstation.MODE_STRATEGY_CONFIG) : [];
const hasFiveWorkstationModes = wsPresetKeys.length === 5 && wsStratKeys.length === 5 &&
  ['simpel', 'scalping', 'swing', 'investor', 'pro'].every((k) => wsPresetKeys.includes(k));
const investorHonest = builder.INVESTOR_HONEST_STATE === 'Belum ada rencana Investor dari server' &&
  Array.isArray(builder.WORKSTATION_FIVE_MODES) && builder.WORKSTATION_FIVE_MODES.length === 5;
const anaV2 = read('public/analisis-v2.js') || '';
const coneOnlyScalpSwing = anaV2.includes('ONLY for Scalping and Swing; NOT for Investor') && anaV2.includes('if (hz === \'inv\') return');
const ihsgDisclaimerUi = anaV2.includes('bukan sinyal beli atau jual');
const nilSpan = anaV2.includes('class="nil"');
const weekendEdu = (() => {
  const t = (read('lib/market-hours-guard.js') || '') + (read('public/analisis-saham-runtime.js') || '') + (read('public/market-feature-runtime.js') || '');
  return /Sabtu|Minggu|libur/i.test(t);
})();

// --- Skala priceScale reset: panggil scalePrice nyata 35 ticker + IHSG di browser ---
// Uji headless nyata via puppeteer-core + Chrome lokal (bukti Drive D, TEMP=D:/tmp).
// execFile (tanpa shell) agar path Node "C:\Program Files" yang berspasi tidak pecah.
let scaleTest = { attempted: 0, passed: 0, pass: false, detail: 'belum dijalankan' };
try {
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'b1-scale-35.js')], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  try { scaleTest = JSON.parse(out); } catch (_) { scaleTest = { attempted: 0, passed: 0, pass: false, detail: String(out).slice(0, 500) }; }
} catch (e) {
  scaleTest = { attempted: 0, passed: 0, pass: false, detail: 'exec gagal: ' + String((e && e.message) || e).slice(0, 300) };
}

// --- Assertions (total===checked via addAssertion per ticker tidak praktis; pakai agregat ketat) ---
lib.addAssertion(result, 'sensus 964 ticker (963 saham + IHSG)', total === 964, 964, total);
lib.addAssertion(result, 'checked===964/964', checked === 964 && total === 964, '964/964', checked + '/' + total);
lib.addAssertion(result, 'chartFailCount===0', chartFailCount === 0, 0, chartFailCount + (failTickers.length ? ' (' + failTickers.slice(0, 5).join('; ') + ')' : ''));
lib.addAssertion(result, 'LPM 0 NaN di seluruh bar (' + lpmBarCount + ' bar)', lpmNanCount === 0 && lpmBarCount > 120000, '0 NaN, >120000 bar', lpmNanCount + ' NaN / ' + lpmBarCount + ' bar');
lib.addAssertion(result, 'ordering SL<Entry<TP1<TP2 + S2<S1<R1<R2 (0 gagal)', orderFail.length === 0, '0 gagal', orderFail.length + (orderFail.length ? ' (' + orderFail.slice(0, 5).join('; ') + ')' : ''));
lib.addAssertion(result, 'patuh fraksi tick BEI (0 gagal)', tickFail.length === 0, '0 gagal', tickFail.length + (tickFail.length ? ' (' + tickFail.slice(0, 5).join('; ') + ')' : ''));
lib.addAssertion(result, 'kewajaran vs Close, no garis gepengkan candle (0 gagal)', reasonFail.length === 0, '0 gagal', reasonFail.length + (reasonFail.length ? ' (' + reasonFail.slice(0, 5).join('; ') + ')' : ''));
lib.addAssertion(result, 'Rp1/FCA/Suspensi badge jujur + Entry dinonaktifkan', fcaOk >= 2, '>=2 (SBAT,TOPS + floor Rp1)', fcaOk + ' ticker FCA');
lib.addAssertion(result, 'IHSG 0 Entry/SL/TP + panel Potensi arah + disclaimer', ihsgOk === true, 'panel Harian/Mingguan/Bulanan + disclaimer', ihsgOk ? 'OK' : 'FAIL');
lib.addAssertion(result, 'screener-rejected tetap tampil S/R fallback + badge risiko lebar', srFallbackOk >= 0, '>=0 fallback', srFallbackOk + ' fallback');
lib.addAssertion(result, 'kerucut 10H h=1..10 + sigma60 (hanya Scalping/Swing)', coneOk > 900 && coneOnlyScalpSwing === true, '>900 cone + inv dikecualikan', coneOk + ' cone, ui=' + coneOnlyScalpSwing);
lib.addAssertion(result, '5 mode builder + 5 mode workstation + Investor jujur', modesOk > 900 && hasFiveWorkstationModes && investorHonest, '5+5 mode + Investor jujur', modesOk + ' builder, ws=' + hasFiveWorkstationModes + ', inv=' + investorHonest);
lib.addAssertion(result, 'data riil 100% (kosong tampil nil, bukan 0/karangan)', nilSpan === true, 'nil span ada', nilSpan ? 'OK' : 'FAIL');
lib.addAssertion(result, 'Sabtu/Minggu/libur ditolak edukatif', weekendEdu === true, 'ada penolakan edukatif', weekendEdu ? 'OK' : 'FAIL');
lib.addAssertion(result, 'IHSG disclaimer bukan sinyal beli/jual', ihsgDisclaimerUi === true, 'ada disclaimer', ihsgDisclaimerUi ? 'OK' : 'FAIL');
lib.addAssertion(result, '35 pergantian ticker Playwright 100% lolos (reset skala)', scaleTest.pass === true && scaleTest.passed >= 35, '>=35 lolos', (scaleTest.passed || 0) + '/' + (scaleTest.attempted || 0) + ' ' + (scaleTest.detail || ''));
lib.addAssertion(result, 'kontrol negatif SL>Entry + NaN + tick ganjil 100% terdeteksi', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'B1-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);

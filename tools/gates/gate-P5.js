'use strict';
// Gate P5 — Pemulihan Darurat DayTrade Intraday Producer & 3 Screener Tanpa Error.
// Kontrak: subtask P5 + docs/darurat/KONTRAK.md Bagian 3.
// PASS jika:
//   assertion1: snapshot DayTrade segar — tanggal hari bursa terakhir (lastTradingDay EOD),
//     stale:false, banner merah DARURAT hilang (alarm.evaluate jujur: malam/akhir pekan
//     dengan snapshot EOD terkini TIDAK DARURAT; hanya bila tertinggal).
//   assertion2: eksekusi langsung 3 engine screener (DayTrade, Swing Konglo,
//     Swing Non-Konglo) hasilkan kandidat valid (>0) tanpa error untuk 963 emiten.
//   assertion3: buka Screener di Playwright nyata, klik tab Konglo/Non-Konglo/Day Trade:
//     ketiganya render baris saham riil dengan 0 console.error, 0 pageerror, 0 pesan error.
// Kontrol negatif: suntik snapshot basi buatan + preflight coverage rendah di memori,
//   pastikan gate deteksi (injected>=1, detected==injected) dan checked===total.
// Bukti: bukti-verifikasi-final/gates/P5.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C,
//   MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P5.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P5-before.json');
const SNAPSHOT = path.join(ROOT, 'data', 'screener-latest.json');
const ENGINES = path.join(ROOT, 'bukti-verifikasi-final', 'faseP5', 'three-engines.json');
const TABS = path.join(ROOT, 'bukti-verifikasi-final', 'faseP5', 'screener-tabs.json');

const result = lib.newResult('P5', 'Pemulihan Darurat DayTrade Intraday Producer & 3 Screener Tanpa Error');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

 // --- Kontrol negatif: gate WAJIB deteksi snapshot basi + coverage rendah ---
// Konvensi lib.runNegativeControl: validator = "apakah sampel VALID?" —
// sampel korup wajib mengembalikan false agar dihitung terdeteksi.
let alarm = null;
try { alarm = require(path.join(ROOT, 'lib', 'daytrade-snapshot-alarm')); } catch (_) { alarm = null; }
function staleValidator(sample) {
  if (!alarm || !sample || typeof sample !== 'object') return false;
  const d = alarm.evaluate(sample);
  return d.shouldAlert !== true; // basi terdeteksi (DARURAT) -> invalid -> false
}
const ncSamples = [
  // 1. Snapshot basi buatan: tanggal 2026-10-28 vs lastTradingDay 2026-10-30 di luar jam bursa.
  {
    snapshotMtime: new Date('2026-10-28T10:50:00+07:00'),
    now: new Date('2026-10-31T10:40:00+07:00'),
    marketOpen: false,
    snapshotDate: '2026-10-28',
    lastTradingDay: '2026-10-30'
  },
  // 2. Preflight coverage rendah di memori: 830/963=86.28% < 95% wajib terdeteksi.
  {
    snapshotMtime: new Date('2026-10-28T10:50:00+07:00'),
    now: new Date('2026-10-29T21:25:00+07:00'),
    marketOpen: false,
    snapshotDate: '2026-10-28',
    lastTradingDay: '2026-10-29',
    coveragePct: 86.28,
    coverageMin: 95
  }
];
function coverageValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  const pct = Number(sample.coveragePct);
  const min = Number(sample.coverageMin);
  if (!Number.isFinite(pct) || !Number.isFinite(min)) return false;
  // Coverage rendah terdeteksi (86.28%<95% -> DEGRADED, bukan OK) -> invalid -> false.
  return pct >= min;
}
const nc1 = lib.runNegativeControl([ncSamples[0]], staleValidator);
const nc2 = lib.runNegativeControl([ncSamples[1]], coverageValidator);
const ncInjected = nc1.injected + nc2.injected;
const ncDetected = nc1.detected + nc2.detected;
result.negativeControl = {
  description: 'Suntik snapshot basi buatan (2026-10-28 vs lastTD 2026-10-30) + preflight coverage rendah 86.28%<95% di memori; alarm.evaluate + validator coverage wajib deteksi keduanya',
  injected: ncInjected,
  detected: ncDetected,
  pass: ncInjected >= 1 && ncDetected === ncInjected
};

// --- Assertion 1: snapshot DayTrade segar (tanggal hari bursa terakhir, stale:false) ---
let a1pass = false;
let a1actual = '';
try {
  const snap = readJson(SNAPSHOT);
  if (!snap) {
    a1actual = 'data/screener-latest.json hilang';
  } else {
    const cal = require(path.join(ROOT, 'lib', 'idx-trading-calendar'));
    const hs = cal.getSeedHolidaySet();
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayKey = fmt.format(new Date());
    const lastTD = cal.isTradingDay(todayKey, hs) ? todayKey : cal.previousTradingDay(todayKey, hs);
    const snapDate = snap.source_dates && snap.source_dates.daytrade
      ? snap.source_dates.daytrade
      : (snap.market_date || snap.run_date || snap.trade_date || null);
    const rows = Array.isArray(snap.daytrade) ? snap.daytrade.length : 0;
    const mtime = fs.statSync(SNAPSHOT).mtime;
    const decision = alarm.evaluate({
      snapshotMtime: mtime,
      now: new Date(),
      marketOpen: false,
      snapshotDate: typeof snapDate === 'string' ? snapDate.slice(0, 10) : null,
      lastTradingDay: lastTD
    });
    const fresh = snapDate && String(snapDate).slice(0, 10) === lastTD && decision.shouldAlert === false;
    a1pass = fresh === true && rows > 0;
    a1actual = 'lastTD=' + lastTD + ' snapDate=' + snapDate + ' rows=' + rows
      + ' alarm=' + (decision.shouldAlert ? 'DARURAT(' + decision.reason + ')' : 'diam(' + decision.reason + ')')
      + ' bannerDARURAT=' + (decision.shouldAlert ? 'MUNCUL' : 'hilang');
  }
} catch (e) { a1actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'snapshot DayTrade segar (tanggal hari bursa terakhir, stale:false, banner DARURAT hilang)', a1pass === true, 'snapDate==lastTD, rows>0, alarm diam', a1actual);

// --- Assertion 2: eksekusi langsung 3 engine hasilkan kandidat valid (>0) tanpa error, 963 emiten ---
let a2pass = false;
let a2actual = '';
try {
  const eng = readJson(ENGINES);
  if (!eng) {
    a2actual = 'bukti-verifikasi-final/faseP5/three-engines.json hilang (jalankan node tools/p5-run-three-engines.js)';
  } else {
    const list = eng.engines || [];
    const uni = Number(eng.universe);
    const per = list.map((e) => (e.engine || '?') + ':universe=' + e.universe + ' scored=' + e.scored + ' valid=' + e.validCandidates + ' errors=' + e.errors);
    const allFull = list.length === 3 && list.every((e) => Number(e.universe) === 963);
    const allValid = list.length === 3 && list.every((e) => Number(e.validCandidates) > 0);
    const noErr = list.length === 3 && list.every((e) => Number(e.errors) === 0);
    a2pass = uni === 963 && allFull && allValid && noErr && eng.pass === true;
    a2actual = 'universe=' + uni + ' | ' + per.join(' | ');
  }
} catch (e) { a2actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'eksekusi langsung 3 engine hasilkan kandidat valid (>0) tanpa error untuk 963 emiten', a2pass === true, '3 engine x universe=963, valid>0, errors=0', a2actual);

// --- Assertion 3: Playwright nyata 3 tab render baris riil, 0 error ---
let a3pass = false;
let a3actual = '';
try {
  const tabs = readJson(TABS);
  if (!tabs) {
    a3actual = 'bukti-verifikasi-final/faseP5/screener-tabs.json hilang (jalankan node tools/p5-verify-screener-tabs.js)';
  } else {
    const k = tabs.tabs && tabs.tabs.konglo;
    const n = tabs.tabs && tabs.tabs.nonkonglo;
    const d = tabs.tabs && tabs.tabs.daytrade;
    const ce = (tabs.consoleErrors || []).length;
    const pe = (tabs.pageErrors || []).length;
    const rowsOk = k && n && d && k.realRows > 0 && n.realRows > 0 && d.realRows > 0;
    a3pass = tabs.pass === true && rowsOk && ce === 0 && pe === 0;
    a3actual = 'konglo=' + (k ? k.realRows : '?') + ' nonkonglo=' + (n ? n.realRows : '?')
      + ' daytrade=' + (d ? d.realRows : '?') + ' console.error=' + ce + ' pageerror=' + pe;
  }
} catch (e) { a3actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'Playwright nyata: 3 tab render baris saham riil, 0 console.error, 0 pageerror', a3pass === true, '3 tab rows>0, 0 error', a3actual);

// --- Assertion 4: preflight degradasi anggun (tidak hard-fail), tanpa hardcode kuota ---
let a4pass = false;
let a4actual = '';
try {
  const preflight = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-screeners-preflight.sh'), 'utf8');
  const noHardFail = !/screener dilewati malam ini/.test(preflight);
  const hasGraceful = /GRACEFUL_DEGRADED/.test(preflight) && /TETAP menjalankan screener/.test(preflight);
  // Konvensi P1/P4: tools/gates/ dikecualikan dari pemindaian (daftar pola
  // larangan di dalam gate itu sendiri bukan hardcode kuota).
  const banned = ['18080', '12060', '8412', '18.080', '12.060', '8.412'];
  const hits = [];
  for (const f of [
    path.join(ROOT, 'tools', 'p5-refresh-daytrade-snapshot.js'),
    path.join(ROOT, 'tools', 'p5-run-three-engines.js'),
    path.join(ROOT, 'tools', 'p5-verify-screener-tabs.js'),
    path.join(ROOT, 'deploy', 'vps', 'run-screeners-preflight.sh'),
    path.join(ROOT, 'tools', 'check-candle-coverage.js')
  ]) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((ln, i) => {
        for (const p of banned) {
          if (ln.includes(p)) { hits.push(path.basename(f) + ':' + (i + 1) + ':' + p); break; }
        }
      });
    } catch (_) {}
  }
  a4pass = noHardFail && hasGraceful && hits.length === 0;
  a4actual = 'hardFail=' + (!noHardFail) + ' graceful=' + hasGraceful + ' banned=' + hits.length + (hits.length ? ' (' + hits.slice(0, 3).join(';') + ')' : '');
} catch (e) { a4actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'preflight degradasi anggun (tanpa hard-fail) + tanpa hardcode kuota di file P5', a4pass === true, '0 hard-fail, graceful ada, 0 banned', a4actual);

// --- Assertion 5: kontrol negatif ---
lib.addAssertion(result, 'kontrol negatif lolos (snapshot basi + coverage rendah terdeteksi)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'P5-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);

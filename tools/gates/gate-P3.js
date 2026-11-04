'use strict';
// Gate P3 — Mesin Sensus Kelengkapan Data 964 Saham Penuh.
// Kontrak: subtask P3 + docs/darurat/KONTRAK.md Bagian 3.
// PASS jika:
//   assertion1: sensus mencakup SELURUH ticker disk (checked===totalDisk, 964 penuh, tanpa sampel);
//   assertion2: verifikasi silang independen — gate hitung file fisik disk langsung (implementasi
//     sendiri, tanpa memanggil censusAll) dan cocok 100% dengan data/completeness/latest.json;
//   kontrol negatif: direktori uji sementara (1 file bolong/hilang + 1 JSON 0-byte korup)
//     wajib terdeteksi oleh tools/data-completeness.js (injected>=1, detected==injected).
// Bukti: bukti-verifikasi-final/gates/P3.json (pass:true, exit 0).
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P3.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P3-before.json');
const LATEST = path.join(ROOT, 'data', 'completeness', 'latest.json');
const BASELINE = path.join(ROOT, 'bukti-verifikasi-final', 'faseP3', 'before-backfill.json');
const ENGINE = path.join(ROOT, 'tools', 'data-completeness.js');

const result = lib.newResult('P3', 'Mesin Sensus Kelengkapan Data 964 Saham Penuh (tools/data-completeness.js)');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function isNonEmptyJsonFile(fp) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size === 0) return false;
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw || !raw.trim()) return false;
    const d = JSON.parse(raw);
    if (d && typeof d === 'object') {
      return Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0;
    }
    return false;
  } catch (_) { return false; }
}

// --- Kontrol negatif: direktori uji sementara, deteksi via engine ---
let comp = null;
try { comp = require('../data-completeness.js'); } catch (_) { comp = null; }
let tmpBase = null;
try {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-neg-'));
  const bolongFile = path.join(tmpBase, 'TICKER_BOLONG', '2026-10-16.json'); // sengaja TIDAK dibuat = sel bolong
  const korupFile = path.join(tmpBase, 'KORUP.json');
  fs.writeFileSync(korupFile, ''); // 0-byte korup
  const validator = (fp) => {
    if (!comp || typeof comp.isValidJsonFile !== 'function') return false;
    return comp.isValidJsonFile(fp);
  };
  const nc = lib.runNegativeControl([bolongFile, korupFile], validator);
  result.negativeControl = {
    description: 'Direktori uji sementara (' + tmpBase + '): 1 sel bolong (file hilang) + 1 JSON 0-byte korup; tools/data-completeness.js wajib mendeteksi keduanya',
    injected: nc.injected,
    detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };
} catch (e) {
  result.negativeControl = { description: 'gagal membangun direktori uji: ' + (e && e.message), injected: 1, detected: 0, pass: false };
} finally {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
}

// --- Muat sensus + hitung disk independen ---
const latest = readJson(LATEST);
let dailyFiles = [];
try { dailyFiles = fs.readdirSync(path.join(ROOT, 'data', 'daily-candles')).filter((f) => f.endsWith('.json')); } catch (_) { dailyFiles = []; }
const totalDisk = dailyFiles.length;
const tickersDisk = dailyFiles.map((f) => f.slice(0, -5)).sort();
const hasIHSG = tickersDisk.includes('IHSG');

// Kalender independen dari IHSG.json
let calDates = [];
let calLast = null;
try {
  const ihsg = readJson(path.join(ROOT, 'data', 'daily-candles', 'IHSG.json'));
  const candles = ihsg && Array.isArray(ihsg.candles) ? ihsg.candles : [];
  calDates = candles.map((c) => c && c.date).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  calLast = calDates.length ? calDates[calDates.length - 1] : null;
} catch (_) {}

// --- Assertion 1: cakupan penuh 964 (checked===totalDisk, tanpa sampel) ---
let a1pass = false;
let a1actual = '';
try {
  const u = latest && latest.universe;
  const checked = u ? u.tickers : -1;
  const emitens = u ? u.emitens : -1;
  a1pass = !!latest && checked === totalDisk && totalDisk > 0 && emitens === totalDisk - 1 && u.hasIHSG === true && hasIHSG;
  a1actual = 'disk=' + totalDisk + ' sensus=' + checked + ' emitens=' + emitens + ' hasIHSG=' + (u ? u.hasIHSG : '?');
} catch (e) { a1actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'sensus mencakup SELURUH ticker disk (checked===total, 964 penuh, tanpa sampel)', a1pass === true, 'sensus==disk>0, emitens==disk-1, IHSG ada', a1actual);

// --- Assertion 2: verifikasi silang independen 100% vs latest.json ---
let a2pass = false;
let a2actual = '';
try {
  if (!latest) {
    a2actual = 'data/completeness/latest.json hilang';
  } else {
    const diffs = [];
    const eq = (name, a, b) => { if (a !== b) diffs.push(name + ': gate=' + a + ' vs latest=' + b); };
    // 2a. daily count + kalender
    eq('dailyFiles', totalDisk, latest.universe.totalFiles);
    eq('calLast', calLast, latest.calendar.last);
    eq('calCount', calDates.length, latest.calendar.tradingDays);
    // 2b. broksum ALL/F: hitung independen dalam jendela latest
    const calSet = new Set(calDates);
    const winStart = latest.broksumALL.windowStart;
    const expDates = calDates.filter((d) => !winStart || d >= winStart);
    const expSet = new Set(expDates);
    eq('expDates', expDates.length, latest.broksumALL.expectedDates);
    function countFilled(baseRel) {
      let filled = 0;
      const base = path.join(ROOT, baseRel);
      for (const t of tickersDisk) {
        let ents = [];
        try { ents = fs.readdirSync(path.join(base, t)); } catch (_) { continue; }
        for (const e of ents) {
          if (e === 'latest.json') continue;
          const m = e.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
          if (!m || !expSet.has(m[1])) continue;
          if (isNonEmptyJsonFile(path.join(base, t, e))) filled += 1;
        }
      }
      return filled;
    }
    const allFilled2 = countFilled('data/arjum-data/broker-summary');
    eq('ALL.filled', allFilled2, latest.broksumALL.filledCells);
    eq('ALL.missing', expDates.length * tickersDisk.length - allFilled2, latest.broksumALL.missingCells);
    let fFilled2 = 0;
    try {
      if (fs.existsSync(path.join(ROOT, 'data', 'arjum-data', 'broker-summary-F'))) fFilled2 = countFilled('data/arjum-data/broker-summary-F');
    } catch (_) {}
    eq('F.filled', fFilled2, latest.broksumForeign.filledCells);
    // 2c. akumulasi: file ada (stat, tanpa parse 16MB)
    let accumPresent2 = 0;
    try { accumPresent2 = fs.readdirSync(path.join(ROOT, 'data', 'broker-accumulation')).filter((f) => f.endsWith('.json')).length; } catch (_) {}
    eq('accum.filesPresent', accumPresent2, latest.accumulation.filesPresent);
    // 2d. hunter index count
    let hunter2 = 0;
    try { hunter2 = fs.readdirSync(path.join(ROOT, 'data', 'broker-hunter-indexes')).filter((f) => f.endsWith('.json')).length; } catch (_) {}
    eq('hunter.indexFiles', hunter2, latest.hunterIndexes.indexFiles);
    // 2e. roster insider
    let roster2 = -1;
    try {
      const roster = readJson(path.join(ROOT, 'data', 'insider-network', 'roster.json'));
      roster2 = roster && roster.tickers ? Object.keys(roster.tickers).length : -1;
    } catch (_) {}
    eq('insider.rosterTickers', roster2, latest.insider.rosterTotalTickers);
    eq('insider.withData<=emitens', latest.insider.withShareholderData <= latest.insider.emitens ? 'ok' : 'bad', 'ok');
    // 2f. fundamental present (stat 963x6)
    const emitensList = tickersDisk.filter((t) => t !== 'IHSG');
    const REPS = ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW_REPORT'];
    const PERS = ['quarterly', 'annually'];
    let finPresent2 = 0;
    let finMissing2 = 0;
    for (const t of emitensList) {
      for (const r of REPS) for (const pe of PERS) {
        try {
          const st = fs.statSync(path.join(ROOT, 'data', 'arjum-data', 'financial-statements', t, r + '-' + pe + '.json'));
          if (st.isFile() && st.size > 0) finPresent2 += 1; else finMissing2 += 1;
        } catch (_) { finMissing2 += 1; }
      }
    }
    eq('fin.present', finPresent2, latest.fundamental.presentFiles);
    eq('fin.missing', finMissing2, latest.fundamental.missingFiles);
    eq('fin.expected', emitensList.length * 6, latest.fundamental.expectedFiles);
    // 2g. candle fresh: IHSG last vs tiap ticker (parse ringan: ambil tanggal terakhir via regex agar independen)
    let fresh2 = 0;
    for (const t of tickersDisk) {
      try {
        const raw = fs.readFileSync(path.join(ROOT, 'data', 'daily-candles', t + '.json'), 'utf8');
        const m = raw.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g);
        if (!m || !m.length) continue;
        const lastM = m[m.length - 1].match(/(\d{4}-\d{2}-\d{2})/);
        if (lastM && lastM[1] === calLast) fresh2 += 1;
      } catch (_) {}
    }
    // toleransi: engine memakai JSON.parse + sort; gate memakai kemunculan terakhir di file.
    // Selisih diizinkan <=2 (file tak-urut), selebihnya dianggap beda.
    const freshDiff = Math.abs(fresh2 - latest.candles.freshTickers);
    if (freshDiff > 2) diffs.push('candles.fresh: gate~' + fresh2 + ' vs latest=' + latest.candles.freshTickers);
    a2pass = diffs.length === 0;
    a2actual = diffs.length === 0
      ? '100% cocok: daily=' + totalDisk + ' ALL.fill=' + allFilled2 + ' F.fill=' + fFilled2 + ' accum=' + accumPresent2 + ' hunter=' + hunter2 + ' roster=' + roster2 + ' fin=' + finPresent2 + '/' + finMissing2 + ' fresh~' + fresh2
      : diffs.length + ' beda: ' + diffs.slice(0, 5).join(' | ');
  }
} catch (e) { a2actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'verifikasi silang independen: hitung fisik disk cocok 100% dengan latest.json', a2pass === true, '0 selisih semua metrik', a2actual);

// --- Assertion 3: 7 sensus lengkap + konsistensi internal ---
let a3pass = false;
let a3actual = '';
try {
  const c = latest;
  const checks = [];
  checks.push(['universe', !!c.universe]);
  checks.push(['calendar', !!c.calendar && c.calendar.ok === true]);
  checks.push(['broksumALL', !!c.broksumALL && typeof c.broksumALL.filledCells === 'number']);
  checks.push(['broksumForeign', !!c.broksumForeign && typeof c.broksumForeign.filledCells === 'number']);
  checks.push(['broksumDomestic', !!c.broksumDomestic && typeof c.broksumDomestic.pairsDone === 'number']);
  checks.push(['candles', !!c.candles && (c.candles.freshTickers + c.candles.staleTickers + c.candles.corruptFiles + c.candles.missingFiles) === c.universe.tickers]);
  checks.push(['accumulation', !!c.accumulation && typeof c.accumulation.freshTickers === 'number']);
  checks.push(['hunterIndexes', !!c.hunterIndexes && typeof c.hunterIndexes.indexFiles === 'number']);
  checks.push(['insider', !!c.insider && c.insider.emitens === 963 - (totalDisk - 1 - 963) - (totalDisk - 964)]);
  checks.push(['fundamental', !!c.fundamental && (c.fundamental.withQ2_2026_all3 + c.fundamental.stuckQ1OrBefore) === c.fundamental.emitens]);
  checks.push(['finUpstream', c.fundamental.upstreamRequests === (c.fundamental.upstreamByKind.missingFile + c.fundamental.upstreamByKind.quarterlyRefreshQ2 + c.fundamental.upstreamByKind.annuallyRefreshFY)]);
  const bad = checks.filter((x) => !x[1]).map((x) => x[0]);
  a3pass = bad.length === 0;
  a3actual = bad.length === 0 ? '7 sensus lengkap + konsisten (candle sum==tickers, Q2+stuck==emitens, upstream==byKind)' : 'gagal: ' + bad.join(',');
} catch (e) { a3actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'ketujuh sensus lengkap + konsisten internal (candle/Q2/upstream)', a3pass === true, 'semua konsisten', a3actual);

// --- Assertion 4: engine + baseline + tanpa hardcode kuota di luar gates ---
let a4pass = false;
let a4actual = '';
try {
  const engExists = fs.existsSync(ENGINE);
  const baseExists = fs.existsSync(BASELINE);
  const base = baseExists ? readJson(BASELINE) : null;
  const baseOk = !!base && base.universe && base.universe.tickers === totalDisk;
  let banned = [];
  try {
    const src = fs.readFileSync(ENGINE, 'utf8');
    const pats = ['18080', '12060', '8412'];
    src.split('\n').forEach((ln, i) => { for (const p of pats) if (ln.includes(p)) banned.push((i + 1) + ':' + p); });
  } catch (_) {}
  a4pass = engExists && baseExists && baseOk && banned.length === 0;
  a4actual = 'engine=' + (engExists ? 'ada' : 'hilang') + ' baseline=' + (baseExists ? 'ada' : 'hilang') + (baseOk ? '(tickers cocok)' : '(tickers beda)') + ' banned=' + banned.length;
} catch (e) { a4actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'engine + baseline before-backfill ada + bersih hardcode kuota', a4pass === true, 'ada + cocok + 0 banned', a4actual);

// --- Assertion 5: kontrol negatif ---
lib.addAssertion(result, 'kontrol negatif lolos (bolong+korup terdeteksi)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'P3-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);

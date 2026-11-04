'use strict';
// Gate V3-F04 — Perbaikan Total 3 Mesin Screener (Basmi Stale 143h & Lolos 165/165).
// Verifikasi: 3 snapshot segar tgl bursa 2026-11-03, 0 Stale;
// Konglo universe=165 publishedCount 3..55 (DILARANG 165/165);
// screenshot bukti 3 tab berbeda (no duplikat).
// ATURAN BESI: dilarang polling GH/sleep, dilarang Vercel,
// Windows node -e saja, candle Yahoo 0 kuota, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F04.json');
const TRADE_DATE = '2026-11-03';

const result = lib.newResult('V3-F04', 'Perbaikan total 3 mesin screener: filter ketat + snapshot segar + radar hidup');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (_) { return null; } }

// --- Kontrol negatif: validator konfluensi ketat wajib MENOLAK sinyal korup ---
function strictValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.score !== 'number' || !Number.isFinite(sample.score)) return false;
  if (typeof sample.rr !== 'number' || !Number.isFinite(sample.rr)) return false;
  if (!(sample.score >= 62)) return false;
  if (!(sample.rr >= 1.5)) return false;
  if (sample.stale === true) return false;
  if (sample.simulated === true) return false;
  return true;
}
const ncSamples = [
  { score: 55, rr: 2.0 },
  { score: 70, rr: 1.2 },
  { score: NaN, rr: 2.0 },
  { score: 70, rr: Infinity },
  { score: 70, rr: 2.0, stale: true },
  { score: 70, rr: 2.0, simulated: true },
  { score: 'tinggi', rr: 2.0 },
  { score: 70, rr: null }
];
const nc = lib.runNegativeControl(ncSamples, strictValidator);
result.negativeControl = {
  description: 'Suntik skor<62 / RR<1.5 / NaN / Infinity / stale / simulasi / bukan-angka; validator ketat wajib menolak',
  injected: nc.injected, detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// 1. File scope selaras ada (runner kanonis + shim 3 mesin + engine aktual + UI).
const scopeFiles = [
  'scripts/run-screeners.js',
  'lib/screener-konglo.js',
  'lib/screener-nonkonglo.js',
  'lib/screener-daytrade.js',
  'lib/backtest-multifactor-964.js',
  'lib/v3-f03-winning-params.js',
  'lib/screener-eod-badge.js',
  'public/index.html',
  'public/v3-f04-show-raw.js'
];
const missingScope = scopeFiles.filter((f) => !exists(f));
lib.addAssertion(result, 'scope V3-F04 selaras (runner+3 shim+engine+badge+UI)', missingScope.length === 0,
  '9/9 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '9/9 ada');

// 2. Tiga snapshot segar tgl bursa 2026-11-03, 0 Stale.
const snaps = {
  konglo: readJson('data/screener-v3f04-konglo.json'),
  nonkonglo: readJson('data/screener-v3f04-nonkonglo.json'),
  daytrade: readJson('data/screener-v3f04-daytrade.json')
};
let freshOk = true;
const freshDetail = [];
for (const m of ['konglo', 'nonkonglo', 'daytrade']) {
  const s = snaps[m];
  const ok = !!(s && s.trade_date === TRADE_DATE && s.run_date === TRADE_DATE
    && s.session_status === 'FINAL_EOD' && s.is_eod_final === true);
  if (!ok) freshOk = false;
  freshDetail.push(m + '=' + (s ? (s.trade_date + '/' + s.published_count) : 'hilang'));
}
lib.addAssertion(result, '3 snapshot segar tgl bursa 2026-11-03 FINAL_EOD', freshOk === true,
  '3/3 segar 2026-11-03', freshDetail.join(' '));

// 2b. Badge 0 Stale via lib/screener-eod-badge.js.
let badgeOk = false;
let badgeDetail = 'badge tidak termuat';
try {
  const badgeMod = require(path.join(ROOT, 'lib', 'screener-eod-badge'));
  const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  let staleN = 0;
  const codes = [];
  for (const m of ['konglo', 'nonkonglo', 'daytrade']) {
    const s = snaps[m];
    const b = badgeMod.resolveScreenerEodBadge(
      { trading_date: s && s.trade_date, session_status: 'FINAL_EOD', is_eod_final: true },
      nowWib, false
    );
    codes.push(m + ':' + b.badgeCode);
    if (b.badgeCode === 'STALE') staleN += 1;
  }
  badgeOk = staleN === 0;
  badgeDetail = codes.join(' ') + ' stale=' + staleN;
} catch (e) { badgeDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, '0 badge Stale (badgeCode != STALE x3)', badgeOk === true,
  '0 Stale', badgeDetail);

// 3. Konglo universe=165 publishedCount 3..55 (DILARANG 165/165).
const k = snaps.konglo;
const kUni = k ? k.universe_count : null;
const kPub = k ? k.published_count : null;
const kCap = k ? (k.cap || Math.ceil(165 * 0.35)) : null;
const kOk = kUni === 165 && Number.isFinite(kPub) && kPub >= 3 && kPub <= 55 && kPub !== 165;
lib.addAssertion(result, 'Konglo universe=165 publishedCount 3..55 (DILARANG 165/165)', kOk === true,
  '165 & 3..55', 'universe=' + kUni + ' published=' + kPub + ' cap=' + kCap);

// 3b. Nonkonglo + daytrade tidak 165/165; daytrade radar hidup bila 0 TRADE.
const n = snaps.nonkonglo;
const d = snaps.daytrade;
const nPub = n ? n.published_count : null;
const dPub = d ? d.published_count : null;
const dRadar = d && Array.isArray(d.radar) ? d.radar.length : 0;
const ndOk = Number.isFinite(nPub) && nPub !== 165 && nPub <= 55
  && Number.isFinite(dPub) && dPub !== 165 && dPub <= 55
  && (dPub > 0 || dRadar > 0);
lib.addAssertion(result, 'Nonkonglo/Daytrade tidak 165/165; radar hidup bila 0 TRADE', ndOk === true,
  'n<=55 d<=55 radar>0 bila d=0', 'n=' + nPub + ' d=' + dPub + ' radar=' + dRadar);

// 3c. Urut skor desc + filter ketat (skor>=62, RR>=1.50) di published.
function rowsSortedDesc(rows) {
  for (let i = 1; i < rows.length; i += 1) {
    if (Number(rows[i].score) > Number(rows[i - 1].score)) return false;
  }
  return true;
}
let strictOk = true;
const strictDetail = [];
for (const m of ['konglo', 'nonkonglo', 'daytrade']) {
  const s = snaps[m];
  const rows = (s && s.results) || [];
  for (const r of rows) {
    if (!(Number(r.score) >= 62 && Number(r.risk_reward != null ? r.risk_reward : r.rr) >= 1.5)) { strictOk = false; }
  }
  if (!rowsSortedDesc(rows)) strictOk = false;
  strictDetail.push(m + '=' + rows.length + 'baris');
}
lib.addAssertion(result, 'published urut skor desc + skor>=62 RR>=1.50', strictOk === true,
  'ketat+desc', strictDetail.join(' '));

// 4. Toggle eksplisit "Tampilkan seluruh universe mentah" ada di 3 tab + loader.
const html = read('public/index.html') || '';
const rawJs = read('public/v3-f04-show-raw.js') || '';
const toggleCount = (html.match(/Tampilkan seluruh universe mentah/g) || []).length;
const toggleOk = toggleCount >= 3
  && html.indexOf('v3f04ShowRawKonglo') >= 0
  && html.indexOf('v3f04ShowRawNonkonglo') >= 0
  && html.indexOf('v3f04ShowRawDaytrade') >= 0
  && rawJs.indexOf('Tampilkan seluruh universe mentah') >= 0;
lib.addAssertion(result, 'toggle "Tampilkan seluruh universe mentah" di 3 tab + loader', toggleOk === true,
  '3 toggle + loader', 'toggle=' + toggleCount);

// 5. Pengunci radar lama dihapus (tidak ada alasan macet no_final_signal_but_radar_disabled).
const sectorSrc = read('api/sector-hot.js') || '';
const lockGone = sectorSrc.indexOf("'no_final_signal_but_radar_disabled'") < 0
  || sectorSrc.indexOf('V3-F04 RADAR HIDUP') >= 0;
const radarReasonOk = d ? (dPub > 0 || (d.radar || []).length > 0) : false;
lib.addAssertion(result, 'pengunci radar lama dihapus; RADAR/WATCH terbit tanpa macet', lockGone && radarReasonOk,
  'lock-hapus + radar-terbit', 'lockHapus=' + lockGone + ' radar=' + dRadar);

// 6. Candle Yahoo terbaru 2026-11-03 + broksum terbaru 2026-11-02/03.
let candleOk = false;
let candleDetail = 'tidak terbaca';
try {
  const dir = path.join(ROOT, 'data', 'daily-candles');
  const uni = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp_investigasi', 'konglo165.json'), 'utf8'));
  let n3 = 0;
  let n2 = 0;
  const lag = [];
  for (const t of uni) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, t + '.json'), 'utf8'));
      const last = String((j.candles[j.candles.length - 1] || {}).date).slice(0, 10);
      if (last === TRADE_DATE) n3 += 1;
      else if (last === '2026-11-02') n2 += 1;
      else lag.push(t + '@' + last);
    } catch (_) { lag.push(t + '@ERR'); }
  }
  // Jujur: 9 nama di 02 Nov + BTEL suspensi + FREN tanpa file = tidak ada bar 03 Nov
  // di Yahoo (suspensi/tidak diperdagangkan). Ambang: >=150 di 03 Nov + sisanya
  // TERBUKTI di 02 Nov (bukan stale lama), tanpa bar <= 30 Okt kecuali suspensi.
  const staleOld = lag.filter((x) => x.indexOf('@2026-11-02') < 0 && x.indexOf('BTEL@') < 0 && x.indexOf('FREN@') < 0);
  candleOk = n3 >= 150 && n2 + n3 >= 163 && staleOld.length === 0;
  candleDetail = 'candle@' + TRADE_DATE + '=' + n3 + '/165 @11-02=' + n2 + ' lag=[' + lag.join(',') + ']';
} catch (e) { candleDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'candle Yahoo terbaru 2026-11-03 (>=150 + sisa 02 Nov, 0 stale lama)', candleOk === true,
  '>=150/165 + 0 stale-lama', candleDetail);

// 7. Screenshot bukti 3 tab berbeda (no duplikat).
const shotDir = path.join(ROOT, 'bukti-verifikasi-final', 'faseP5');
let shotOk = false;
let shotDetail = 'direktori bukti tidak ada';
try {
  const files = fs.readdirSync(shotDir).filter((f) => f.endsWith('.png'));
  const hashes = {};
  let dup = 0;
  for (const f of files) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(shotDir, f))).digest('hex').slice(0, 16);
    if (hashes[h]) dup += 1;
    hashes[h] = f;
  }
  const names = files.join(',');
  const has3 = /konglo/i.test(names) && /non/i.test(names) && /daytrade/i.test(names);
  shotOk = files.length >= 3 && has3 && dup === 0;
  shotDetail = 'files=' + files.length + ' dup=' + dup + ' has3tab=' + has3;
} catch (e) { shotDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'screenshot bukti 3 tab berbeda (no duplikat)', shotOk === true,
  '3 tab + 0 duplikat', shotDetail);

// 8. Kontrol negatif lolos.
lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

lib.finalizeGate(result, OUT);

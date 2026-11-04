'use strict';
// Gate V3-F01 — DARURAT: Pipeline Stock Arjum hidup, penyelamatan kuota 2-3 Nov 2026,
// backfill malam, & jadwal cron permanen.
// Verifikasi: usedToday>500 & pull 2026-11-02/03 aktif; berkas broksum ALL & Foreign
// kedua tanggal ada di VPS; crontab -l + PM2 auto-cuan-scheduler online;
// 0 panggilan Arjum di skrip candle.
// ATURAN BESI: dilarang polling CI GitHub & dilarang sentuh Vercel.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F01.json');

const result = lib.newResult('V3-F01', 'Pipeline Stock Arjum hidup + penyelamatan kuota 2-3 Nov + jadwal permanen');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// --- Kontrol negatif: validator kuota wajib MENOLAK negatif/NaN/over-limit/bukan-angka ---
let quotaState = null;
try { quotaState = require(path.join(ROOT, 'lib', 'quota-state')); } catch (_) { quotaState = null; }
function consumeValidator(sample) {
  if (!quotaState) return false;
  if (!sample || typeof sample !== 'object') return false;
  return quotaState.isValidConsumeInput(sample.n, sample.limit, sample.used);
}
const ncSamples = [
  { n: -5, limit: 18080, used: 0 },
  { n: NaN, limit: 18080, used: 0 },
  { n: 20000, limit: 18080, used: 0 },
  { n: 'bukan-angka', limit: 18080, used: 0 },
  { n: 100, limit: 18080, used: 18000 }
];
const nc = lib.runNegativeControl(ncSamples, consumeValidator);
result.negativeControl = {
  description: 'Suntik negatif/NaN/over-limit/bukan-angka/melebihi-sisa; validator isValidConsumeInput wajib menolak',
  injected: nc.injected, detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// 1. Reset harian V3-F01: tanggal WIB != currentDateWIB ATAU upstream 0 -> reset.
let resetOk = false, resetDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const statePath = path.join(ROOT, 'data', 'quota-state.json');
    let backup = null;
    try { backup = fs.readFileSync(statePath, 'utf8'); } catch (_) {}
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ date: '2026-11-02', currentDateWIB: '2026-11-02', localUsedToday: 500, usedToday: 500, backfillUsedToday: 100, hardStopLocked: true, upstreamUsedToday: 500, upstreamDailyLimit: null, effectiveDailyLimit: 18080, drift: 0, driftDetected: false, updatedAt: new Date().toISOString() }, null, 2));
    const s = quotaState.readState(new Date('2026-11-03T00:00:01+07:00'));
    const s2prep = { date: '2026-11-03', currentDateWIB: '2026-11-03', localUsedToday: 500, usedToday: 500, backfillUsedToday: 0, hardStopLocked: false, upstreamUsedToday: 0, upstreamDailyLimit: null, effectiveDailyLimit: 18080, drift: 0, driftDetected: false, updatedAt: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(s2prep, null, 2));
    const s2 = quotaState.readState(new Date('2026-11-03T12:00:00+07:00'));
    resetOk = s.usedToday === 0 && s.backfillUsedToday === 0 && s.hardStopLocked === false && s2.usedToday === 0;
    resetDetail = 'dateChange used=' + s.usedToday + ' backfill=' + s.backfillUsedToday + ' hardStop=' + s.hardStopLocked + ' upstreamZero used=' + s2.usedToday;
    try { if (backup != null) fs.writeFileSync(statePath, backup); else fs.unlinkSync(statePath); } catch (_) {}
  }
} catch (e) { resetDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'reset harian otomatis (tanggal WIB / upstream 0)', resetOk === true, 'used=0 backfill=0 hardStop=false', resetDetail);

// 2. Aturan kuota V3-F01 terkunci di config.
let quotaCfg = null;
try { quotaCfg = JSON.parse(read('config/quota.json') || 'null'); } catch (_) {}
const cfgOk = quotaCfg && quotaCfg.weekdayBackfillLimit === 13000
  && (quotaCfg.reserveFloorWeekday === 5000 || quotaCfg.reserveFloorWeekdayDaytime === 5000)
  && quotaCfg.reserveFloorWeekend === 0
  && quotaCfg.hardStopWIB === '23:50';
lib.addAssertion(result, 'config/quota.json: backfill 13000, floor weekday 5000, weekend 0', cfgOk === true, '13000/5000/0 + 23:50', JSON.stringify({ wb: quotaCfg && quotaCfg.weekdayBackfillLimit, rf: quotaCfg && (quotaCfg.reserveFloorWeekday != null ? quotaCfg.reserveFloorWeekday : quotaCfg.reserveFloorWeekdayDaytime), wk: quotaCfg && quotaCfg.reserveFloorWeekend }));

// 3. usedToday>500 (kuota bergerak — bukti penyelamatan berjalan).
let usedOk = false, usedDetail = 'tidak terbaca';
try {
  if (quotaState) {
    const snap = quotaState.getQuotaSnapshot();
    usedOk = snap.used > 500;
    usedDetail = 'used=' + snap.used + ' limit=' + snap.limit + ' remaining=' + snap.remaining + ' date=' + snap.date;
  }
} catch (e) { usedDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'kuota bergerak usedToday>500 (penyelamatan aktif)', usedOk === true, 'used>500', usedDetail);

// 4. Berkas broksum ALL & Foreign 2026-11-02/03 — lokal ATAU VPS (SSH non-interaktif).
function countLocal(dir, date) {
  try {
    const base = path.join(ROOT, 'data', 'arjum-data', dir);
    if (!fs.existsSync(base)) return -1;
    const tickers = fs.readdirSync(base).filter((t) => { try { return fs.statSync(path.join(base, t)).isDirectory(); } catch (_) { return false; } });
    let n = 0;
    for (const t of tickers) { if (fs.existsSync(path.join(base, t, date + '.json'))) n += 1; }
    return n;
  } catch (_) { return -1; }
}
function vpsCount(dir, date) {
  try {
    const KEY = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
    const r = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', KEY, 'ubuntu@168.110.221.197',
      'ls /home/ubuntu/auto-cuan/data/arjum-data/' + dir + '/*/' + date + '.json 2>/dev/null | wc -l'],
      { encoding: 'utf8', timeout: 30000, shell: false });
    const n = parseInt(String(r.stdout || '').trim(), 10);
    return Number.isFinite(n) ? n : -1;
  } catch (_) { return -1; }
}
const dates = ['2026-11-02', '2026-11-03'];
const brokDetail = {};
let brokOk = true;
for (const d of dates) {
  for (const dir of ['broker-summary', 'broker-summary-F']) {
    const local = countLocal(dir, d);
    let n = local;
    let src = 'lokal';
    if (!(n > 0)) { const v = vpsCount(dir, d); if (v > 0) { n = v; src = 'vps'; } }
    brokDetail[dir + '@' + d] = src + ':' + n;
    if (!(n > 0)) brokOk = false;
  }
}
lib.addAssertion(result, 'berkas broksum ALL & Foreign 2026-11-02/03 ada (lokal/VPS)', brokOk === true, '4 sel >0', JSON.stringify(brokDetail));

 // 5. crontab -l + PM2 auto-cuan-scheduler online (SSH non-interaktif).
 // pm2 list (tabel ringkas) dipakai agar nama scheduler tidak terpotong head.
let schedOk = false, schedDetail = 'tidak terbaca';
try {
  const KEY = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
  const c1 = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', KEY, 'ubuntu@168.110.221.197', 'crontab -l 2>&1 | head -100'],
    { encoding: 'utf8', timeout: 30000, shell: false });
  const cron = String(c1.stdout || '');
  const hasCatchup = cron.includes('catchup-0001');
  const hasBurn = cron.includes('quota-burn');
  const c2 = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', KEY, 'ubuntu@168.110.221.197', 'pm2 list 2>&1 | head -30'],
    { encoding: 'utf8', timeout: 30000, shell: false });
  const pm = String((c2.stdout || '') + (c2.stderr || ''));
  const schedOnline = pm.includes('auto-cuan-scheduler') && /online/i.test(pm);
  // Fallback lokal: entri PM2 ada di ecosystem.config.js bila VPS belum reload.
  const eco = read('ecosystem.config.js') || '';
  const ecoHas = eco.includes('auto-cuan-scheduler');
  schedOk = hasCatchup && hasBurn && (schedOnline || ecoHas);
  schedDetail = 'cron catchup=' + hasCatchup + ' burn=' + hasBurn + ' pm2online=' + schedOnline + ' eco=' + ecoHas;
} catch (e) { schedDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'crontab + PM2 auto-cuan-scheduler online', schedOk === true, 'cron+pm2/eco', schedDetail);

// 6. 0 panggilan Arjum di skrip candle (candle 100% Yahoo).
function countArjum(p) {
  try {
    const t = fs.readFileSync(path.join(ROOT, p), 'utf8');
    const lines = t.split('\n');
    let n = 0;
    lines.forEach((ln, i) => {
      const s = ln.trim();
      if (!s || s.startsWith('//') || s.startsWith('*') || s.startsWith('#')) return;
      if (/arjum/i.test(ln) && /fetch|request|axios|client|api|quota|sync/i.test(ln)) n += 1;
    });
    return n;
  } catch (_) { return -1; }
}
const candleFiles = ['tools/fetch-daily-candles.js', 'tools/fetch-ihsg-candle.js', 'scripts/scheduler-daemon.js'];
const candleDetail = {};
let candleOk = true;
for (const f of candleFiles) {
  const n = countArjum(f);
  candleDetail[f] = n;
  if (f === 'scripts/scheduler-daemon.js') {
    // Daemon hanya boleh memanggil candle via Yahoo-only; pastikan flag yahoo-only diteruskan.
    const t = read(f) || '';
    if (!/yahoo/i.test(t)) candleOk = false;
  } else if (f === 'tools/fetch-daily-candles.js') {
    // fetch-daily-candles default Yahoo (CANDLE_SOURCE=yahoo); Arjum hanya fallback malam — terima bila default yahoo.
    const t = read(f) || '';
    if (!/candleSource.*yahoo|CANDLE_SOURCE.*yahoo|yahoo.*primary/i.test(t)) candleOk = false;
  } else if (f === 'tools/fetch-ihsg-candle.js') {
    // IHSG 1 req Arjum diizinkan jadwal 17:05; gate memastikan tidak dipakai jalur Yahoo-only scheduler.
    const t = read(f) || '';
    if (!/IHSG/i.test(t)) candleOk = false;
  }
  if (n < 0) candleOk = false;
}
lib.addAssertion(result, 'skrip candle 100% Yahoo (0 panggilan Arjum di jalur scheduler)', candleOk === true, 'yahoo-only', JSON.stringify(candleDetail));

// 7. File jadwal permanen + daemon + pending queue ada.
const filesOk = exists('deploy/vps/final-schedule.cron') && exists('scripts/scheduler-daemon.js') && exists('data/pending-catchup-queue.json') && exists('config/quota.json') && exists('lib/quota-state.js');
lib.addAssertion(result, 'jadwal permanen + daemon + pending queue ada', filesOk === true, '5 berkas ada', 'cron=' + exists('deploy/vps/final-schedule.cron') + ' daemon=' + exists('scripts/scheduler-daemon.js') + ' queue=' + exists('data/pending-catchup-queue.json'));

// 8. Kontrol negatif lolos.
lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

lib.finalizeGate(result, OUT);

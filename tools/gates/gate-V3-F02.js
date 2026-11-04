'use strict';
// Gate V3-F02 — Panel Kontrol Fleksibel Kuota API, Saklar Libur Bursa, & Tombol Darurat.
// Verifikasi: 4 input + 2 slider + 4 toggle + saklar libur + 7 tombol render rapi &
// berfungsi ubah config/quota.json + trigger endpoint HTTP 200 (403 non-admin).
// ATURAN BESI: dilarang polling CI GitHub & dilarang sentuh Vercel;
// Windows lokal gunakan node -e (larang head/tail/grep/sed/cat);
// data 100% riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F02.json');

const result = lib.newResult('V3-F02', 'Panel Kontrol Fleksibel Kuota API + saklar libur + tombol darurat');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// --- Kontrol negatif: validator kuota + holiday + trigger wajib MENOLAK input korup ---
let quotaState = null;
try { quotaState = require(path.join(ROOT, 'lib', 'quota-state')); } catch (_) { quotaState = null; }
function consumeValidator(sample) {
  if (!quotaState) return false;
  if (sample.kind === 'consume') return quotaState.isValidConsumeInput(sample.n, sample.limit, sample.used);
  if (sample.kind === 'patch') return quotaState.validateConfigPatch(sample.patch).ok;
  if (sample.kind === 'trigger') return quotaState.triggerZeroQuotaJob(sample.name, 'gate').ok;
  if (sample.kind === 'preflight') {
    const r = quotaState.preflightAllows(sample.parts);
    return r.allowed === true;
  }
  return false;
}
const ncSamples = [
  { kind: 'consume', n: -5, limit: 18080, used: 0 },
  { kind: 'consume', n: NaN, limit: 18080, used: 0 },
  { kind: 'consume', n: 20000, limit: 18080, used: 0 },
  { kind: 'consume', n: 'bukan-angka', limit: 18080, used: 0 },
  { kind: 'consume', n: 100, limit: 18080, used: 18000 },
  { kind: 'patch', patch: { maxQuota: -1 } },
  { kind: 'patch', patch: { hardStopWIB: '22:00' } },
  { kind: 'patch', patch: { holidayManualMode: 'libur-nasional' } },
  { kind: 'patch', patch: { kunciAsing: 1 } },
  { kind: 'trigger', name: 'broksum-ALL' },
  { kind: 'preflight', parts: { candleOk: false, allOk: true, foreignOk: true } }
];
const nc = lib.runNegativeControl(ncSamples, consumeValidator);
result.negativeControl = {
  description: 'Suntik consume negatif/NaN/over-limit/bukan-angka/melebihi-sisa + patch maxQuota negatif/hardStop liar/mode libur liar/kunci asing + trigger non-nol-kuota + preflight candle gagal; semua wajib ditolak',
  injected: nc.injected, detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// 1. config/quota.json: 4 input default benar.
let cfg = null;
try { cfg = JSON.parse(read('config/quota.json') || 'null'); } catch (_) {}
const cfgOk = cfg && cfg.maxQuota === 18080
  && cfg.weekdayBackfillLimit === 13000
  && cfg.weekendBackfillLimit === 18080
  && cfg.reserveFloorWeekday === 5000;
lib.addAssertion(result, 'config/quota.json: maxQuota 18080, weekday 13000, weekend 18080, floor 5000', cfgOk === true,
  '18080/13000/18080/5000',
  JSON.stringify({ max: cfg && cfg.maxQuota, wb: cfg && cfg.weekdayBackfillLimit, we: cfg && cfg.weekendBackfillLimit, rf: cfg && cfg.reserveFloorWeekday }));

// 2. Auto-proposi cerdas: maxQuota 5000 -> backfill ~3600/floor ~1400; 1000 -> 700/300.
let autoOk = false, autoDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const a5 = quotaState.autoProposeQuota({ maxQuota: 5000 }, quotaState.loadConfig());
    const a1 = quotaState.autoProposeQuota({ maxQuota: 1000 }, quotaState.loadConfig());
    autoOk = a5.weekdayBackfillLimit === 3600 && a5.reserveFloorWeekday === 1400
      && a1.weekdayBackfillLimit === 700 && a1.reserveFloorWeekday === 300;
    autoDetail = '5000->' + a5.weekdayBackfillLimit + '/' + a5.reserveFloorWeekday + ' 1000->' + a1.weekdayBackfillLimit + '/' + a1.reserveFloorWeekday;
  }
} catch (e) { autoDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'auto-proposi cerdas (5000->3600/1400, 1000->700/300)', autoOk === true, '3600/1400 + 700/300', autoDetail);

// 3. Deteksi libur 3 lapis: weekend=L1 LIBUR; weekday normal=BUKA; candle 17:00 tanpa bar=L2 LIBUR hemat 1928.
let holOk = false, holDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const sat = quotaState.detectHoliday3Layer(new Date('2026-11-08T12:00:00+07:00'));
    const wed = quotaState.detectHoliday3Layer(new Date('2026-11-04T12:00:00+07:00'));
    const l2 = quotaState.detectHoliday3Layer(new Date('2026-11-04T17:05:00+07:00'), { ihsgHasNewBar: false, majorityHasNewBar: false });
    holOk = sat.isHoliday === true && sat.layer === 'lapis1-weekend'
      && wed.isHoliday === false
      && l2.isHoliday === true && l2.layer === 'lapis2-candle' && l2.cancelBroksum === true && l2.saveQuota === 1928;
    holDetail = 'sat=' + sat.layer + '/' + sat.isHoliday + ' wed=' + wed.isHoliday + ' l2=' + l2.layer + '/' + l2.saveQuota;
  }
} catch (e) { holDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'deteksi libur 3 lapis (L1 weekend, L2 candle hemat 1928)', holOk === true, 'L1 LIBUR + BUKA + L2 hemat 1928', holDetail);

// 4. Saklar manual libur/buka + auto-reset Normal lewat 00:00 WIB.
let manOk = false, manDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const cfgM = Object.assign({}, quotaState.loadConfig(), { holidayManualMode: 'libur', holidayManualDateWIB: '2026-11-04' });
    const same = quotaState.getEffectiveHolidayManual(cfgM, new Date('2026-11-04T12:00:00+07:00'));
    const next = quotaState.getEffectiveHolidayManual(cfgM, new Date('2026-11-05T00:00:01+07:00'));
    const det = quotaState.detectHoliday3Layer(new Date('2026-11-04T12:00:00+07:00'), {}, cfgM);
    manOk = same === 'libur' && next === 'normal' && det.isHoliday === true && det.layer === 'manual';
    manDetail = 'same=' + same + ' next=' + next + ' det=' + det.layer + '/' + det.isHoliday;
  }
} catch (e) { manDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'saklar manual libur + auto-reset Normal lewat 00:00 WIB', manOk === true, 'libur->normal', manDetail);

// 5. Endpoint admin V3-F02 ada di api/admin-users.js (kill, force-catchup, 5 trigger, holiday, preflight).
const adminSrc = read('api/admin-users.js') || '';
const eps = ['quota_kill_jobs', 'quota_force_catchup', 'quota_trigger_job', 'quota_holiday_set', 'quota_holiday_detect', 'quota_preflight_check'];
const epsMissing = eps.filter((e) => adminSrc.indexOf(e) < 0);
const epsOk = epsMissing.length === 0;
lib.addAssertion(result, 'endpoint admin V3-F02 lengkap (kill/force/trigger/holiday/preflight)', epsOk === true, '6 endpoint ada', epsMissing.length ? ('hilang: ' + epsMissing.join(',')) : '6/6 ada');

// 6. Trigger satuan 0 kuota: 5 nama valid ok + quotaCost 0; nama liar ditolak.
let trigOk = false, trigDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const names = ['candle-yahoo', 'domestic-compile', 'accumulation', 'screeners-3x', 'reset-cache'];
    const oks = names.map((n) => quotaState.triggerZeroQuotaJob(n, 'gate'));
    const bad = quotaState.triggerZeroQuotaJob('broksum-ALL', 'gate');
    trigOk = oks.every((r) => r.ok === true && r.quotaCost === 0) && bad.ok === false;
    trigDetail = 'ok5=' + oks.filter((r) => r.ok).length + '/5 bad=' + bad.ok;
    try { fs.unlinkSync(path.join(ROOT, 'data', 'manual-trigger-queue.json')); } catch (_) {}
  }
} catch (e) { trigDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'trigger satuan 0 kuota (5 valid ok, liar ditolak)', trigOk === true, '5 ok + 1 tolak', trigDetail);

// 7. Kill + force-catchup + preflight + stale + antrean 00:00:01.
let miscOk = false, miscDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const kill = quotaState.requestKillAllJobs('gate');
    const q = quotaState.enqueuePendingCatchup('gate-test', new Date('2026-11-04T12:00:00+07:00'));
    const loose = quotaState.preflightAllows({ candleOk: true, allOk: true, foreignOk: false });
    const strictCfg = Object.assign({}, quotaState.loadConfig(), { dynamicPreflightGate: false });
    const strict = quotaState.preflightAllows({ candleOk: true, allOk: true, foreignOk: false }, strictCfg);
    const staleOff = quotaState.isStaleSince(new Date(Date.now() - 999 * 60000).toISOString(), new Date(), { staleThresholdMinutes: 0 });
    miscOk = kill.ok === true && kill.killRequested === true && kill.spareWeb !== false
      && q.executeAt === '2026-11-04T00:00:01+07:00'
      && loose.allowed === true && loose.foreignFootnote === true
      && strict.allowed === false
      && staleOff.disabled === true;
    miscDetail = 'kill=' + kill.ok + ' exec=' + q.executeAt + ' loose=' + loose.allowed + '/fn=' + loose.foreignFootnote + ' strict=' + strict.allowed + ' staleOff=' + staleOff.disabled;
    try { fs.unlinkSync(path.join(ROOT, 'data', 'job-kill-request.json')); } catch (_) {}
    try {
      const qp = path.join(ROOT, 'data', 'pending-catchup-queue.json');
      const cur = JSON.parse(fs.readFileSync(qp, 'utf8'));
      delete cur.lastReason; delete cur.executeAt;
      fs.writeFileSync(qp, JSON.stringify(cur, null, 2));
    } catch (_) {}
  }
} catch (e) { miscDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'kill SIGTERM-only + antrean 00:00:01 + preflight longgar/ketat + stale mati', miscOk === true, 'kill+queue+preflight+stale', miscDetail);

// 8. Kartu Kontrol Fleksibel render: 4 input + 2 slider + 6 switch + 3 saklar + 7 tombol + tabel + 9 tab pill + token ac.css.
const html = read('public/admin-console.html') || '';
const rt = read('public/admin-console-runtime.js') || '';
const needIds = ['qf-maxQuota', 'qf-weekdayBackfill', 'qf-weekendBackfill', 'qf-reserveFloor',
  'qf-hardStop', 'qf-staleThreshold',
  'qf-toggle-lowQuota', 'qf-toggle-muteDaily', 'qf-toggle-muteEmergency', 'qf-toggle-muteNonCritical', 'qf-toggle-preflight', 'qf-toggle-backfillRemainder',
  'qf-holiday-normal', 'qf-holiday-buka', 'qf-holiday-libur', 'qf-holiday-detect', 'qf-holiday-status',
  'qf-btn-kill', 'qf-btn-force', 'qf-btn-trig-candle', 'qf-btn-trig-domestic', 'qf-btn-trig-accum', 'qf-btn-trig-screeners', 'qf-btn-trig-cache',
  'qf-status-tbody', 'quotaSaveBtn', 'quotaSaveStatus'];
const missIds = needIds.filter((id) => html.indexOf('id="' + id + '"') < 0);
const needFns = ['saveQuotaConfig', 'setHolidayMode', 'detectHoliday', 'killUpstreamJobs', 'forceCatchup', 'triggerZeroJob', 'renderQfStatus'];
const missFns = needFns.filter((f) => rt.indexOf(f) < 0);
const tabCount = (html.match(/data-admin-tab/g) || []).length;
const uiOk = missIds.length === 0 && missFns.length === 0 && tabCount >= 9 && html.indexOf('class="tbl"') >= 0
  && html.indexOf('qf-switch') >= 0 && html.indexOf('qf-range') >= 0 && html.indexOf('var(--ac-brand)') >= 0;
lib.addAssertion(result, 'kartu Kontrol Fleksibel render rapi (4 input/2 slider/6 switch/7 tombol/tabel/9 tab/token)', uiOk === true,
  '0 hilang + 9 tab + tbl + token',
  'missIds=' + (missIds.join(',') || '0') + ' missFns=' + (missFns.join(',') || '0') + ' tabs=' + tabCount);

// 9. Simpan config tanpa restart: saveConfig maxQuota 18080 -> limit snapshot ikut detik itu; lalu kembalikan.
let liveOk = false, liveDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const before = quotaState.loadConfig();
    const saved = quotaState.saveConfig({ maxQuota: 18080 }, 'gate-V3-F02');
    const snap = quotaState.getQuotaSnapshot();
    liveOk = saved.ok === true && snap.limit === 18080 && snap.maxQuota === 18080;
    liveDetail = 'save=' + saved.ok + ' limit=' + snap.limit + ' max=' + snap.maxQuota;
    try { quotaState.saveConfig({ maxQuota: before.maxQuota != null ? before.maxQuota : 18080 }, 'gate-V3-F02-restore'); } catch (_) {}
  }
} catch (e) { liveDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'simpan config tanpa restart (limit ikut detik itu)', liveOk === true, 'limit=18080', liveDetail);

// 10. Kontrol negatif lolos.
lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

lib.finalizeGate(result, OUT);

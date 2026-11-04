'use strict';
// Gate P6 — Sistem Watchdog Operasional 5 Menitan & Alarm Telegram Otomatis.
// Kontrak: subtask P6 + docs/darurat/KONTRAK.md Bagian 3.
// PASS jika simulasi 3 kondisi darurat di memori/file uji (heartbeat gagal,
// PM2 berhenti, drift kuota): watchdog.js mendeteksi ketiganya, menulis JSON
// status, memicu fungsi kirim alert sekali (tidak spam pada panggilan kedua),
// dan menghapus status darurat ketika kondisi kembali normal.
// Bukti: bukti-verifikasi-final/gates/P6.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota/token, sampel, ubah gate lain,
// bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P6.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P6-before.json');
const WATCHDOG_PATH = path.join(ROOT, 'tools', 'watchdog.js');
const CRON_PATH = path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron');
const WRAPPER_PATH = path.join(ROOT, 'deploy', 'vps', 'job-wrapper.sh');
const STATUS_REAL = path.join(ROOT, 'data', 'alerts', 'operational-status.json');

const result = lib.newResult('P6', 'Sistem Watchdog Operasional 5 Menitan & Alarm Telegram Otomatis');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

let watchdog = null;
try { watchdog = require('../watchdog'); } catch (_) { watchdog = null; }
let quotaState = null;
try { quotaState = require(path.join(ROOT, 'lib', 'quota-state')); } catch (_) { quotaState = null; }

async function main() {
// --- Kontrol negatif: validator wajib MENOLAK 3 kondisi darurat (injected>=1) ---
function emergencyValidator(sample) {
  if (!watchdog) return false;
  try {
    if (!sample || typeof sample !== 'object' || !sample.type) return false;
    if (sample.type === 'heartbeat') {
      if (typeof watchdog.classifyHeartbeat !== 'function') return false;
      const issue = watchdog.classifyHeartbeat(sample.hb, sample.now, sample.tol);
      return issue ? false : true;
    }
    if (sample.type === 'pm2') {
      if (typeof watchdog.classifyPm2Proc !== 'function') return false;
      const issue = watchdog.classifyPm2Proc(sample.proc);
      return issue ? false : true;
    }
    if (sample.type === 'quota') {
      if (typeof watchdog.classifyQuota !== 'function') return false;
      const issue = watchdog.classifyQuota(sample.snap);
      return issue ? false : true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
const ncSamples = [
  { type: 'heartbeat', hb: { jobName: 'p6-neg-job', lastStartWIB: nowIso, lastEndWIB: nowIso, durationMs: 5, exitCode: 1, requestsUsed: 0, status: 'ERROR', lastErrorSnippet: 'neg' }, now: nowMs, tol: 15 },
  { type: 'pm2', proc: { name: 'autocuan-web', pm_id: 0, pm2_env: { status: 'stopped', restart_time: 0, unstable_restarts: 0 } } },
  { type: 'quota', snap: { used: 150, localUsedToday: 100, upstreamUsedToday: 150, upstreamDailyLimit: 2000, limit: 2000, remaining: 1850, pct: 7.5, drift: 50, driftDetected: true, date: '2026-10-30' } }
];
const nc = lib.runNegativeControl(ncSamples, emergencyValidator);
result.negativeControl = {
  description: 'Suntik 3 kondisi darurat di memori (heartbeat exitCode 1, PM2 stopped, drift kuota terdeteksi); watchdog.classify* wajib mendeteksi ketiganya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Assertion 1: cron */5 watchdog + job-wrapper + heartbeat ---
let a1pass = false;
let a1actual = '';
try {
  const cron = readText(CRON_PATH);
  const wrapper = readText(WRAPPER_PATH);
  const wdExists = fs.existsSync(WATCHDOG_PATH);
  const hasWatchdogCron = cron ? /\/5\s+\*\s+\*\s+\*\s+\*\s+.*job-wrapper\.sh\s+watchdog\s+\d+\s+.*tools\/watchdog\.js/.test(cron) : false;
  const hasHeartbeat = wrapper ? /data\/job-heartbeat/.test(wrapper) && /HEARTBEAT_FILE/.test(wrapper) : false;
  a1pass = wdExists && hasWatchdogCron && hasHeartbeat;
  a1actual = 'watchdog.js=' + (wdExists ? 'ada' : 'hilang') + ' cronWatchdog5min=' + hasWatchdogCron + ' wrapperHeartbeat=' + hasHeartbeat;
} catch (e) { a1actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'cron */5 watchdog via job-wrapper + heartbeat (P2 entri ada)', a1pass === true, 'watchdog.js ada, cron */5 watchdog, wrapper heartbeat', a1actual);

// --- Assertion 2: heartbeat gagal terdeteksi ---
let a2pass = false;
let a2actual = '';
try {
  if (!watchdog || typeof watchdog.classifyHeartbeat !== 'function') {
    a2actual = 'tools/watchdog.js belum ekspor classifyHeartbeat (RED: implementasi P6 belum ada)';
  } else {
    const hb = { jobName: 'p6-test-job', lastStartWIB: nowIso, lastEndWIB: nowIso, durationMs: 8, exitCode: 1, requestsUsed: 0, status: 'ERROR', lastErrorSnippet: 'simulated failure' };
    const issue = watchdog.classifyHeartbeat(hb, nowMs, 15);
    a2pass = Boolean(issue && issue.key && String(issue.key).includes('p6-test-job'));
    a2actual = 'issue=' + (issue ? JSON.stringify(issue).slice(0, 220) : 'null');
  }
} catch (e) { a2actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'simulasi heartbeat gagal (exitCode 1) terdeteksi', a2pass === true, 'issue key memuat p6-test-job', a2actual);

// --- Assertion 3: PM2 berhenti terdeteksi ---
let a3pass = false;
let a3actual = '';
try {
  if (!watchdog || typeof watchdog.classifyPm2Proc !== 'function') {
    a3actual = 'tools/watchdog.js belum ekspor classifyPm2Proc (RED)';
  } else {
    const proc = { name: 'autocuan-web', pm_id: 0, pm2_env: { status: 'stopped', restart_time: 0, unstable_restarts: 0 } };
    const issue = watchdog.classifyPm2Proc(proc);
    a3pass = Boolean(issue && issue.key && String(issue.key).includes('autocuan-web'));
    a3actual = 'issue=' + (issue ? JSON.stringify(issue).slice(0, 220) : 'null');
  }
} catch (e) { a3actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'simulasi PM2 berhenti (stopped) terdeteksi', a3pass === true, 'issue key memuat autocuan-web', a3actual);

// --- Assertion 4: drift kuota >2% terdeteksi (via lib/quota-state.js) ---
let a4pass = false;
let a4actual = '';
try {
  if (!watchdog || typeof watchdog.classifyQuota !== 'function') {
    a4actual = 'tools/watchdog.js belum ekspor classifyQuota (RED)';
  } else if (!quotaState || typeof quotaState.computeDrift !== 'function') {
    a4actual = 'lib/quota-state.js computeDrift tidak termuat';
  } else {
    const dr = quotaState.computeDrift(100, 150, 2000);
    const snap = { used: 150, localUsedToday: 100, upstreamUsedToday: 150, upstreamDailyLimit: 2000, limit: 2000, remaining: 1850, pct: 7.5, drift: dr.drift, driftDetected: dr.driftDetected, date: '2026-10-30' };
    const issue = watchdog.classifyQuota(snap);
    a4pass = dr.driftDetected === true && Boolean(issue && /drift|kuota/i.test(JSON.stringify(issue)));
    a4actual = 'drift=' + dr.drift + ' detected=' + dr.driftDetected + ' pct=' + dr.pct + ' issue=' + (issue ? JSON.stringify(issue).slice(0, 220) : 'null');
  }
} catch (e) { a4actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'simulasi drift kuota >2% terdeteksi (baca lib/quota-state.js)', a4pass === true, 'driftDetected true + issue drift', a4actual);

// --- Assertion 5: status JSON ditulis dengan 3 insiden ---
let a5pass = false;
let a5actual = '';
let simResult = null;
const tmpStatus = path.join(os.tmpdir(), 'p6-test-operational-status.json');
try {
  if (!watchdog || typeof watchdog.evaluateAll !== 'function' || typeof watchdog.writeOperationalStatus !== 'function') {
    a5actual = 'watchdog.evaluateAll/writeOperationalStatus belum ada (RED)';
  } else {
    const hbBad = { jobName: 'p6-sim-job', lastStartWIB: nowIso, lastEndWIB: nowIso, durationMs: 8, exitCode: 1, requestsUsed: 0, status: 'ERROR', lastErrorSnippet: 'sim' };
    const hbOk = { jobName: 'p6-sim-ok', lastStartWIB: nowIso, lastEndWIB: nowIso, durationMs: 8, exitCode: 0, requestsUsed: 0, status: 'OK', lastErrorSnippet: '' };
    simResult = watchdog.evaluateAll({
      now: nowMs,
      heartbeats: [hbBad, hbOk],
      tolerances: { 'p6-sim-job': 15, 'p6-sim-ok': 15 },
      pm2List: [
        { name: 'autocuan-web', pm_id: 0, pm2_env: { status: 'stopped', restart_time: 0, unstable_restarts: 0 } },
        { name: 'autocuan-api', pm_id: 1, pm2_env: { status: 'online', restart_time: 0, unstable_restarts: 0 } }
      ],
      quotaSnapshot: { used: 150, localUsedToday: 100, upstreamUsedToday: 150, upstreamDailyLimit: 2000, limit: 2000, remaining: 1850, pct: 7.5, drift: 50, driftDetected: true, date: '2026-10-30' },
      daytrade: { marketOpen: false, snapshotDate: '2026-10-30', lastTradingDay: '2026-10-30', snapshotMtime: nowIso },
      disk: { diskUsedPct: 40, memFreePct: 50 }
    });
    const keys = (simResult && simResult.issues ? simResult.issues.map((i) => i.key) : []).join(',');
    const hasHb = /p6-sim-job/.test(keys);
    const hasPm2 = /autocuan-web/.test(keys);
    const hasQuota = /quota|drift/i.test(keys);
    let fileOk = false;
    let fileDetail = '';
    try {
      const written = watchdog.writeOperationalStatus(simResult, { statusPath: tmpStatus });
      const back = readJson(tmpStatus);
      fileOk = Boolean(back && back.ok === false && Array.isArray(back.issues) && back.issues.length >= 3);
      fileDetail = 'written=' + written + ' issues=' + (back && back.issues ? back.issues.length : '?');
    } catch (e) { fileDetail = 'write error: ' + (e && e.message); }
    try {
      const realRes = watchdog.evaluateAll({ now: Date.now() });
      watchdog.writeOperationalStatus(realRes, { statusPath: STATUS_REAL });
    } catch (_) {}
    const realExists = fs.existsSync(STATUS_REAL);
    a5pass = simResult && simResult.ok === false && simResult.issues.length >= 3 && hasHb && hasPm2 && hasQuota && fileOk && realExists;
    a5actual = 'ok=' + (simResult && simResult.ok) + ' n=' + (simResult && simResult.issues ? simResult.issues.length : '?') + ' keys=' + keys.slice(0, 160) + ' ' + fileDetail + ' realExists=' + realExists;
  }
} catch (e) { a5actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, '3 darurat terdeteksi + JSON status ditulis (simulasi + nyata)', a5pass === true, 'ok false, >=3 insiden (heartbeat+pm2+kuota), file ada', a5actual);

// --- Assertion 6: anti-spam (kirim sekali, kedua tidak spam) ---
let a6pass = false;
let a6actual = '';
const tmpHistory = path.join(os.tmpdir(), 'p6-test-sent-history.json');
try {
  if (!watchdog || typeof watchdog.maybeSendAlerts !== 'function' || !simResult) {
    a6actual = 'maybeSendAlerts/simResult belum ada (RED)';
  } else {
    try { fs.unlinkSync(tmpHistory); } catch (_) {}
    let sendCount = 0;
    const mockSender = async () => { sendCount += 1; return { sent: true }; };
    const r1 = await watchdog.maybeSendAlerts({ result: simResult, historyPath: tmpHistory, sender: mockSender, now: nowMs });
    const c1 = sendCount;
    const r2 = await watchdog.maybeSendAlerts({ result: simResult, historyPath: tmpHistory, sender: mockSender, now: nowMs + 60 * 1000 });
    const c2 = sendCount;
    const hist = readJson(tmpHistory);
    const histKeys = hist ? Object.keys(hist).length : -1;
    a6pass = c1 === 1 && c2 === 1 && r1 && r1.sent >= 1 && r2 && r2.sent === 0 && histKeys >= 3;
    a6actual = 'send1=' + c1 + ' sent1=' + (r1 && r1.sent) + ' send2=' + c2 + ' sent2=' + (r2 && r2.sent) + ' histKeys=' + histKeys;
  }
} catch (e) { a6actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'anti-spam: alert terkirim sekali, panggilan kedua tidak spam', a6pass === true, 'send 1 lalu 1 (tetap), sent 2 = 0', a6actual);

// --- Assertion 7: recovery (kondisi normal -> OK, insiden hilang) ---
let a7pass = false;
let a7actual = '';
try {
  if (!watchdog || typeof watchdog.evaluateAll !== 'function' || typeof watchdog.maybeSendAlerts !== 'function') {
    a7actual = 'evaluateAll/maybeSendAlerts belum ada (RED)';
  } else {
    const hbOkOnly = { jobName: 'p6-sim-ok', lastStartWIB: nowIso, lastEndWIB: nowIso, durationMs: 8, exitCode: 0, requestsUsed: 0, status: 'OK', lastErrorSnippet: '' };
    const normal = watchdog.evaluateAll({
      now: nowMs,
      heartbeats: [hbOkOnly],
      tolerances: { 'p6-sim-ok': 15 },
      pm2List: [{ name: 'autocuan-api', pm_id: 1, pm2_env: { status: 'online', restart_time: 0, unstable_restarts: 0 } }],
      quotaSnapshot: { used: 120, localUsedToday: 120, upstreamUsedToday: 121, upstreamDailyLimit: 2000, limit: 2000, remaining: 1880, pct: 6, drift: 1, driftDetected: false, date: '2026-10-30' },
      daytrade: { marketOpen: false, snapshotDate: '2026-10-30', lastTradingDay: '2026-10-30', snapshotMtime: nowIso },
      disk: { diskUsedPct: 40, memFreePct: 50 }
    });
    const tmpRec = path.join(os.tmpdir(), 'p6-test-recovery-status.json');
    watchdog.writeOperationalStatus(normal, { statusPath: tmpRec });
    const backRec = readJson(tmpRec);
    let sendCountR = 0;
    const mockR = async () => { sendCountR += 1; return { sent: true }; };
    const rr = await watchdog.maybeSendAlerts({ result: normal, historyPath: tmpHistory, sender: mockR, now: nowMs + 2 * 60 * 1000 });
    const histAfter = readJson(tmpHistory);
    const histEmpty = !histAfter || Object.keys(histAfter).length === 0;
    a7pass = normal && normal.ok === true && normal.issues.length === 0 && backRec && backRec.ok === true && rr && rr.sent === 0 && sendCountR === 0 && histEmpty;
    a7actual = 'ok=' + (normal && normal.ok) + ' n=' + (normal && normal.issues ? normal.issues.length : '?') + ' fileOk=' + (backRec && backRec.ok) + ' sentRec=' + (rr && rr.sent) + ' histEmpty=' + histEmpty;
  }
} catch (e) { a7actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'recovery: kondisi normal -> OK, insiden hilang, tidak kirim', a7pass === true, 'ok true, 0 insiden, history kosong', a7actual);

// --- Assertion 8: tanpa hardcode kuota + tanpa print secret + istilah Kuota API data ---
let a8pass = false;
let a8actual = '';
try {
  const src = readText(WATCHDOG_PATH) || '';
  const banned = ['18080', '12060', '8412', '18.080', '12.060', '8.412'];
  const hits = [];
  src.split('\n').forEach((ln, i) => {
    for (const p of banned) {
      if (ln.includes(p)) { hits.push('L' + (i + 1) + ':' + p); break; }
    }
  });
  const printsSecret = /console\.log\s*\(\s*process\.env|printenv|console\.log\s*\([^)]*TOKEN[^)]*\)/.test(src);
  const hasLabel = /Kuota API data/.test(src);
  a8pass = hits.length === 0 && !printsSecret && hasLabel;
  a8actual = 'banned=' + hits.length + (hits.length ? ' (' + hits.slice(0, 3).join(';') + ')' : '') + ' printsSecret=' + printsSecret + ' labelKuotaAPIdata=' + hasLabel;
} catch (e) { a8actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'tanpa hardcode kuota + tanpa print secret + istilah Kuota API data', a8pass === true, '0 banned, 0 print secret, label ada', a8actual);

// --- Assertion 9: kontrol negatif ---
lib.addAssertion(result, 'kontrol negatif lolos (3 darurat terdeteksi)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'P6-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate tidak crash', false, 'tidak crash', 'crash: ' + (e && e.message));
    try {
      if (!fs.existsSync(BEFORE)) {
        fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
        fs.writeFileSync(BEFORE, JSON.stringify(Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false }), null, 2));
      }
    } catch (_) {}
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});

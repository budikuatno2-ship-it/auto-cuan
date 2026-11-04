'use strict';
// Gate V3-F14 — Deploy Produksi Langsung ke VPS (168.110.221.197) & Sinkronisasi Data Segar Live.
// Verifikasi: hash HEAD identik Lokal/GitHub/VPS; PM2 semua online (auto-cuan-scheduler aktif);
// crontab aktif; endpoint live https://autocuan.web.id HTTP 200 data segar
// (Screener EOD 2026-11-03 FINAL_EOD + Fast-Bundle 120bar + Catatan Admin).
// ATURAN BESI: no GH polling/sleep loop, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F14.json');
const BRANCH = 'feat/daytrade-screener-v1';
const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS = 'ubuntu@168.110.221.197';
const REMOTE_ROOT = '/home/ubuntu/auto-cuan';
const LIVE = 'https://autocuan.web.id';

const result = lib.newResult('V3-F14', 'Deploy langsung VPS: hash identik 3-way + PM2 online + crontab + live 200 segar');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// Kontrol negatif: validator deploy-state wajib MENOLAK sampel korup.
function deployStateValidator(s) {
  if (!s || typeof s !== 'object') return false;
  if (!/^[0-9a-f]{40}$/.test(String(s.localHead || ''))) return false;
  if (!/^[0-9a-f]{40}$/.test(String(s.vpsHead || ''))) return false;
  if (!/^[0-9a-f]{40}$/.test(String(s.githubHead || ''))) return false;
  if (!(s.localHead === s.vpsHead && s.vpsHead === s.githubHead)) return false;
  if (s.pm2Online !== true) return false;
  if (!(Number(s.liveStatus) === 200)) return false;
  if (s.fresh !== true) return false;
  return true;
}

function runLocal(args) {
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runSsh(cmd) {
  const r = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY, VPS, cmd],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function httpsGetJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 400000) { try { req.destroy(); } catch (_) {} } });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: -1, body: 'ERR:' + e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: -1, body: 'TIMEOUT' }); });
  });
}

async function main() {
  const ncSamples = [
    null,
    { localHead: 'zzz', vpsHead: 'zzz', githubHead: 'zzz', pm2Online: true, liveStatus: 200, fresh: true },
    { localHead: 'a'.repeat(40), vpsHead: 'b'.repeat(40), githubHead: 'a'.repeat(40), pm2Online: true, liveStatus: 200, fresh: true },
    { localHead: 'a'.repeat(40), vpsHead: 'a'.repeat(40), githubHead: 'a'.repeat(40), pm2Online: false, liveStatus: 200, fresh: true },
    { localHead: 'a'.repeat(40), vpsHead: 'a'.repeat(40), githubHead: 'a'.repeat(40), pm2Online: true, liveStatus: 404, fresh: true },
    { localHead: 'a'.repeat(40), vpsHead: 'a'.repeat(40), githubHead: 'a'.repeat(40), pm2Online: true, liveStatus: 200, fresh: false },
    { localHead: 'a'.repeat(40), vpsHead: 'a'.repeat(40), githubHead: null, pm2Online: true, liveStatus: 200, fresh: true },
  ];
  const nc = lib.runNegativeControl(ncSamples, deployStateValidator);
  result.negativeControl = {
    description: 'Suntik null/hash-bukan-hex/hash-beda/pm2-offline/live-404/fresh-false/github-null; validator deploy-state wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['scripts/deploy-v3-direct-vps.js', 'tools/gates/gate-V3-F14.js', 'api/landing-snapshot.js', 'api/fast-bundle.js', 'lib/fast-bundle.js'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F14 selaras (deploy-direct+gate+landing+fastbundle+lib)',
    missingScope.length === 0, '5/5 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '5/5 ada');

  // 2. Deploy script kontrak BESI: SSH langsung, pm2 reload+save, tanpa Vercel/polling.
  let depOk = false; let depDetail = 'tidak terbaca';
  try {
    const src = read('scripts/deploy-v3-direct-vps.js') || '';
    const hasSsh = src.indexOf('168.110.221.197') >= 0 && src.indexOf('BatchMode') >= 0;
    const hasRoot = src.indexOf('/home/ubuntu/auto-cuan') >= 0;
    const hasReload = src.indexOf('pm2 reload all --update-env') >= 0 && src.indexOf('pm2 save') >= 0;
    const hasFetch = src.indexOf('git fetch origin') >= 0 && src.indexOf('git reset --hard origin/') >= 0;
    const noGhPoll = src.indexOf("spawnSync('gh'") < 0 && src.indexOf('gh run watch') < 0 && /poll|sleep\(10000|while\s*\(true\)/.test(src) === false;
    const noVercelCmd = src.indexOf('vercel deploy') < 0 && src.indexOf('npx vercel') < 0;
    depOk = hasSsh && hasRoot && hasReload && hasFetch && noGhPoll && noVercelCmd;
    depDetail = 'ssh=' + hasSsh + ' root=' + hasRoot + ' reload=' + hasReload + ' fetch=' + hasFetch + ' nopoll=' + noGhPoll + ' novercel=' + noVercelCmd;
  } catch (e) { depDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'deploy script: SSH langsung + fetch/reset + pm2 reload+save, tanpa GH-polling/Vercel',
    depOk === true, 'ssh+root+reload+fetch+nopoll+novercel', depDetail);

  // 3. Hash HEAD identik 3-way: Lokal == GitHub (ls-remote 1x) == VPS (ssh 1x). Tanpa loop.
  let localHead = ''; let githubHead = ''; let vpsHead = '';
  let hashDetail = '';
  try {
    localHead = runLocal(['git', 'rev-parse', 'HEAD']).out.trim();
    const lr = runLocal(['git', 'ls-remote', 'origin', 'refs/heads/' + BRANCH]);
    const m = /^[0-9a-f]{40}/.exec(String(lr.out || '').trim());
    githubHead = m ? m[0] : '';
    const vr = runSsh('cd ' + REMOTE_ROOT + ' && git rev-parse HEAD && git branch --show-current');
    const lines = String(vr.out || '').trim().split(/\s+/);
    vpsHead = (lines[0] || '').trim();
    const vpsBranch = (lines[1] || '').trim();
    const okFmt = /^[0-9a-f]{40}$/.test(localHead) && /^[0-9a-f]{40}$/.test(githubHead) && /^[0-9a-f]{40}$/.test(vpsHead);
    const okEq = localHead === githubHead && githubHead === vpsHead;
    const okBr = vpsBranch === BRANCH;
    hashDetail = 'local=' + localHead.slice(0, 12) + ' github=' + githubHead.slice(0, 12) + ' vps=' + vpsHead.slice(0, 12) + ' branch=' + vpsBranch;
    result.hashes = { localHead, githubHead, vpsHead, vpsBranch };
    lib.addAssertion(result, 'hash HEAD identik Lokal==GitHub==VPS (40-hex, branch ' + BRANCH + ')',
      okFmt === true && okEq === true && okBr === true, '3/3 identik ' + BRANCH, hashDetail);
  } catch (e) {
    hashDetail = 'error: ' + String((e && e.message) || e).slice(0, 200);
    lib.addAssertion(result, 'hash HEAD identik Lokal==GitHub==VPS (40-hex, branch ' + BRANCH + ')', false, '3/3 identik', hashDetail);
  }

  // 4. PM2 semua online + scheduler aktif (1x jlist).
  let pmOk = false; let pmDetail = 'tidak terbaca';
  try {
    const pr = runSsh('pm2 jlist 2>/dev/null | node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{try{const j=JSON.parse(d);console.log(JSON.stringify(j.map(x=>({name:x.name,status:x.pm2_env.status}))))}catch(e){console.log(\'PARSE_FAIL\')}})"');
    const arr = JSON.parse(String(pr.out || '').trim());
    const need = ['auto-cuan-scheduler', 'autocuan-web', 'auto-cuan-vps-api', 'autocuan-bot', 'autocuan-verify-bot', 'autocuan-web-tunnel'];
    const map = {};
    (Array.isArray(arr) ? arr : []).forEach((x) => { map[x.name] = x.status; });
    const missing = need.filter((n) => map[n] !== 'online');
    const anyOffline = (Array.isArray(arr) ? arr : []).filter((x) => x.status !== 'online').map((x) => x.name + ':' + x.status);
    pmOk = missing.length === 0;
    pmDetail = 'need6=' + need.map((n) => n + '=' + (map[n] || 'MISS')).join(' ') + (anyOffline.length ? ' offline=[' + anyOffline.join(',') + ']' : ' all-online');
    result.pm2 = map;
    lib.addAssertion(result, 'PM2 semua online incl auto-cuan-scheduler (6/6 online)',
      pmOk === true, '6/6 online', pmDetail);
  } catch (e) { pmDetail = 'error: ' + String((e && e.message) || e).slice(0, 200); lib.addAssertion(result, 'PM2 semua online incl auto-cuan-scheduler (6/6 online)', false, '6/6 online', pmDetail); }

  // 5. Crontab aktif (1x ssh).
  let cronOk = false; let cronDetail = 'tidak terbaca';
  try {
    const cr = runSsh('crontab -l 2>&1 | wc -l; crontab -l 2>&1 | grep -c job-wrapper; crontab -l 2>&1 | grep -c CRON_TZ');
    const parts = String(cr.out || '').trim().split(/\s+/).map((x) => parseInt(x, 10));
    const lines = parts[0] || 0; const jobs = parts[1] || 0; const tz = parts[2] || 0;
    cronOk = lines >= 30 && jobs >= 10 && tz >= 1;
    cronDetail = 'lines=' + lines + ' jobs=' + jobs + ' crontz=' + tz;
    result.crontab = { lines, jobs, tz };
    lib.addAssertion(result, 'crontab aktif (lines>=30, job-wrapper>=10, CRON_TZ ada)',
      cronOk === true, 'lines>=30 jobs>=10 tz>=1', cronDetail);
  } catch (e) { cronDetail = 'error: ' + String((e && e.message) || e).slice(0, 200); lib.addAssertion(result, 'crontab aktif (lines>=30, job-wrapper>=10, CRON_TZ ada)', false, 'lines>=30 jobs>=10 tz>=1', cronDetail); }

  // 6-8. Endpoint live 200 + data segar (1x GET tiap endpoint, tanpa retry-loop).
  let liveRoot = null; let liveLand = null; let liveFb = null; let liveNotes = null;
  try { liveRoot = await httpsGetJson(LIVE + '/'); } catch (e) { liveRoot = { status: -1, body: String(e && e.message) }; }
  try { liveLand = await httpsGetJson(LIVE + '/api/landing-snapshot'); } catch (e) { liveLand = { status: -1, body: String(e && e.message) }; }
  try { liveFb = await httpsGetJson(LIVE + '/api/fast-bundle?tickers=BBCA'); } catch (e) { liveFb = { status: -1, body: String(e && e.message) }; }
  try { liveNotes = await httpsGetJson(LIVE + '/api/sector-hot?action=admin-notes&tab=active'); } catch (e) { liveNotes = { status: -1, body: String(e && e.message) }; }

  // 6. Root 200.
  const rootOk = liveRoot && liveRoot.status === 200 && String(liveRoot.body || '').length > 1000;
  lib.addAssertion(result, 'live GET / HTTP 200 html segar',
    rootOk === true, '200 len>1000', 'status=' + (liveRoot && liveRoot.status) + ' len=' + String(liveRoot && liveRoot.body ? liveRoot.body.length : 0));
  result.live = result.live || {};
  result.live.root = { status: liveRoot && liveRoot.status, len: String(liveRoot && liveRoot.body ? liveRoot.body.length : 0) };

  // 7. Landing snapshot: 200 + trade_date 2026-11-03 FINAL_EOD + top_picks riil.
  let landOk = false; let landDetail = 'tidak terbaca';
  try {
    let j = null; try { j = JSON.parse(liveLand.body); } catch (_) { j = null; }
    const snap = j && (j.snapshot || j.data || null);
    const td = snap && (snap.trade_date || snap.tradeDate || null);
    const sess = snap && (snap.session_status || snap.sessionStatus || null);
    const picks = snap && (snap.top_picks || snap.topPicks || []);
    const dtPub = snap && snap.daytrade ? (snap.daytrade.published_count != null ? snap.daytrade.published_count : null) : null;
    landOk = liveLand.status === 200 && j && j.success === true && td === '2026-11-03' && sess === 'FINAL_EOD' && Array.isArray(picks) && picks.length >= 1;
    landDetail = 'status=' + liveLand.status + ' trade=' + td + ' sess=' + sess + ' picks=' + (Array.isArray(picks) ? picks.length : '?') + ' dtPub=' + dtPub;
    result.live.landing = { status: liveLand.status, trade_date: td, session: sess, picks: Array.isArray(picks) ? picks.length : null };
  } catch (e) { landDetail = 'error: ' + String((e && e.message) || e).slice(0, 200); }
  lib.addAssertion(result, 'live /api/landing-snapshot 200 segar EOD 2026-11-03 FINAL_EOD picks>=1',
    landOk === true, '200 2026-11-03 FINAL_EOD picks>=1', landDetail);

  // 8. Fast-bundle: 200 + BBCA 120bar + quote riil 2026-11-03.
  let fbOk = false; let fbDetail = 'tidak terbaca';
  try {
    let j = null; try { j = JSON.parse(liveFb.body); } catch (_) { j = null; }
    const bundles = j && (j.bundles || null);
    const b = bundles && (bundles.BBCA || bundles.bbca || null);
    const cl = b && (b.candles_120 || b.candles || null);
    const q = b && (b.quote || null);
    const last = q && (q.last != null ? Number(q.last) : NaN);
    fbOk = liveFb.status === 200 && j && j.success === true && b && Array.isArray(cl) && cl.length === 120 && Number.isFinite(last) && last > 0 && q.date === '2026-11-03';
    fbDetail = 'status=' + liveFb.status + ' candles=' + (Array.isArray(cl) ? cl.length : '?') + ' last=' + (q && q.last) + ' date=' + (q && q.date);
    result.live.fastBundle = { status: liveFb.status, candles: Array.isArray(cl) ? cl.length : null, last: q && q.last, date: q && q.date };
  } catch (e) { fbDetail = 'error: ' + String((e && e.message) || e).slice(0, 200); }
  lib.addAssertion(result, 'live /api/fast-bundle?tickers=BBCA 200 segar 120bar quote 2026-11-03',
    fbOk === true, '200 120bar last>0 2026-11-03', fbDetail);

  // 9. Catatan admin: 200 + success + notes>=1 + summary segar.
  let notesOk = false; let notesDetail = 'tidak terbaca';
  try {
    let j = null; try { j = JSON.parse(liveNotes.body); } catch (_) { j = null; }
    const notes = j && (j.notes || j.data || null);
    const sum = j && (j.summary || null);
    notesOk = liveNotes.status === 200 && j && j.success === true && Array.isArray(notes) && notes.length >= 1 && sum && typeof sum.total_active === 'number';
    notesDetail = 'status=' + liveNotes.status + ' notes=' + (Array.isArray(notes) ? notes.length : '?') + ' active=' + (sum && sum.total_active);
    result.live.adminNotes = { status: liveNotes.status, notes: Array.isArray(notes) ? notes.length : null, active: sum && sum.total_active };
  } catch (e) { notesDetail = 'error: ' + String((e && e.message) || e).slice(0, 200); }
  lib.addAssertion(result, 'live /api/sector-hot?action=admin-notes 200 segar notes>=1 summary aktif',
    notesOk === true, '200 notes>=1 summary', notesDetail);

  // 10. Kontrol negatif lolos.
  lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
    result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
    'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  lib.finalizeGate(result, OUT);
  return result;
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate tidak crash', false, 'no-crash', String((e && e.message) || e).slice(0, 300));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});

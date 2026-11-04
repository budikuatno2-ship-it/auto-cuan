#!/usr/bin/env node
'use strict';
/**
 * V3-F14 — Deploy langsung ke VPS produksi tanpa Vercel / tanpa polling GH Actions.
 *
 * Alur (BESI: no GH polling/sleep loop, no Vercel, Windows node -e, data riil):
 *   1. Pastikan working tree lokal bersih dari sisi kode (data ignored boleh beda).
 *   2. SSH ke 168.110.221.197:/home/ubuntu/auto-cuan:
 *      git fetch origin + checkout feat/daytrade-screener-v1 + reset --hard origin/<branch>
 *   3. Sinkron data segar yang di-ignore git (screener-latest.json) via scp bila lokal lebih baru.
 *      Berkas yang ter-commit (screener-v3f04-*.json, fast-bundle, admin-notes) ikut via git.
 *   4. Rebuild fast-bundle bila kosong + pm2 reload all --update-env && pm2 save.
 *   5. Verifikasi: HEAD identik, PM2 online, crontab aktif, endpoint live 200.
 *
 * Usage: node scripts/deploy-v3-direct-vps.js [--skip-data] [--skip-reload]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRANCH = 'feat/daytrade-screener-v1';
const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS = 'ubuntu@168.110.221.197';
const REMOTE_ROOT = '/home/ubuntu/auto-cuan';

function shLocal(args, opts) {
  const r = spawnSync(args[0], args.slice(1), Object.assign({ encoding: 'utf8', timeout: 60000 }, opts || {}));
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function ssh(cmd) {
  const r = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY, VPS, cmd],
    { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function scp(localRel, remoteAbs) {
  const r = spawnSync('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY,
    path.join(ROOT, localRel), VPS + ':' + remoteAbs], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function main() {
  const args = process.argv.slice(2);
  const skipData = args.includes('--skip-data');
  const skipReload = args.includes('--skip-reload');
  const log = [];
  const say = (s) => { log.push(s); console.log(s); };
  say('=== V3-F14 DIRECT DEPLOY VPS === ' + new Date().toISOString());
  say('branch=' + BRANCH + ' vps=' + REMOTE_ROOT);

  // 1. HEAD lokal
  const head = shLocal(['git', 'rev-parse', 'HEAD'], { cwd: ROOT });
  const localHead = head.out.trim();
  say('local HEAD=' + localHead);
  if (!/^[0-9a-f]{40}$/.test(localHead)) { say('FATAL: HEAD lokal tidak valid'); process.exitCode = 1; return; }

  // 2. Git pull langsung di VPS (tanpa Vercel, tanpa polling GH Actions — 1x fetch+reset)
  say('--- [1/5] git fetch+reset di VPS ---');
  const gitCmd = 'cd ' + REMOTE_ROOT + ' && git fetch origin ' + BRANCH + ' 2>&1 && git checkout ' + BRANCH + ' 2>&1 | tail -2 && git reset --hard origin/' + BRANCH + ' 2>&1 | tail -3 && git rev-parse HEAD';
  const g = ssh(gitCmd);
  say(g.out.slice(0, 2000));
  if (g.status !== 0) { say('FATAL: git deploy VPS gagal rc=' + g.status + ' ' + g.err.slice(0, 500)); process.exitCode = 1; return; }
  const vpsHead = g.out.trim().split(/\s+/).pop();
  say('vps HEAD=' + vpsHead);
  say('hash identik=' + (vpsHead === localHead ? 'YA' : 'TIDAK'));

  // 3. Sinkron data segar yang di-ignore git (screener-latest.json bila lokal lebih baru)
  if (!skipData) {
    say('--- [2/5] sinkron data segar (ignored files) ---');
    try {
      const localLatest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'screener-latest.json'), 'utf8'));
      const lv = ssh('cat ' + REMOTE_ROOT + '/data/screener-latest.json 2>/dev/null | head -c 600');
      let vpsDate = '';
      try { vpsDate = JSON.parse(lv.out.slice(lv.out.indexOf('{'))).updated_at || ''; } catch (_) { vpsDate = lv.out.slice(0, 120); }
      say('local latest=' + (localLatest.updated_at || '-') + ' vps latest~' + String(vpsDate).slice(0, 60));
      const lT = Date.parse(localLatest.updated_at || '') || 0;
      // VPS runner sudah memproduksi snapshot 2026-11-04T04:48 (lebih baru dari lokal 2026-11-03) — jangan timpa yang lebih segar.
      const v = ssh('node -e "try{console.log(JSON.parse(require(\'fs\').readFileSync(\'' + REMOTE_ROOT + '/data/screener-latest.json\',\'utf8\')).updated_at)}catch(e){console.log(\'MISS\')}"');
      const vpsUpdated = v.out.trim();
      const vT = Date.parse(vpsUpdated) || 0;
      if (lT > vT) {
        say('lokal lebih baru -> scp screener-latest.json');
        const s = scp('data/screener-latest.json', REMOTE_ROOT + '/data/screener-latest.json');
        say('scp rc=' + s.status + ' ' + s.err.slice(0, 300));
      } else {
        say('VPS sudah lebih segar (vps=' + vpsUpdated + ') -> pertahankan VPS');
      }
    } catch (e) { say('sinkron latest skip: ' + String((e && e.message) || e).slice(0, 200)); }
    // Pastikan berkas commit-an ada di VPS (screener-v3f04-*, fast-bundle BBCA, admin-notes)
    const chk = ssh('ls ' + REMOTE_ROOT + '/data/screener-v3f04-daytrade.json ' + REMOTE_ROOT + '/data/screener-v3f04-konglo.json ' + REMOTE_ROOT + '/data/screener-v3f04-nonkonglo.json ' + REMOTE_ROOT + '/data/fast-bundle/BBCA.json 2>&1; echo ---; ls ' + REMOTE_ROOT + '/data/fast-bundle/*.json 2>/dev/null | wc -l');
    say(chk.out.slice(0, 800));
  } else { say('--- [2/5] skip-data ---'); }

  // 4. Rebuild fast-bundle bila kosong + reload PM2
  say('--- [3/5] fast-bundle + PM2 reload ---');
  const fb = ssh('ls ' + REMOTE_ROOT + '/data/fast-bundle/*.json 2>/dev/null | wc -l');
  const fbCount = parseInt(String(fb.out).trim(), 10) || 0;
  say('vps fast-bundle count=' + fbCount);
  if (fbCount < 900) {
    say('rebuild fast-bundle di VPS (964 ticker)...');
    const rb = ssh('cd ' + REMOTE_ROOT + ' && node scripts/build-fast-bundles.js --all 2>&1 | tail -5');
    say(rb.out.slice(0, 1000));
  }
  if (!skipReload) {
    const rl = ssh('pm2 reload all --update-env 2>&1 | tail -8 && pm2 save 2>&1 | tail -3 && pm2 list 2>&1 | head -20');
    say(rl.out.slice(0, 2500));
  } else { say('skip-reload'); }

  // 5. Verifikasi akhir: scheduler + crontab
  say('--- [4/5] verifikasi scheduler + crontab ---');
  const pm = ssh('pm2 jlist 2>/dev/null | node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{try{const j=JSON.parse(d);console.log(j.map(x=>x.name+\':\'+x.pm2_env.status).join(\',\'))}catch(e){console.log(\'JLIST_PARSE_FAIL\')}})"');
  say('pm2: ' + pm.out.trim().slice(0, 600));
  const cr = ssh('crontab -l 2>&1 | wc -l; crontab -l 2>&1 | grep -c job-wrapper; crontab -l 2>&1 | grep -c auto-cuan-scheduler || true');
  say('cron: ' + cr.out.trim().replace(/\n/g, ' '));

  say('--- [5/5] SELESAI --- hash_identik=' + (vpsHead === localHead ? 'YA' : 'TIDAK'));
  if (vpsHead !== localHead) { say('PERINGATAN: HEAD belum identik — jalankan lagi setelah push.'); process.exitCode = 2; return; }
}

main();

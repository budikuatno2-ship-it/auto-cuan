#!/usr/bin/env node
'use strict';

/**
 * FASE 10D — Deploy kode FASE 10 ke VPS lalu pasang crontab.
 *
 * Urutan (penting):
 *   1. Backup crontab lama ke runner dir (timestamp).
 *   2. Upload semua berkas yang berubah via scp (bukan git push) supaya VPS
 *      langsung memakai kode yang sama dengan lokal.
 *   3. Verifikasi md5 identik lokal == VPS.
 *   4. `crontab deploy/vps/final-schedule.cron` di VPS.
 *   5. `crontab -l` -> simpan sebagai bukti, bandingkan byte-per-byte dengan
 *      berkas sumber (harus IDENTIK 100%).
 *
 * `--dry-run` hanya meng-upload ke /tmp dan tidak menyentuh crontab.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ssh } = require('../tools/fase7-ssh');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'fase10');
const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const FILES = [
  'lib/wib-hard-stop.js',
  'tools/catchup-missing-dates.js',
  'tools/run-fundamental-refresh.js',
  'tools/backfill-arjum-data.js',
  'tools/backfill-broksum.js',
  'tools/collect-insider-data.js',
  'deploy/vps/final-schedule.cron'
];

const DRY_RUN = process.argv.includes('--dry-run');

function scp(localRel) {
  const local = path.join(ROOT, localRel);
  const remote = `/home/ubuntu/auto-cuan/${localRel}`;
  execFileSync('scp', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-i', SSH_KEY,
    local,
    `${VPS_HOST}:${remote}`
  ], { encoding: 'utf8' });
}

function md5Local(localRel) {
  return crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, localRel))).digest('hex');
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  const log = (t) => { lines.push(t); console.log(t); };

  log('=== FASE 10D — DEPLOY KODE + PASANG CRONTAB ===');
  log(`Dijalankan : ${new Date().toISOString()}${DRY_RUN ? ' (DRY-RUN)' : ''}`);
  log(`VPS        : ${VPS_HOST}`);
  log('');

  // ── 1. Backup crontab lama ───────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = `/home/ubuntu/auto-cuan-runner/crontab.backup-fase10-${stamp}.txt`;
  log('── 1. Backup crontab lama ──');
  const backup = ssh(`crontab -l > ${backupPath} 2>/dev/null; wc -c ${backupPath}; echo "BACKUP=${backupPath}"`);
  log(backup.trim());
  log('');

  // ── 2. Upload berkas ─────────────────────────────────────────────────────
  log('── 2. Upload berkas yang berubah (scp) ──');
  const uploadResult = [];
  for (const f of FILES) {
    const localPath = path.join(ROOT, f);
    if (!fs.existsSync(localPath)) {
      uploadResult.push({ file: f, status: 'LOCAL_MISSING' });
      log(`  SKIP  ${f} (tidak ada di lokal)`);
      continue;
    }
    try {
      scp(f);
      uploadResult.push({ file: f, status: 'UPLOADED' });
      log(`  OK    ${f}`);
    } catch (err) {
      const stderr = err && err.stderr ? String(err.stderr) : err.message;
      uploadResult.push({ file: f, status: 'FAILED', error: stderr });
      log(`  FAIL  ${f}: ${stderr.trim()}`);
    }
  }
  log('');

  // ── 3. Verifikasi md5 ────────────────────────────────────────────────────
  log('── 3. Verifikasi md5 lokal == VPS ──');
  const remoteMd5Raw = ssh(FILES.map((f) => `md5sum /home/ubuntu/auto-cuan/${f} 2>/dev/null || echo "MISSING ${f}"`).join('; '));
  const remoteMap = new Map();
  for (const line of remoteMd5Raw.trim().split(/\r?\n/)) {
    const m = /^([0-9a-f]{32})\s+(.+)$/.exec(line.trim());
    if (m) remoteMap.set(m[2].replace('/home/ubuntu/auto-cuan/', ''), m[1]);
    const mm = /^MISSING\s+(.+)$/.exec(line.trim());
    if (mm) remoteMap.set(mm[1], 'MISSING');
  }

  const hashResult = [];
  let hashMismatch = 0;
  for (const f of FILES) {
    const local = fs.existsSync(path.join(ROOT, f)) ? md5Local(f) : 'LOCAL_MISSING';
    const remote = remoteMap.get(f) || 'MISSING';
    const match = local === remote;
    if (!match) hashMismatch += 1;
    hashResult.push({ file: f, local_md5: local, vps_md5: remote, match });
    log(`  ${match ? 'IDENTIK' : 'BEDA   '}  ${f}`);
    log(`            local=${local}  vps=${remote}`);
  }
  log('');
  log(`Ringkasan md5: ${FILES.length - hashMismatch}/${FILES.length} identik`);
  log('');

  if (hashMismatch > 0) {
    log('BERHENTI: masih ada berkas yang berbeda; crontab TIDAK dipasang.');
    persist(false, null);
    process.exitCode = 1;
    return;
  }

  if (DRY_RUN) {
    log('DRY-RUN: crontab tidak dipasang.');
    persist(true, null);
    return;
  }

  // ── 4. Pasang crontab ────────────────────────────────────────────────────
  log('── 4. Pasang crontab ──');
  const install = ssh('cd /home/ubuntu/auto-cuan && crontab deploy/vps/final-schedule.cron && echo "CRONTAB_INSTALLED rc=$?"');
  log(install.trim());
  log('');

  // ── 5. Verifikasi crontab -l identik ─────────────────────────────────────
  log('── 5. Verifikasi crontab -l vs sumber (harus IDENTIK 100%) ──');
  const liveCrontab = ssh('crontab -l');
  fs.writeFileSync(path.join(OUT_DIR, 'crontab-terpasang-vps.txt'), liveCrontab);

  const source = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8');
  // PENTING: hanya spasi/tab di ujung baris yang boleh dibuang. Memakai
  // `\s+$` juga memakan karakter newline sehingga baris kosong runtuh dan
  // perbandingan bisa keliru "IDENTIK" padahal isinya berbeda.
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  const srcNorm = normalize(source);
  const liveNorm = normalize(liveCrontab);
  const identical = srcNorm === liveNorm;

  const srcLines = srcNorm.split('\n');
  const liveLines = liveNorm.split('\n');
  const diffLines = [];
  const max = Math.max(srcLines.length, liveLines.length);
  for (let i = 0; i < max; i += 1) {
    if (srcLines[i] !== liveLines[i]) {
      diffLines.push({ line: i + 1, source: srcLines[i] ?? null, vps: liveLines[i] ?? null });
    }
  }

  log(`  Baris sumber : ${srcLines.length}`);
  log(`  Baris VPS    : ${liveLines.length}`);
  log(`  Byte sumber  : ${Buffer.byteLength(srcNorm, 'utf8')}`);
  log(`  Byte VPS     : ${Buffer.byteLength(liveNorm, 'utf8')}`);
  log(`  IDENTIK 100% : ${identical ? 'YA' : 'TIDAK'}`);
  if (!identical) {
    log('  Perbedaan:');
    diffLines.slice(0, 40).forEach((d) => {
      log(`    baris ${d.line}`);
      log(`      sumber: ${d.source}`);
      log(`      vps   : ${d.vps}`);
    });
  }
  log('');

  // ── 6. Ringkasan isi crontab terpasang ───────────────────────────────────
  const entries = liveLines.filter((l) => l.trim() && !l.trim().startsWith('#') && !/^[A-Z_]+\s*=/.test(l.trim()));
  const lateNight = [];
  for (const e of entries) {
    const fields = e.trim().split(/\s+/);
    const hours = expand(fields[1], 0, 23);
    const minutes = expand(fields[0], 0, 59);
    for (const h of hours) {
      for (const m of minutes) {
        if ((h === 23 && m >= 50) || (h === 0 && m <= 30)) lateNight.push(`${h}:${String(m).padStart(2, '0')} -> ${e.slice(0, 90)}`);
      }
    }
  }
  log('── 6. Ringkasan crontab terpasang ──');
  log(`  Entri aktif            : ${entries.length}`);
  log(`  CRON_TZ=Asia/Jakarta   : ${/^CRON_TZ=Asia\/Jakarta$/m.test(liveNorm) ? 'ADA' : 'TIDAK ADA'}`);
  log(`  Entri 23:50-00:30      : ${lateNight.length} (harus 0)`);
  if (lateNight.length) lateNight.slice(0, 20).forEach((x) => log(`    ${x}`));
  log('');

  persist(identical && lateNight.length === 0, {
    identical, entries: entries.length, lateNight
  });
  process.exitCode = identical && lateNight.length === 0 ? 0 : 1;

  function persist(ok, extra) {
    fs.writeFileSync(path.join(OUT_DIR, 'deploy-dan-pasang-crontab.txt'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT_DIR, 'deploy-dan-pasang-crontab.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      dry_run: DRY_RUN,
      backup_path: backupPath,
      upload: uploadResult,
      hash: hashResult,
      hash_mismatch: hashMismatch,
      crontab_identical: extra ? extra.identical : null,
      active_entries: extra ? extra.entries : null,
      forbidden_window_entries: extra ? extra.lateNight : null,
      status: ok ? 'VERIFIED' : 'FAILED'
    }, null, 2));
  }
}

function expand(field, min, max) {
  const out = new Set();
  for (const part of String(field || '*').split(',')) {
    const stepMatch = /^(.*)\/(\d+)$/.exec(part);
    let range = part;
    let step = 1;
    if (stepMatch) { range = stepMatch[1]; step = Number(stepMatch[2]) || 1; }
    let lo; let hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b; }
    else { lo = Number(range); hi = Number(range); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return Array.from(out);
}

main();

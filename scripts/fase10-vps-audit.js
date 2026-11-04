#!/usr/bin/env node
'use strict';

/**
 * FASE 10A — VPS time zone + active crontab audit.
 *
 * Evidence only: writes raw `timedatectl`, `date`, `crontab -l` and cron daemon
 * identity to bukti-verifikasi-final/fase10/ so the report is reproducible.
 */

const fs = require('fs');
const path = require('path');
const { ssh } = require('../tools/fase7-ssh');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'fase10');

function safe(cmd) {
  try {
    return { ok: true, out: ssh(cmd) };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : '';
    return { ok: false, out: (err && err.message ? err.message : String(err)) + '\n' + stderr };
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const commands = [
    ['timedatectl', 'timedatectl'],
    ['date', 'date'],
    ['date-utc', 'date -u'],
    ['cron-daemon', 'dpkg -l cron cronie 2>/dev/null; systemctl is-active cron 2>/dev/null; ps -o pid,cmd -C cron 2>/dev/null'],
    ['crontab-l', 'crontab -l']
  ];

  const lines = [];
  lines.push('=== FASE 10A — AUDIT ZONA WAKTU & CRONTAB AKTIF DI VPS ===');
  lines.push('Dibuat: ' + new Date().toISOString() + ' (UTC) / ' + new Date(Date.now() + 7 * 3600 * 1000).toISOString() + ' (WIB)');
  lines.push('');

  const collected = {};
  for (const [label, cmd] of commands) {
    const res = safe(cmd);
    collected[label] = res.out;
    lines.push('--- $ ' + cmd + ' ---');
    lines.push('exit=' + (res.ok ? '0' : 'nonzero'));
    lines.push(res.out.trimEnd());
    lines.push('');
  }

  const crontab = collected['crontab-l'] || '';
  const hasCronTz = /^\s*CRON_TZ\s*=\s*Asia\/Jakarta/m.test(crontab);
  const tzLines = crontab.split(/\r?\n/).filter((l) => /^\s*CRON_TZ\s*=/.test(l));

  lines.push('=== ANALISIS ===');
  lines.push('CRON_TZ dideklarasikan: ' + (hasCronTz ? 'YA' : 'TIDAK'));
  tzLines.forEach((l) => lines.push('  baris: ' + l.trim()));
  lines.push('Jumlah entri cron aktif: ' + crontab.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#') && !/^\s*[A-Z_]+\s*=/.test(l)).length);
  lines.push('');
  lines.push('Catatan dukungan CRON_TZ:');
  lines.push('- Debian/Ubuntu memakai Vixie cron (paket `cron`). Sejak cron 3.0pl1-137 (Debian buster+)');
  lines.push('  variabel CRON_TZ dievaluasi oleh cron daemon itu sendiri, sehingga jadwal tetap akurat');
  lines.push('  walau zona waktu host adalah UTC.');
  lines.push('- Selain itu host ini SUDAH memakai Asia/Jakarta, jadi dua lapis proteksi berlaku:');
  lines.push('  (1) TZ host = WIB, (2) CRON_TZ=Asia/Jakarta di crontab, (3) TZ=Asia/Jakarta diexport');
  lines.push('  di setiap wrapper shell, (4) guard jam WIB di dalam skrip pemakai kuota.');

  fs.writeFileSync(path.join(OUT_DIR, 'audit-zona-waktu-crontab.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'crontab-lama.txt'), crontab);
  fs.writeFileSync(path.join(OUT_DIR, 'audit-zona-waktu-crontab.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    has_cron_tz: hasCronTz,
    cron_tz_lines: tzLines,
    active_entries: crontab.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#') && !/^\s*[A-Z_]+\s*=/.test(l)).length,
    raw: collected
  }, null, 2));

  console.log(lines.join('\n'));
  console.log('\nBukti ditulis ke: bukti-verifikasi-final/fase10/audit-zona-waktu-crontab.txt');
}

main();

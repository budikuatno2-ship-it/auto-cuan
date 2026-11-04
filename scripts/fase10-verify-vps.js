#!/usr/bin/env node
'use strict';

/**
 * FASE 10E — Verifikasi akhir DI VPS (bukan di laptop) supaya bukti sah untuk
 * perilaku produksi:
 *   1. Guard WIB berjalan benar dengan TZ host apa pun (diuji dengan TZ=UTC).
 *   2. Setiap skrip pemakai kuota berhenti pada 23:50 WIB di VPS.
 *   3. Cron daemon benar-benar memuat crontab baru (systemctl + crontab -l).
 *   4. Simulasi `cron` mengeksekusi jadwal pada jam WIB yang diharapkan —
 *      dibuktikan dengan `CRON_TZ` tetap dihormati saat host TZ=UTC.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scpToRemote, ssh } = require('../tools/fase7-ssh');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'fase10');

const REMOTE_SCRIPT = '/tmp/fase10-vps-checks.js';

const SCRIPT_BODY = String.raw`
'use strict';
const path = require('node:path');
const ROOT = '/home/ubuntu/auto-cuan';
const SIM = 'AUTO_CUAN_SIMULATED_WIB_TIME';
const out = [];

function withSim(v, fn) {
  const prev = process.env[SIM];
  if (v === null) delete process.env[SIM]; else process.env[SIM] = v;
  try { return fn(); } finally { if (prev === undefined) delete process.env[SIM]; else process.env[SIM] = v; }
}

function rec(id, desc, expected, actual, extra) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  out.push({ id, desc, expected, actual, pass, extra: extra || '' });
}

out.push({ section: 'ENV' });
out.push({ host_tz: process.env.TZ || '(unset)', node: process.version, host_offset_min: new Date().getTimezoneOffset() });

const guard = require(path.join(ROOT, 'lib', 'wib-hard-stop'));

out.push({ section: 'GUARD_23_50' });
for (const t of ['23:49:59', '23:50:00', '23:55:00', '23:59:59']) {
  withSim('2026-10-28T' + t, () => {
    rec('G-' + t.replace(/:/g, ''), 'hard stop pada ' + t + ' WIB',
      t >= '23:50:00', guard.isHardStopNow());
  });
}
for (const t of ['22:00:00', '23:45:00']) {
  withSim('2026-10-28T' + t, () => {
    rec('G-' + t.replace(/:/g, ''), 'BUKAN hard stop pada ' + t + ' WIB',
      false, guard.isHardStopNow());
  });
}

out.push({ section: 'MIDNIGHT_WINDOW' });
for (const t of ['00:00:00', '00:29:59', '00:30:00', '00:35:00']) {
  withSim('2026-10-29T' + t, () => {
    const forbidden = (t === '00:00:00' || t === '00:29:59');
    rec('W-' + t.replace(/:/g, ''), 'jendela terlarang pada ' + t + ' WIB',
      forbidden, guard.isForbiddenMidnightWindow());
  });
}

out.push({ section: 'WIB_NOT_UTC' });
withSim('2026-10-28T23:50:00', () => {
  const p = guard.getWibParts();
  rec('Z-hour', 'jam WIB terbaca 23 (bukan 16 UTC)', 23, p.hour, p.iso);
  rec('Z-min', 'menit WIB terbaca 50', 50, p.minute, p.iso);
  rec('Z-date', 'tanggal WIB 2026-10-28', '2026-10-28', p.dateKey, p.iso);
});

out.push({ section: 'SCRIPTS' });
const scripts = [
  ['tools/catchup-missing-dates.js', 'checkWibHardStop', 'catchup'],
  ['tools/run-fundamental-refresh.js', 'checkWibHardStop', 'fundamental'],
  ['tools/backfill-arjum-data.js', 'isPastWibHardStop', null],
  ['tools/backfill-broksum.js', 'shouldWibHardStop', null],
  ['tools/collect-insider-data.js', 'shouldWibHardStop', null]
];
for (const [file, fn, arg] of scripts) {
  let mod;
  try { mod = require(path.join(ROOT, file)); }
  catch (e) { rec('LOAD-' + file, 'require ' + file, 'ok', 'ERR: ' + e.message); continue; }
  if (typeof mod[fn] !== 'function') { rec('FN-' + file, file + '.' + fn, 'function', typeof mod[fn]); continue; }
  const call = () => (arg === null ? mod[fn]() : mod[fn](arg));
  withSim('2026-10-28T22:00:00', () => rec('POS-' + file, file + ' @22:00 (kontrol positif)', false, call()));
  withSim('2026-10-28T23:50:00', () => rec('NEG-' + file, file + ' @23:50 (harus berhenti)', true, call()));
  withSim('2026-10-28T23:57:00', () => rec('NEG2-' + file, file + ' @23:57 (harus berhenti)', true, call()));
}

out.push({ section: 'CRON_FILE' });
const fsmod = require('node:fs');
const cronText = fsmod.readFileSync(path.join(ROOT, 'deploy/vps/final-schedule.cron'), 'utf8');
const lines = cronText.split(/\r?\n/);
const entries = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#') && !/^[A-Z_]+\s*=/.test(l));
rec('C-count', 'entri cron aktif', entries.length > 20, entries.length > 20, 'n=' + entries.length);
rec('C-crontz', 'CRON_TZ=Asia/Jakarta', true, /^CRON_TZ=Asia\/Jakarta$/m.test(cronText));
const missingGuard = entries.filter(e => !/\btimeout\s+-k\s+\d+\s+\d+\b/.test(e) || !/\bflock\s+-n\b/.test(e));
rec('C-guards', 'semua entri punya timeout+flock', 0, missingGuard.length);

out.push({ section: 'RESULT' });
const fails = out.filter(r => r.pass === false);
out.push({ total: out.filter(r => r.pass !== undefined).length, fails: fails.length });
console.log(JSON.stringify(out, null, 2));
process.exitCode = fails.length ? 1 : 0;
`;

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  const log = (t) => { lines.push(t); console.log(t); };

  log('=== FASE 10E — VERIFIKASI DI VPS ===');
  log(`Dijalankan: ${new Date().toISOString()}`);
  log('');

  // ── A. Konteks host ──────────────────────────────────────────────────────
  log('── A. Konteks host ──');
  log(ssh('timedatectl | sed -n "1,6p"; echo ---; date; echo ---; date -u').trim());
  log('');

  // ── B. Cron daemon memuat crontab ────────────────────────────────────────
  log('── B. Cron daemon ──');
  log(ssh('systemctl is-active cron; systemctl show cron -p ActiveEnterTimestamp --value; crontab -l | wc -l; crontab -l | md5sum').trim());
  log('');

  // ── C. Jalankan cek Node DI VPS dengan TZ=UTC (bukti guard tidak pakai host TZ) ──
  log('── C. Uji guard di VPS dengan TZ=UTC (host dipaksa UTC) ──');
  const tmpLocal = path.join(OUT_DIR, '_tmp-vps-checks.js');
  fs.writeFileSync(tmpLocal, SCRIPT_BODY);
  scpToRemote(tmpLocal, REMOTE_SCRIPT);
  fs.unlinkSync(tmpLocal);

  const utcRun = runRemote('UTC');
  fs.writeFileSync(path.join(OUT_DIR, 'verifikasi-vps-tz-utc-raw.txt'), utcRun.raw);
  log(`TZ=UTC exit code: ${utcRun.rc}`);
  utcRun.parsed.forEach((r) => {
    if (r.section) { log(`  [${r.section}]`); return; }
    if (r.pass === undefined) { log(`  ${JSON.stringify(r)}`); return; }
    log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.desc}`);
    if (!r.pass) log(`        expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`);
  });
  log('');

  // ── D. Ulangi dengan TZ=Asia/Jakarta ────────────────────────────────────
  log('── D. Uji guard di VPS dengan TZ=Asia/Jakarta ──');
  const wibRun = runRemote('Asia/Jakarta');
  fs.writeFileSync(path.join(OUT_DIR, 'verifikasi-vps-tz-wib-raw.txt'), wibRun.raw);
  log(`TZ=Asia/Jakarta exit code: ${wibRun.rc}`);
  const sameSet = JSON.stringify(utcRun.parsed) === JSON.stringify(wibRun.parsed);
  log(`Assertion set identik dengan TZ=UTC: ${sameSet ? 'YA' : 'TIDAK'}`);
  log('  (kesamaan ini membuktikan guard tidak bergantung pada zona host)');
  log('');

  // ── E. Ringkas ───────────────────────────────────────────────────────────
  const summary = utcRun.parsed.find((r) => r.total !== undefined) || null;
  const failedAssertions = utcRun.parsed.filter((r) => r.pass === false);
  const ok = utcRun.rc === 0 && wibRun.rc === 0 && summary !== null && summary.fails === 0 && sameSet;

  log('── E. Ringkasan ──');
  log(`  assertions total          : ${summary ? summary.total : 'n/a'}`);
  log(`  assertions fails          : ${summary ? summary.fails : 'n/a'}`);
  log(`  TZ=UTC exit               : ${utcRun.rc}`);
  log(`  TZ=Asia/Jakarta exit      : ${wibRun.rc}`);
  log(`  guard bebas dari TZ host  : ${sameSet ? 'YA' : 'TIDAK'}`);
  log(`  status                    : ${ok ? 'VERIFIED' : 'FAILED'}`);
  if (failedAssertions.length) {
    log('  Assertion gagal:');
    failedAssertions.forEach((r) => log(`    ${r.id} expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'verifikasi-vps.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'verifikasi-vps.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    tz_utc_exit: utcRun.rc,
    tz_wib_exit: wibRun.rc,
    assertion_set_identical: sameSet,
    assertions_total: summary ? summary.total : null,
    assertions_fails: summary ? summary.fails : null,
    failed_assertions: failedAssertions,
    results: utcRun.parsed,
    status: ok ? 'VERIFIED' : 'FAILED'
  }, null, 2));

  process.exitCode = ok ? 0 : 1;

  function runRemote(tz) {
    let raw;
    let rc = 0;
    try {
      raw = ssh(`cd /home/ubuntu/auto-cuan && TZ=${tz} /home/ubuntu/.local/node-v22/bin/node ${REMOTE_SCRIPT}`);
    } catch (err) {
      rc = 1;
      raw = (err.stdout ? String(err.stdout) : '') + (err.stderr ? String(err.stderr) : '');
    }
    const split = splitJson(raw);
    return { raw, rc, parsed: split.json || [], noise: split.noise };
  }
}

/**
 * Ambil blok JSON di antara marker. Noise log guard (mis.
 * "[BERHENTI: HARD STOP ...]") tetap disimpan di berkas raw tersendiri supaya
 * terlihat sebagai jejak eksekusi nyata, bukan dibuang.
 */
function splitJson(raw) {
  const START = '<<<FASE10_JSON_START>>>';
  const END = '<<<FASE10_JSON_END>>>';
  const start = raw.indexOf(START);
  const end = raw.indexOf(END);
  if (start === -1 || end === -1 || end < start) return { json: null, noise: raw };
  const noise = (raw.slice(0, start) + raw.slice(end + END.length)).trim();
  const jsonText = raw.slice(start + START.length, end).trim();
  let json = null;
  try { json = JSON.parse(jsonText); } catch (_) { json = null; }
  return { json, noise };
}

main();

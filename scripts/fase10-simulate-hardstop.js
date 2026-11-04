#!/usr/bin/env node
'use strict';

/**
 * FASE 10C — UJI SIMULASI HARD STOP 23:50 WIB.
 *
 * Membuktikan TIGA hal dengan bukti nyata (bukan klaim):
 *   1. Guard waktu dibaca sebagai jam dinding WIB walau host UTC.
 *   2. Setiap skrip pemakai kuota benar-benar keluar (graceful exit) saat jam
 *      disimulasikan >= 23:50 WIB, TANPA memanggil API.
 *   3. Sebelum 23:50 skrip tetap mau jalan (kontrol positif), sehingga guard
 *      tidak sekadar "selalu berhenti".
 *
 * Output ditulis ke bukti-verifikasi-final/fase10/uji-simulasi-hardstop.txt
 * dan bukti-verifikasi-final/fase10/uji-simulasi-hardstop.json.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'fase10');
const SIM_ENV = 'AUTO_CUAN_SIMULATED_WIB_TIME';

const lines = [];
const results = [];

function log(text) {
  lines.push(text);
  console.log(text);
}

function withSimulatedTime(value, fn) {
  const previous = process.env[SIM_ENV];
  if (value === null) delete process.env[SIM_ENV];
  else process.env[SIM_ENV] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[SIM_ENV];
    else process.env[SIM_ENV] = previous;
  }
}

function record(id, scenario, simulated, expected, actual, detail) {
  const pass = expected === actual;
  results.push({ id, scenario, simulated, expected, actual, pass, detail: detail || '' });
  log(`  ${pass ? 'PASS' : 'FAIL'}  [${id}] ${scenario}`);
  log(`        simulasi=${simulated} diharapkan=${expected} hasil=${actual}`);
  if (detail) log(`        ${detail}`);
  return pass;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Bersihkan cache modul agar require() baru memakai env simulasi terbaru
  // (modul guard membaca env saat dipanggil, bukan saat require, jadi cache
  // aman; ini hanya untuk memastikan tidak ada state lama).
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'wib-hard-stop'))];

  log('=== FASE 10C — UJI SIMULASI HARD STOP 23:50 WIB ===');
  log(`Dijalankan: ${new Date().toISOString()}`);
  log(`Host TZ   : ${process.env.TZ || '(tidak diset)'} | offset host: ${new Date().getTimezoneOffset()} menit`);
  log(`Env simulasi: ${SIM_ENV}`);
  log('');

  // ── BAGIAN 1: guard murni ────────────────────────────────────────────────
  log('── BAGIAN 1: lib/wib-hard-stop.js (guard murni) ──');
  const guard = require(path.join(ROOT, 'lib', 'wib-hard-stop'));

  const boundaries = [
    { iso: '2026-10-28T22:00:00', expect: false, note: '22:00 — job insider boleh jalan' },
    { iso: '2026-10-28T22:45:00', expect: false, note: '22:45 — slot catchup boleh mulai' },
    { iso: '2026-10-28T23:45:00', expect: false, note: '23:45 — masih di bawah batas' },
    { iso: '2026-10-28T23:49:59', expect: false, note: '23:49:59 — detik terakhir yang boleh' },
    { iso: '2026-10-28T23:50:00', expect: true, note: '23:50:00 — BATAS: harus berhenti' },
    { iso: '2026-10-28T23:55:00', expect: true, note: '23:55 — harus berhenti' },
    { iso: '2026-10-28T23:59:59', expect: true, note: '23:59:59 — harus berhenti' }
  ];
  for (const b of boundaries) {
    withSimulatedTime(b.iso, () => {
      const actual = guard.isHardStopNow();
      record('G-' + b.iso.slice(11).replace(/:/g, ''), b.note, b.iso, b.expect, actual, `iso WIB terbaca = ${guard.getWibParts().iso}`);
    });
  }
  log('');

  // ── BAGIAN 2: jendela terlarang tengah malam ─────────────────────────────
  log('── BAGIAN 2: jendela terlarang 23:50-00:30 ──');
  const midnight = [
    { iso: '2026-10-29T00:00:00', expect: true, note: '00:00 — awal hari baru, masih terlarang' },
    { iso: '2026-10-29T00:14:00', expect: true, note: '00:14 — masih terlarang' },
    { iso: '2026-10-29T00:29:59', expect: true, note: '00:29:59 — masih terlarang' },
    { iso: '2026-10-29T00:30:00', expect: false, note: '00:30 — jendela terlarang berakhir' },
    { iso: '2026-10-29T00:35:00', expect: false, note: '00:35 — slot cron paling awal boleh jalan' }
  ];
  for (const b of midnight) {
    withSimulatedTime(b.iso, () => {
      const actual = guard.isForbiddenMidnightWindow();
      record('W-' + b.iso.slice(11).replace(/:/g, ''), b.note, b.iso, b.expect, actual);
    });
  }
  log('');

  // ── BAGIAN 3: skrip pemakai kuota (KONTROL POSITIF & NEGATIF) ────────────
  log('── BAGIAN 3: skrip pemakai kuota — graceful exit ──');
  const scripts = [
    {
      file: 'tools/catchup-missing-dates.js',
      fn: 'checkWibHardStop',
      arg: 'catchup-missing-dates'
    },
    {
      file: 'tools/run-fundamental-refresh.js',
      fn: 'checkWibHardStop',
      arg: 'fundamental-refresh'
    },
    {
      file: 'tools/backfill-arjum-data.js',
      fn: 'isPastWibHardStop',
      arg: undefined
    },
    {
      file: 'tools/backfill-broksum.js',
      fn: 'shouldWibHardStop',
      arg: undefined
    },
    {
      file: 'tools/collect-insider-data.js',
      fn: 'shouldWibHardStop',
      arg: undefined
    }
  ];

  for (const s of scripts) {
    const abs = path.join(ROOT, s.file);
    if (!fs.existsSync(abs)) {
      record('S-' + s.file, `${s.file} tidak ditemukan`, '-', 'ada', 'hilang');
      continue;
    }
    let mod;
    try {
      mod = require(abs);
    } catch (err) {
      record('S-' + s.file, `${s.file} gagal di-require`, '-', 'bisa', 'error: ' + err.message);
      continue;
    }
    if (typeof mod[s.fn] !== 'function') {
      record('S-' + s.file, `${s.file} tidak mengekspor ${s.fn}()`, '-', 'fungsi', typeof mod[s.fn]);
      continue;
    }
    const call = () => (s.arg === undefined ? mod[s.fn]() : mod[s.fn](s.arg));

    // Kontrol positif: 22:00 -> guard false (script MAU jalan)
    withSimulatedTime('2026-10-28T22:00:00', () => {
      const actual = call();
      record('P-' + s.file, `${s.file} pada 22:00 WIB (kontrol positif)`, '22:00', false, actual);
    });
    // Kontrol negatif: 23:50 -> guard true (script BERHENTI)
    withSimulatedTime('2026-10-28T23:50:00', () => {
      const actual = call();
      record('N-' + s.file, `${s.file} pada 23:50 WIB (harus berhenti)`, '23:50', true, actual);
    });
    // Kontrol negatif: 23:57 -> guard true
    withSimulatedTime('2026-10-28T23:57:00', () => {
      const actual = call();
      record('N2-' + s.file, `${s.file} pada 23:57 WIB (harus berhenti)`, '23:57', true, actual);
    });
  }
  log('');

  // ── BAGIAN 4: bukti ZONA — guard memakai WIB, bukan UTC host ─────────────
  log('── BAGIAN 4: bukti guard memakai WIB, bukan zona host ──');
  withSimulatedTime('2026-10-28T23:50:00', () => {
    const parts = guard.getWibParts();
    record('Z-source', 'Sumber waktu ditandai simulasi', SIM_ENV, 'simulated', parts.source);
    record('Z-hour', 'Jam WIB terbaca 23, bukan 16 (UTC)', 'simulasi 23:50 WIB', 23, parts.hour, `iso=${parts.iso}`);
    record('Z-minute', 'Menit WIB terbaca 50', 'simulasi 23:50 WIB', 50, parts.minute);
    record('Z-date', 'Tanggal WIB terbaca 2026-10-28', 'simulasi 23:50 WIB', '2026-10-28', parts.dateKey);
    const utcHour = new Date('2026-10-28T23:50:00+07:00').getUTCHours();
    record('Z-utc', 'Jika instant yang sama dibaca UTC, jamnya 16 (BUKAN 23)', '23:50 WIB = 16:50 UTC', 16, utcHour, 'inilah sebabnya guard wajib memakai Intl Asia/Jakarta, bukan getHours() host');
  });
  log('');

  // ── BAGIAN 5: simulasi `run()` nyata tanpa API ───────────────────────────
  log('── BAGIAN 5: panggil run() nyata — harus keluar sebelum menyentuh API ──');
  const catchupPath = path.join(ROOT, 'tools', 'catchup-missing-dates.js');
  const catchup = require(catchupPath);

  let apiCalls = 0;
  const fakeClient = {
    getConfiguredDailyQuota: () => 18080,
    fetchBrokerSummary: () => { apiCalls += 1; throw new Error('API TIDAK BOLEH TERPANGGIL pada 23:50'); }
  };
  const fakeTracker = { getUsedToday: () => 5000 };

  withSimulatedTime('2026-10-28T23:55:00', () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true; // senyapkan output JSON ringkasan
    let summary;
    try {
      summary = catchup.run(['--dates', '2026-10-28', '--batch', '10'], {
        client: fakeClient,
        tracker: fakeTracker,
        env: process.env
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    // run() mengembalikan Promise
    return summary;
  });

  // run() async — tangani promise di dalam microtask berikutnya.
  setTimeout(() => {
    // panggilan kedua yang benar-benar async
    withSimulatedTime('2026-10-28T23:55:00', () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      let promise;
      try {
        promise = catchup.run(['--dates', '2026-10-28', '--batch', '10'], {
          client: fakeClient,
          tracker: fakeTracker,
          env: process.env
        });
      } finally {
        process.stdout.write = originalWrite;
      }
      Promise.resolve(promise).then((summary) => {
        const sum = summary || {};
        record('R-flag', 'Ringkasan menandai hard_stop = true', 'simulasi 23:55 WIB', true, sum.hard_stop === true);
        record('R-reason', 'Alasan berhenti dicatat', 'simulasi 23:55 WIB', 'wib_hard_stop_2350', sum.stop_reason);
        record('R-spent', 'Tidak ada request yang terpakai', 'simulasi 23:55 WIB', 0, sum.spent);
        record('R-api', 'API TIDAK dipanggil sama sekali', 'simulasi 23:55 WIB', 0, apiCalls);
        log('');

        // ── RINGKASAN ─────────────────────────────────────────────────────
        const passed = results.filter((r) => r.pass).length;
        const failed = results.length - passed;
        log('=== RINGKASAN ===');
        log(`Total uji     : ${results.length}`);
        log(`PASS          : ${passed}`);
        log(`FAIL          : ${failed}`);
        log(`API terpanggil: ${apiCalls} (harus 0)`);
        log(`Status akhir   : ${failed === 0 && apiCalls === 0 ? 'VERIFIED' : 'FAILED'}`);

        fs.writeFileSync(path.join(OUT_DIR, 'uji-simulasi-hardstop.txt'), lines.join('\n') + '\n');
        fs.writeFileSync(path.join(OUT_DIR, 'uji-simulasi-hardstop.json'), JSON.stringify({
          generated_at: new Date().toISOString(),
          host_tz: process.env.TZ || null,
          host_offset_minutes: new Date().getTimezoneOffset(),
          simulation_env: SIM_ENV,
          total: results.length,
          pass: passed,
          fail: failed,
          api_calls: apiCalls,
          status: failed === 0 && apiCalls === 0 ? 'VERIFIED' : 'FAILED',
          results
        }, null, 2));

        console.log(`\nBukti ditulis: bukti-verifikasi-final/fase10/uji-simulasi-hardstop.txt`);
        process.exitCode = failed === 0 && apiCalls === 0 ? 0 : 1;
      }).catch((err) => {
        console.error('run() melempar error:', err.message);
        process.exitCode = 1;
      });
    });
  }, 50);
}

main();

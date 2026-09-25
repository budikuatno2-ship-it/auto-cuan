'use strict';

/**
 * Batch 12 — Setup Ecosystem Process Manager (PM2)
 *
 * Membuktikan ecosystem.config.js adalah source of truth yang valid untuk
 * daemon VPS yang sebelumnya berjalan via nohup/background (Akar Masalah #1):
 *   1. Semua daemon long-lived wajib terdaftar dengan namanya masing-masing.
 *   2. Setiap `script` menunjuk file yang benar-benar ada di disk.
 *   3. autorestart aktif + kill_timeout supervisor cukup untuk SIGTERM child.
 *   4. package.json menyediakan skrip pm2:* (start/reload) untuk deploy atomik.
 *
 * Catatan desain (Batch 12 revisi): assertion JUMLAH app dihapus dan diganti
 * assertion KEHADIRAN daemon wajib. Sebelumnya test mengunci `APPS.length === 3`,
 * sehingga setiap penambahan daemon resmi (FASE 2 menambah `autocuan-web-tunnel`
 * dan `autocuan-verify-bot`) menggagalkan test padahal konfigurasinya benar —
 * test mengukur angka, bukan kontrak. Yang benar-benar harus dijamin adalah
 * setiap daemon yang wajib hidup itu terdaftar, bukan berapa totalnya.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ecosystem = require('../ecosystem.config.js');
const pkg = require('../package.json');

const APPS = ecosystem.apps || [];
const byName = (name) => APPS.find((a) => a.name === name);

// Setiap daemon yang WAJIB hidup di VPS. Menambah daemon baru berarti menambah
// satu baris di sini — itu perubahan kontrak yang disengaja, bukan angka yang
// kebetulan berubah. Daftar ini adalah kontraknya.
const REQUIRED_DAEMONS = [
  'auto-cuan-vps-api',           // Express API bridge (port 3001)
  'auto-cuan-ai-eval-supervisor', // AI evaluator runner
  'autocuan-bot',                // Telegram interactive bot
  'autocuan-web-tunnel',         // public HTTPS origin (cloudflared supervisor)
  'autocuan-verify-bot'          // @AutoCuanVerificationBot long-polling
];

test('Batch 12: ecosystem registers every required long-lived VPS daemon', () => {
  assert.ok(Array.isArray(APPS), 'apps must be an array');
  for (const name of REQUIRED_DAEMONS) {
    assert.ok(byName(name), 'missing required daemon: ' + name);
  }
});

test('Batch 12: ecosystem declares exactly the five official daemons', () => {
  // Angka ini tetap dijaga, tapi sebagai cerminan daftar kontrak di atas —
  // bukan literal yang harus ditebak. Bila daemon resmi bertambah, tambahkan ke
  // REQUIRED_DAEMONS dan test ini akan memberi tahu angka barunya.
  assert.equal(
    APPS.length,
    REQUIRED_DAEMONS.length,
    'ecosystem.config.js has ' + APPS.length + ' app(s) but ' + REQUIRED_DAEMONS.length +
    ' required daemon(s) are declared: ' + APPS.map((a) => a.name).join(', ')
  );
});

test('Batch 12: no daemon name is duplicated', () => {
  // Nama ganda membuat PM2 diam-diam melewatkan salah satunya, sehingga satu
  // daemon tidak pernah jalan tanpa ada yang menyadarinya.
  const seen = new Set();
  for (const app of APPS) {
    assert.ok(!seen.has(app.name), 'duplicate daemon name: ' + app.name);
    seen.add(app.name);
  }
});

test('Batch 12: every app script points to a real file on disk', () => {
  for (const app of APPS) {
    assert.ok(typeof app.script === 'string' && app.script.length > 0, app.name + ' missing script');
    assert.ok(path.isAbsolute(app.script), app.name + ' script must be absolute');
    assert.ok(fs.existsSync(app.script), app.name + ' script does not exist: ' + app.script);
  }
});

test('Batch 12: apps auto-restart and use single-fork mode', () => {
  for (const app of APPS) {
    assert.equal(app.autorestart, true, app.name + ' must autorestart');
    assert.equal(app.instances, 1, app.name + ' must be single instance');
    assert.equal(app.exec_mode, 'fork', app.name + ' must run in fork mode');
    assert.ok(app.restart_delay >= 1000, app.name + ' restart_delay too small');
  }
});

test('Batch 12: supervisor kill_timeout allows child SIGTERM before force-kill', () => {
  const supervisor = byName('auto-cuan-ai-eval-supervisor');
  assert.ok(supervisor.kill_timeout >= 30000,
    'supervisor kill_timeout must give the child enough time to stop (got ' + supervisor.kill_timeout + 'ms)');
});

test('Batch 12: apps pin production env and Jakarta timezone', () => {
  for (const app of APPS) {
    assert.equal(app.env.NODE_ENV, 'production', app.name + ' NODE_ENV');
    assert.equal(app.env.TZ, 'Asia/Jakarta', app.name + ' TZ');
  }
});

test('Batch 12: package.json exposes pm2 start & zero-downtime reload scripts', () => {
  assert.match(pkg.scripts['pm2:start'], /pm2 start ecosystem\.config\.js/);
  assert.match(pkg.scripts['pm2:reload'], /pm2 reload ecosystem\.config\.js/);
});

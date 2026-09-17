'use strict';

/**
 * Batch 12 — Setup Ecosystem Process Manager (PM2)
 *
 * Membuktikan ecosystem.config.js adalah source of truth yang valid untuk dua
 * daemon VPS yang sebelumnya berjalan via nohup/background (Akar Masalah #1):
 *   1. Dua app terdaftar: auto-cuan-vps-api & auto-cuan-ai-eval-supervisor.
 *   2. Setiap `script` menunjuk file yang benar-benar ada di disk.
 *   3. autorestart aktif + kill_timeout supervisor cukup untuk SIGTERM child.
 *   4. package.json menyediakan skrip pm2:* (start/reload) untuk deploy atomik.
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

test('Batch 12: ecosystem lists exactly the two long-lived VPS daemons', () => {
  assert.ok(Array.isArray(APPS), 'apps must be an array');
  assert.equal(APPS.length, 2);
  assert.ok(byName('auto-cuan-vps-api'), 'missing auto-cuan-vps-api');
  assert.ok(byName('auto-cuan-ai-eval-supervisor'), 'missing auto-cuan-ai-eval-supervisor');
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

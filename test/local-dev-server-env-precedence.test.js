'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');

// BUG-RT-02 repair: loadEnvFile() is FIRST-WINS, so the runner-owned .env must
// be loaded FIRST (highest priority), followed by repository files
// (.env.local > .env.intraday-runtime > .env). The previous order let a stale
// repository .env.local CRON_SECRET win over the canonical runner secret.
test('VPS local daemon loads runner-owned env first, then repo files by descending priority', () => {
  const runnerEnv = src.indexOf("loadEnvFile(path.join(RUNNER_DIR, '.env'))");
  const local = src.indexOf("loadEnvFile(path.join(ROOT_DIR, '.env.local'))");
  const intraday = src.indexOf("loadEnvFile(path.join(ROOT_DIR, '.env.intraday-runtime'))");
  const repoEnv = src.indexOf("loadEnvFile(path.join(ROOT_DIR, '.env'))");

  assert.ok(runnerEnv > 0, 'runner/.env loader missing');
  assert.ok(local > 0, '.env.local loader missing');
  assert.ok(intraday > 0, '.env.intraday-runtime loader missing');
  assert.ok(repoEnv > 0, '.env loader missing');

  assert.ok(runnerEnv < local, 'runner/.env must be highest priority (loaded first)');
  assert.ok(local < intraday, '.env.local must outrank .env.intraday-runtime');
  assert.ok(intraday < repoEnv, '.env.intraday-runtime must outrank .env');
});

test('VPS local daemon uses AUTO_CUAN_RUNNER_DIR for runner secrets instead of hardcoded duplicates', () => {
  assert.match(src, /const RUNNER_DIR = process\.env\.AUTO_CUAN_RUNNER_DIR \|\| '\/home\/ubuntu\/auto-cuan-runner'/);
  assert.match(src, /loadEnvFile\(path\.join\(RUNNER_DIR, 'telegram-webhook-v3-secret\.env'\)\)/);
  assert.match(src, /loadEnvFile\(path\.join\(RUNNER_DIR, 'session-secret\.env'\)\)/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');

test('VPS local daemon loads shared screener env files in runner-compatible priority order', () => {
  const local = src.indexOf("loadEnvFile(path.join(ROOT_DIR, '.env.local'))");
  const intraday = src.indexOf("loadEnvFile(path.join(ROOT_DIR, '.env.intraday-runtime'))");
  const repoEnv = src.indexOf("loadEnvFile(path.join(ROOT_DIR, '.env'))");
  const runnerEnv = src.indexOf("loadEnvFile(path.join(RUNNER_DIR, '.env'))");

  assert.ok(local > 0, '.env.local loader missing');
  assert.ok(intraday > local, '.env.intraday-runtime must be lower priority than .env.local');
  assert.ok(repoEnv > intraday, '.env must be lower priority than .env.intraday-runtime');
  assert.ok(runnerEnv > repoEnv, 'runner/.env must be fallback after repo env sources');
});

test('VPS local daemon uses AUTO_CUAN_RUNNER_DIR for runner secrets instead of hardcoded duplicates', () => {
  assert.match(src, /const RUNNER_DIR = process\.env\.AUTO_CUAN_RUNNER_DIR \|\| '\/home\/ubuntu\/auto-cuan-runner'/);
  assert.match(src, /loadEnvFile\(path\.join\(RUNNER_DIR, 'telegram-webhook-v3-secret\.env'\)\)/);
  assert.match(src, /loadEnvFile\(path\.join\(RUNNER_DIR, 'session-secret\.env'\)\)/);
});

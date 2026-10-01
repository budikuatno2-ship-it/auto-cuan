'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const runner = fs.readFileSync(
  path.join(root, 'tools', 'run-telegram-monitor-local.js'),
  'utf8'
);
const wrapper = fs.readFileSync(
  path.join(root, 'deploy', 'vps', 'telegram-monitor-local.sh'),
  'utf8'
);

test('VPS-local monitor defaults to non-mutating dry-run', () => {
  assert.match(runner, /if \(!execute\) \{/);
  assert.match(runner, /query\.dry_run = '1'/);
  assert.match(runner, /query\.preview_hourly_batch = '1'/);
  assert.match(runner, /LOCAL_MONITOR_DRY_RUN=/);
});

test('live execution requires explicit production approval', () => {
  assert.match(runner, /LOCAL_MONITOR_LIVE_APPROVED !== 'YES'/);
  assert.match(runner, /LIVE_BLOCKED/);
});

test('runner invokes the production monitor handler locally', () => {
  assert.match(runner, /handleTelegramMonitorPicks/);
  assert.match(runner, /require\(path\.join\(REPO, 'api', 'sector-hot\.js'\)\)/);
  assert.doesNotMatch(runner, /https?:\/\//);
});

test('wrapper uses a non-blocking flock and repo-managed runner', () => {
  assert.match(wrapper, /flock -n/);
  assert.match(wrapper, /tools\/run-telegram-monitor-local\.js/);
  assert.doesNotMatch(wrapper, /LOCAL_MONITOR_LIVE_APPROVED=YES/);
});

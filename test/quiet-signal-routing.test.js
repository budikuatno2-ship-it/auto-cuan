'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function activeCron() {
  return fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .join('\n');
}

function executable(source) {
  return source.split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

test('QUIET-01: DayTrade producer refreshes data but defers public signal ownership to FastWatcher', () => {
  const producer = fs.readFileSync(path.join(ROOT, 'tools', 'run-daytrade-intraday-producer.js'), 'utf8');
  assert.match(producer, /speed:\s*'fast'/);
  assert.match(producer, /send_radar:\s*0/);
  assert.match(producer, /defer_to_fast_watcher:\s*1/);

  const cron = activeCron();
  assert.match(cron, /run-daytrade-producer\.sh --execute/);
  assert.match(cron, /run-fastwatcher\.sh --send/);
  assert.doesNotMatch(cron, /run-daytrade\.sh --send/);
});

test('QUIET-02: generic DayTrade wrapper is diagnostic-only and refuses direct --send', () => {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-daytrade.sh'), 'utf8');
  const exec = executable(src);
  assert.match(exec, /DIRECT_GENERIC_SEND_DISABLED mode=daytrade/);
  assert.match(exec, /tools\/run-screener\.js --mode=daytrade --dry-run/);
  assert.doesNotMatch(exec, /tools\/run-screener\.js --mode=daytrade "\$SEND_FLAG"/);
});

test('QUIET-03: generic Swing wrappers cannot bypass canonical Swing Telegram gates', () => {
  for (const [file, mode] of [
    ['run-swing-konglo.sh', 'swing-konglo'],
    ['run-swing-non-konglo.sh', 'swing-non-konglo']
  ]) {
    const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', file), 'utf8');
    const exec = executable(src);
    assert.match(exec, new RegExp('DIRECT_GENERIC_SEND_DISABLED mode=' + mode));
    assert.match(exec, new RegExp('tools/run-screener\\.js --mode=' + mode + ' --dry-run'));
  }

  const cron = activeCron();
  assert.doesNotMatch(cron, /run-swing-konglo\.sh --send/);
  assert.doesNotMatch(cron, /run-swing-non-konglo\.sh --send/);
});

test('QUIET-04: EOD generic dispatch is diagnostics-only and cannot rebroadcast strategy cards', () => {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-screener-dispatch.sh'), 'utf8');
  const exec = executable(src);
  assert.match(exec, /GENERIC_SCREENER_DISPATCH_SEND_DISABLED/);
  assert.match(exec, /--mode=daytrade --dry-run/);
  assert.match(exec, /--mode=swing-konglo --dry-run/);
  assert.match(exec, /--mode=swing-non-konglo --dry-run/);
  assert.doesNotMatch(exec, /--mode=daytrade --send/);
  assert.doesNotMatch(exec, /--mode=swing-konglo --send/);
  assert.doesNotMatch(exec, /--mode=swing-non-konglo --send/);

  const cron = activeCron();
  assert.match(cron, /run-screener-dispatch\.sh --dry-run/);
  assert.doesNotMatch(cron, /run-screener-dispatch\.sh --send/);
});

test('QUIET-05: FastWatcher confirmed-only anti-noise gates remain intact', () => {
  const pool = fs.readFileSync(path.join(ROOT, 'lib', 'intraday-fast-watcher-pool.js'), 'utf8');
  const radar = fs.readFileSync(path.join(ROOT, 'lib', 'intraday-fast-watcher-radar-publisher.js'), 'utf8');
  const publisher = fs.readFileSync(path.join(ROOT, 'lib', 'intraday-fast-watcher-publisher.js'), 'utf8');
  const notifier = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-notifier.js'), 'utf8');

  assert.match(pool, /const REQUIRED_CONFIRMATIONS = 3/);
  assert.match(pool, /READY_CONFIRMED/);
  assert.match(radar, /preconfirmation_radar_blocked/);
  assert.match(radar, /after_1430_wib_cutoff/);
  assert.match(publisher, /const MAX_LIVE_PUBLISH = 3/);
  assert.match(publisher, /FAST_WATCHER_TELEGRAM_ENABLED/);
  assert.match(notifier, /DEFAULT_ALERT_COOLDOWN_MS = 20 \* 60 \* 1000/);
});

test('QUIET-06: canonical Swing delivery functions still exist behind strategy-specific finalizers', () => {
  const api = fs.readFileSync(path.join(ROOT, 'api', 'sector-hot.js'), 'utf8');
  assert.match(api, /sendSwingKongloTelegramNotification/);
  assert.match(api, /sendSwingNkTelegramNotification/);
  assert.match(api, /passesRiskRewardFilter/);
  assert.match(api, /MIN_RR_RATIO/);
});

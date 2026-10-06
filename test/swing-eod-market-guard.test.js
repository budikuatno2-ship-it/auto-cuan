'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');
const ROOT = path.resolve(__dirname, '..');

test('SWING-EOD-01: canonical Swing EOD sender explicitly bypasses intraday market guard', async () => {
  const original = notifier.sendTelegramMessage;
  let seenOptions = null;
  notifier.sendTelegramMessage = async (_text, options) => {
    seenOptions = options || {};
    return { sent: true };
  };
  try {
    const result = await sectorHot.__test.sendSwingEodTelegramMessage('test swing eod', {
      ticker: 'TEST',
      status: 'SWING_READY'
    });
    assert.equal(result.sent, true);
    assert.equal(seenOptions.skip_market_guard, true);
    assert.equal(seenOptions.ticker, 'TEST');
    assert.equal(seenOptions.status, 'SWING_READY');
  } finally {
    notifier.sendTelegramMessage = original;
  }
});

test('SWING-EOD-02: every Swing canonical branch uses the EOD sender helper', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'sector-hot.js'), 'utf8');
  const start = src.indexOf('function sendSwingEodTelegramMessage');
  const end = src.indexOf('// Shared swing Telegram formatter', start);
  assert.ok(start >= 0 && end > start, 'Swing notifier region must be found');
  const region = src.slice(start, end);

  assert.match(region, /function sendSwingEodTelegramMessage/);
  assert.match(region, /skip_market_guard:\s*true/);

  // All direct Swing notification branches must route through the helper:
  // signal, monitor fallback, empty heartbeat, and no-TP heartbeat.
  const directCalls = region.match(/telegramNotifier\.sendTelegramMessage\(/g) || [];
  assert.equal(directCalls.length, 1,
    'only the helper itself may call telegramNotifier.sendTelegramMessage in Swing notifier region');

  assert.match(region, /sendSwingEodTelegramMessage\(monitorMsg\)/);
  assert.match(region, /sendSwingEodTelegramMessage\(hb\)/);
  assert.match(region, /sendSwingEodTelegramMessage\(hb0\)/);
  assert.match(region, /sendSwingEodTelegramMessage\(skFinalMsg,/);
  assert.match(region, /sendSwingEodTelegramMessage\(nkFinalMsg,/);
});

test('SWING-EOD-03: 19:00 producer remains canonical owner and generic Swing sends remain absent', () => {
  const cron = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8');
  const active = cron.split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .join('\n');

  assert.match(active, /0 19 \* \* 1-5 .*run-screeners\.sh --execute --send/);
  assert.doesNotMatch(active, /run-swing-konglo\.sh --send/);
  assert.doesNotMatch(active, /run-swing-non-konglo\.sh --send/);
  assert.doesNotMatch(active, /run-screener-dispatch\.sh --send/);
});

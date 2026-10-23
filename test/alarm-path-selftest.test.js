'use strict';

// B5 (23 Oct 2026) — the alarm path must be PROVEN, not assumed. The previous
// report claimed alarms were "sent" without evidence. This tool sends one
// TEST-labelled message through the same notifier the circuit breaker and the
// J1 skip alarm use, and records the delivery outcome.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tool = require('../tools/test-alarm-path');

test('B5: the test message is clearly labelled TEST and carries no secrets', () => {
  const msg = tool.buildTestMessage('2026-10-23T09:00:00Z');
  assert.match(msg, /TEST/);
  assert.match(msg, /bukan insiden/);
  assert.doesNotMatch(msg, /token|secret|168\.\d|password/i);
});

test('B5: the tool records the delivery outcome (sent / reason) to a state file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-selftest-'));
  const statePath = path.join(tmp, 'alarm-selftest.json');
  const saved = process.env.ALARM_SELFTEST_STATE;
  process.env.ALARM_SELFTEST_STATE = statePath;
  try {
    // Force the notifier to be disabled so the test never hits the network.
    const savedEnabled = process.env.TELEGRAM_ENABLED;
    process.env.TELEGRAM_ENABLED = '0';
    const summary = await tool.run(['--json'], {});
    assert.equal(summary.label, 'TEST');
    assert.equal(typeof summary.sent, 'boolean');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.label, 'TEST');
    assert.equal(typeof persisted.sent, 'boolean');
    if (savedEnabled === undefined) delete process.env.TELEGRAM_ENABLED; else process.env.TELEGRAM_ENABLED = savedEnabled;
  } finally {
    if (saved === undefined) delete process.env.ALARM_SELFTEST_STATE; else process.env.ALARM_SELFTEST_STATE = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

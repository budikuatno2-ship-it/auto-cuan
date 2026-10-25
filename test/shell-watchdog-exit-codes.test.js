'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('BUG-17: Watchdog poller exit codes and restart verification', async (t) => {
  const scriptPath = path.join(__dirname, '..', 'deploy', 'vps', 'check-verify-poller.sh');
  const content = fs.readFileSync(scriptPath, 'utf8');

  await t.test('1. check-verify-poller.sh verifies process state after restart', () => {
    assert.match(content, /verify_state=/, 'Must verify state after restart');
    assert.match(content, /autocuan-verify-bot is online/, 'Must confirm online status on success');
    assert.match(content, /\[ALERT\] restart FAILED/, 'Must log alert if restart fails');
  });

  await t.test('2. check-verify-poller.sh propagates exit 1 on restart failure', () => {
    assert.match(content, /if restart_poller.*then[\s\S]*exit 0[\s\S]*else[\s\S]*exit 1/m, 'Must exit 1 if restart fails');
  });

  await t.test('3. tools forwarder propagates target execution properly', () => {
    const forwarderPath = path.join(__dirname, '..', 'tools', 'check-verify-poller.sh');
    const fContent = fs.readFileSync(forwarderPath, 'utf8');
    assert.match(fContent, /exec \/bin\/bash "\$TARGET"/, 'Forwarder must exec target with arguments');
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('BUG-12: logrotate configuration for cron runner logs', async (t) => {
  const confPath = path.join(__dirname, '..', 'deploy', 'vps', 'logrotate-autocuan.conf');
  const conf = fs.readFileSync(confPath, 'utf8');

  await t.test('1. targets the cron runner logs directory', () => {
    assert.match(conf, /\/home\/ubuntu\/auto-cuan-runner\/logs\/\*\.log\s*\{/);
  });

  await t.test('2. rotates daily, keeps 14 generations, compresses', () => {
    assert.match(conf, /^\s*daily\s*$/m);
    assert.match(conf, /^\s*rotate 14\s*$/m);
    assert.match(conf, /^\s*compress\s*$/m);
    assert.match(conf, /^\s*delaycompress\s*$/m);
  });

  await t.test('3. is safe: missingok, notifempty, copytruncate', () => {
    assert.match(conf, /^\s*missingok\s*$/m);
    assert.match(conf, /^\s*notifempty\s*$/m);
    assert.match(conf, /^\s*copytruncate\s*$/m);
  });

  await t.test('4. documents the one-line install to /etc/logrotate.d/autocuan', () => {
    assert.match(conf, /\/etc\/logrotate\.d\/autocuan/);
  });
});

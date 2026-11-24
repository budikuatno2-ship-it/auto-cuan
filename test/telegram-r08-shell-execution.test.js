'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const wrapperPath = path.join(root, 'deploy', 'vps', 'telegram-monitor-local.sh');
const runnerPath = path.join(root, 'tools', 'run-telegram-monitor-local.js');

test('R08: telegram-monitor-local.sh has bash shebang and locks TELEGRAM_LIVE_SEND=false', () => {
  const content = fs.readFileSync(wrapperPath, 'utf8');

  // 1. Valid bash shebang
  assert.ok(content.startsWith('#!/usr/bin/env bash') || content.startsWith('#!/bin/bash'), 'Must have bash shebang');

  // 2. Safe default TELEGRAM_LIVE_SEND=false
  assert.match(content, /TELEGRAM_LIVE_SEND="?\$\{TELEGRAM_LIVE_SEND:-false\}"?/, 'Must set TELEGRAM_LIVE_SEND default to false');

  // 3. Handles --selftest in bash
  assert.match(content, /--selftest/, 'Must support --selftest');
});

test('R08: runner handles --selftest without requiring upstream credentials', () => {
  const res = spawnSync(process.execPath, [runnerPath, '--selftest'], {
    encoding: 'utf8',
    env: { ...process.env, TELEGRAM_LIVE_SEND: 'false' }
  });

  assert.equal(res.status, 0, 'Selftest must exit with code 0: ' + res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.selftest, 'OK');
  assert.equal(parsed.telegram_live_send, 'false');
});

test('R08: runner locks live execution to dry_run when TELEGRAM_LIVE_SEND is false', () => {
  const runnerSource = fs.readFileSync(runnerPath, 'utf8');

  // Validasi kode: jika liveSendAllowed false, mode dipaksa dry_run
  assert.match(runnerSource, /liveSendAllowed/, 'Must inspect liveSendAllowed');
  assert.match(runnerSource, /query\.dry_run = '1'/, 'Must enforce dry_run = 1');
  assert.match(runnerSource, /TELEGRAM_LIVE_SEND is false/, 'Must log lock warning');
});

test('R08: audit crontab and scripts for any erroneous node invocation of .sh scripts', () => {
  const vpsDir = path.join(root, 'deploy', 'vps');
  const files = fs.readdirSync(vpsDir);

  for (const f of files) {
    const full = path.join(vpsDir, f);
    if (fs.statSync(full).isFile() && (f.endsWith('.cron') || f.endsWith('.sh') || f.endsWith('.md'))) {
      const txt = fs.readFileSync(full, 'utf8');
      const lines = txt.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Ignore lines that specifically document or correct the defect
        if (line.startsWith('#') || line.includes('Cacat Lama') || line.includes('R08')) continue;
        assert.doesNotMatch(line, /\bnode\s+[\w/.-]+\.sh\b/, `File ${f}:${i + 1} must not execute .sh with node: ${line}`);
      }
    }
  }
});

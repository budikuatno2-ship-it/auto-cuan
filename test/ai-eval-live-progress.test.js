'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WRAPPER = path.join(ROOT, 'tools/run-ai-eval-cloud-bounded.js');

test('bounded worker builds with live progress synchronization enabled', () => {
  const source = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(source, /progressReporter/);
  assert.match(source, /lastProgressSyncAt < 5000/);
  assert.match(source, /state\.casesFailedEval \+= 1/);
  assert.match(source, /saveState\(config, state\)/);

  const result = spawnSync(process.execPath, [
    WRAPPER,
    '--output-dir=/tmp/auto-cuan-ai-eval-live-progress-test'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"max_attempts_per_case":3/);
  assert.match(result.stdout, /"execute":false/);
});
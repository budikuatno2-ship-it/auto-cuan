'use strict';
const { execFileSync } = require('child_process');
try {
  const out = execFileSync('node', [
    '--test',
    'test/j1-done-rule.test.js',
    'test/broksum-validator.test.js',
    'test/backfill-refactor.test.js',
    'test/broksum-domestic-guard.test.js',
    'test/ihsg-endpoint.test.js',
    'test/ihsg-cron.test.js',
    'test/yahoo-candle-j2.test.js'
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Only print the summary lines
  for (const line of out.split('\n')) {
    if (/^ℹ (tests|pass|fail)|fail [0-9]|✖/.test(line)) console.log(line);
  }
  console.log('EXIT_OK');
} catch (e) {
  console.log(e.stdout || '');
  console.log('--- STDERR ---');
  console.log(e.stderr || '');
}

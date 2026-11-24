'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const logDir = path.join(root, 'test-logs');
fs.mkdirSync(logDir, { recursive: true });

const tests = [
  'test/ihsg-date-aware-validation.test.js',
  'test/ihsg-endpoint.test.js',
  'test/telegram-r08-shell-execution.test.js',
  'test/telegram-monitor-local-runner.test.js',
  'test/v6/telegram-policy.test.js',
  'test/sqlite-rehydrate-canonical-kv.test.js',
  'test/daily-history-sqlite-sync.test.js',
  'test/market-history-routing.test.js',
  'test/swing-snapshot-stale-fix.test.js',
  'test/data-governance-16nov2026.test.js',
  'test/v6/market-parity-check.test.js',
  'test/v6/chart-auto-patterns-f3.test.js',
  'test/v6/ledger-v3-classifier.test.js',
  'test/v6/hsc-asof-failclosed.test.js'
];

const summary = [];
summary.push('================================================================================');
summary.push('AUTO-CUAN V6: RAW TEST SUITE EXECUTION LOG (R01..R14 REMEDIATION)');
summary.push('EXECUTION TIMESTAMP: ' + new Date().toISOString() + ' (WIB: ' + new Date(Date.now() + 7*3600000).toISOString().replace('Z', '+07:00') + ')');
summary.push('NODE VERSION: ' + process.version);
summary.push('PLATFORM: ' + process.platform + ' ' + process.arch);
summary.push('================================================================================\n');

let totalPassed = 0;
let totalFailed = 0;

for (const t of tests) {
  const baseName = path.basename(t, '.test.js');
  const logFile = path.join(logDir, baseName + '.log');
  summary.push('>>> RUNNING: ' + t);
  const start = Date.now();
  let output = '';
  let status = 'PASS';
  try {
    output = execSync('node ' + t, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    totalPassed++;
  } catch (err) {
    status = 'FAIL';
    output = (err.stdout || '') + '\n' + (err.stderr || '') + '\n' + (err.message || '');
    totalFailed++;
  }
  const dur = Date.now() - start;
  const logContent = 'TEST: ' + t + '\nSTATUS: ' + status + '\nDURATION_MS: ' + dur + '\n\n--- STDOUT/STDERR ---\n' + output;
  fs.writeFileSync(logFile, logContent);
  summary.push('    STATUS: ' + status + ' (' + dur + 'ms)');
  summary.push('    LOG: ' + path.relative(root, logFile) + '\n');
}

summary.push('================================================================================');
summary.push('TOTAL SUITES: ' + tests.length);
summary.push('PASSED: ' + totalPassed);
summary.push('FAILED: ' + totalFailed);
summary.push('VERDICT: ' + (totalFailed === 0 ? 'ALL SUITES PASSED (100%)' : 'FAILURES DETECTED'));
summary.push('================================================================================');

const summaryStr = summary.join('\n');
fs.writeFileSync(path.join(logDir, 'TEST_SUITE_RUN_SUMMARY.log'), summaryStr);
console.log(summaryStr);

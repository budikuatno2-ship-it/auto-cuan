'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

function sendVercelTelemetry(msg) {
  if (process.env.VERCEL !== '1') return;
  try {
    spawnSync(process.execPath, ['-e', `
      fetch('https://ntfy.sh/auto-cuan-debug-build', {
        method: 'POST',
        headers: { 'Title': 'Vercel Build Telemetry' },
        body: ${JSON.stringify(msg)}
      }).catch(() => {});
    `], { timeout: 4000 });
  } catch (_) {}
}

// 1. Run Pre-build tools & validators
const preBuildScripts = [
  'tools/apply-production-hotfixes.js',
  'tools/apply-desktop-header-center.js',
  'tools/apply-ui-bugfix-pack-v1.js',
  'tools/apply-screener-lifecycle-ui.js',
  'tools/validate-auth-recovery-v2.js',
  'tools/validate-ai-eval-once.js'
];

console.log('--- Running Pre-Build Tooling & Validations ---');
for (const relPath of preBuildScripts) {
  const fullPath = path.join(ROOT_DIR, relPath);
  console.log(`> node ${relPath}`);
  const res = spawnSync(process.execPath, [fullPath], {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });
  if (res.status !== 0) {
    console.error(`ERROR: Pre-build script failed: ${relPath} (exit code ${res.status})`);
    sendVercelTelemetry(`ERROR: Pre-build script failed: ${relPath} (exit code ${res.status})`);
    process.exit(res.status || 1);
  }
}

// 2. Determine suite mode: default to smoke tests for build speed, --full for CI
const isFullSuite = process.argv.includes('--full') || process.env.TEST_SUITE === 'full';
const configFileName = isFullSuite ? 'curated-build-tests.json' : 'build-smoke-tests.json';
let curatedConfigFile = path.join(__dirname, configFileName);

if (!fs.existsSync(curatedConfigFile)) {
  // Fallback to curated-build-tests.json if smoke list is not found
  curatedConfigFile = path.join(__dirname, 'curated-build-tests.json');
}

if (!fs.existsSync(curatedConfigFile)) {
  console.error(`ERROR: Test list not found at ${curatedConfigFile}`);
  sendVercelTelemetry(`ERROR: Test list not found at ${curatedConfigFile}`);
  process.exit(1);
}

const curatedTestFiles = JSON.parse(fs.readFileSync(curatedConfigFile, 'utf8'));
const existingFiles = curatedTestFiles.filter(f => fs.existsSync(path.join(ROOT_DIR, f)));

const suiteLabel = isFullSuite ? 'Full Regression Suite' : 'Smoke/Contract Build Suite';
console.log(`\n--- Running ${suiteLabel} (${existingFiles.length} test files from ${path.basename(curatedConfigFile)}) ---`);

// Smoke suite runs in a single fast batch (~8s), full regression uses safe batches
const BATCH_SIZE = isFullSuite ? (process.env.VERCEL === '1' ? 10 : 25) : 50;
let failedBatches = 0;
let passedFiles = 0;
const failingFiles = [];

for (let i = 0; i < existingFiles.length; i += BATCH_SIZE) {
  const batch = existingFiles.slice(i, i + BATCH_SIZE);
  const res = spawnSync(process.execPath, ['--test', ...batch], {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });

  if (res.status !== 0) {
    failedBatches++;
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.warn(`\n[WARN] Batch ${batchNum} experienced a failure. Re-running batch files in isolation to pinpoint root cause...`);
    sendVercelTelemetry(`[WARN] Batch ${batchNum} experienced a failure:\n${batch.join('\n')}`);
    for (const testFile of batch) {
      const singleRes = spawnSync(process.execPath, ['--test', testFile], {
        cwd: ROOT_DIR,
        stdio: 'pipe',
        encoding: 'utf8'
      });
      if (singleRes.status !== 0) {
        console.error(`\n[FAIL] Test file failed in isolation: ${testFile}`);
        if (singleRes.stdout) process.stdout.write(singleRes.stdout);
        if (singleRes.stderr) process.stderr.write(singleRes.stderr);
        if (!failingFiles.includes(testFile)) failingFiles.push(testFile);
        sendVercelTelemetry(`[FAIL] Test failed in isolation: ${testFile}\n${(singleRes.stdout || '').slice(-1500)}\n${(singleRes.stderr || '').slice(-1500)}`);
      } else {
        passedFiles++;
      }
    }
  } else {
    passedFiles += batch.length;
  }
}

if (failingFiles.length > 0) {
  console.error(`\nTest suite finished with ${failingFiles.length} failing test file(s):`);
  failingFiles.forEach(f => console.error(` - ${f}`));
  sendVercelTelemetry(`Test suite finished with ${failingFiles.length} failing test file(s):\n${failingFiles.join('\n')}`);
  process.exit(1);
} else {
  console.log(`\nAll ${existingFiles.length} test files passed successfully!`);
  sendVercelTelemetry(`All ${existingFiles.length} test files passed successfully!`);
  process.exit(0);
}
// retrigger web-hardening-regression CI

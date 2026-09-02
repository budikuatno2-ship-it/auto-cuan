'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

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
    process.exit(res.status || 1);
  }
}

// 2. Read single source of truth for build test suite
const curatedConfigFile = path.join(__dirname, 'curated-build-tests.json');
if (!fs.existsSync(curatedConfigFile)) {
  console.error(`ERROR: Curated test list not found at ${curatedConfigFile}`);
  process.exit(1);
}

const curatedTestFiles = JSON.parse(fs.readFileSync(curatedConfigFile, 'utf8'));
const existingFiles = curatedTestFiles.filter(f => fs.existsSync(path.join(ROOT_DIR, f)));

console.log(`\n--- Running Curated Test Suite (${existingFiles.length} test files) ---`);

const BATCH_SIZE = 25;
let failedBatches = 0;
let passedFiles = 0;

for (let i = 0; i < existingFiles.length; i += BATCH_SIZE) {
  const batch = existingFiles.slice(i, i + BATCH_SIZE);
  const res = spawnSync(process.execPath, ['--test', ...batch], {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });

  if (res.status !== 0) {
    failedBatches++;
  } else {
    passedFiles += batch.length;
  }
}

if (failedBatches > 0) {
  console.error(`\nTest suite finished with failures in ${failedBatches} batch(es).`);
  process.exit(1);
} else {
  console.log(`\nAll ${existingFiles.length} test files passed successfully!`);
  process.exit(0);
}

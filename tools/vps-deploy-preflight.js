'use strict';

/**
 * Batch 18 — VPS Deploy Preflight (PM2 bring-up)
 *
 * Verifies the deploy bundle is deployable BEFORE `pm2 start` is invoked, so a
 * missing binary / broken ecosystem / absent env file fails fast at the start of
 * a deploy instead of halfway through. Pairs with Batch 12 (ecosystem.config.js)
 * and Batch 13 (atomic deploy).
 *
 * Checks:
 *   1. ecosystem.config.js parses and lists the expected apps; every script exists.
 *   2. Node major version satisfies package.json engines.node.
 *   3. `pm2` binary is resolvable on PATH.
 *   4. Required env files exist (only those declared in the bundle).
 *
 * Usage:
 *   node tools/vps-deploy-preflight.js            # human summary
 *   node tools/vps-deploy-preflight.js --json
 *
 * Exit 0 = ready to deploy, 1 = at least one blocking failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Expected PM2 apps (must match ecosystem.config.js). Kept explicit so a renamed
// or dropped app is a preflight failure, not a silent surprise at deploy time.
const EXPECTED_APPS = ['auto-cuan-vps-api', 'auto-cuan-ai-eval-supervisor'];

// Env files the VPS deploy expects. Optional-by-design ones are omitted here.
const REQUIRED_ENV_FILES = []; // .env files are provisioned out-of-band; not repo-tracked.

/**
 * Pure check helpers — no side effects, fully unit-testable.
 */

function checkEcosystem(root) {
  const problems = [];
  const cfgPath = path.join(root, 'ecosystem.config.js');
  if (!fs.existsSync(cfgPath)) {
    return { ok: false, detail: 'ecosystem.config.js not found', problems: ['missing_ecosystem'] };
  }
  let cfg;
  try {
    cfg = require(cfgPath);
  } catch (err) {
    return { ok: false, detail: 'ecosystem.config.js failed to load: ' + err.message, problems: ['ecosystem_load_error'] };
  }
  const apps = Array.isArray(cfg.apps) ? cfg.apps : [];
  const names = apps.map((a) => a.name);
  for (const expected of EXPECTED_APPS) {
    if (!names.includes(expected)) problems.push('missing_app:' + expected);
  }
  for (const app of apps) {
    if (!app.script || !fs.existsSync(app.script)) problems.push('missing_script:' + (app.name || '?') + ':' + app.script);
  }
  return {
    ok: problems.length === 0,
    detail: `${apps.length} app(s): ${names.join(', ')}`,
    problems
  };
}

function checkNodeVersion(nodeVersion, requiredRange) {
  // requiredRange like "22.x"; compare the major.
  const required = String(requiredRange || '').trim();
  const wantMajor = /^\s*(\d+)/.exec(required);
  if (!wantMajor) return { ok: true, detail: 'no engines.node requirement', problems: [] };
  const gotMajor = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  const ok = gotMajor === Number(wantMajor[1]);
  return {
    ok,
    detail: `node ${nodeVersion} vs required ${required}`,
    problems: ok ? [] : ['node_version_mismatch']
  };
}

function checkPm2(binary) {
  const res = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  const ok = res.status === 0;
  return {
    ok,
    detail: ok ? 'pm2 ' + String(res.stdout || '').trim() : 'pm2 not resolvable on PATH',
    problems: ok ? [] : ['pm2_not_installed']
  };
}

function checkEnvFiles(root, files) {
  const problems = [];
  for (const rel of files || []) {
    if (!fs.existsSync(path.join(root, rel))) problems.push('missing_env_file:' + rel);
  }
  return {
    ok: problems.length === 0,
    detail: files && files.length ? files.join(', ') : 'none required',
    problems
  };
}

function runPreflight(opts = {}) {
  const root = opts.root || ROOT;
  const nodeVersion = opts.nodeVersion || process.version;
  const requiredNode = opts.requiredNode != null ? opts.requiredNode : readEnginesNode(root);
  const pm2Check = opts.skipPm2 ? { ok: true, detail: 'skipped', problems: [] } : checkPm2(opts.pm2Bin || 'pm2');

  const checks = {
    ecosystem: checkEcosystem(root),
    node_version: checkNodeVersion(nodeVersion, requiredNode),
    pm2: pm2Check,
    env_files: checkEnvFiles(root, REQUIRED_ENV_FILES)
  };
  const failed = Object.keys(checks).filter((k) => !checks[k].ok);
  return { ready: failed.length === 0, checks, failed };
}

function readEnginesNode(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return (pkg.engines && pkg.engines.node) || '';
  } catch (_) {
    return '';
  }
}

function main(argv) {
  const asJson = argv.includes('--json');
  const result = runPreflight({});
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const [name, c] of Object.entries(result.checks)) {
      console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${name}: ${c.detail}`);
    }
    if (!result.ready) {
      console.error('\nPREFLIGHT FAILED: ' + result.failed.join(', '));
    } else {
      console.log('\nPreflight OK — ready to deploy. Next: npm run pm2:start');
    }
  }
  return result.ready ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  EXPECTED_APPS,
  REQUIRED_ENV_FILES,
  checkEcosystem,
  checkNodeVersion,
  checkPm2,
  checkEnvFiles,
  readEnginesNode,
  runPreflight
};
'use strict';

// BUG-RT-02 regression — production env precedence.
//
// Invariant: runner-owned runtime env ($RUNNER_DIR/.env) overrides repository
// / local-development env files (.env.local, .env.intraday-runtime, .env) in
// every production runner and in the local origin daemon.
//
// Discipline: every fixture value below is a dummy literal. Effective secret
// values are compared by SHA-256 only, so no test output ever echoes even a
// dummy plaintext secret.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'deploy', 'vps', 'lib', 'load-env.sh');

// Every wrapper that used to source runner .env FIRST and repo .env.local LAST.
const FIXED_WRAPPERS = [
  'run-screeners.sh',
  'run-daytrade.sh',
  'run-daytrade-producer.sh',
  'run-fastwatcher.sh',
  'run-screener-dispatch.sh',
  'run-swing-konglo.sh',
  'run-swing-non-konglo.sh',
  'run-sector-hot.sh'
];

function resolveBash() {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', 'bash']
    : ['bash'];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'exit 0'], { encoding: 'utf8' });
      if (probe.status === 0) return candidate;
    } catch (_) { /* try next */ }
  }
  return null;
}

const BASH = resolveBash();
const bashSkip = BASH ? false : 'bash unavailable on this host';

function bashPath(p) {
  return String(p).replace(/\\/g, '/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-envprec-'));
  const repo = path.join(base, 'repo');
  const runner = path.join(base, 'runner');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(runner, { recursive: true });
  return { base, repo, runner };
}

function runHelper(sandbox, tail) {
  const script = [
    'set -euo pipefail',
    'source "' + bashPath(HELPER) + '"',
    'load_auto_cuan_env "' + bashPath(sandbox.repo) + '" "' + bashPath(sandbox.runner) + '"',
    tail
  ].join('\n');
  return spawnSync(BASH, ['-c', script], { encoding: 'utf8' });
}

test('RT-02 A: runner .env CRON_SECRET wins over stale repo .env.local (hash compared)', { skip: bashSkip }, () => {
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(path.join(sandbox.runner, '.env'), 'CRON_SECRET=dummy-runner-secret\n');
    fs.writeFileSync(path.join(sandbox.repo, '.env.local'), 'CRON_SECRET=dummy-stale-repo-secret\n');

    const res = runHelper(sandbox, "printf '%s' \"${CRON_SECRET:-}\" | sha256sum | cut -d' ' -f1");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), sha256('dummy-runner-secret'), 'runner secret must win');
    assert.notEqual(res.stdout.trim(), sha256('dummy-stale-repo-secret'));
  } finally {
    fs.rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test('RT-02 B: missing runner .env falls back to repo values (documented fallback)', { skip: bashSkip }, () => {
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(path.join(sandbox.repo, '.env.local'), 'CRON_SECRET=dummy-repo-fallback-secret\n');

    const res = runHelper(sandbox, "printf '%s' \"${CRON_SECRET:-}\" | sha256sum | cut -d' ' -f1");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), sha256('dummy-repo-fallback-secret'), 'repo value is used when runner env is absent');
  } finally {
    fs.rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test('RT-02 C: blank runner CRON_SECRET fails closed instead of accepting the stale repo secret', { skip: bashSkip }, () => {
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(path.join(sandbox.runner, '.env'), 'CRON_SECRET=\n');
    fs.writeFileSync(path.join(sandbox.repo, '.env.local'), 'CRON_SECRET=dummy-stale-repo-secret\n');

    const res = runHelper(sandbox, [
      'if require_nonempty_env "CRON_SECRET" "${CRON_SECRET:-}"; then',
      '  echo OK_UNEXPECTED',
      'else',
      '  echo FAILED_CLOSED',
      'fi'
    ].join('\n'));

    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'FAILED_CLOSED', 'blank runner value must fail closed');
    assert.match(res.stderr, /ENV_ERROR: CRON_SECRET/);
    assert.doesNotMatch(res.stdout + res.stderr, /dummy-stale-repo-secret/, 'no secret value may be printed');
  } finally {
    fs.rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test('RT-02 C2: missing everywhere and whitespace-only values also fail closed', { skip: bashSkip }, () => {
  const sandbox = makeSandbox();
  try {
    const missing = runHelper(sandbox, [
      'if require_nonempty_env "CRON_SECRET" "${CRON_SECRET:-}"; then echo OK_UNEXPECTED; else echo FAILED_CLOSED; fi'
    ].join('\n'));
    assert.equal(missing.stdout.trim(), 'FAILED_CLOSED');

    fs.writeFileSync(path.join(sandbox.runner, '.env'), 'CRON_SECRET=   \n');
    const blank = runHelper(sandbox, [
      'if require_nonempty_env "CRON_SECRET" "${CRON_SECRET:-}"; then echo OK_UNEXPECTED; else echo FAILED_CLOSED; fi'
    ].join('\n'));
    assert.equal(blank.stdout.trim(), 'FAILED_CLOSED');
  } finally {
    fs.rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test('RT-02 wrappers: all fixed production wrappers delegate to the canonical loader', () => {
  for (const name of FIXED_WRAPPERS) {
    const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', name), 'utf8');
    assert.match(src, /lib\/load-env\.sh/, name + ' must source deploy/vps/lib/load-env.sh');
    assert.match(src, /load_auto_cuan_env "\$REPO" "\$RUNNER_DIR"/, name + ' must call load_auto_cuan_env');
    assert.doesNotMatch(
      src,
      /for env_file in "\$RUNNER_DIR\/\.env" "\$REPO\/\.env"/,
      name + ' must not keep the old runner-first/env.local-last loop'
    );
  }
});

test('RT-02 run-screeners.sh fails closed on an empty CRON_SECRET', () => {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-screeners.sh'), 'utf8');
  assert.match(src, /require_nonempty_env "CRON_SECRET" "\$\{CRON_SECRET:-\}"/);
});

function withSavedEnv(keys, fn) {
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test('RT-02 node runner loadEnvFiles: runner .env wins over stale repo .env.local', async () => {
  const runnerLoader = require('../tools/run-all-screeners-vps');
  const snapshotLoader = require('../tools/build-screener-snapshot');
  const screenerLoader = require('../tools/run-screener');
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(path.join(sandbox.runner, '.env'), 'CRON_SECRET=dummy-runner-secret\n');
    fs.writeFileSync(path.join(sandbox.repo, '.env.local'), 'CRON_SECRET=dummy-stale-repo-secret\n');

    await withSavedEnv(['AUTO_CUAN_RUNNER_DIR', 'CRON_SECRET'], () => {
      process.env.AUTO_CUAN_RUNNER_DIR = sandbox.runner;
      delete process.env.CRON_SECRET;

      const envA = {};
      runnerLoader.loadEnvFiles(envA, sandbox.repo);
      assert.equal(envA.CRON_SECRET, 'dummy-runner-secret', 'run-all-screeners-vps must prefer runner env');

      delete process.env.CRON_SECRET;
      const envB = {};
      snapshotLoader.loadEnvFiles(envB, sandbox.repo);
      assert.equal(envB.CRON_SECRET, 'dummy-runner-secret', 'build-screener-snapshot must prefer runner env');

      delete process.env.CRON_SECRET;
      const envC = {};
      screenerLoader.loadEnvFiles(envC, sandbox.repo);
      assert.equal(envC.CRON_SECRET, 'dummy-runner-secret', 'run-screener must prefer runner env');
    });
  } finally {
    fs.rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test('RT-02 node runner loadEnvFiles: repo fallback still works when runner .env is absent', async () => {
  const runnerLoader = require('../tools/run-all-screeners-vps');
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(path.join(sandbox.repo, '.env.local'), 'CRON_SECRET=dummy-repo-fallback-secret\n');

    await withSavedEnv(['AUTO_CUAN_RUNNER_DIR', 'CRON_SECRET'], () => {
      process.env.AUTO_CUAN_RUNNER_DIR = sandbox.runner;
      delete process.env.CRON_SECRET;

      const env = {};
      runnerLoader.loadEnvFiles(env, sandbox.repo);
      assert.equal(env.CRON_SECRET, 'dummy-repo-fallback-secret');
    });
  } finally {
    fs.rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test('RT-02 recap initEnv: runner .env is loaded before repo files', async () => {
  const recap = require('../tools/run-daily-afternoon-recap');
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(path.join(sandbox.runner, '.env'), 'CRON_SECRET=dummy-runner-secret\n');
    fs.writeFileSync(path.join(sandbox.repo, '.env.local'), 'CRON_SECRET=dummy-stale-repo-secret\n');

    await withSavedEnv(['AUTO_CUAN_RUNNER_DIR', 'CRON_SECRET'], () => {
      process.env.AUTO_CUAN_RUNNER_DIR = sandbox.runner;
      delete process.env.CRON_SECRET;
      recap.initEnv(sandbox.repo);
      assert.equal(process.env.CRON_SECRET, 'dummy-runner-secret');
    });
  } finally {
    fs.rmSync(sandbox.base, { recursive: true, force: true });
  }
});

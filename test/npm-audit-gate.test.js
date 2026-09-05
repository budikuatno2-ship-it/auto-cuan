'use strict';

// tools/npm-audit-gate.sh wraps `npm audit --omit=dev --audit-level=high` in a
// retry, because registry.npmjs.org intermittently answers the audit endpoint
// with 503 or 400 and npm exits 1 for that indistinguishably from
// "vulnerabilities found". That made a transient registry outage read as a
// failed security gate.
//
// The whole point is that the wrapper must NOT weaken the gate. These tests
// pin both halves of that: a real vulnerability fails on the FIRST attempt and
// is never retried away, and an audit that never ran fails closed rather than
// being treated as clean.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE = path.resolve(__dirname, '..', 'tools', 'npm-audit-gate.sh');

const hasBash = (() => {
  try {
    const res = spawnSync('bash', ['-c', 'exit 0']);
    return res.status === 0;
  } catch (_) {
    return false;
  }
})();

function withFakeNpm(script, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-audit-gate-'));
  const bin = path.join(dir, 'npm');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  try {
    return run(bin, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runGate(npmBin, options) {
  options = options || {};
  return spawnSync('bash', [GATE], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      NPM_BIN: npmBin,
      NPM_AUDIT_ATTEMPTS: String(options.attempts || 3),
      NPM_AUDIT_BACKOFF_SECONDS: '0',
      NPM_AUDIT_TIMEOUT_SECONDS: String(options.timeout || 30)
    })
  });
}

const CLEAN = '#!/bin/sh\necho "found 0 vulnerabilities"\nexit 0\n';

const VULNERABLE = [
  '#!/bin/sh',
  'echo "# npm audit report"',
  'echo "lodash  <4.17.21  Severity: high  Prototype Pollution"',
  'echo "1 high severity vulnerability"',
  'exit 1',
  ''
].join('\n');

function registryFailure(message) {
  return [
    '#!/bin/sh',
    'echo "' + message + '" >&2',
    'echo "npm error audit endpoint returned an error" >&2',
    'exit 1',
    ''
  ].join('\n');
}

function countAttempts(stdout) {
  return (stdout.match(/npm audit attempt/g) || []).length;
}

test('a clean audit passes', { skip: !hasBash ? 'bash is not available on host' : false }, () => {
  withFakeNpm(CLEAN, (bin) => {
    const result = runGate(bin);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(countAttempts(result.stdout), 1, 'a passing audit must not retry');
  });
});

test('a real vulnerability fails on the first attempt and is never retried away', { skip: !hasBash ? 'bash is not available on host' : false }, () => {
  withFakeNpm(VULNERABLE, (bin) => {
    const result = runGate(bin);
    assert.equal(result.status, 1);
    assert.equal(countAttempts(result.stdout), 1,
      'a genuine vulnerability must not be retried - retrying could mask it');
    assert.match(result.stdout, /high or critical vulnerabilities/);
  });
});

test('a 503 from the registry is retried', { skip: !hasBash ? 'bash is not available on host' : false }, () => {
  const script = registryFailure('npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Service Unavailable');
  withFakeNpm(script, (bin) => {
    const result = runGate(bin, { attempts: 3 });
    assert.equal(countAttempts(result.stdout), 3);
  });
});

test('a 400 Invalid package tree from the registry is retried', { skip: !hasBash ? 'bash is not available on host' : false }, () => {
  const script = registryFailure('npm warn audit 400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Bad Request');
  withFakeNpm(script, (bin) => {
    const result = runGate(bin, { attempts: 2 });
    assert.equal(countAttempts(result.stdout), 2);
  });
});

test('an audit that never runs fails closed, never silently green', { skip: !hasBash ? 'bash is not available on host' : false }, () => {
  const script = registryFailure('npm warn audit 503 Service Unavailable');
  withFakeNpm(script, (bin) => {
    const result = runGate(bin, { attempts: 2 });
    assert.equal(result.status, 1, 'an unverifiable dependency tree must not pass the gate');
    assert.match(result.stdout, /NOT verified/,
      'the operator must be told the tree was never checked');
  });
});

test('a transient failure that then succeeds passes', { skip: !hasBash ? 'bash is not available on host' : false }, () => {
  withFakeNpm('', (bin, dir) => {
    const counter = path.join(dir, 'count');
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      'N=$(cat ' + counter + ' 2>/dev/null || echo 0)',
      'N=$((N+1)); echo "$N" > ' + counter,
      'if [ "$N" -lt 2 ]; then',
      '  echo "npm error audit endpoint returned an error" >&2',
      '  exit 1',
      'fi',
      'echo "found 0 vulnerabilities"',
      'exit 0',
      ''
    ].join('\n'), { mode: 0o755 });

    const result = runGate(bin, { attempts: 3 });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(countAttempts(result.stdout), 2);
  });
});

test('a hanging audit is bounded and retried, not left to stall the job', { skip: !hasBash ? 'bash is not available on host' : false }, () => {
  withFakeNpm('#!/bin/sh\nsleep 30\n', (bin) => {
    const started = Date.now();
    const result = runGate(bin, { attempts: 2, timeout: 1 });
    const elapsedMs = Date.now() - started;
    assert.equal(result.status, 1);
    assert.equal(countAttempts(result.stdout), 2);
    assert.ok(elapsedMs < 20000, 'each attempt must be time-bounded, took ' + elapsedMs + 'ms');
  });
});

test('the workflow invokes the wrapper rather than npm audit directly', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '.github', 'workflows', 'security-gate.yml'), 'utf8');
  assert.match(workflow, /bash tools\/npm-audit-gate\.sh/);
  assert.doesNotMatch(workflow, /^\s*run: npm audit/m,
    'the raw npm audit call must not come back alongside the wrapper');
});

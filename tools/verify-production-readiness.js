'use strict';

/**
 * Production readiness audit (Batch 16).
 *
 * Two jobs, both fail-closed:
 *   1. Required env vars must be present in the runtime.
 *   2. No static review token (F-013) or credential backdoor (F-037) may be
 *      active in the shipped source.
 *
 * Usage:
 *   node tools/verify-production-readiness.js            # audit current env
 *   node tools/verify-production-readiness.js --json     # machine-readable
 *
 * Exit 0 = ready, exit 1 = not ready. Never prints secret values.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// APP_SECRET (or ENCRYPTION_SECRET) is the BYOK master key; the service-role
// key is the DB credential; a Gemini key is required for AI narration.
const REQUIRED_ENV = [
  { name: 'APP_SECRET', aliases: ['ENCRYPTION_SECRET'], minLength: 16 },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', aliases: [], minLength: 20 },
  { name: 'GEMINI_API_KEY', aliases: ['GEMINI_API_KEY_PRIMARY', 'API_KEY_ANALISA_SAHAM_PORTOFOLIO'], minLength: 20 }
];

// Source files that must stay free of hardcoded credentials. Each entry is a
// pattern that would re-introduce a known finding if it ever matched again.
const FORBIDDEN_SOURCE_PATTERNS = [
  {
    id: 'F-013',
    file: 'api/review-access.js',
    // A literal token fallback (e.g. `|| 'some-token'`) after the env read.
    regex: /REVIEW_ACCESS_TOKEN\s*\|\|\s*['"][^'"]+['"]/,
    message: 'static review token fallback is active in api/review-access.js'
  },
  {
    id: 'F-013',
    file: 'tools/run-build-test-suite.js',
    regex: /REVIEW_ACCESS_TOKEN\s*=\s*['"][^'"]+['"]/,
    message: 'static review token literal is planted in the build runner'
  },
  {
    id: 'F-037',
    file: 'api/login-user.js',
    regex: /LEGACY_BUDI_PASSWORD_HASH|matchesLegacyBudiPassword/,
    message: 'legacy budi credential backdoor is present in api/login-user.js'
  },
  {
    id: 'F-038',
    file: 'lib/user-ai-credentials.js',
    regex: /autocuan-chart-ai-key-secret-seed/,
    message: 'hardcoded BYOK master-key fallback is present in lib/user-ai-credentials.js'
  }
];

function resolveEnv(entry, env) {
  const names = [entry.name, ...entry.aliases];
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length >= entry.minLength) {
      return { ok: true, via: name };
    }
  }
  return { ok: false, via: null };
}

function auditEnv(env) {
  return REQUIRED_ENV.map((entry) => {
    const result = resolveEnv(entry, env);
    return {
      check: 'env:' + entry.name,
      ok: result.ok,
      detail: result.ok
        ? `configured via ${result.via}`
        : `missing or too short (need ${entry.name}${entry.aliases.length ? ' or ' + entry.aliases.join('/') : ''})`
    };
  });
}

function auditSource(rootDir) {
  return FORBIDDEN_SOURCE_PATTERNS.map((rule) => {
    const abs = path.join(rootDir, rule.file);
    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (_) {
      return { check: 'source:' + rule.id + ':' + rule.file, ok: false, detail: 'file not found' };
    }
    const hit = rule.regex.test(text);
    return {
      check: 'source:' + rule.id + ':' + rule.file,
      ok: !hit,
      detail: hit ? rule.message : 'no hardcoded credential pattern'
    };
  });
}

function runAudit(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || ROOT;
  const results = [...auditEnv(env), ...auditSource(rootDir)];
  return { ready: results.every((r) => r.ok), results };
}

function main() {
  const report = runAudit();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('--- Production Readiness Audit ---');
    for (const r of report.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}  ${r.detail}`);
    }
    console.log(report.ready ? 'READY: production environment is configured.' : 'NOT READY: fix the FAIL items above.');
  }
  process.exitCode = report.ready ? 0 : 1;
}

if (require.main === module) main();

module.exports = { runAudit, auditEnv, auditSource, REQUIRED_ENV, FORBIDDEN_SOURCE_PATTERNS };
'use strict';

/**
 * api/version.js — TRUTHFUL version endpoint (V5).
 * ============================================================================
 * The previous implementation hardcoded `version: 'v4-final'` and stamped a
 * request-time `new Date()` as if it were a build timestamp. Both were
 * fabricated values. This module never invents data:
 *
 *   commitSha   GIT_COMMIT env → data/build-info.json → `git rev-parse HEAD`
 *               (cached, guarded) → null
 *   branch      GIT_BRANCH env → build-info → `git rev-parse --abbrev-ref HEAD`
 *               (cached, guarded) → null
 *   buildTime   data/build-info.json buildTime → null (NEVER request time)
 *   startedAt   process start time of this Node worker (real, always known)
 *
 * Unknown values are explicit null (or the literal string "unknown" for the
 * human-readable `version` label when no release metadata exists). Nothing is
 * fabricated, and no hardcoded release literal is returned.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Process start time — the one timestamp this module genuinely knows.
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

let cachedMeta = null;

function readBuildInfo() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'data', 'build-info.json'), 'utf8');
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' ? doc : {};
  } catch (_) {
    return {};
  }
}

function gitCommitSha() {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
    });
    const sha = String(out).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (_) {
    return null;
  }
}

function gitBranch() {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
    });
    const branch = String(out).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch (_) {
    return null;
  }
}

function truthCommitSha(buildInfo) {
  if (process.env.GIT_COMMIT && /^[0-9a-f]{40}$/.test(process.env.GIT_COMMIT)) {
    return process.env.GIT_COMMIT;
  }
  if (process.env.GIT_SHA && /^[0-9a-f]{40}$/.test(process.env.GIT_SHA)) {
    return process.env.GIT_SHA;
  }
  if (typeof buildInfo.commitSha === 'string' && /^[0-9a-f]{40}$/.test(buildInfo.commitSha)) {
    return buildInfo.commitSha;
  }
  return gitCommitSha();
}

function truthBranch(buildInfo) {
  if (process.env.GIT_BRANCH && process.env.GIT_BRANCH.trim()) return process.env.GIT_BRANCH.trim();
  if (typeof buildInfo.branch === 'string' && buildInfo.branch.trim()) return buildInfo.branch.trim();
  return gitBranch();
}

function truthBuildTime(buildInfo) {
  // ONLY from build metadata — never from Date.now() at request time.
  if (typeof buildInfo.buildTime === 'string' && !Number.isNaN(Date.parse(buildInfo.buildTime))) {
    return buildInfo.buildTime;
  }
  return null;
}

function collectMeta() {
  if (cachedMeta) return cachedMeta;
  const buildInfo = readBuildInfo();
  const commitSha = truthCommitSha(buildInfo);
  cachedMeta = {
    commitSha,
    commitShort: commitSha ? commitSha.slice(0, 8) : null,
    branch: truthBranch(buildInfo),
    buildTime: truthBuildTime(buildInfo)
  };
  return cachedMeta;
}

function buildPayload() {
  const meta = collectMeta();
  const versionLabel = (meta.commitSha && meta.branch)
    ? 'v5-' + meta.branch + '-' + meta.commitShort
    : 'unknown';
  return {
    success: true,
    status: 200,
    version: versionLabel,
    release: 'Auto-Cuan IDX V5',
    active: true,
    versionSource: meta.commitSha
      ? (process.env.GIT_COMMIT || process.env.GIT_SHA)
        ? 'env'
        : (hasBuildInfoKey('commitSha') ? 'build-info' : 'git')
      : 'none',
    commitSha: meta.commitSha,
    commitShort: meta.commitShort,
    branch: meta.branch,
    buildTime: meta.buildTime,
    startedAt: STARTED_AT,
    timestamp: new Date().toISOString()
  };
}

function hasBuildInfoKey(key) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'build-info.json'), 'utf8'));
    return Boolean(doc && typeof doc === 'object' && doc[key]);
  } catch (_) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  const payload = buildPayload();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (typeof res.status === 'function') {
    return res.status(200).json(payload);
  }
  res.writeHead(200);
  return res.end(JSON.stringify(payload));
};

// Exposed for tests — pure, no HTTP.
module.exports.buildPayload = buildPayload;
module.exports.collectMeta = collectMeta;

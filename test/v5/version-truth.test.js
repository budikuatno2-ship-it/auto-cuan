'use strict';

/**
 * test/v5/version-truth.test.js — BUG-V5-P0-008 truth gate (V5)
 * ============================================================================
 * Asserts api/version.js NEVER fabricates release metadata.
 * Run: node test/v5/version-truth.test.js   (exit 0 = truth holds)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MOD_PATH = path.join(ROOT, 'api', 'version.js');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  ok   ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label); }
}

delete require.cache[require.resolve(MOD_PATH)];
const mod = require(MOD_PATH);

if (typeof mod !== 'function') {
  console.error('FATAL: api/version.js default export must be the request handler function');
  process.exit(2);
}
if (typeof mod.buildPayload !== 'function') {
  console.error('FATAL: api/version.js must export buildPayload() for this truth gate');
  process.exit(2);
}

const payload = mod.buildPayload();
console.log('[version-truth] payload = ' + JSON.stringify(payload));

const HEX40 = /^[0-9a-f]{40}$/;
assert(
  payload.commitSha === null || (typeof payload.commitSha === 'string' && HEX40.test(payload.commitSha)),
  'commitSha is null or 40-hex (got: ' + JSON.stringify(payload.commitSha) + ')'
);
assert(
  payload.commitShort === null || (typeof payload.commitShort === 'string' && /^[0-9a-f]{8}$/.test(payload.commitShort)),
  'commitShort is null or 8-hex'
);
if (payload.commitSha !== null) {
  assert(payload.commitShort === payload.commitSha.slice(0, 8), 'commitShort is the first 8 chars of commitSha');
}

assert(typeof payload.version === 'string' && payload.version.length > 0, 'version is a non-empty string');
assert(
  payload.version === 'unknown' || /^v5-/.test(payload.version),
  "version is the honest 'unknown' label or derives from real commit metadata (got: " + payload.version + ')'
);

assert(payload.buildTime === null || !Number.isNaN(Date.parse(payload.buildTime)), 'buildTime is null or a parseable date');
assert(payload.startedAt !== payload.timestamp, 'startedAt is distinct from the request timestamp');
assert(!Number.isNaN(Date.parse(payload.startedAt)) && Date.parse(payload.startedAt) <= Date.now(), 'startedAt is a real, non-future process timestamp');
if (payload.buildTime !== null) {
  assert(Date.parse(payload.buildTime) <= Date.parse(payload.startedAt), 'buildTime predates or equals startedAt');
}

const src = fs.readFileSync(MOD_PATH, 'utf8');
const nonCommentLines = src.split(/\r?\n/).filter((l) => {
  const t = l.trim();
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}).join('\n');
assert(!/['"]v4-final['"]/.test(nonCommentLines), "source contains no hardcoded 'v4-final' literal in executable code");
assert(payload.version !== 'v4-final', "payload.version is not the fabricated 'v4-final'");
assert(payload.release !== undefined, 'release field present');
assert(typeof payload.versionSource === 'string', 'versionSource labels where version metadata came from');
if (payload.commitSha !== null) {
  assert(['env', 'build-info', 'git'].includes(payload.versionSource), 'versionSource is a documented source when commitSha exists');
} else {
  assert(payload.versionSource === 'none', "versionSource is 'none' when no metadata exists");
}

if (failures.length > 0) {
  console.error('[version-truth] FAIL — ' + failures.length + ' assertion(s) violated:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('[version-truth] PASS — version endpoint is truthful');
process.exit(0);
'use strict';

/**
 * test/v6-release-runbook-validation.test.js
 * ============================================================================
 * V6 (Subtask L) — Release/rollback runbook command validation (staging).
 *
 * Asserts that the runbook references only real source contracts and never
 * emits a dangerous command. Exercised against the real modules/fixture on a
 * throwaway SQLite DB (no production DB, no PM2, no network).
 *
 * Covered:
 *   1. `lib/quota-manager` exports `getQuotaStatus` (NOT the old `getStatus`).
 *   2. The runbook's *command blocks* use `getQuotaStatus`, never `getStatus`.
 *   3. The runbook's *command blocks* don't contain a read-only `PRAGMA wal_checkpoint`.
 *   4. The runbook's *command blocks* never contain `pm2 restart all`/`reload all`.
 *   5. The fixture CLI end-to-end still returns PASS.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const safety = require('../lib/sqlite-rollback-safety');

function readDoc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Extract only ```bash ... ``` code fences (the actual commands a human would
// copy-paste), ignoring the prose/explanation that may quote an old command.
function bashBlocks(doc) {
  const out = [];
  const re = /```bash\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(doc)) !== null) out.push(m[1]);
  return out.join('\n');
}

test('quota-manager exports getQuotaStatus, and getStatus is undefined', () => {
  const m = require('../lib/quota-manager');
  assert.equal(typeof m.getQuotaStatus, 'function', 'getQuotaStatus must exist');
  assert.equal(typeof m.calculateQuotaState, 'function', 'alias calculateQuotaState must exist');
  assert.equal(m.getStatus, undefined, 'legacy getStatus must NOT exist');
});

test('runbook command blocks use getQuotaStatus, never getStatus', () => {
  const doc = readDoc('docs/v6/V6_RELEASE_AND_ROLLBACK.md');
  const cmds = bashBlocks(doc);
  assert.match(doc, /getQuotaStatus/);
  assert.doesNotMatch(cmds, /\.getStatus\(\)/);
});

test('runbook command blocks never use read-only wal_checkpoint', () => {
  const doc = readDoc('docs/v6/V6_RELEASE_AND_ROLLBACK.md');
  const cmds = bashBlocks(doc);
  assert.doesNotMatch(cmds, /-readonly[^\n]*wal_checkpoint/i);
  assert.doesNotMatch(cmds, /sqlite3\s+-readonly[^\n]*wal_checkpoint/i);
});

test('runbook command blocks never emit `pm2 restart all`/`reload all`', () => {
  const doc = readDoc('docs/v6/V6_RELEASE_AND_ROLLBACK.md');
  const cmds = bashBlocks(doc);
  assert.doesNotMatch(cmds, /pm2\s+restart\s+all\b/i);
  assert.doesNotMatch(cmds, /pm2\s+reload\s+all\b/i);
  assert.match(cmds, /pm2\s+(?:reload|restart)\s+auto-cuan-vps-api/);
  assert.match(cmds, /pm2\s+(?:reload|restart)\s+autocuan-web/);
});

test('scoped restart plan flags `pm2 restart all` as dangerous', () => {
  const good = safety.buildScopedRestartPlan(['pm2 restart auto-cuan-vps-api'], safety.DB_PM2_APP_NAMES);
  assert.equal(good.containsRestartAll, false);
  assert.ok(good.plan.every((p) => p.scoped === true && p.dangerous === false));

  const bad = safety.buildScopedRestartPlan(['pm2 restart all'], safety.DB_PM2_APP_NAMES);
  assert.equal(bad.containsRestartAll, true);
  assert.equal(bad.plan[0].dangerous, true);
});

test('rollback fixture CLI still returns PASS (real commands on throwaway DB)', () => {
  const fixtureMain = require('../tools/v6-rollback-fixture').main;
  const code = fixtureMain(['--json']);
  assert.equal(code, 0, 'fixture must complete successfully');
});

test('consistent snapshot uses VACUUM INTO (wal-safe, no cp)', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-rbv-'));
  const dbPath = path.join(dir, 'live.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  const opened = safety.openDatabaseSync(dbPath);
  assert.equal(opened.ok, true);
  opened.db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL);');
  const ins = opened.db.prepare('INSERT INTO t(v) VALUES (?)');
  for (let i = 1; i <= 5; i++) ins.run('row-' + i);

  const snap = safety.consistentSnapshot(opened.db, backupPath);
  assert.equal(snap.ok, true);
  assert.equal(snap.stage, 'SNAPSHOT');
  assert.equal(fs.existsSync(backupPath), true);

  const b = safety.openDatabaseSync(backupPath);
  assert.equal(b.ok, true);
  assert.equal(b.db.prepare('SELECT COUNT(*) c FROM t').get().c, 5);
  assert.equal(safety.integrityCheck(b.db), true);
  b.db.close();
  opened.db.close();
});
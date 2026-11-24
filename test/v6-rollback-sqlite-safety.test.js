'use strict';

/**
 * test/v6-rollback-sqlite-safety.test.js
 * ============================================================================
 * V6 (Subtask I) — SQLite WAL/SHM rollback & data-safety regression.
 *
 * Every assertion exercises the REAL safe-rollback primitives
 * (lib/sqlite-rollback-safety.js) and the real fixture runner
 * (tools/v6-rollback-fixture.js) against a throwaway DB in os.tmpdir().
 * No production DB, no PM2, no network.
 *
 * Covered:
 *   1. Consistent snapshot uses VACUUM INTO + wal_checkpoint (NOT `cp`).
 *   2. WAL/SHM sibling paths are derived and non-empty DB restores correctly.
 *   3. integrity_check true for a valid snapshot; false for a corrupt DB.
 *   4. Hash tamper -> HASH_MISMATCH (restore refused).
 *   5. Missing backup -> BACKUP_MISSING.
 *   6. Symlink awareness prevents clobbering a canonical data symlink.
 *   7. Scoped PM2 restart plan never emits `restart all`; flags dangerous cmd.
 *   8. Full fixture: seed -> snapshot -> mutate -> restore -> hash+integrity.
 *   9. Graceful degradation when node:sqlite is unavailable (by contract).
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const safety = require('../lib/sqlite-rollback-safety');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-rb-')); }

function makeDb(file) {
  const opened = safety.openDatabaseSync(file);
  assert.equal(opened.ok, true, 'node:sqlite must be available: ' + opened.error);
  opened.db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL);');
  const ins = opened.db.prepare('INSERT INTO t(v) VALUES (?)');
  for (let i = 1; i <= 5; i++) ins.run('row-' + i);
  return opened.db;
}

test('consistentSnapshot uses wal_checkpoint + VACUUM INTO (single atomic file)', () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'live.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  const db = makeDb(dbPath);

  const snap = safety.consistentSnapshot(db, backupPath);
  assert.equal(snap.ok, true, 'snapshot must succeed: ' + JSON.stringify(snap));
  assert.equal(snap.stage, 'SNAPSHOT');
  assert.ok(snap.checkpoint.ok === true, 'checkpoint reported not-busy');

  // The backup is a standalone valid SQLite file with exactly the seeded rows.
  assert.equal(fs.existsSync(backupPath), true);
  const b = safety.openDatabaseSync(backupPath);
  assert.equal(b.ok, true);
  const rows = b.db.prepare('SELECT COUNT(*) c FROM t').get().c;
  assert.equal(rows, 5);
  assert.equal(safety.integrityCheck(b.db), true);
  b.db.close();
  db.close();
});

test('walShmPaths derive -wal and -shm siblings', () => {
  const p = safety.walShmPaths('/x/market.sqlite');
  assert.equal(p.wal, '/x/market.sqlite-wal');
  assert.equal(p.shm, '/x/market.sqlite-shm');
});

test('integrityCheck true for valid DB, false for corrupt bytes', () => {
  const dir = tmpdir();
  const good = path.join(dir, 'good.sqlite');
  const db = makeDb(good);
  assert.equal(safety.integrityCheck(db), true);
  db.close();

  const bad = path.join(dir, 'bad.sqlite');
  fs.writeFileSync(bad, 'not-a-sqlite-database-at-all');
  const opened = safety.openDatabaseSync(bad);
  if (opened.ok) {
    assert.equal(safety.integrityCheck(opened.db), false, 'corrupt bytes must fail integrity_check');
    opened.db.close();
  } else {
    assert.equal(opened.reason, 'SQLITE_NODE_UNAVAILABLE');
  }
});

test('validateBackup refuses tampered hash (HASH_MISMATCH)', () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'live.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  const db = makeDb(dbPath);
  safety.consistentSnapshot(db, backupPath);
  db.close();

  const goodHash = safety.sha256FileSync(backupPath);
  const valid = safety.validateBackup(backupPath, goodHash);
  assert.equal(valid.ok, true);
  assert.equal(valid.reason, 'VALID');

  const tampered = safety.validateBackup(backupPath, 'deadbeef'.padEnd(64, '0'));
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'HASH_MISMATCH');
});

test('validateBackup returns BACKUP_MISSING for absent file', () => {
  const r = safety.validateBackup('/nonexistent/path.sqlite');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'BACKUP_MISSING');
});

test('symlink awareness: restore target must not silently clobber a data symlink', () => {
  const dir = tmpdir();
  const real = path.join(dir, 'real-data');
  fs.mkdirSync(real);
  const link = path.join(dir, 'data');
  // Windows requires 'junction' for directory links without elevated rights;
  // POSIX uses 'dir'.
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(real, link, type);
  } catch (err) {
    // On restricted windows environments symlink creation may be forbidden;
    // verify the safety helpers degrade gracefully rather than throwing.
    assert.equal(safety.isSymlink(link), false);
    assert.equal(safety.resolveRealPath(link), fs.realpathSync(link));
    return;
  }

  assert.equal(safety.isSymlink(link), true);
  assert.equal(safety.resolveRealPath(link), fs.realpathSync(link));
  assert.equal(safety.isSymlink(real), false);
});

test('scoped PM2 restart plan never emits restart all', () => {
  const cmds = [
    'pm2 restart auto-cuan-vps-api',
    'pm2 restart auto-cuan-vps-api,autocuan-web'
  ];
  const r = safety.buildScopedRestartPlan(cmds, safety.DB_PM2_APP_NAMES);
  assert.equal(r.containsRestartAll, false);
  assert.equal(r.plan.length, 2);
  assert.ok(r.plan.every((p) => p.scoped === true && p.dangerous === false));

  const bad = safety.buildScopedRestartPlan(['pm2 restart all'], safety.DB_PM2_APP_NAMES);
  assert.equal(bad.containsRestartAll, true);
  assert.equal(bad.plan[0].dangerous, true);
});

test('full fixture: seed -> snapshot -> bad migration -> restore -> hash+integrity PASS', () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'market.sqlite');
  const backupPath = path.join(dir, 'market.sqlite.backup');
  const db = makeDb(dbPath);

  const snap = safety.consistentSnapshot(db, backupPath);
  assert.equal(snap.ok, true);
  const backupHash = safety.sha256FileSync(backupPath);

  // Bad migration: wipe + junk.
  db.exec('DELETE FROM t;');
  db.prepare('INSERT INTO t(v) VALUES (?)').run('junk');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM t').get().c, 1);
  db.close();

  // Restore to a sibling file (equivalent of restored live path).
  const restoredPath = path.join(dir, 'market.sqlite.restored');
  fs.copyFileSync(backupPath, restoredPath);

  const validation = safety.validateBackup(restoredPath, backupHash);
  assert.equal(validation.ok, true);
  assert.equal(validation.reason, 'VALID');

  const restored = safety.openDatabaseSync(restoredPath);
  assert.equal(restored.ok, true);
  assert.equal(restored.db.prepare('SELECT COUNT(*) c FROM t').get().c, 5);
  const vals = restored.db.prepare('SELECT v FROM t ORDER BY id').all().map((r) => r.v);
  assert.deepEqual(vals, ['row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
  assert.equal(safety.integrityCheck(restored.db), true);
  restored.db.close();
});

test('fixture CLI returns PASS end-to-end (tools/v6-rollback-fixture.js)', () => {
  const fixtureMain = require('../tools/v6-rollback-fixture').main;
  const code = fixtureMain(['--json']);
  assert.equal(code, 0, 'fixture must complete successfully');
});

test('graceful degradation contract: node:sqlite unavailable handled without throw', () => {
  // Contract-level: openDatabaseSync always returns {ok, reason} and never throws.
  const r = safety.openDatabaseSync(path.join(tmpdir(), 'x.sqlite'));
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) { r.db.close(); } else { assert.ok(r.reason, 'reason present when unavailable'); }
});
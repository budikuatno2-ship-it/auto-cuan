'use strict';

/**
 * test/v6-snapshot-immutability.test.js
 * ============================================================================
 * Subtask H / P0-10 — canonical snapshot content hash + append-only history.
 *
 * Asserted contract:
 *  1. snapshot_id is a CANONICAL CONTENT HASH: changing a score, an R/R level,
 *     a risk flag, a reason or the ranking produces a NEW id; identical content
 *     always produces the identical id (determinism).
 *  2. The hash covers session_date, algorithm version, universe, per-row
 *     digests (scores, breakdown, entry/max_entry/SL/TP, R/R, flags, reasons,
 *     input checksums) and the published ranking.
 *  3. Snapshot history is APPEND-ONLY: re-publishing identical content is a
 *     no-op; publishing a revision appends a new record and never rewrites or
 *     removes the previous one.
 *  4. A revision carries `revision_parent` pointing at the previous snapshot of
 *     the same session_date.
 *  5. A tampered frozen artifact fails verification (content hash mismatch).
 *  6. Consumers must not publish READY from a superseded snapshot: the runner
 *     reports SNAPSHOT_SUPERSEDED_BY_NEWER_REVISION and empties picks/top5.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../lib/saham-potensial-engine');
const store = require('../lib/saham-potensial-snapshot-store');

const SESSION = '2026-11-09';

function freshCandidate(ticker, overrides = {}) {
  return Object.assign({
    ticker,
    as_of: SESSION,
    price_asof: SESSION,
    last_price: 5000,
    entry_low: 4900,
    entry_high: 5050,
    sl: 4700,
    tp1: 5900,
    volume_ratio: 1.8,
    change_pct: 1.2,
    bandar_score: 80,
    bandar_asof: SESSION,
    foreign_flow_score: 75,
    foreign_asof: SESSION,
    technical_score: 72,
    technical_asof: SESSION,
    volume_asof: SESSION
  }, overrides);
}

function tmpStoreDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-snap-store-'));
}

/* -------------------------------------------------------------------------- */
/* 1. Content hash changes when content changes                               */
/* -------------------------------------------------------------------------- */
test('immutability: score change produces a NEW snapshot_id', () => {
  const a = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  const b = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBCA', { bandar_score: 30 })],
    { sessionDate: SESSION }
  );
  assert.notEqual(a.snapshot_id, b.snapshot_id);
  assert.notEqual(a.snapshot_content_hash, b.snapshot_content_hash);
});

test('immutability: R/R level change (tp1) produces a NEW snapshot_id', () => {
  const a = engine.buildSahamPotensialSnapshot([freshCandidate('BBRI')], { sessionDate: SESSION });
  const b = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBRI', { tp1: 6400 })],
    { sessionDate: SESSION }
  );
  assert.notEqual(a.snapshot_id, b.snapshot_id);
});

test('immutability: risk-flag change produces a NEW snapshot_id', () => {
  const a = engine.buildSahamPotensialSnapshot([freshCandidate('BMRI')], { sessionDate: SESSION });
  // change_pct > 15 adds HIGH_CHASE_RISK
  const b = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BMRI', { change_pct: 18 })],
    { sessionDate: SESSION }
  );
  assert.notEqual(a.snapshot_id, b.snapshot_id);
  assert.ok(b.top20[0].risk_flags.includes('HIGH_CHASE_RISK'));
});

test('immutability: session_date change produces a NEW snapshot_id', () => {
  const a = engine.buildSahamPotensialSnapshot([freshCandidate('ASII')], { sessionDate: SESSION });
  const b = engine.buildSahamPotensialSnapshot(
    [freshCandidate('ASII', { as_of: '2026-11-10', price_asof: '2026-11-10', bandar_asof: '2026-11-10', foreign_asof: '2026-11-10', technical_asof: '2026-11-10', volume_asof: '2026-11-10' })],
    { sessionDate: '2026-11-10' }
  );
  assert.notEqual(a.snapshot_id, b.snapshot_id);
});

test('immutability: ranking order change produces a NEW snapshot_id', () => {
  const strong = freshCandidate('BBCA', { bandar_score: 95, foreign_flow_score: 95, technical_score: 95 });
  const weak = freshCandidate('BBRI', { bandar_score: 55, foreign_flow_score: 55, technical_score: 55 });
  const a = engine.buildSahamPotensialSnapshot([strong, weak], { sessionDate: SESSION });
  // Force the opposite ranking by inverting the scores.
  const strong2 = freshCandidate('BBCA', { bandar_score: 55, foreign_flow_score: 55, technical_score: 55 });
  const weak2 = freshCandidate('BBRI', { bandar_score: 95, foreign_flow_score: 95, technical_score: 95 });
  const b = engine.buildSahamPotensialSnapshot([strong2, weak2], { sessionDate: SESSION });
  assert.notEqual(a.ranking[0], b.ranking[0]);
  assert.notEqual(a.snapshot_id, b.snapshot_id);
});

test('immutability: identical content is deterministic (same id, same hash)', () => {
  const build = () => engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBCA'), freshCandidate('BBRI', { last_price: 4000, entry_low: 3900, entry_high: 4050, sl: 3700, tp1: 4700 })],
    { sessionDate: SESSION }
  );
  const a = build();
  const b = build();
  assert.equal(a.snapshot_id, b.snapshot_id);
  assert.equal(a.snapshot_content_hash, b.snapshot_content_hash);
  assert.equal(a.snapshot_content_hash.length, 64);
  assert.match(a.snapshot_id, /^SP-2026-11-09-[0-9a-f]{16}$/);
});

test('immutability: hash inputs are persisted on the snapshot', () => {
  const s = engine.buildSahamPotensialSnapshot([freshCandidate('TLKM')], { sessionDate: SESSION });
  assert.ok(Array.isArray(s.universe));
  assert.ok(Array.isArray(s.ranking));
  assert.equal(typeof s.row_digests, 'object');
  assert.equal(typeof s.row_digests.TLKM, 'string');
  assert.equal(s.row_digests.TLKM.length, 64);
  assert.equal(s.content_hash_version, engine.CONTENT_HASH_VERSION);
});

test('immutability: the deprecated ticker-set hash is NOT the published id', () => {
  const s = engine.buildSahamPotensialSnapshot([freshCandidate('UNVR')], { sessionDate: SESSION });
  const legacy = engine.buildSnapshotId(SESSION, ['UNVR']);
  assert.notEqual(s.snapshot_id, legacy,
    'published snapshot_id must be the content hash, not the legacy ticker-set hash');
});

/* -------------------------------------------------------------------------- */
/* 2. Append-only history + revision parent                                   */
/* -------------------------------------------------------------------------- */
test('store: first publish appends one history record with revision_parent=null', () => {
  const dir = tmpStoreDir();
  const s = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  const res = store.publishSnapshot(s, { storeDir: dir });

  assert.equal(res.appended, true);
  assert.equal(res.revision_parent, null);

  const history = store.readHistory({ storeDir: dir });
  assert.equal(history.length, 1);
  assert.equal(history[0].snapshot_id, s.snapshot_id);
  assert.equal(history[0].content_hash, s.snapshot_content_hash);
  assert.equal(history[0].revision_parent, null);
});

test('store: re-publishing identical content is an idempotent no-op (no new line)', () => {
  const dir = tmpStoreDir();
  const s = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  store.publishSnapshot(s, { storeDir: dir });
  const res2 = store.publishSnapshot(s, { storeDir: dir });

  assert.equal(res2.appended, false);
  assert.equal(store.readHistory({ storeDir: dir }).length, 1,
    'append-only history must not grow on identical re-publish');
});

test('store: a revision appends a NEW record and keeps the old one (append-only)', () => {
  const dir = tmpStoreDir();
  const v1 = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  const v2 = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBCA', { bandar_score: 33 })],
    { sessionDate: SESSION }
  );

  store.publishSnapshot(v1, { storeDir: dir });
  const res2 = store.publishSnapshot(v2, { storeDir: dir });

  const history = store.readHistory({ storeDir: dir });
  assert.equal(history.length, 2, 'both revisions must remain in history');
  assert.equal(history[0].snapshot_id, v1.snapshot_id, 'old record must not be rewritten');
  assert.equal(history[1].snapshot_id, v2.snapshot_id);
  assert.equal(res2.revision_parent, v1.snapshot_id, 'revision must reference its parent');
  assert.equal(history[1].revision_parent, v1.snapshot_id);

  // Both frozen artifacts still exist.
  assert.ok(fs.existsSync(path.join(dir, v1.snapshot_id + '.json')));
  assert.ok(fs.existsSync(path.join(dir, v2.snapshot_id + '.json')));
});

test('store: the frozen artifact of the parent is never overwritten by a revision', () => {
  const dir = tmpStoreDir();
  const v1 = engine.buildSahamPotensialSnapshot([freshCandidate('BBRI')], { sessionDate: SESSION });
  store.publishSnapshot(v1, { storeDir: dir });
  const parentFile = path.join(dir, v1.snapshot_id + '.json');
  const before = fs.readFileSync(parentFile, 'utf8');

  const v2 = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBRI', { tp1: 6100 })],
    { sessionDate: SESSION }
  );
  store.publishSnapshot(v2, { storeDir: dir });

  assert.equal(fs.readFileSync(parentFile, 'utf8'), before,
    'parent snapshot file must be byte-identical after a revision');
});

test('store: revision_parent is scoped per session_date', () => {
  const dir = tmpStoreDir();
  const s1 = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: '2026-11-09' });
  const s2 = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBCA', { as_of: '2026-11-10', price_asof: '2026-11-10', bandar_asof: '2026-11-10', foreign_asof: '2026-11-10', technical_asof: '2026-11-10', volume_asof: '2026-11-10' })],
    { sessionDate: '2026-11-10' }
  );
  const r1 = store.publishSnapshot(s1, { storeDir: dir });
  const r2 = store.publishSnapshot(s2, { storeDir: dir });

  assert.equal(r1.revision_parent, null);
  assert.equal(r2.revision_parent, null, 'a different session starts its own chain');
});

/* -------------------------------------------------------------------------- */
/* 3. Tamper detection                                                        */
/* -------------------------------------------------------------------------- */
test('store: a tampered frozen artifact fails verification', () => {
  const dir = tmpStoreDir();
  const s = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  store.publishSnapshot(s, { storeDir: dir });

  assert.equal(store.loadVerifiedSnapshot(s.snapshot_id, { storeDir: dir }).valid, true);

  // Tamper: inflate the published score without updating the digest.
  const file = path.join(dir, s.snapshot_id + '.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.top20[0].score = 99.9;
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8');

  const verified = store.loadVerifiedSnapshot(s.snapshot_id, { storeDir: dir });
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, 'CONTENT_HASH_MISMATCH');
});

test('store: a missing artifact is reported, never served as truth', () => {
  const dir = tmpStoreDir();
  const res = store.loadVerifiedSnapshot('SP-2026-11-09-doesnotexist', { storeDir: dir });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'SNAPSHOT_FILE_MISSING');
  assert.equal(res.snapshot, null);
});

test('store: publishing different content under an existing id throws', () => {
  const dir = tmpStoreDir();
  const s = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  store.publishSnapshot(s, { storeDir: dir });

  const forged = Object.assign({}, s, {
    snapshot_content_hash: 'f'.repeat(64)
  });
  assert.throws(() => store.publishSnapshot(forged, { storeDir: dir }),
    /SNAPSHOT_ID_CONTENT_MISMATCH/);
});

/* -------------------------------------------------------------------------- */
/* 4. Superseded snapshots must not be published as current                   */
/* -------------------------------------------------------------------------- */
test('store: isSuperseded flags an older revision of the same session', () => {
  const dir = tmpStoreDir();
  const v1 = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  const v2 = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBCA', { bandar_score: 44 })],
    { sessionDate: SESSION }
  );
  store.publishSnapshot(v1, { storeDir: dir });
  store.publishSnapshot(v2, { storeDir: dir });

  assert.equal(store.isSuperseded(v1.snapshot_id, { storeDir: dir }), true);
  assert.equal(store.isSuperseded(v2.snapshot_id, { storeDir: dir }), false);

  const latest = store.getLatestRecord({ storeDir: dir, sessionDate: SESSION });
  assert.equal(latest.snapshot_id, v2.snapshot_id);
});

test('consumer: top5-radar refuses to publish picks from a superseded snapshot', () => {
  const dir = tmpStoreDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-radar-'));

  const v1 = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  const v2 = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBCA', { bandar_score: 44 })],
    { sessionDate: SESSION }
  );
  store.publishSnapshot(v1, { storeDir: dir });
  store.publishSnapshot(v2, { storeDir: dir });

  // Simulate a producer document that still points at the OLD revision.
  const doc = {
    market_date: SESSION,
    trade_date: SESSION,
    short_swing: v1.top20,
    short_swing_meta: {
      snapshot_id: v1.snapshot_id,
      snapshot_content_hash: v1.snapshot_content_hash,
      session_date: SESSION,
      score_version: v1.score_version,
      universe: v1.universe,
      row_digests: v1.row_digests,
      ranking: v1.ranking
    }
  };
  const sourceFile = path.join(dataDir, 'screener-latest.json');
  fs.writeFileSync(sourceFile, JSON.stringify(doc, null, 2), 'utf8');

  const out = runRadarOnFile(sourceFile, dataDir, dir);
  assert.equal(out.data_status, 'NOT_PUBLISHED');
  assert.equal(out.status_reason, 'SNAPSHOT_SUPERSEDED_BY_NEWER_REVISION');
  assert.equal(out.picks.length, 0, 'a superseded snapshot must not publish actionable picks');
  assert.equal(out.top5.length, 0);
  assert.equal(out.top20.length, 0);
  assert.equal(out.snapshot_superseded, true);
});

test('consumer: top5-radar rejects a tampered pool row (content-hash mismatch)', () => {
  const dir = tmpStoreDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-radar-'));

  const v1 = engine.buildSahamPotensialSnapshot([freshCandidate('BBCA')], { sessionDate: SESSION });
  store.publishSnapshot(v1, { storeDir: dir });

  const tamperedRows = v1.top20.map((r) => Object.assign({}, r, { score: 99.9 }));
  const doc = {
    market_date: SESSION,
    trade_date: SESSION,
    short_swing: tamperedRows,
    short_swing_meta: {
      snapshot_id: v1.snapshot_id,
      snapshot_content_hash: v1.snapshot_content_hash,
      session_date: SESSION,
      score_version: v1.score_version,
      universe: v1.universe,
      row_digests: v1.row_digests,
      ranking: v1.ranking
    }
  };
  const sourceFile = path.join(dataDir, 'screener-latest.json');
  fs.writeFileSync(sourceFile, JSON.stringify(doc, null, 2), 'utf8');

  const out = runRadarOnFile(sourceFile, dataDir, dir);
  assert.equal(out.data_status, 'VALIDATION_FAILED');
  assert.match(out.status_reason, /SNAPSHOT_ROW_TAMPERED_BBCA/);
  assert.equal(out.picks.length, 0);
});

test('consumer: top5-radar rejects the deprecated swing alias (P0-09 gate)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-radar-'));
  const doc = {
    market_date: SESSION,
    trade_date: SESSION,
    swing_alias_deprecated: true,
    swing: [freshCandidate('BBCA')]
  };
  const sourceFile = path.join(dataDir, 'screener-latest.json');
  fs.writeFileSync(sourceFile, JSON.stringify(doc, null, 2), 'utf8');

  const out = runRadarOnFile(sourceFile, dataDir, tmpStoreDir());
  assert.equal(out.data_status, 'NOT_PUBLISHED');
  assert.match(out.status_reason, /DEPRECATED_SWING_ALIAS_REJECTED/);
  assert.equal(out.picks.length, 0);
  assert.equal(out.top20.length, 0);
});

test('consumer: top5-radar publishes the canonical pool and stamps the producer id', () => {
  const dir = tmpStoreDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-radar-'));

  const v1 = engine.buildSahamPotensialSnapshot(
    [freshCandidate('BBCA'), freshCandidate('BBRI', { last_price: 4000, entry_low: 3900, entry_high: 4050, sl: 3700, tp1: 4700 })],
    { sessionDate: SESSION }
  );
  store.publishSnapshot(v1, { storeDir: dir });

  const doc = {
    market_date: SESSION,
    trade_date: SESSION,
    short_swing: v1.top20,
    short_swing_meta: {
      snapshot_id: v1.snapshot_id,
      snapshot_content_hash: v1.snapshot_content_hash,
      session_date: SESSION,
      score_version: v1.score_version,
      universe: v1.universe,
      row_digests: v1.row_digests,
      ranking: v1.ranking
    }
  };
  const sourceFile = path.join(dataDir, 'screener-latest.json');
  fs.writeFileSync(sourceFile, JSON.stringify(doc, null, 2), 'utf8');

  const out = runRadarOnFile(sourceFile, dataDir, dir);
  assert.equal(out.snapshot_id, v1.snapshot_id, 'published id must be the producer canonical id');
  assert.equal(out.snapshot_content_hash, v1.snapshot_content_hash);
  assert.equal(out.snapshot_id_match, true);
  assert.equal(out.store_verified, true);
  assert.equal(out.top5.length, Math.min(5, out.top20.length));
  for (let i = 0; i < out.top5.length; i++) {
    assert.deepEqual(out.top5[i], out.top20[i], 'top5 must equal top20[0..n]');
  }
  for (const row of out.top20) {
    assert.equal(row.snapshot_id, v1.snapshot_id);
  }
});

/**
 * Run the REAL `scripts/top5-radar.js` in a child process against a synthetic
 * source file / output dir / snapshot store, via its documented env seams
 * (V6_RADAR_SOURCE / V6_RADAR_OUTDIR / V6_RADAR_STORE). Exercising the actual
 * runner — not a reimplementation — is what makes these consumer-contract
 * assertions meaningful.
 */
function runRadarOnFile(sourceFile, dataDir, storeDir) {
  const { execFileSync } = require('node:child_process');
  const runnerPath = path.join(__dirname, '..', 'scripts', 'top5-radar.js');
  execFileSync(process.execPath, [runnerPath], {
    stdio: 'pipe',
    env: Object.assign({}, process.env, {
      V6_RADAR_SOURCE: sourceFile,
      V6_RADAR_OUTDIR: dataDir,
      V6_RADAR_STORE: storeDir
    })
  });
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'top5-radar.json'), 'utf8'));
}

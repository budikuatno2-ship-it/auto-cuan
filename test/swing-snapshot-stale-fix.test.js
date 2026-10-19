'use strict';

/**
 * Regression: Swing Konglo / Non-Konglo frozen at STALE_SNAPSHOT since
 * 2026-10-05 (snapshot market_date stuck at 2026-09-30).
 *
 * Two independent technical faults combined:
 *
 *   A. PATH: lib/daily-history-sqlite-sync.js resolved the candle directory
 *      from process.cwd(). Cron invokes tools/run-daily-market-update.js by
 *      absolute path with no `cd`, so cwd is /home/ubuntu and the sync looked
 *      for /home/ubuntu/data/daily-candles (nonexistent) → no_candles_found →
 *      SQLite stock_daily_history stalled at 2026-09-29 → the nightly
 *      screener coverage gate saw < 95% and deferred → the producer never ran
 *      Phase 8 → data/screener-latest.json was never rewritten.
 *
 *   B. FRESHNESS: the stale snapshot file still carried a legacy top-level
 *      `market_date: 2026-09-30` from the pre-schema-v2 format. The current
 *      builder never writes that field, so it froze forever. The freshness
 *      gate read it before anything else and reported STALE_SNAPSHOT even
 *      though the file's own updated_at was current.
 *
 * Both are technical (path + format migration), not business logic. Score,
 * gate and Top 5 are untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const freshness = require('../lib/snapshot-freshness');
const historySync = require('../lib/daily-history-sqlite-sync');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// A. Candle directory must be repo-anchored, never cwd-anchored
// ---------------------------------------------------------------------------
test('candle dir resolves from the repo, not process.cwd()', () => {
  const savedCwd = process.cwd();
  const savedEnv = process.env.CANDLE_CACHE_DIR;
  delete process.env.CANDLE_CACHE_DIR;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-cwd-'));
  try {
    // Simulate the cron invocation: cwd is the home dir, no `cd` into the repo.
    process.chdir(tmp);
    const resolved = historySync.defaultCandleDir();
    assert.equal(
      path.resolve(resolved),
      path.resolve(ROOT, 'data', 'daily-candles'),
      'candle dir must be <repo>/data/daily-candles regardless of cwd'
    );
    assert.notEqual(
      path.resolve(resolved),
      path.resolve(tmp, 'data', 'daily-candles'),
      'candle dir must NOT be cwd-relative (that path does not exist under cron)'
    );
  } finally {
    process.chdir(savedCwd);
    if (savedEnv === undefined) delete process.env.CANDLE_CACHE_DIR;
    else process.env.CANDLE_CACHE_DIR = savedEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CANDLE_CACHE_DIR still wins when explicitly configured', () => {
  const saved = process.env.CANDLE_CACHE_DIR;
  const custom = path.join(os.tmpdir(), 'autocuan-explicit-candles');
  try {
    process.env.CANDLE_CACHE_DIR = custom;
    assert.equal(path.resolve(historySync.defaultCandleDir()), path.resolve(custom));
  } finally {
    if (saved === undefined) delete process.env.CANDLE_CACHE_DIR;
    else process.env.CANDLE_CACHE_DIR = saved;
  }
});

// ---------------------------------------------------------------------------
// B. A schema-v2 snapshot must ignore its legacy top-level date fields
// ---------------------------------------------------------------------------
test('schema-v2 snapshot ignores a stale legacy market_date', () => {
  const snapshot = {
    freshness_schema_version: 2,
    source_dates: { 'swing-konglo': '2026-10-19' },
    updated_at: '2026-10-19T11:00:00.000Z',
    market_date: '2026-09-30', // legacy leftover, NOT authoritative
    run_date: '2026-09-30',
    trade_date: '2026-09-30'
  };
  assert.equal(freshness.isSchemaV2(snapshot), true);
  const extracted = freshness.extractSnapshotDate(snapshot);
  assert.equal(extracted.field, 'updated_at', 'legacy market_date must be skipped');
  assert.equal(extracted.date, '2026-10-19');
});

test('a legacy (pre-schema-v2) snapshot still honours market_date', () => {
  const snapshot = {
    market_date: '2026-09-30',
    updated_at: '2026-10-19T11:00:00.000Z'
  };
  assert.equal(freshness.isSchemaV2(snapshot), false);
  const extracted = freshness.extractSnapshotDate(snapshot);
  assert.equal(extracted.field, 'market_date', 'legacy snapshots keep the old precedence');
  assert.equal(extracted.date, '2026-09-30');
});

test('source_dates alone (without the version flag) counts as schema v2', () => {
  const snapshot = {
    source_dates: { 'swing-non-konglo': '2026-10-19' },
    updated_at: '2026-10-19T11:00:00.000Z',
    market_date: '2026-09-30'
  };
  assert.equal(freshness.isSchemaV2(snapshot), true);
  assert.equal(freshness.extractSnapshotDate(snapshot).field, 'updated_at');
});

test('a stale legacy market_date can no longer force STALE_SNAPSHOT on a v2 snapshot', () => {
  // 2026-10-19 is a Monday trading day. The per-mode source date is supplied
  // by the caller (run-screener) from source_dates, which is authoritative.
  const snapshot = {
    freshness_schema_version: 2,
    source_dates: { 'swing-konglo': '2026-10-19' },
    updated_at: '2026-10-19T11:00:00.000Z',
    market_date: '2026-09-30'
  };
  const result = freshness.evaluateSnapshotFreshness({
    snapshot,
    snapshotDate: snapshot.source_dates['swing-konglo'],
    mode: 'swing-konglo',
    now: new Date('2026-10-19T12:15:00Z')
  });
  assert.equal(result.fresh, true);
  assert.equal(result.reason, 'fresh');
  assert.equal(result.snapshot_date, '2026-10-19');
  assert.equal(result.snapshot_date_field, 'snapshotDate');
});

test('the old behaviour is still reachable for a genuinely stale v2 source date', () => {
  const snapshot = {
    freshness_schema_version: 2,
    source_dates: { 'swing-konglo': '2026-09-30' },
    updated_at: '2026-10-19T11:00:00.000Z',
    market_date: '2026-09-30'
  };
  const result = freshness.evaluateSnapshotFreshness({
    snapshot,
    snapshotDate: snapshot.source_dates['swing-konglo'],
    mode: 'swing-konglo',
    now: new Date('2026-10-19T12:15:00Z')
  });
  assert.equal(result.fresh, false, 'a genuinely stale source date must still be blocked');
  assert.equal(result.reason, 'STALE_SNAPSHOT');
});

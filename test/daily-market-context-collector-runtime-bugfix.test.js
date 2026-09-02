'use strict';

/**
 * Regression tests for the three live-runtime bugs found on a controlled
 * VPS collector run:
 *   BUG 1 — wrapper/CLI argument handling swallowed an explicit ticker list
 *           because the wrapper always forwarded AUTO_CUAN_COLLECTOR_TICKERS
 *           (even when empty) as the FIRST positional arg, shifting the
 *           real ticker list to argv[1] where parseArgs never looked.
 *   BUG 2 — the default eligible universe (lib/daytrade-full-eligible-universe.js)
 *           returns an array of full row OBJECTS (`{ ticker, board, ... }`),
 *           not plain ticker strings. resolveTickers() passed that straight
 *           through, so every downstream "ticker" was actually an object.
 *   BUG 3 — buildFeatureSnapshotsForTickers always built a
 *           stock_daily_features row per requested ticker, even when that
 *           ticker had zero rows in stock_daily_history, producing
 *           as_of_trade_date = null and violating the NOT NULL constraint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const { parseArgs, resolveTickers, normalizeTickerList, run } = require('../scripts/collect-daily-market-context');
const { makeFakeSupabase } = require('./helpers/fake-supabase');

// ------------------------------------------------------------
// BUG 1 — parseArgs robustness (JS-side defense-in-depth)
// ------------------------------------------------------------

test('BUG1: an empty leading argv entry cannot hide a real ticker list positioned after it', () => {
  const result = parseArgs(['', 'BBCA,BBRI,TLKM']);
  assert.deepEqual(result.argTickers, ['BBCA', 'BBRI', 'TLKM']);
});

test('BUG1: an explicit CLI ticker list as the sole/first arg resolves to exactly those tickers', () => {
  const result = parseArgs(['BBCA,BBRI,TLKM']);
  assert.deepEqual(result.argTickers, ['BBCA', 'BBRI', 'TLKM']);
  assert.equal(result.argTickers.length, 3);
});

test('BUG1: --dry-run flag is recognized regardless of position relative to an empty leading arg', () => {
  const result = parseArgs(['', 'BBCA,BBRI,TLKM', '--dry-run']);
  assert.equal(result.isDryRun, true);
  assert.deepEqual(result.argTickers, ['BBCA', 'BBRI', 'TLKM']);
});

// ------------------------------------------------------------
// BUG 1 — wrapper-level end-to-end test (not just JS parseArgs)
// ------------------------------------------------------------

function makeStubNodeBin(dir) {
  const argsLogPath = path.join(dir, 'argv.json');
  const stubPath = path.join(dir, 'stub-node.sh');
  fs.writeFileSync(stubPath,
    '#!/usr/bin/env bash\n' +
    'shift\n' + // drop the RUNNER_JS path argv[0], keep the rest
    'printf \'%s\\n\' "$@" | node -e "process.stdout.write(JSON.stringify(require(\'fs\').readFileSync(0,\'utf8\').split(String.fromCharCode(10)).filter(Boolean)))" > "' + argsLogPath + '"\n' +
    'exit 0\n'
  );
  fs.chmodSync(stubPath, 0o755);
  return { stubPath, argsLogPath };
}

const hasBash = (() => {
  try {
    const { execSync } = require('node:child_process');
    execSync('bash --version', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

function runWrapper(extraArgs, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-test-'));
  const { stubPath, argsLogPath } = makeStubNodeBin(dir);
  // AUTO_CUAN_REPO points at this real repo checkout, so the wrapper's
  // existence check on scripts/collect-daily-market-context.js passes
  // against the real file — but AUTO_CUAN_NODE_BIN is our stub, so that
  // real file is never actually executed by real Node; only its path
  // string and the forwarded argv matter for this test.
  const repoRoot = path.resolve(__dirname, '..');
  const wrapperPath = path.resolve(__dirname, '..', 'deploy', 'vps', 'run-daily-market-context-collector.sh');

  execFileSync('bash', [wrapperPath, ...extraArgs], {
    env: Object.assign({}, process.env, {
      AUTO_CUAN_REPO: repoRoot,
      AUTO_CUAN_RUNNER_DIR: dir,
      AUTO_CUAN_NODE_BIN: stubPath,
      PATH: process.env.PATH
    }, env || {}),
    stdio: ['ignore', 'ignore', 'ignore']
  });

  return JSON.parse(fs.readFileSync(argsLogPath, 'utf8'));
}

test('BUG1 (wrapper): explicit CLI ticker list reaches Node as a single clean arg, no empty slot ahead of it', { skip: !hasBash }, () => {
  // The wrapper resolves RUNNER_JS as $REPO/scripts/collect-daily-market-context.js,
  // which exists in this repo, so no extra setup is needed beyond AUTO_CUAN_REPO.
  const argv = runWrapper(['BBCA,BBRI,TLKM']);
  assert.deepEqual(argv, ['BBCA,BBRI,TLKM']);
});

test('BUG1 (wrapper): AUTO_CUAN_COLLECTOR_TICKERS env var is forwarded when no CLI ticker arg is given', { skip: !hasBash }, () => {
  const argv = runWrapper([], { AUTO_CUAN_COLLECTOR_TICKERS: 'BBCA,TLKM' });
  assert.deepEqual(argv, ['BBCA,TLKM']);
});

test('BUG1 (wrapper): explicit CLI ticker arg takes precedence over the env var', { skip: !hasBash }, () => {
  const argv = runWrapper(['UNVR,ASII'], { AUTO_CUAN_COLLECTOR_TICKERS: 'BBCA,TLKM' });
  assert.deepEqual(argv, ['UNVR,ASII']);
});

test('BUG1 (wrapper): no CLI arg and no env var forwards no ticker-list positional at all', { skip: !hasBash }, () => {
  const argv = runWrapper([]);
  assert.deepEqual(argv, []);
});

test('BUG1 (wrapper): --dry-run passes through cleanly with an explicit ticker list', { skip: !hasBash }, () => {
  const argv = runWrapper(['BBCA,BBRI,TLKM', '--dry-run']);
  assert.deepEqual(argv, ['BBCA,BBRI,TLKM', '--dry-run']);
});

// ------------------------------------------------------------
// Follow-up review finding: the ticker positional must be found ANYWHERE
// in argv, not just at $1 — a flag placed before the ticker list (e.g.
// `--dry-run BBCA,BBRI,TLKM`) must not cause the env var (or nothing) to
// win instead of the explicit CLI list.
// ------------------------------------------------------------

test('BUG1 (wrapper): `--dry-run BBCA,BBRI,TLKM` (flag BEFORE the ticker list) still resolves to the explicit tickers + dry-run', { skip: !hasBash }, () => {
  const argv = runWrapper(['--dry-run', 'BBCA,BBRI,TLKM']);
  // The wrapper may reorder (ticker first, flags preserved after), but the
  // resulting argv must still be exactly what parseArgs resolves to the
  // explicit 3-ticker list with dry-run enabled.
  const parsed = parseArgs(argv);
  assert.equal(parsed.isDryRun, true);
  assert.deepEqual(parsed.argTickers, ['BBCA', 'BBRI', 'TLKM']);
  assert.equal(argv.filter((a) => a === '--dry-run').length, 1); // not duplicated
  assert.equal(argv.filter((a) => a === 'BBCA,BBRI,TLKM').length, 1); // not dropped
});

test('BUG1 (wrapper): explicit CLI ticker list (flag before it) wins over AUTO_CUAN_COLLECTOR_TICKERS', { skip: !hasBash }, () => {
  const argv = runWrapper(['--dry-run', 'BBCA,BBRI,TLKM'], { AUTO_CUAN_COLLECTOR_TICKERS: 'ASII' });
  const parsed = parseArgs(argv);
  assert.equal(parsed.isDryRun, true);
  assert.deepEqual(parsed.argTickers, ['BBCA', 'BBRI', 'TLKM']);
  assert.ok(!argv.includes('ASII'));
});

test('BUG1 (wrapper): with only --dry-run and no explicit ticker, the env var is used and dry-run remains enabled', { skip: !hasBash }, () => {
  const argv = runWrapper(['--dry-run'], { AUTO_CUAN_COLLECTOR_TICKERS: 'ASII' });
  const parsed = parseArgs(argv);
  assert.equal(parsed.isDryRun, true);
  assert.deepEqual(parsed.argTickers, ['ASII']);
});

// ------------------------------------------------------------
// BUG 2 — universe normalization at the collector boundary
// ------------------------------------------------------------

test('BUG2: normalizeTickerList converts row objects ({ticker: "BBCA", ...}) to plain ticker strings', () => {
  const rows = [{ ticker: 'BBCA', board: 'Utama' }, { ticker: 'bbri', board: 'Utama' }];
  assert.deepEqual(normalizeTickerList(rows), ['BBCA', 'BBRI']);
});

test('BUG2: normalizeTickerList never coerces a malformed object via String() (no "[object Object]")', () => {
  const malformed = [{ notATicker: 'x' }, { ticker: 123 }, {}, null, undefined, 42, ''];
  const result = normalizeTickerList(malformed);
  assert.deepEqual(result, []);
  assert.ok(!result.some((t) => t.includes('OBJECT')));
});

test('BUG2: normalizeTickerList deduplicates (case-insensitive) while preserving first-seen order', () => {
  const mixed = ['BBCA', { ticker: 'bbca' }, 'TLKM', 'tlkm', { ticker: 'TLKM' }];
  assert.deepEqual(normalizeTickerList(mixed), ['BBCA', 'TLKM']);
});

test('BUG2: resolveTickers accepts an explicit plain-string ticker list unchanged (order/dedupe preserved)', async () => {
  const result = await resolveTickers(['BBCA', 'BBRI', 'TLKM']);
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});

test('BUG2: resolveTickers normalizes an explicit object-shaped ticker list (defensive — same boundary fix)', async () => {
  const result = await resolveTickers([{ ticker: 'BBCA' }, { ticker: 'bbri' }, { notATicker: true }, null]);
  assert.deepEqual(result, ['BBCA', 'BBRI']);
});

test('BUG2: resolveTickers falls back to the full eligible universe and normalizes its row-object shape', async () => {
  const universe = require('../lib/daytrade-full-eligible-universe');
  const original = universe.loadFullEligibleUniverseFromSupabase;
  universe.loadFullEligibleUniverseFromSupabase = async () => ({
    tickers: [
      { ticker: 'AADI', board: 'Utama' },
      { ticker: 'bbca', board: 'Utama' },
      { notATicker: 'garbage' },
      null
    ]
  });
  try {
    const result = await resolveTickers([]);
    assert.deepEqual(result, ['AADI', 'BBCA']);
  } finally {
    universe.loadFullEligibleUniverseFromSupabase = original;
  }
});

// ------------------------------------------------------------
// BUG 3 — never persist a feature row without history
// ------------------------------------------------------------

function historyRow(ticker, trade_date, close, volume) {
  return { ticker, trade_date, open: close, high: close, low: close, close, previous_close: null, volume,
    data_source: 'yahoo', data_quality_status: 'ok' };
}

test('BUG3: a ticker with no history produces NO stock_daily_features row', async () => {
  const builder = require('../lib/daily-market-context-builder');
  const supabase = makeFakeSupabase({ stock_daily_history: [] });
  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['NOHIST'], {});
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.skippedTickers, ['NOHIST']);
});

test('BUG3: mixed batch — ticker with history builds, ticker without history is skipped, both reported', async () => {
  const builder = require('../lib/daily-market-context-builder');
  const supabase = makeFakeSupabase({ stock_daily_history: [historyRow('BBCA', '2026-08-11', 9500, 1000)] });
  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA', 'NOHIST'], {});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].ticker, 'BBCA');
  assert.deepEqual(result.skippedTickers, ['NOHIST']);
});

test('BUG3: as_of_trade_date is never null in any row passed to upsertDailyFeatures', async () => {
  const builder = require('../lib/daily-market-context-builder');
  const historyStore = require('../lib/stock-daily-history-store');
  const supabase = makeFakeSupabase({ stock_daily_history: [historyRow('BBCA', '2026-08-11', 9500, 1000)] });

  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA', 'GHOST'], {});
  result.rows.forEach((row) => assert.notEqual(row.as_of_trade_date, null));

  await historyStore.upsertDailyFeatures(supabase, result.rows);
  supabase._tables.stock_daily_features.forEach((row) => assert.notEqual(row.as_of_trade_date, null));
  assert.equal(supabase._tables.stock_daily_features.length, 1);
});

test('BUG3: upsertDailyFeatures defensively drops a malformed row (null as_of_trade_date) without failing the batch', async () => {
  const historyStore = require('../lib/stock-daily-history-store');
  const supabase = makeFakeSupabase();
  const rows = [
    { ticker: 'BBCA', as_of_trade_date: '2026-08-11', last_price: 9500 },
    { ticker: 'GHOST', as_of_trade_date: null, last_price: null } // should never happen post-fix, but must not poison the batch
  ];
  const upserted = await historyStore.upsertDailyFeatures(supabase, rows);
  assert.equal(upserted, 1);
  assert.equal(supabase._tables.stock_daily_features.length, 1);
  assert.equal(supabase._tables.stock_daily_features[0].ticker, 'BBCA');
});

test('BUG3: one bad ticker does not block a good ticker through the full collect+build+upsert pipeline', async () => {
  const collector = require('../lib/daily-history-collector');
  const builder = require('../lib/daily-market-context-builder');
  const historyStore = require('../lib/stock-daily-history-store');
  const supabase = makeFakeSupabase();

  const fetchFn = async (ticker) => {
    if (ticker === 'FAILS') return null; // insufficient/failed fetch -> no history row ever written
    const candles = [];
    for (let i = 0; i < 25; i++) candles.push({ date: '2026-07-' + String(i + 1).padStart(2, '0'), open: 100, high: 101, low: 99, close: 100 + i, volume: 1000 });
    return candles;
  };

  await collector.collectDailyHistoryForTickers(supabase, ['BBCA', 'FAILS'], { fetchFn });
  const featureResult = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA', 'FAILS'], {});
  const upserted = await historyStore.upsertDailyFeatures(supabase, featureResult.rows);

  assert.equal(upserted, 1);
  assert.deepEqual(featureResult.skippedTickers, ['FAILS']);
  assert.equal(supabase._tables.stock_daily_features[0].ticker, 'BBCA');
});

// ------------------------------------------------------------
// End-to-end: run() with the full bug set exercised together
// ------------------------------------------------------------

test('run(): --dry-run with the explicit 3-ticker CLI arg resolves to exactly 3 tickers', async () => {
  const result = await run(['BBCA,BBRI,TLKM', '--dry-run'], { supabaseUrl: '', supabaseKey: '' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.tickerCount, 3);
});

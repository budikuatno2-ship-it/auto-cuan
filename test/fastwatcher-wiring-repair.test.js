'use strict';

// BUG-3C-01 regression — FastWatcher production wiring.
//
// Invariant: the production cron wrapper must reach the canonical dedicated
// intraday FastWatcher engine (lib/intraday-fast-watcher-guarded-live.js via
// tools/run-intraday-fast-watcher-guarded-live.js), NOT the obsolete
// `run-screener.js --mode=fastwatcher` consumer that read a snapshot key the
// EOD producer never writes (always 0 candidates).
//
// Every test here is offline: no Telegram, no real market provider, no VPS.
// The engine is exercised through its documented dependency-injection surface
// (fake engine/collector/notifyFn) or by source/wiring assertions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guarded = require('../lib/intraday-fast-watcher-guarded-live');
const materializer = require('../tools/materialize-fastwatcher-shortlist');

const ROOT = path.resolve(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-wiring-'));
}

function fixtureObservation(ticker, time, extra) {
  return Object.assign({
    ticker,
    scheduled_time: time,
    current_price: 100,
    entry_low: 98,
    entry_high: 103,
    tp1: 119,
    stop_loss: 95,
    current_status: 'A_PLUS_SETUP',
    volume: 1000,
    average_volume: 700,
    relative_volume: 1.1,
    momentum_component: 14,
    liquidity_component: 16,
    risk_reward: 2,
    high: 103,
    low: 98,
    freshness: { is_stale: false }
  }, extra || {});
}

function fakeCollector() {
  return {
    checkProductionWorkerActive: async () => ({ active: false }),
    fetchWithFreshnessFallback: async () => ({ candles: [], freshness: { is_stale: false } }),
    buildCandidateRecord: (result, time) => fixtureObservation(result.ticker, time, {
      current_price: result.last_price,
      volume: result.volume_today,
      relative_volume: result.volume_ratio_20d,
      score: result.daytrade_score
    }),
    deriveDistances: (row) => row,
    sanitizeRecord: (row) => row
  };
}

function fakeEngineWithSetup() {
  let run = 0;
  return {
    runDayTradeBatch: async (batch) => ({
      results: batch.map((item) => {
        run += 1;
        return {
          ticker: item.ticker,
          last_price: run === 1 ? 100 : 101,
          entry_low: 98,
          entry_high: 105,
          tp1: 119,
          stop_loss: 95,
          status: 'A_PLUS_SETUP',
          daytrade_score: 75,
          volume_today: run === 1 ? 1000 : 2200,
          avg_volume_20d: 700,
          volume_ratio_20d: run === 1 ? 1.2 : 2.4,
          momentum_score: 14,
          liquidity_score: 16,
          risk_reward: 2,
          high_price: 105,
          low_price: 98
        };
      }),
      failed: []
    })
  };
}

function engineDeps(root, shortlistFile, engine) {
  return {
    sampleDate: '2026-10-02',
    shortlistFile,
    stateDir: path.join(root, 'state'),
    eventDir: path.join(root, 'events'),
    observationRoot: path.join(root, 'obs'),
    publishedDir: path.join(root, 'published'),
    env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1' },
    engine,
    collector: fakeCollector(),
    checkProductionWorkerActive: async () => ({ active: false }),
    loadSupplemental: async () => [],
    publishConfirmed: async () => ({ system_published: 0, telegram_sent: 0, telegram_attempted: false }),
    readPayload: async () => JSON.parse(fs.readFileSync(shortlistFile, 'utf8'))
  };
}

function executableLines(source) {
  // Comments may legitimately DOCUMENT the removed bug; only executable lines
  // must be free of the obsolete wiring.
  return source.split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

test('FW-01: production wrapper resolves to the canonical FastWatcher engine, not the obsolete snapshot consumer', () => {
  const wrapper = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-fastwatcher.sh'), 'utf8');
  const executable = executableLines(wrapper);

  assert.match(executable, /tools\/run-intraday-fast-watcher-guarded-live\.js/,
    'wrapper must invoke the canonical dedicated intraday engine');
  assert.match(executable, /tools\/materialize-fastwatcher-shortlist\.js/,
    'wrapper must materialize the shortlist the engine consumes');
  assert.doesNotMatch(executable, /tools\/run-screener\.js/,
    'wrapper must not use the obsolete run-screener --mode=fastwatcher path');
  assert.doesNotMatch(executable, /--mode=fastwatcher/,
    'the impossible snapshot-key contract must be gone from the wrapper');

  // The EOD dispatch wrapper must no longer attempt a FastWatcher dispatch.
  const dispatch = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-screener-dispatch.sh'), 'utf8');
  assert.doesNotMatch(executableLines(dispatch), /--mode=fastwatcher/,
    'EOD dispatch must not invoke the obsolete fastwatcher snapshot mode');

  // The cron cadence must remain the 5-minute live-bursa window.
  const cron = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8');
  assert.match(cron, /\*\/5 9-15 \* \* 1-5 \/home\/ubuntu\/auto-cuan\/deploy\/vps\/run-fastwatcher\.sh --send/,
    'cron cadence and --send must be preserved');
});

test('FW-02: a valid FastWatcher setup in the materialized fixture produces >= 1 confirmed candidate', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');
  fs.writeFileSync(shortlistFile, JSON.stringify({
    status: 'published',
    source: 'fixture',
    results: [{ ticker: 'PADA', score: 80, board: 'UTAMA' }]
  }));

  try {
    const deps = engineDeps(root, shortlistFile, fakeEngineWithSetup());
    const first = await guarded.run(Object.assign({}, deps, { scheduledTime: '09:10' }));
    assert.equal(first.status, 'guarded_live_recorded');
    assert.equal(first.shortlist_count, 1, 'the fixture shortlist must reach the engine');
    assert.equal(first.active_pool_count, 1);

    // The pool requires 3 distinct confirmation minutes (3-of-5 window).
    await guarded.run(Object.assign({}, deps, { scheduledTime: '09:12' }));
    const third = await guarded.run(Object.assign({}, deps, { scheduledTime: '09:14' }));
    assert.equal(third.confirmed.length, 1, 'three distinct confirmations must confirm the candidate');
    assert.equal(third.publishable.length, 1);
    assert.equal(third.confirmed[0].ticker, 'PADA');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FW-03: no setup in the fixture produces 0 candidates for a REAL screening reason, not a missing-key contract', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');
  // Empty daemon answer materialized by the real tool shape.
  fs.writeFileSync(shortlistFile, JSON.stringify({
    status: 'published',
    source: 'fixture',
    results: []
  }));

  try {
    const deps = engineDeps(root, shortlistFile, fakeEngineWithSetup());
    const result = await guarded.run(Object.assign({}, deps, { scheduledTime: '09:10' }));
    assert.equal(result.status, 'empty_shortlist', 'zero candidates must come from an empty real shortlist');
    assert.equal(result.shortlist_count, 0);
    assert.equal(result.telegram_sent || 0, 0);

    // The obsolete failure mode was different: a non-empty snapshot that had
    // no fastwatcher key. Prove the new contract is structural, not key-based.
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const legacySnapshot = path.join(root, 'data', 'screener-latest.json');
    fs.writeFileSync(legacySnapshot, JSON.stringify({
      daytrade: [{ ticker: 'BBCA' }],
      swing: [{ ticker: 'BBRI' }],
      updated_at: '2026-10-02T09:30:06.606Z'
    }));
    const runner = require('../tools/run-screener');
    const legacyReport = runner.analyze(
      { mode: 'fastwatcher', dryRun: true, send: false, json: false },
      { rootDir: root, env: {}, now: new Date('2026-10-02T04:00:00Z') }
    );
    assert.equal(legacyReport.candidate_count, 0);
    assert.ok(legacyReport.reasons.some((r) => r.indexOf('no_candidates') === 0),
      'legacy snapshot contract still reports no_candidates (diagnostic mode only)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FW-04: out-of-session execution is blocked by the engine market window', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');
  fs.writeFileSync(shortlistFile, JSON.stringify({
    status: 'published', source: 'fixture', results: [{ ticker: 'PADA' }]
  }));
  try {
    const deps = engineDeps(root, shortlistFile, fakeEngineWithSetup());
    const late = await guarded.run(Object.assign({}, deps, { scheduledTime: '17:30' }));
    assert.equal(late.status, 'invalid_input');
    assert.equal(late.error_code, 'outside_supported_market_window');
    const breakTime = await guarded.run(Object.assign({}, deps, { scheduledTime: '12:30' }));
    assert.equal(breakTime.error_code, 'outside_supported_market_window',
      'Mon-Thu lunch break must not collect observations');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FW-05: local test execution sends no real Telegram request', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');
  fs.writeFileSync(shortlistFile, JSON.stringify({
    status: 'published', source: 'fixture', results: [{ ticker: 'PADA' }]
  }));
  let notifyCalled = false;
  try {
    const deps = engineDeps(root, shortlistFile, fakeEngineWithSetup());
    deps.publishConfirmed = async () => ({ system_published: 0, telegram_sent: 0, telegram_attempted: false });
    deps.notifyFn = async () => { notifyCalled = true; return { sent: true }; };
    // Kill switches OFF (default): live_disabled, nothing reaches any sender.
    const disabled = await guarded.run({
      sampleDate: '2026-10-02', scheduledTime: '09:10', shortlistFile,
      env: {}, notifyFn: deps.notifyFn
    });
    assert.equal(disabled.status, 'live_disabled');
    assert.equal(notifyCalled, false, 'no notification may occur while the kill switch is off');

    // Live enabled but publish kill switch off: still no Telegram.
    const publishOff = await guarded.run(Object.assign({}, deps, {
      scheduledTime: '09:10',
      env: { FAST_WATCHER_LIVE_ENABLED: '1' }
    }));
    assert.equal(publishOff.status, 'guarded_live_recorded');
    assert.equal(publishOff.telegram_sent, 0);
    assert.equal(notifyCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FW-06: Repair A env precedence still applies in run-fastwatcher.sh', () => {
  const wrapper = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-fastwatcher.sh'), 'utf8');
  assert.match(wrapper, /lib\/load-env\.sh/, 'wrapper must source the shared canonical env loader');
  assert.match(wrapper, /load_auto_cuan_env "\$REPO" "\$RUNNER_DIR"/,
    'wrapper must call load_auto_cuan_env (runner .env last, wins)');
});

test('FW-07: materializer builds the engine-accepted contract and skips non-trading days', async () => {
  // Daemon payload → shortlist shape the guarded-live engine accepts.
  const built = materializer.buildShortlist({
    success: true,
    status: 'published',
    results: [{ ticker: 'MMIX', score: 88 }, { ticker: 'AMRT' }]
  }, { runDate: '2026-10-02' });
  assert.equal(built.payload.status, 'published');
  assert.equal(built.payload.run_date, '2026-10-02');
  assert.equal(built.counts.rows, 2);
  assert.deepEqual(built.payload.results.map((r) => r.ticker), ['MMIX', 'AMRT']);

  // A still-running full screener is preserved so the engine can skip it.
  const running = materializer.buildShortlist({ status: 'running' }, { runDate: '2026-10-02' });
  assert.equal(running.payload.status, 'running');
  assert.equal(running.counts.running, true);

  // Saturday (2026-10-03) must skip before any daemon read.
  const skipped = await materializer.main(
    { dryRun: false, print: false, output: path.join(tempDir(), 'out.json') },
    { env: { CRON_SECRET: 'dummy' }, runDate: '2026-10-03', log: () => {} }
  );
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'MARKET_CLOSED');

  // IDX holiday (2026-05-14, Kenaikan Yesus Kristus) must also skip.
  const holiday = await materializer.main(
    { dryRun: false, print: false, output: path.join(tempDir(), 'out.json') },
    { env: { CRON_SECRET: 'dummy' }, runDate: '2026-05-14', log: () => {} }
  );
  assert.equal(holiday.skipped, true);
});

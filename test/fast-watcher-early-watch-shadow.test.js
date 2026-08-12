'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pool = require('../lib/intraday-fast-watcher-pool');
const guarded = require('../lib/intraday-fast-watcher-guarded-live');
const earlyWatch = require('../lib/intraday-fast-watcher-early-watch');
const volumePace = require('../lib/intraday-volume-pace');

function obs(ticker, time, extra) {
  return Object.assign({
    ticker,
    scheduled_time: time,
    current_price: 100,
    entry_low: 98,
    entry_high: 103,
    tp1: 119,
    stop_loss: 95,
    current_status: 'EARLY_RADAR',
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

async function tmpDirs() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-early-watch-'));
  return { stateDir: path.join(root, 'state'), eventDir: path.join(root, 'events') };
}

// ---------------------------------------------------------------------------
// 1-4: capture / idempotency / independence across tickers and dates
// ---------------------------------------------------------------------------

test('first WATCHING creates exactly one Early Watch record', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10', now: '2026-08-12T02:10:00.000Z',
    priorPoolState: null, processedPoolState: processed.state,
    observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.enabled, true);
  assert.equal(result.captured_count, 1);
  const state = JSON.parse(await fsp.readFile(result.state_file, 'utf8'));
  assert.equal(Object.keys(state.tickers).length, 1);
  assert.ok(state.tickers.PADA);
  const eventLines = (await fsp.readFile(result.event_file, 'utf8')).trim().split('\n');
  const firstWatchLines = eventLines.map(line => JSON.parse(line)).filter(row => row.type === 'FIRST_WATCH');
  assert.equal(firstWatchLines.length, 1);
  assert.equal(firstWatchLines[0].ticker, 'PADA');
  assert.equal(firstWatchLines[0].version, 'FAST_WATCHER_EARLY_WATCH_V1');
  assert.equal(firstWatchLines[0].reference_price, 100);
});

test('repeated WATCHING on same ticker/date/version does not duplicate first event', async () => {
  const dirs = await tmpDirs();
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:10')], priorState: null
  });
  const run1 = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: first.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(run1.captured_count, 1);

  const second = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:13',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:13', { current_price: 101 })], priorState: first.state
  });
  const run2 = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:13',
    priorPoolState: first.state, processedPoolState: second.state, observations: [obs('PADA', '09:13', { current_price: 101 })],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(run2.captured_count, 0);
  const eventLines = (await fsp.readFile(run2.event_file, 'utf8')).trim().split('\n');
  const firstWatchLines = eventLines.map(line => JSON.parse(line)).filter(row => row.type === 'FIRST_WATCH');
  assert.equal(firstWatchLines.length, 1);
});

test('another ticker creates independent state', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }, { ticker: 'TLKM', source_rank: 2 }],
    observations: [obs('PADA', '09:10'), obs('TLKM', '09:10', { current_price: 4000 })], priorState: null
  });
  const result = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state,
    observations: [obs('PADA', '09:10'), obs('TLKM', '09:10', { current_price: 4000 })],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.captured_count, 2);
  const state = JSON.parse(await fsp.readFile(result.state_file, 'utf8'));
  assert.equal(state.tickers.PADA.reference_price, 100);
  assert.equal(state.tickers.TLKM.reference_price, 4000);
});

test('next trading date creates a new early event for the same ticker', async () => {
  const dirs = await tmpDirs();
  const day1 = pool.process({
    sampleDate: '2026-08-11', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const run1 = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-11', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: day1.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(run1.captured_count, 1);

  const day2 = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const run2 = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: day2.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(run2.captured_count, 1);
  assert.notEqual(
    earlyWatch.earlyWatchId('2026-08-11', 'PADA'),
    earlyWatch.earlyWatchId('2026-08-12', 'PADA')
  );
});

// ---------------------------------------------------------------------------
// 5-9: feature flag off / 2/2 confirmation untouched
// ---------------------------------------------------------------------------

test('feature OFF causes zero Early Watch side effects', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatchShadow({
    env: {}, sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.enabled, false);
  assert.equal(result.status, 'disabled');
  await assert.rejects(fsp.readFile(path.join(dirs.stateDir, '2026-08-12.json'), 'utf8'));
  await assert.rejects(fsp.readFile(path.join(dirs.eventDir, '2026-08-12.jsonl'), 'utf8'));
});

function confirmationSequence(env) {
  return async () => {
    const dirs = await tmpDirs();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-guarded-2of2-'));
    let run = 0;
    const fakeEngine = {
      runDayTradeBatch: async batch => ({
        results: batch.map(item => {
          run += 1;
          return {
            ticker: item.ticker, last_price: run === 1 ? 100 : 101, entry_low: 98, entry_high: 103,
            tp1: 119, stop_loss: 95, status: 'EARLY_RADAR', daytrade_score: 75,
            volume_today: run === 1 ? 1000 : 1800, avg_volume_20d: 700, volume_ratio_20d: run === 1 ? 1.5 : 1.8,
            momentum_score: 14, liquidity_score: 16, risk_reward: 2, high_price: 103, low_price: 98
          };
        }),
        failed: []
      })
    };
    const fakeCollector = {
      checkProductionWorkerActive: async () => ({ active: false }),
      fetchWithFreshnessFallback: async () => ({ candles: [], freshness: { is_stale: false } }),
      buildCandidateRecord: (r, t) => obs(r.ticker, t, { current_price: r.last_price, volume: r.volume_today, relative_volume: r.volume_ratio_20d, score: r.daytrade_score }),
      deriveDistances: r => r,
      sanitizeRecord: r => r
    };
    const common = {
      sampleDate: '2026-08-12', shortlistFile: 'ignored',
      stateDir: path.join(root, 'state'), eventDir: path.join(root, 'events'),
      observationRoot: path.join(root, 'obs'), publishedDir: path.join(root, 'published'),
      earlyWatchStateDir: dirs.stateDir, earlyWatchEventDir: dirs.eventDir,
      env, readPayload: async () => ({ status: 'published', radar_candidates: ['PADA'] }),
      loadSupplemental: async () => [], engine: fakeEngine, collector: fakeCollector,
      checkProductionWorkerActive: async () => ({ active: false }),
      publishConfirmed: async () => ({ system_published: 1, telegram_sent: 0 })
    };
    const first = await guarded.run({ ...common, scheduledTime: '09:10' });
    assert.equal(first.system_published, 0);
    const second = await guarded.run({ ...common, scheduledTime: '09:13' });
    assert.equal(second.confirmed.length, 1);
    assert.equal(second.system_published, 1);
    return second;
  };
}

test('existing 2/2 behavior is identical with shadow feature OFF', async () => {
  const second = await confirmationSequence({ FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1' })();
  assert.equal(second.early_watch.enabled, false);
});

test('existing 2/2 behavior is identical with shadow feature ON', async () => {
  const second = await confirmationSequence({ FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1', FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' })();
  assert.equal(second.early_watch.enabled, true);
  assert.equal(second.confirmed.length, 1);
  assert.equal(second.system_published, 1);
});

test('Early Watch never changes READY_PENDING transition', () => {
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  assert.equal(first.state.tickers.PADA.status, 'WATCHING');
  const second = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:13',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:13', { current_price: 101, volume: 1700, relative_volume: 1.5 })],
    priorState: first.state
  });
  assert.equal(second.state.tickers.PADA.status, 'READY_PENDING');
});

test('Early Watch never changes READY_CONFIRMED transition', () => {
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const second = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:13',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:13', { current_price: 101, volume: 1700, relative_volume: 1.5 })],
    priorState: first.state
  });
  const third = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:22',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:22', { current_price: 102, volume: 3200, relative_volume: 2 })],
    priorState: second.state
  });
  assert.equal(third.state.tickers.PADA.status, 'READY_CONFIRMED');
});

test('source setup/plan reset in current Fast Watcher still behaves exactly as before', () => {
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:10', { plan_lock_id: 'plan-A' })], priorState: null
  });
  assert.equal(first.state.tickers.PADA.locked_plan_lock_id, 'plan-A');
  const second = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:13',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:13', { plan_lock_id: 'plan-B', current_price: 101 })], priorState: first.state
  });
  assert.ok(second.events.some(event => event.reasons.includes('source_plan_identity_changed_locked_setup_preserved')));
  assert.equal(second.state.tickers.PADA.locked_plan_lock_id, 'plan-A');
});

// ---------------------------------------------------------------------------
// 11-12: persistence beyond pool drop
// ---------------------------------------------------------------------------

test('Early Watch record survives ticker dropping out of the current candidate pool', async () => {
  const dirs = await tmpDirs();
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: first.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });

  // PADA is no longer in the shortlist this run: pool.js evicts it.
  const second = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '10:00',
    shortlistRows: [{ ticker: 'OTHER', source_rank: 1 }],
    observations: [obs('OTHER', '10:00')], priorState: first.state
  });
  assert.equal(second.state.tickers.PADA.status, 'DROPPED_FROM_WATCH_POOL');
  assert.equal(second.state.tickers.PADA.active, false);

  const result = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '10:00',
    priorPoolState: first.state, processedPoolState: second.state, observations: [obs('OTHER', '10:00')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.captured_count, 1); // OTHER captured, PADA not re-captured
  const state = JSON.parse(await fsp.readFile(result.state_file, 'utf8'));
  assert.ok(state.tickers.PADA, 'PADA early-watch record must still exist after pool eviction');
  assert.equal(state.tickers.PADA.still_in_pool, false);
  assert.equal(state.tickers.PADA.tracking_complete, false);
});

test('follow-up tracking continues independently of pool membership', async () => {
  const dirs = await tmpDirs();
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: first.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  // PADA dropped from the pool, but a price sample for it still opportunistically
  // arrives this run (e.g. it briefly re-enters, or another consumer supplies it).
  const dropped = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:40',
    shortlistRows: [{ ticker: 'OTHER', source_rank: 1 }], observations: [obs('OTHER', '09:40')], priorState: first.state
  });
  const result = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:40',
    priorPoolState: first.state, processedPoolState: dropped.state,
    observations: [obs('OTHER', '09:40'), obs('PADA', '09:40', { current_price: 103 })],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  const state = JSON.parse(await fsp.readFile(result.state_file, 'utf8'));
  assert.equal(state.tickers.PADA.checkpoints.next_observation.filled, true);
  assert.equal(state.tickers.PADA.checkpoints.next_observation.price, 103);
  assert.equal(state.tickers.PADA.checkpoints.m30.filled, true); // 09:10 -> 09:40 = 30 active minutes
});

// ---------------------------------------------------------------------------
// 13-15: active-minute session math
// ---------------------------------------------------------------------------

test('active-minute horizons handle the Mon-Thu lunch break correctly', () => {
  // Monday 2026-08-10 (verify day-of-week is a weekday first).
  const elapsed = earlyWatch.activeMinutesElapsed('2026-08-10', '11:50', '13:35');
  // 11:50 -> 12:00 = 10 active minutes, break excluded, 13:30 -> 13:35 = 5 minutes.
  assert.equal(elapsed, 15);
});

test('Friday session timing correctly differs from Mon-Thu', () => {
  const monThu = volumePace.tradingSchedule('2026-08-10');
  const friday = volumePace.tradingSchedule('2026-08-14');
  assert.equal(monThu.total, 330);
  assert.equal(friday.total, 270);
  assert.deepEqual(friday.windows, [{ start: 540, end: 690 }, { start: 840, end: 960 }]);
  // 11:40 is inside the Mon-Thu morning session (ends 12:00) but already past
  // Friday's shorter morning session (ends 11:30), so active minutes freeze
  // at the Friday morning session length (09:00-11:30 = 150 minutes).
  assert.equal(earlyWatch.activeMinutesAt('2026-08-14', '11:40'), 150);
});

test('late-day event becomes session-end censored correctly', async () => {
  const dirs = await tmpDirs();
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '15:50',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '15:50')], priorState: null
  });
  await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '15:50',
    priorPoolState: null, processedPoolState: first.state, observations: [obs('PADA', '15:50')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  const result = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '16:00',
    priorPoolState: first.state, processedPoolState: first.state, observations: [],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.completed_count, 1);
  const eventLines = (await fsp.readFile(result.event_file, 'utf8')).trim().split('\n').map(JSON.parse);
  const completion = eventLines.find(row => row.type === 'TRACKING_COMPLETE');
  assert.equal(completion.completion_reason, 'session_end_censored');
  assert.equal(completion.checkpoints.m60.filled, false);
  assert.equal(completion.checkpoints.m60.reason, 'session_end_censored');
});

// ---------------------------------------------------------------------------
// 16-18: shadow-only safety proofs
// ---------------------------------------------------------------------------

test('Early Watch module never requires Telegram or Supabase clients', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'intraday-fast-watcher-early-watch.js'), 'utf8');
  assert.equal(/require\(['"].*telegram/i.test(source), false);
  assert.equal(/require\(['"]@supabase/i.test(source), false);
  assert.equal(typeof earlyWatch.runEarlyWatchShadow, 'function');
  assert.equal(Object.keys(earlyWatch).some(key => /telegram|supabase/i.test(key)), false);
});

test('no production recommendation registration from Early Watch', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.telegram_attempted, false);
  assert.equal(result.telegram_sent, false);
  assert.equal(result.supabase_write, false);
  assert.equal(result.production_recommendation_registered, false);
  const eventLines = (await fsp.readFile(result.event_file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(eventLines[0].shadow_only, true);
  assert.equal(eventLines[0].telegram_eligible, false);
  assert.equal(eventLines[0].supabase_write, false);
  assert.equal(eventLines[0].production_recommendation, false);
});

// ---------------------------------------------------------------------------
// 19-20: determinism / restart safety
// ---------------------------------------------------------------------------

test('FIRST_WATCH record building is deterministic', () => {
  const item = {
    first_price: 100, first_time: '09:10', source_score: 62, source_status: 'EARLY_RADAR',
    source_origin: 'current_radar', shortlist_rank: 3, locked_plan_lock_id: 'plan-1', locked_setup_id: 'setup-1',
    last_reasons: ['engine_not_ready'], last_metrics: { advance_pct: 0, liquidity_component: 16, momentum_component: 14 },
    last_observation: { candidate_type: 'FAST_WATCHER_MOMENTUM_FLOW', freshness: { is_stale: false } }
  };
  const a = earlyWatch.buildFirstWatchRecord({ sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA', item, now: '2026-08-12T02:10:00.000Z' });
  const b = earlyWatch.buildFirstWatchRecord({ sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA', item, now: '2026-08-12T02:10:00.000Z' });
  assert.deepEqual(a, b);
});

test('restart/idempotency: reloading state from disk prevents duplicate capture', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  // Simulate a fresh process: re-run without any in-memory state, relying purely
  // on what runEarlyWatchShadow reads back from disk.
  const rerun = await earlyWatch.runEarlyWatchShadow({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:11',
    priorPoolState: processed.state, processedPoolState: processed.state, observations: [obs('PADA', '09:11', { current_price: 100 })],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(rerun.captured_count, 0);
  const eventLines = (await fsp.readFile(rerun.event_file, 'utf8')).trim().split('\n');
  assert.equal(eventLines.filter(line => JSON.parse(line).type === 'FIRST_WATCH').length, 1);
});

// ---------------------------------------------------------------------------
// 21-23: honest nulls / bounded state
// ---------------------------------------------------------------------------

test('invalid/missing price does not invent a reference or executable value', () => {
  const item = { first_price: null, first_time: null, last_metrics: null, last_observation: null };
  const record = earlyWatch.buildFirstWatchRecord({ sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA', item, now: '2026-08-12T02:10:00.000Z' });
  assert.equal(record.reference_price, null);
  assert.equal(record.reference_price_source, null);

  const tracker = earlyWatch.initTrackerState(record);
  const untouched = earlyWatch.applyObservationToTracker(tracker, { time: '09:20', price: null, priceSource: 'x' });
  assert.deepEqual(untouched, tracker);
});

test('missing executable price source is labeled, not silently filled', () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const tracker = earlyWatch.initTrackerState(record);
  const completion = earlyWatch.buildCompletionRecord(tracker, { now: '2026-08-12T02:40:00.000Z', completionReason: 'session_end_censored', sessionEnd: true });
  assert.equal(completion.executable_price, null);
  assert.equal(completion.executable_price_available, false);
  assert.equal(completion.executable_price_unavailable_reason, earlyWatch.EXECUTABLE_PRICE_UNAVAILABLE_REASON);
  assert.equal(completion.pre_execution_move_pct, null);
});

test('bounded state: tracker shape stays fixed-size across many observations', () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  let tracker = earlyWatch.initTrackerState(record);
  const baselineKeyCount = Object.keys(tracker).length;
  for (let minute = 1; minute <= 50; minute += 1) {
    const hh = String(9 + Math.floor((10 + minute) / 60)).padStart(2, '0');
    const mm = String((10 + minute) % 60).padStart(2, '0');
    tracker = earlyWatch.applyObservationToTracker(tracker, { time: `${hh}:${mm}`, price: 100 + (minute % 5), priceSource: 'x' });
  }
  assert.equal(Object.keys(tracker).length, baselineKeyCount);
  assert.equal(Object.keys(tracker.checkpoints).length, 4);
});

// ---------------------------------------------------------------------------
// existing anti-chase constant reuse (read-only reference, never a new rule)
// ---------------------------------------------------------------------------

test('existing_anti_chase_limit_pct reuses the frozen production MAX_ADVANCE_PCT constant', () => {
  const momentum = require('../lib/intraday-fast-watcher-momentum');
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  assert.equal(record.existing_anti_chase_limit_pct, momentum.MAX_ADVANCE_PCT);
});

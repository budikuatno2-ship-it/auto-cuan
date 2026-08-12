'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pool = require('../lib/intraday-fast-watcher-pool');
const guarded = require('../lib/intraday-fast-watcher-guarded-live');
const earlyWatch = require('../lib/intraday-fast-watcher-early-watch');
const earlyWatchPublisher = require('../lib/intraday-fast-watcher-early-watch-publisher');
const radarPublisher = require('../lib/intraday-fast-watcher-radar-publisher');
const telegramNotifier = require('../lib/telegram-notifier');
const volumePace = require('../lib/intraday-volume-pace');

const ENABLED_ENV = { FAST_WATCHER_EARLY_WATCH_ENABLED: 'true' };

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

function fakeSender(responses) {
  const calls = [];
  return {
    calls,
    fn: async (text, options) => {
      calls.push({ text, options });
      const scripted = Array.isArray(responses) ? responses.shift() : responses;
      return scripted || { sent: true, status: 200 };
    }
  };
}

// ---------------------------------------------------------------------------
// 1-4: capture / idempotency / independence across tickers and dates
// (kept from PR #376, updated to the renamed runEarlyWatch API)
// ---------------------------------------------------------------------------

test('first WATCHING creates exactly one Early Watch record', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV,
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
  assert.equal(firstWatchLines[0].informational_only, true);
});

test('repeated WATCHING on same ticker/date/version does not duplicate first event', async () => {
  const dirs = await tmpDirs();
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }],
    observations: [obs('PADA', '09:10')], priorState: null
  });
  const run1 = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV,
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
  const run2 = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV,
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
  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV,
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

test('next trading date creates a new Early Watch event for the same ticker', async () => {
  const dirs = await tmpDirs();
  const day1 = pool.process({
    sampleDate: '2026-08-11', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const run1 = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV,
    sampleDate: '2026-08-11', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: day1.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(run1.captured_count, 1);

  const day2 = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const run2 = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV,
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: day2.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(run2.captured_count, 1);
  assert.notEqual(earlyWatch.earlyWatchId('2026-08-11', 'PADA'), earlyWatch.earlyWatchId('2026-08-12', 'PADA'));
});

// ---------------------------------------------------------------------------
// Feature flag: OFF / single authoritative flag (no legacy alias)
// ---------------------------------------------------------------------------

test('feature OFF causes zero Early Watch persistence or side effects', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatch({
    env: {}, sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.enabled, false);
  assert.equal(result.status, 'disabled');
  await assert.rejects(fsp.readFile(path.join(dirs.stateDir, '2026-08-12.json'), 'utf8'));
  await assert.rejects(fsp.readFile(path.join(dirs.eventDir, '2026-08-12.jsonl'), 'utf8'));
});

test('the legacy FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED flag can NOT enable the live feature', async () => {
  // FAST_WATCHER_EARLY_WATCH_ENABLED is the single authoritative flag.
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' }), false);
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_ENABLED: 'true' }), true);
  assert.equal(earlyWatch.isEnabled({}), false);
  assert.equal('LEGACY_ENV_FLAG' in earlyWatch, false);

  // End-to-end: with ONLY the legacy shadow flag set, runEarlyWatch must be
  // a full no-op — no persistence, no state/event files.
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatch({
    env: { FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED: 'true' },
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.enabled, false);
  assert.equal(result.status, 'disabled');
  await assert.rejects(fsp.readFile(path.join(dirs.stateDir, '2026-08-12.json'), 'utf8'));
});

// ---------------------------------------------------------------------------
// 6-10: existing 2/2 confirmation and confirmed Telegram flow are untouched
// ---------------------------------------------------------------------------

function confirmationSequence(env, extraOpts) {
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
    const common = Object.assign({
      sampleDate: '2026-08-12', shortlistFile: 'ignored',
      stateDir: path.join(root, 'state'), eventDir: path.join(root, 'events'),
      observationRoot: path.join(root, 'obs'), publishedDir: path.join(root, 'published'),
      earlyWatchStateDir: dirs.stateDir, earlyWatchEventDir: dirs.eventDir,
      env, readPayload: async () => ({ status: 'published', radar_candidates: ['PADA'] }),
      loadSupplemental: async () => [], engine: fakeEngine, collector: fakeCollector,
      checkProductionWorkerActive: async () => ({ active: false }),
      publishConfirmed: async () => ({ system_published: 1, telegram_sent: 0 })
    }, extraOpts || {});
    const first = await guarded.run({ ...common, scheduledTime: '09:10' });
    assert.equal(first.system_published, 0);
    const second = await guarded.run({ ...common, scheduledTime: '09:13' });
    assert.equal(second.confirmed.length, 1);
    assert.equal(second.system_published, 1);
    return { first, second };
  };
}

test('existing 2/2 behavior is identical with Early Watch OFF', async () => {
  const { second } = await confirmationSequence({ FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1' })();
  assert.equal(second.early_watch.enabled, false);
});

test('existing 2/2 behavior is identical with Early Watch ON', async () => {
  const { second } = await confirmationSequence({ FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1', FAST_WATCHER_EARLY_WATCH_ENABLED: 'true' })();
  assert.equal(second.early_watch.enabled, true);
  assert.equal(second.confirmed.length, 1);
  assert.equal(second.system_published, 1);
});

test('Early Watch never creates READY_PENDING (pool.js untouched)', () => {
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

test('Early Watch never creates READY_CONFIRMED (pool.js untouched)', () => {
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

test('existing confirmed signal is emitted normally after an Early Watch alert, and its payload is unchanged', async () => {
  const sent = fakeSender();
  const { second } = await confirmationSequence(
    { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1', FAST_WATCHER_EARLY_WATCH_ENABLED: 'true' },
    { earlyWatchNotifyFn: sent.fn, publishConfirmed: async opts => ({ system_published: 1, telegram_sent: 1, publishable_ticker: opts.publishable[0].ticker }) }
  )();
  // Confirmed publication result is untouched by Early Watch running in the same orchestrator call.
  assert.equal(second.confirmed.length, 1);
  assert.equal(second.confirmed[0].ticker, 'PADA');
  assert.equal(second.system_published, 1);
  assert.equal(second.publication.publishable_ticker, 'PADA');
  // The Early Watch alert (from run 1, first WATCHING) was sent through the
  // injected sender, completely separate from confirmed publication.
  assert.ok(sent.calls.some(call => call.text.includes('EARLY WATCH')));
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
// 11-13: Early Watch Telegram content
// ---------------------------------------------------------------------------

test('Early Watch Telegram says EARLY WATCH and BELUM TERKONFIRMASI', () => {
  const tracker = earlyWatch.initTrackerState(earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10', source_score: 62, ready_streak: 0, last_observation: { candidate_type: 'FAST_WATCHER_MOMENTUM_FLOW' } },
    now: '2026-08-12T02:10:00.000Z'
  }));
  const text = earlyWatchPublisher.buildEarlyWatchMessage(tracker, 'TMPO');
  assert.ok(text.includes('EARLY WATCH'));
  assert.ok(text.includes('BELUM TERKONFIRMASI'));
  assert.ok(text.includes('Rp157'));
  assert.ok(text.includes('Konfirmasi'));
  assert.ok(text.includes('0/2'));
});

test('Early Watch Telegram does not say BELI SEKARANG, ENTRY SEKARANG, or SIGNAL TERKONFIRMASI', () => {
  const tracker = earlyWatch.initTrackerState(earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10', ready_streak: 1 }, now: '2026-08-12T02:10:00.000Z'
  }));
  const text = earlyWatchPublisher.buildEarlyWatchMessage(tracker, 'TMPO');
  assert.equal(text.includes('BELI SEKARANG'), false);
  assert.equal(text.includes('ENTRY SEKARANG'), false);
  assert.equal(text.includes('SIGNAL TERKONFIRMASI'), false);
  // The disclaimer is a deliberate NEGATION ("Belum merupakan sinyal BUY") —
  // it must contain that exact reassurance, not omit the word entirely.
  assert.ok(text.includes('Belum merupakan sinyal BUY'));
  assert.ok(text.includes('1/2'));
});

test('Early Watch Telegram price label is "Harga referensi", never "Harga beli"/"Entry price"', () => {
  const tracker = earlyWatch.initTrackerState(earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  }));
  const text = earlyWatchPublisher.buildEarlyWatchMessage(tracker, 'TMPO');
  assert.ok(text.includes('Harga referensi'));
  assert.equal(text.includes('Harga beli'), false);
  assert.equal(/entry price/i.test(text), false);
});

test('Konfirmasi falls back to "Belum 2/2" when confirmation progress is unknown', () => {
  const tracker = earlyWatch.initTrackerState(earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10' /* no ready_streak */ }, now: '2026-08-12T02:10:00.000Z'
  }));
  const text = earlyWatchPublisher.buildEarlyWatchMessage(tracker, 'TMPO');
  assert.ok(text.includes('Belum 2/2'));
});

// ---------------------------------------------------------------------------
// 14-18: anti-chase reuses the existing canonical classification
// ---------------------------------------------------------------------------

test('anti-chase trigger reuses the existing canonical CHASE_REASONS classification, not a new formula', () => {
  assert.equal(earlyWatchPublisher.isChaseBlocked({ status: 'BLOCKED_CHASE', last_reasons: ['adaptive_advance_chase'] }), true);
  assert.equal(earlyWatchPublisher.isChaseBlocked({ status: 'SPIKE_RADAR', last_reasons: ['adaptive_advance_chase', 'spike_detected_informational_only'] }), true);
  assert.equal(earlyWatchPublisher.isChaseBlocked({ status: 'BLOCKED_CHASE', last_reasons: ['invalid_tp1'] }), false); // no chase reason present -> must not fire
  assert.equal(earlyWatchPublisher.isChaseBlocked({ status: 'WATCHING', last_reasons: ['adaptive_advance_chase'] }), true);
  assert.equal(earlyWatchPublisher.isChaseBlocked(null), false);
  assert.equal(earlyWatchPublisher.isChaseBlocked({ status: 'BLOCKED_CHASE' }), false); // no last_reasons array at all
  // Deliberately NOT status-gated: pool.js's own process() terminal-safety
  // cleanup rewrites a BLOCKED_CHASE status to DROPPED_FROM_WATCH_POOL
  // within the same call whenever scheduled_time is available (i.e. on
  // every real guarded-live run), so the reason code — never overwritten
  // by that cleanup — is the only reliable canonical chase signal.
  assert.equal(earlyWatchPublisher.isChaseBlocked({ status: 'DROPPED_FROM_WATCH_POOL', last_reasons: ['adaptive_advance_chase'] }), true);
  // Reused, not duplicated: every reason isChaseBlocked() honors must come
  // from the same CHASE_REASONS Set instance radar-publisher.js already ships.
  assert.ok(radarPublisher.CHASE_REASONS.has('adaptive_advance_chase'));
  assert.ok(radarPublisher.CHASE_REASONS.has('above_adaptive_entry_tolerance'));
  assert.equal(earlyWatchPublisher.isChaseBlocked({ status: 'BLOCKED_CHASE', last_reasons: ['above_adaptive_entry_tolerance'] }), true);
});

test('anti-chase message matches the TMPO evidence example and headline text', () => {
  const tracker = earlyWatch.initTrackerState(earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  }));
  const poolItem = { status: 'BLOCKED_CHASE', last_reasons: ['adaptive_advance_chase'], last_price: 168 };
  const text = earlyWatchPublisher.buildAntiChaseMessage(tracker, 'TMPO', poolItem);
  assert.ok(text.includes('HARGA SUDAH NAIK TERLALU JAUH'));
  assert.ok(text.includes('JANGAN DIKEJAR'));
  assert.ok(text.includes('Rp157'));
  assert.ok(text.includes('Rp168'));
  assert.ok(text.includes('+7.01%'));
  assert.ok(text.includes('Harga referensi kini'));
});

function trackerWithEarlyWatchAlreadySent(record) {
  const tracker = earlyWatch.initTrackerState(record);
  tracker.early_watch_notification_attempted = true;
  tracker.early_watch_notification_attempted_at = '2026-08-12T02:10:05.000Z';
  tracker.early_watch_notification_sent = true;
  tracker.early_watch_notification_sent_at = '2026-08-12T02:10:05.000Z';
  return tracker;
}

test('first chase-blocked evaluation (after a genuine prior Early Watch send) sends exactly one anti-chase alert; repeats do not resend', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { TMPO: trackerWithEarlyWatchAlreadySent(record) } };
  const poolState = { tickers: { TMPO: { active: true, status: 'BLOCKED_CHASE', last_reasons: ['adaptive_advance_chase'], last_price: 168 } } };
  const sent = fakeSender();
  const env = { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' };

  const run1 = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env, notifyFn: sent.fn });
  assert.equal(run1.anti_chase_sent, 1);
  assert.equal(run1.state.tickers.TMPO.anti_chase_notification_attempted, true);
  assert.equal(run1.state.tickers.TMPO.anti_chase_notification_sent, true);
  assert.ok(run1.state.tickers.TMPO.anti_chase_notification_sent_at);

  const run2 = await earlyWatchPublisher.sendPendingNotifications(run1.state, poolState, { env, notifyFn: sent.fn });
  assert.equal(run2.anti_chase_sent, 0);
  assert.equal(sent.calls.filter(call => call.text.includes('JANGAN DIKEJAR')).length, 1);
});

test('restart does not resend the anti-chase alert (dedup survives disk round-trip)', async () => {
  const dirs = await tmpDirs();
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const seedState = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { TMPO: trackerWithEarlyWatchAlreadySent(record) } };
  seedState.tickers.TMPO.anti_chase_notification_attempted = true;
  seedState.tickers.TMPO.anti_chase_notification_attempted_at = '2026-08-12T02:15:00.000Z';
  seedState.tickers.TMPO.anti_chase_notification_sent = true;
  seedState.tickers.TMPO.anti_chase_notification_sent_at = '2026-08-12T02:15:00.000Z';
  const stateFile = path.join(dirs.stateDir, '2026-08-12.json');
  await earlyWatch.writeStateAtomic(stateFile, seedState);

  const reloaded = await earlyWatch.readState(stateFile);
  const poolState = { tickers: { TMPO: { active: true, status: 'BLOCKED_CHASE', last_reasons: ['adaptive_advance_chase'], last_price: 170 } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(reloaded, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn });
  assert.equal(result.anti_chase_sent, 0);
  assert.equal(sent.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Restart safety for the Early Watch alert itself (not just anti-chase)
// ---------------------------------------------------------------------------

test('process restart: persisted early_watch_notification_sent prevents a duplicate alert', async () => {
  const dirs = await tmpDirs();
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const seedState = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: trackerWithEarlyWatchAlreadySent(record) } };
  const stateFile = path.join(dirs.stateDir, '2026-08-12.json');
  await earlyWatch.writeStateAtomic(stateFile, seedState);

  const reloaded = await earlyWatch.readState(stateFile);
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(reloaded, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
});

// ---------------------------------------------------------------------------
// FIX 2: at-most-once ATTEMPT contract is crash-safe — the "attempted"
// reservation is durably persisted BEFORE the outbound Telegram call, so a
// crash between reservation and delivery can never cause a resend.
// ---------------------------------------------------------------------------

test('a persisted attempted (but not yet sent) Early Watch reservation does NOT resend after "restart"', async () => {
  const dirs = await tmpDirs();
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  // Simulates: reservation was durably written, then the process/VPS
  // crashed before the Telegram call ever resolved (sent stays false).
  const seedState = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: earlyWatch.initTrackerState(record) } };
  seedState.tickers.PADA.early_watch_notification_attempted = true;
  seedState.tickers.PADA.early_watch_notification_attempted_at = '2026-08-12T02:10:05.000Z';
  const stateFile = path.join(dirs.stateDir, '2026-08-12.json');
  await earlyWatch.writeStateAtomic(stateFile, seedState);

  const reloaded = await earlyWatch.readState(stateFile);
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(reloaded, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0, 'a reserved-but-unresolved attempt must never be retried, even though sent stayed false');
  assert.equal(result.state.tickers.PADA.early_watch_notification_sent, false);
});

test('a persisted attempted (but not yet sent) anti-chase reservation does NOT resend after "restart"', async () => {
  const dirs = await tmpDirs();
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const seedState = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { TMPO: trackerWithEarlyWatchAlreadySent(record) } };
  seedState.tickers.TMPO.anti_chase_notification_attempted = true;
  seedState.tickers.TMPO.anti_chase_notification_attempted_at = '2026-08-12T02:15:00.000Z';
  const stateFile = path.join(dirs.stateDir, '2026-08-12.json');
  await earlyWatch.writeStateAtomic(stateFile, seedState);

  const reloaded = await earlyWatch.readState(stateFile);
  const poolState = { tickers: { TMPO: { active: true, status: 'BLOCKED_CHASE', last_reasons: ['adaptive_advance_chase'], last_price: 168 } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(reloaded, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn });
  assert.equal(result.anti_chase_sent, 0);
  assert.equal(sent.calls.length, 0);
  assert.equal(result.state.tickers.TMPO.anti_chase_notification_sent, false);
});

test('the attempted reservation is durably persisted BEFORE the outbound Telegram call', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: earlyWatch.initTrackerState(record) } };
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  let persistedAttemptedAtSendTime = null;
  const persistCalls = [];
  const persist = async nextState => { persistCalls.push(JSON.parse(JSON.stringify(nextState))); };
  const notifyFn = async () => {
    // At the moment Telegram would actually be called, the reservation
    // must already have been durably persisted.
    persistedAttemptedAtSendTime = persistCalls.length > 0 && persistCalls[persistCalls.length - 1].tickers.PADA.early_watch_notification_attempted;
    return { sent: true };
  };
  await earlyWatchPublisher.sendPendingNotifications(state, poolState, {
    env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn, persist
  });
  assert.equal(persistedAttemptedAtSendTime, true);
  assert.ok(persistCalls.length >= 1);
});

test('sent state remains correct when the Telegram send genuinely succeeds', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: earlyWatch.initTrackerState(record) } };
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  const sent = fakeSender({ sent: true });
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn });
  const tracker = result.state.tickers.PADA;
  assert.equal(tracker.early_watch_notification_attempted, true);
  assert.equal(tracker.early_watch_notification_sent, true);
  assert.ok(tracker.early_watch_notification_sent_at);
  assert.equal(tracker.early_watch_notification_failure_reason, null);
});

test('failure state records the reason without retrying automatically', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: earlyWatch.initTrackerState(record) } };
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  const env = { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' };
  const sent = fakeSender({ sent: false, reason: 'missing_chat_id' });

  const run1 = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env, notifyFn: sent.fn });
  assert.equal(run1.early_watch_sent, 0);
  assert.equal(run1.state.tickers.PADA.early_watch_notification_attempted, true);
  assert.equal(run1.state.tickers.PADA.early_watch_notification_sent, false);
  assert.equal(run1.state.tickers.PADA.early_watch_notification_failure_reason, 'missing_chat_id');

  // A later run must NOT retry, even though it never actually got sent —
  // "attempted" is the sole gate, per the at-most-once-ATTEMPT contract.
  const run2 = await earlyWatchPublisher.sendPendingNotifications(run1.state, poolState, { env, notifyFn: sent.fn });
  assert.equal(run2.early_watch_sent, 0);
  assert.equal(sent.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 19-20: failure isolation
// ---------------------------------------------------------------------------

test('Early Watch Telegram failure does not break main pool/confirmation persistence', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const throwingSend = async () => { throw new Error('network down'); };
  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir,
    sendNotifications: async (state, poolState) => earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: throwingSend })
  });
  // Tracking/persistence still happened despite the notification failure.
  assert.equal(result.captured_count, 1);
  assert.equal(result.notification_failures.length, 1);
  const state = JSON.parse(await fsp.readFile(result.state_file, 'utf8'));
  assert.ok(state.tickers.PADA);
  assert.equal(state.tickers.PADA.early_watch_notification_sent, false);
});

test('a throwing sendNotifications callback still leaves tracking state persisted (defense in depth)', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir,
    sendNotifications: async () => { throw new Error('boom'); }
  });
  assert.equal(result.captured_count, 1);
  assert.equal(result.notification_failures.length, 1);
  const state = JSON.parse(await fsp.readFile(result.state_file, 'utf8'));
  assert.ok(state.tickers.PADA);
});

test('a whole-hook Early Watch failure does not break guarded.run() or the confirmed path', async () => {
  const { second } = await confirmationSequence(
    { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1', FAST_WATCHER_EARLY_WATCH_ENABLED: 'true' },
    { runEarlyWatch: async () => { throw new Error('early watch exploded'); } }
  )();
  assert.equal(second.early_watch.status, 'error');
  assert.equal(second.confirmed.length, 1);
  assert.equal(second.system_published, 1);
});

// ---------------------------------------------------------------------------
// 21-23: kill switches / no Supabase / no production recommendation
// ---------------------------------------------------------------------------

test('TELEGRAM gate: sendPendingNotifications sends nothing when FAST_WATCHER_TELEGRAM_ENABLED is off', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: earlyWatch.initTrackerState(record) } };
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1' }, notifyFn: sent.fn });
  assert.equal(result.telegram_gate_open, false);
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
});

test('TELEGRAM gate: sendPendingNotifications sends nothing when FAST_WATCHER_LIVE_ENABLED is off', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: earlyWatch.initTrackerState(record) } };
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: { FAST_WATCHER_TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn });
  assert.equal(result.telegram_gate_open, false);
  assert.equal(sent.calls.length, 0);
});

// ---------------------------------------------------------------------------
// FIX 1: the GLOBAL TELEGRAM_ENABLED switch must gate BEFORE the durable
// `_attempted` reservation is written — otherwise a globally-disabled run
// would permanently consume the alert via telegram-notifier's own internal
// "telegram_disabled" response, and it would never fire even once Telegram
// is turned back on.
// ---------------------------------------------------------------------------

test('FIX1: global TELEGRAM_ENABLED=off blocks Early Watch AND anti-chase without reserving an attempt', async () => {
  // Fresh capture (no prior Early Watch send yet) that is ALSO already
  // chase-blocked, so with the gate open both notification types would be
  // candidates this run (Early Watch would actually be skipped by FIX3.4,
  // anti-chase by FIX3.6 — but neither reason should even be reached here:
  // the closed global gate must short-circuit before either check runs).
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'TMPO',
    item: { first_price: 157, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { TMPO: earlyWatch.initTrackerState(record) } };
  const poolState = { tickers: { TMPO: { active: true, status: 'BLOCKED_CHASE', last_reasons: ['adaptive_advance_chase'], last_price: 168 } } };
  const sent = fakeSender();
  const env = { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '0' };
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env, notifyFn: sent.fn });
  assert.equal(result.telegram_gate_open, false);
  assert.equal(sent.calls.length, 0);
  assert.equal(result.state.tickers.TMPO.early_watch_notification_attempted, false);
  assert.equal(result.state.tickers.TMPO.anti_chase_notification_attempted, false);
});

test('FIX1: TELEGRAM_ENABLED=off on a fresh capture reserves nothing, so a later run with it on still sends', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: earlyWatch.initTrackerState(record) } };
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: [] } } };
  const sent = fakeSender();

  const disabledRun = await earlyWatchPublisher.sendPendingNotifications(state, poolState, {
    env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '0' }, notifyFn: sent.fn
  });
  assert.equal(disabledRun.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
  assert.equal(disabledRun.state.tickers.PADA.early_watch_notification_attempted, false, 'a globally-disabled run must be a clean no-op, not a consumed attempt');

  const enabledRun = await earlyWatchPublisher.sendPendingNotifications(disabledRun.state, poolState, {
    env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn
  });
  assert.equal(enabledRun.early_watch_sent, 1);
  assert.equal(sent.calls.length, 1);
});

test('default notifyFn is the canonical telegram-notifier sender, not a new client', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'intraday-fast-watcher-early-watch-publisher.js'), 'utf8');
  assert.ok(source.includes("require('./telegram-notifier')"));
  assert.equal(/api\.telegram\.org|fetch\(/.test(source), false, 'publisher must never call the Telegram HTTP API directly');
  assert.equal(typeof telegramNotifier.sendTelegramMessage, 'function');
});

test('no Supabase write is caused by Early Watch (neither core nor publisher module)', async () => {
  const coreSource = await fsp.readFile(path.join(__dirname, '..', 'lib', 'intraday-fast-watcher-early-watch.js'), 'utf8');
  const publisherSource = await fsp.readFile(path.join(__dirname, '..', 'lib', 'intraday-fast-watcher-early-watch-publisher.js'), 'utf8');
  assert.equal(/require\(['"]@supabase/i.test(coreSource), false);
  assert.equal(/require\(['"]@supabase/i.test(publisherSource), false);
  assert.equal(/createClient\(/.test(coreSource), false);
  assert.equal(/createClient\(/.test(publisherSource), false);
  assert.equal(/\.upsert\(/.test(publisherSource), false);
});

test('no production recommendation registration from Early Watch', async () => {
  const dirs = await tmpDirs();
  const processed = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: processed.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.supabase_write, false);
  assert.equal(result.production_recommendation_registered, false);
  const eventLines = (await fsp.readFile(result.event_file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(eventLines[0].informational_only, true);
  assert.equal(eventLines[0].supabase_write, false);
  assert.equal(eventLines[0].production_recommendation, false);
});

// ---------------------------------------------------------------------------
// 24: production eligibility reuse
// ---------------------------------------------------------------------------

test('production-eligibility-blocked ticker does not receive a misleading Early Watch alert', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'RISK',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { RISK: earlyWatch.initTrackerState(record) } };
  // Mirrors exactly what pool.js itself already writes into last_reasons when
  // lib/intraday-production-eligibility.js blocks a candidate (see pool.js's
  // own eligibility.eligible check) — reused verbatim, not re-derived.
  const poolState = { tickers: { RISK: { active: true, status: 'WATCHING', last_reasons: ['production_eligibility_blocked', 'data_quality_risk_status'] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' }, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
});

test('eligibility becoming clear on a later run finally sends the (still-pending) Early Watch alert', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'RISK',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { RISK: earlyWatch.initTrackerState(record) } };
  const env = { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' };
  const sent = fakeSender();
  const blocked = await earlyWatchPublisher.sendPendingNotifications(state, { tickers: { RISK: { active: true, status: 'WATCHING', last_reasons: ['production_eligibility_blocked'] } } }, { env, notifyFn: sent.fn });
  assert.equal(blocked.early_watch_sent, 0);
  const clear = await earlyWatchPublisher.sendPendingNotifications(blocked.state, { tickers: { RISK: { active: true, status: 'WATCHING', last_reasons: [] } } }, { env, notifyFn: sent.fn });
  assert.equal(clear.early_watch_sent, 1);
});

// ---------------------------------------------------------------------------
// FIX 3: never send a stale Early Watch alert once the ticker has left the
// active pool or become terminal/ineligible/chase-blocked, and never emit
// Early Watch immediately followed by anti-chase in the same run.
// ---------------------------------------------------------------------------

function freshState(ticker, item, sampleDate, scheduledTime, now) {
  const record = earlyWatch.buildFirstWatchRecord({ sampleDate, scheduledTime, ticker, item, now });
  return { schema_version: 1, version: earlyWatch.VERSION, date: sampleDate, tickers: { [ticker]: earlyWatch.initTrackerState(record) } };
}

const EW_ENV = { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1', TELEGRAM_ENABLED: '1' };

test('FIX3.1 missing poolItem -> no Early Watch send', async () => {
  const state = freshState('PADA', { first_price: 100, first_time: '09:10' }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, { tickers: {} }, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
  assert.equal(result.state.tickers.PADA.early_watch_notification_attempted, false);
});

test('FIX3.2 inactive poolItem -> no Early Watch send', async () => {
  const state = freshState('PADA', { first_price: 100, first_time: '09:10' }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  const poolState = { tickers: { PADA: { active: false, status: 'WATCHING', last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
});

test('FIX3.3 DROPPED_FROM_WATCH_POOL -> no Early Watch send', async () => {
  const state = freshState('PADA', { first_price: 100, first_time: '09:10' }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  // active:true is intentionally implausible-but-defensive here: even if
  // active were somehow still true, the terminal status alone must block.
  const poolState = { tickers: { PADA: { active: true, status: 'DROPPED_FROM_WATCH_POOL', last_reasons: ['pool_capacity_evicted'] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
});

test('FIX3.3b every canonical terminal status blocks Early Watch (INVALIDATED, STALE, INVALID_DATA, BLOCKED_CHASE)', async () => {
  for (const status of ['INVALIDATED', 'STALE', 'INVALID_DATA', 'BLOCKED_CHASE']) {
    const state = freshState('PADA', { first_price: 100, first_time: '09:10' }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
    const poolState = { tickers: { PADA: { active: true, status, last_reasons: [] } } };
    const sent = fakeSender();
    const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
    assert.equal(result.early_watch_sent, 0, `status ${status} must block Early Watch`);
    assert.equal(sent.calls.length, 0, `status ${status} must not send`);
  }
});

// ---------------------------------------------------------------------------
// FIX 2: Early Watch is a PRE-confirmation alert only. A delayed/pending
// send must never fire once the CURRENT pool status has moved past
// pre-confirmation (most importantly READY_CONFIRMED — the existing
// confirmed publisher already owns that ticker's notification at that
// point), and the message must reflect CURRENT status/confirmation
// progress, never the frozen FIRST_WATCH snapshot.
// ---------------------------------------------------------------------------

test('FIX2.1 READY_CONFIRMED current status -> no Early Watch notification', async () => {
  const state = freshState('PADA', { first_price: 100, first_time: '09:10' }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  const poolState = { tickers: { PADA: { active: true, status: 'READY_CONFIRMED', ready_streak: 2, last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
  assert.equal(result.state.tickers.PADA.early_watch_notification_attempted, false);
});

test('FIX2.2 WATCHING current status -> Early Watch allowed', async () => {
  const state = freshState('PADA', { first_price: 100, first_time: '09:10', source_score: 60 }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', ready_streak: 0, last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 1);
  assert.ok(sent.calls[0].text.includes('Status           : WATCHING'));
  assert.ok(sent.calls[0].text.includes('0/2'));
});

test('FIX2.3 READY_PENDING current status -> Early Watch allowed, message shows CURRENT status + ready_streak', async () => {
  const state = freshState('PADA', { first_price: 100, first_time: '09:10', ready_streak: 0 }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  // The frozen tracker's own confirmation_count (from capture time) is 0,
  // but the CURRENT pool item has since progressed to 1/2 — the message
  // must show the current value, not the stale frozen one.
  assert.equal(state.tickers.PADA.confirmation_count, 0);
  const poolState = { tickers: { PADA: { active: true, status: 'READY_PENDING', ready_streak: 1, last_reasons: [] } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 1);
  assert.ok(sent.calls[0].text.includes('Status           : READY_PENDING'));
  assert.ok(sent.calls[0].text.includes('Konfirmasi       : 1/2'));
  assert.equal(sent.calls[0].text.includes('0/2'), false);
});

test('FIX2.4 a delayed alert cannot sneak out immediately before/after an already-confirmed signal', async () => {
  // Simulates: capture happened (tracker exists, reference_price known,
  // never yet notified — e.g. Telegram was globally disabled at capture
  // time, see FIX1), but by the time a later run finally attempts to send
  // it, the ticker's CURRENT pool status has already progressed all the
  // way to READY_CONFIRMED via the genuine, unmodified momentum engine —
  // the confirmed Telegram flow is the authoritative signal at that point,
  // and Early Watch must defer to it rather than send a stale "WATCHING"
  // alert alongside/around it.
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

  const state = freshState('PADA', first.state.tickers.PADA, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  assert.equal(state.tickers.PADA.early_watch_notification_attempted, false);
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, third.state, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(sent.calls.length, 0);
  assert.equal(result.state.tickers.PADA.early_watch_notification_attempted, false);
});

test('FIX3.4 chase-blocked on the very same run it was first captured -> no Early Watch alert at all', async () => {
  const state = freshState('TMPO', { first_price: 157, first_time: '09:10' }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  // Same-run chase: e.g. above_adaptive_entry_tolerance can fire on the very
  // first observation (it does not depend on advance-from-first_price).
  const poolState = { tickers: { TMPO: { active: true, status: 'WATCHING', last_reasons: ['above_adaptive_entry_tolerance'], last_price: 160 } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(result.anti_chase_sent, 0);
  assert.equal(sent.calls.length, 0);
  assert.equal(result.state.tickers.TMPO.early_watch_notification_attempted, false);
  assert.equal(result.state.tickers.TMPO.anti_chase_notification_attempted, false);
});

test('FIX3.5 same run never emits Early Watch immediately followed by anti-chase', async () => {
  // A ticker that is EARLY-WATCH-ELIGIBLE this run (not itself chase-blocked)
  // but whose Telegram send happens in this same run must not also become
  // eligible for anti-chase in this same run, even if some other logic path
  // could theoretically compute chase-blocked for it moments later.
  const state = freshState('PADA', { first_price: 100, first_time: '09:10' }, '2026-08-12', '09:10', '2026-08-12T02:10:00.000Z');
  const poolState = { tickers: { PADA: { active: true, status: 'WATCHING', last_reasons: ['adaptive_advance_chase'], last_price: 108 } } };
  // last_reasons already carries a chase reason, but isChaseBlocked() would
  // gate Early Watch itself off in this scenario (FIX3.4); to specifically
  // prove the back-to-back guard (not the FIX3.4 guard), verify no anti-chase
  // fires even though early_watch_notification_sent is (correctly) false.
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.early_watch_sent, 0);
  assert.equal(result.anti_chase_sent, 0);
  assert.equal(sent.calls.length, 0);
});

test('FIX3.6 anti-chase requires a previously SUCCESSFULLY sent Early Watch alert, not merely attempted', async () => {
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  const tracker = earlyWatch.initTrackerState(record);
  // Attempted but FAILED (e.g. Telegram was down) — the user never actually
  // received an Early Watch alert, so a chase warning referencing "harga
  // saat Early Watch" would be misleading.
  tracker.early_watch_notification_attempted = true;
  tracker.early_watch_notification_attempted_at = '2026-08-12T02:10:05.000Z';
  tracker.early_watch_notification_sent = false;
  tracker.early_watch_notification_failure_reason = 'telegram_exception';
  const state = { schema_version: 1, version: earlyWatch.VERSION, date: '2026-08-12', tickers: { PADA: tracker } };
  const poolState = { tickers: { PADA: { active: true, status: 'BLOCKED_CHASE', last_reasons: ['adaptive_advance_chase'], last_price: 110 } } };
  const sent = fakeSender();
  const result = await earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn });
  assert.equal(result.anti_chase_sent, 0);
  assert.equal(sent.calls.length, 0);
  assert.equal(result.state.tickers.PADA.anti_chase_notification_attempted, false);
});

test('FIX3.7 previously Early-Watched ticker later becomes canonical chase-blocked -> exactly one anti-chase alert', async () => {
  const dirs = await tmpDirs();
  // Run 1: genuine first capture + successful Early Watch send.
  const tmpoObs = (time, extra) => obs('TMPO', time, Object.assign({ current_price: 157, entry_low: 155, entry_high: 158, tp1: 170, high: 158, low: 154 }, extra || {}));
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'TMPO', source_rank: 1 }], observations: [tmpoObs('09:10')], priorState: null
  });
  const sent = fakeSender();
  await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: first.state, observations: [tmpoObs('09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir,
    sendNotifications: (state, poolState) => earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn })
  });
  assert.ok(sent.calls.some(call => call.text.includes('EARLY WATCH')));

  // Run 2: price has since moved far enough that pool.js's own frozen
  // momentum engine classifies it chase-blocked.
  const second = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:25',
    shortlistRows: [{ ticker: 'TMPO', source_rank: 1 }],
    observations: [obs('TMPO', '09:25', { current_price: 168, entry_low: 155, entry_high: 158, tp1: 170 })],
    priorState: first.state
  });
  const chaseReasons = second.state.tickers.TMPO.last_reasons || [];
  assert.ok(chaseReasons.some(r => radarPublisher.CHASE_REASONS.has(r)), `expected a chase reason, got ${JSON.stringify(chaseReasons)}`);

  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '09:25',
    priorPoolState: first.state, processedPoolState: second.state, observations: [obs('TMPO', '09:25', { current_price: 168 })],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir,
    sendNotifications: (state, poolState) => earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn })
  });
  assert.equal(result.anti_chase_telegram_sent, 1);
  assert.ok(sent.calls.some(call => call.text.includes('JANGAN DIKEJAR')));

  // Run 3: repeat — must not resend.
  const third = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:40',
    shortlistRows: [{ ticker: 'TMPO', source_rank: 1 }],
    observations: [obs('TMPO', '09:40', { current_price: 169, entry_low: 155, entry_high: 158, tp1: 170 })],
    priorState: second.state
  });
  const result3 = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '09:40',
    priorPoolState: second.state, processedPoolState: third.state, observations: [obs('TMPO', '09:40', { current_price: 169 })],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir,
    sendNotifications: (state, poolState) => earlyWatchPublisher.sendPendingNotifications(state, poolState, { env: EW_ENV, notifyFn: sent.fn })
  });
  assert.equal(result3.anti_chase_telegram_sent, 0);
  assert.equal(sent.calls.filter(call => call.text.includes('JANGAN DIKEJAR')).length, 1);
});

// ---------------------------------------------------------------------------
// 25: active-minute session math (kept from PR #376)
// ---------------------------------------------------------------------------

test('active-minute horizons handle the Mon-Thu lunch break correctly', () => {
  const elapsed = earlyWatch.activeMinutesElapsed('2026-08-10', '11:50', '13:35');
  assert.equal(elapsed, 15);
});

test('Friday session timing correctly differs from Mon-Thu', () => {
  const monThu = volumePace.tradingSchedule('2026-08-10');
  const friday = volumePace.tradingSchedule('2026-08-14');
  assert.equal(monThu.total, 330);
  assert.equal(friday.total, 270);
  assert.deepEqual(friday.windows, [{ start: 540, end: 690 }, { start: 840, end: 960 }]);
  assert.equal(earlyWatch.activeMinutesAt('2026-08-14', '11:40'), 150);
});

test('late-day event becomes session-end censored correctly', async () => {
  const dirs = await tmpDirs();
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '15:50',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '15:50')], priorState: null
  });
  await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '15:50',
    priorPoolState: null, processedPoolState: first.state, observations: [obs('PADA', '15:50')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '16:00',
    priorPoolState: first.state, processedPoolState: first.state, observations: [],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.completed_count, 1);
  const eventLines = (await fsp.readFile(result.event_file, 'utf8')).trim().split('\n').map(JSON.parse);
  const completion = eventLines.find(row => row.type === 'TRACKING_COMPLETE');
  assert.equal(completion.completion_reason, 'session_end_censored');
  assert.equal(completion.checkpoints.m60.filled, false);
});

// ---------------------------------------------------------------------------
// persistence / pool-drop survival / honest nulls / bounded state
// (kept from PR #376)
// ---------------------------------------------------------------------------

test('Early Watch record survives ticker dropping out of the current candidate pool', async () => {
  const dirs = await tmpDirs();
  const first = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '09:10',
    shortlistRows: [{ ticker: 'PADA', source_rank: 1 }], observations: [obs('PADA', '09:10')], priorState: null
  });
  await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '09:10',
    priorPoolState: null, processedPoolState: first.state, observations: [obs('PADA', '09:10')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  const second = pool.process({
    sampleDate: '2026-08-12', scheduledTime: '10:00',
    shortlistRows: [{ ticker: 'OTHER', source_rank: 1 }],
    observations: [obs('OTHER', '10:00')], priorState: first.state
  });
  assert.equal(second.state.tickers.PADA.status, 'DROPPED_FROM_WATCH_POOL');
  const result = await earlyWatch.runEarlyWatch({
    env: ENABLED_ENV, sampleDate: '2026-08-12', scheduledTime: '10:00',
    priorPoolState: first.state, processedPoolState: second.state, observations: [obs('OTHER', '10:00')],
    stateDir: dirs.stateDir, eventDir: dirs.eventDir
  });
  assert.equal(result.captured_count, 1); // OTHER captured, PADA not re-captured
  const state = JSON.parse(await fsp.readFile(result.state_file, 'utf8'));
  assert.ok(state.tickers.PADA, 'PADA early-watch record must still exist after pool eviction');
  assert.equal(state.tickers.PADA.still_in_pool, false);
});

test('invalid/missing price does not invent a reference value', () => {
  const item = { first_price: null, first_time: null, last_metrics: null, last_observation: null };
  const record = earlyWatch.buildFirstWatchRecord({ sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA', item, now: '2026-08-12T02:10:00.000Z' });
  assert.equal(record.reference_price, null);
  assert.equal(record.reference_price_source, null);
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

test('existing_anti_chase_limit_pct reuses the frozen production MAX_ADVANCE_PCT constant', () => {
  const momentum = require('../lib/intraday-fast-watcher-momentum');
  const record = earlyWatch.buildFirstWatchRecord({
    sampleDate: '2026-08-12', scheduledTime: '09:10', ticker: 'PADA',
    item: { first_price: 100, first_time: '09:10' }, now: '2026-08-12T02:10:00.000Z'
  });
  assert.equal(record.existing_anti_chase_limit_pct, momentum.MAX_ADVANCE_PCT);
});

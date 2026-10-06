'use strict';

// Regression tests for FastWatcher early recall, producer-schedule separation,
// safe producer overlap reuse, 12-candidate watch pool, and frozen safety gates.
//
// Invariants verified:
// 1. Scheduler producer and FastWatcher do not start on the same minute.
// 2. First DayTrade producer current-day runs at 09:02 WIB.
// 3. Producer running + fresh completed shortlist: FastWatcher reuses last completed shortlist (no lost tick).
// 4. Producer running + stale/missing shortlist: fails closed (skipped_screener_running).
// 5. Candidate ranking #8 / #10 / #12 can enter internal watch pool.
// 6. Candidate #13 does not enter when cap = 12.
// 7. Even with 12 candidates watched: MAX_PUBLISH_COUNT remains strictly 3.
// 8. 3-of-5 confirmation window remains strictly required.
// 9. TP1_ALREADY_REACHED remains BLOCKED_CHASE.
// 10. Above entry tolerance remains BLOCKED_CHASE.
// 11. AVOID remains hard reject.
// 12. Preconfirmation / radar does not send Telegram.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const guarded = require('../lib/intraday-fast-watcher-guarded-live');
const materializer = require('../tools/materialize-fastwatcher-shortlist');
const pool = require('../lib/intraday-fast-watcher-pool');
const momentum = require('../lib/intraday-fast-watcher-momentum');
const publisher = require('../lib/intraday-fast-watcher-publisher');
const radarPublisher = require('../lib/intraday-fast-watcher-radar-publisher');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-recall-'));
}

function fixtureCandidate(ticker, rank, extra) {
  return Object.assign({
    ticker,
    board: 'UTAMA',
    source_rank: rank,
    daytrade_score: Math.max(65, 90 - rank),
    score: Math.max(65, 90 - rank),
    status: 'READY_BREAKOUT',
    entry_low: 100,
    entry_high: 105,
    stop_loss: 95,
    tp1: 120,
    risk_reward: 2.5
  }, extra || {});
}

function fixtureObservation(ticker, time, extra) {
  return Object.assign({
    ticker,
    scheduled_time: time,
    current_price: 102,
    entry_low: 100,
    entry_high: 105,
    stop_loss: 95,
    tp1: 120,
    current_status: 'READY_BREAKOUT',
    volume: 5000,
    average_volume: 2000,
    relative_volume: 2.5,
    volume_rate: 150,
    volume_pace_ratio: 1.8,
    momentum_component: 18,
    liquidity_component: 16,
    risk_reward: 2.5,
    high: 105,
    low: 100,
    freshness: { is_stale: false }
  }, extra || {});
}

function fakeCollector(customObsFn) {
  return {
    checkProductionWorkerActive: async () => ({ active: false }),
    fetchWithFreshnessFallback: async () => ({ candles: [], freshness: { is_stale: false } }),
    buildCandidateRecord: (result, time) => {
      if (customObsFn) return customObsFn(result, time);
      return fixtureObservation(result.ticker, time, {
        current_price: result.last_price,
        volume: result.volume_today,
        relative_volume: result.volume_ratio_20d,
        score: result.daytrade_score
      });
    },
    deriveDistances: (row) => row,
    sanitizeRecord: (row) => row
  };
}

function fakeEngine(setupMap) {
  return {
    runDayTradeBatch: async (batch) => ({
      results: batch.map((item) => {
        const custom = (setupMap && setupMap[item.ticker]) || {};
        return Object.assign({
          ticker: item.ticker,
          last_price: 102,
          entry_low: 100,
          entry_high: 105,
          tp1: 120,
          stop_loss: 95,
          status: 'READY_BREAKOUT',
          daytrade_score: 80,
          volume_today: 5000,
          avg_volume_20d: 2000,
          volume_ratio_20d: 2.5,
          momentum_score: 18,
          liquidity_score: 16,
          risk_reward: 2.5,
          high_price: 105,
          low_price: 100
        }, custom);
      }),
      failed: []
    })
  };
}

function baseDeps(root, shortlistFile, engine, collector) {
  return {
    sampleDate: '2026-10-06',
    shortlistFile,
    stateDir: path.join(root, 'state'),
    eventDir: path.join(root, 'events'),
    observationRoot: path.join(root, 'obs'),
    publishedDir: path.join(root, 'published'),
    env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1' },
    engine: engine || fakeEngine(),
    collector: collector || fakeCollector(),
    checkProductionWorkerActive: async () => ({ active: false }),
    loadSupplemental: async () => [],
    publishConfirmed: async () => ({ system_published: 0, telegram_sent: 0, telegram_attempted: false }),
    readPayload: async () => JSON.parse(fs.readFileSync(shortlistFile, 'utf8'))
  };
}

// -------------------------------------------------------------------------
// 1. Scheduler producer dan FastWatcher tidak start pada menit sama
// -------------------------------------------------------------------------
test('FWE-01: DayTrade producer dan FastWatcher tidak start pada menit yang sama dalam crontab', () => {
  const cron = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8');

  const producerMatch = cron.match(/^([0-9,*/]+)\s+9-15\s+\*\s+\*\s+1-5\s+.*run-daytrade-producer\.sh/m);
  const fwMatch = cron.match(/^([0-9,*/]+)\s+9-15\s+\*\s+\*\s+1-5\s+.*run-fastwatcher\.sh/m);

  assert.ok(producerMatch, 'DayTrade producer line must exist in cron');
  assert.ok(fwMatch, 'FastWatcher line must exist in cron');

  const parseMinutes = (expr) => {
    if (expr.startsWith('*/')) {
      const step = parseInt(expr.slice(2), 10);
      const mins = [];
      for (let i = 0; i < 60; i += step) mins.push(i);
      return mins;
    }
    return expr.split(',').map((x) => parseInt(x.trim(), 10));
  };

  const producerMins = parseMinutes(producerMatch[1]);
  const fwMins = parseMinutes(fwMatch[1]);

  assert.deepEqual(producerMins, [2, 17, 32, 47], 'Producer schedule must be 2,17,32,47');
  assert.deepEqual(fwMins, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], 'FastWatcher schedule must be */5');

  const collision = producerMins.filter((m) => fwMins.includes(m));
  assert.equal(collision.length, 0, `No shared execution minute allowed, found: ${collision.join(',')}`);
});

// -------------------------------------------------------------------------
// 2. First DayTrade producer current-day berjalan 09:02
// -------------------------------------------------------------------------
test('FWE-02: DayTrade producer pertama hari bursa berjalan tepat 09:02 WIB', () => {
  const cron = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8');
  const producerMatch = cron.match(/^([0-9,*/]+)\s+(\d+)-(\d+)\s+\*\s+\*\s+1-5\s+.*run-daytrade-producer\.sh/m);

  assert.ok(producerMatch);
  const startHour = parseInt(producerMatch[2], 10);
  const firstMinute = parseInt(producerMatch[1].split(',')[0], 10);

  const formatted = `${String(startHour).padStart(2, '0')}:${String(firstMinute).padStart(2, '0')}`;
  assert.equal(formatted, '09:02', 'First producer run of the day must be at 09:02 WIB');
});

// -------------------------------------------------------------------------
// 3. Producer running + fresh completed shortlist: FastWatcher TIDAK kehilangan tick
// -------------------------------------------------------------------------
test('FWE-03: Producer running + fresh completed shortlist: FastWatcher memakai last completed fresh shortlist (no lost tick)', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');

  // Pre-existing completed fresh shortlist from earlier tick (run_date = 2026-10-06)
  const freshCompleted = {
    status: 'published',
    source: 'local-vps-api:daytrade-screener',
    generated_at: '2026-10-06T09:02:00.000Z',
    run_date: '2026-10-06',
    results: [
      { ticker: 'PADA', score: 85, board: 'UTAMA' },
      { ticker: 'BBRI', score: 80, board: 'UTAMA' }
    ]
  };
  fs.writeFileSync(shortlistFile, JSON.stringify(freshCompleted, null, 2));

  // Daemon returns status = running (DayTrade producer currently scanning)
  const runningPayload = {
    success: true,
    status: 'running',
    scanned_count: 75,
    universe_count: 760
  };
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(runningPayload)
  });

  try {
    const matResult = await materializer.main(
      { dryRun: false, print: false, output: shortlistFile },
      {
        env: { CRON_SECRET: 'dummy' },
        runDate: '2026-10-06',
        now: new Date('2026-10-06T02:05:00Z'),
        fetchFn: fakeFetch,
        baseUrl: 'http://127.0.0.1:3000',
        log: () => {}
      }
    );

    assert.equal(matResult.ok, true);
    assert.equal(matResult.producer_overlap_reuse, true, 'materializer must flag producer_overlap_reuse=true');
    assert.equal(matResult.counts.rows, 2);

    // File on disk retains published status with preserved candidates
    const diskContent = JSON.parse(fs.readFileSync(shortlistFile, 'utf8'));
    assert.equal(diskContent.status, 'published');
    assert.equal(diskContent.producer_overlap_reuse, true);
    assert.equal(diskContent.results.length, 2);

    // FastWatcher engine executes successfully without skipping
    const deps = baseDeps(root, shortlistFile);
    const fwResult = await guarded.run(Object.assign({}, deps, { scheduledTime: '09:05' }));

    assert.notEqual(fwResult.status, 'skipped_screener_running', 'FastWatcher must NOT skip tick during overlap');
    assert.equal(fwResult.status, 'guarded_live_recorded');
    assert.equal(fwResult.producer_overlap_reuse, true);
    assert.equal(fwResult.shortlist_count, 2);
    assert.equal(fwResult.active_pool_count, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// 4. Producer running + stale/missing shortlist: tetap FAIL-CLOSED
// -------------------------------------------------------------------------
test('FWE-04: Producer running + stale atau missing shortlist: tetap fail-closed (skipped_screener_running)', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');

  // Case A: Missing shortlist file + producer running
  const runningPayload = { success: true, status: 'running' };
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(runningPayload)
  });

  try {
    const matResultMissing = await materializer.main(
      { dryRun: false, print: false, output: shortlistFile },
      {
        env: { CRON_SECRET: 'dummy' },
        runDate: '2026-10-06',
        now: new Date('2026-10-06T02:05:00Z'),
        fetchFn: fakeFetch,
        baseUrl: 'http://127.0.0.1:3000',
        log: () => {}
      }
    );
    assert.equal(matResultMissing.ok, true);
    assert.equal(matResultMissing.producer_overlap_reuse, false);
    assert.equal(matResultMissing.counts.rows, 0);

    const depsMissing = baseDeps(root, shortlistFile);
    const fwMissing = await guarded.run(Object.assign({}, depsMissing, { scheduledTime: '09:05' }));
    assert.equal(fwMissing.status, 'skipped_screener_running', 'Missing shortlist must fail closed');
    assert.equal(fwMissing.shortlist_count, 0);

    // Case B: Stale shortlist file (date 2026-09-30 on 2026-10-06) + producer running
    const staleContent = {
      status: 'published',
      run_date: '2026-09-30',
      results: [{ ticker: 'STAL', score: 80 }]
    };
    fs.writeFileSync(shortlistFile, JSON.stringify(staleContent, null, 2));

    const matResultStale = await materializer.main(
      { dryRun: false, print: false, output: shortlistFile },
      {
        env: { CRON_SECRET: 'dummy' },
        runDate: '2026-10-06',
        now: new Date('2026-10-06T02:05:00Z'),
        fetchFn: fakeFetch,
        baseUrl: 'http://127.0.0.1:3000',
        log: () => {}
      }
    );
    assert.equal(matResultStale.ok, true);
    assert.equal(matResultStale.producer_overlap_reuse, false, 'Stale shortlist must NOT be reused');

    const depsStale = baseDeps(root, shortlistFile);
    const fwStale = await guarded.run(Object.assign({}, depsStale, { scheduledTime: '09:05' }));
    assert.equal(fwStale.status, 'skipped_screener_running', 'Stale shortlist overlap must fail closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// 5. Candidate ranking #8 / #10 / #12 dapat masuk internal watch pool
// -------------------------------------------------------------------------
test('FWE-05: Candidate ranking #8, #10, dan #12 dapat masuk internal watch pool', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');

  const tickers = ['TKAA', 'TKAB', 'TKAC', 'TKAD', 'TKAE', 'TKAF', 'TKAG', 'TKAH', 'TKAI', 'TKAJ', 'TKAK', 'TKAL'];
  const candidates = tickers.map((t, i) => fixtureCandidate(t, i + 1));

  fs.writeFileSync(shortlistFile, JSON.stringify({
    status: 'published',
    source: 'test',
    run_date: '2026-10-06',
    results: candidates
  }, null, 2));

  try {
    const deps = baseDeps(root, shortlistFile);
    const result = await guarded.run(Object.assign({}, deps, { scheduledTime: '09:10', maxShortlist: 12 }));

    assert.equal(result.status, 'guarded_live_recorded');
    assert.equal(result.shortlist_count, 12);
    assert.equal(result.active_pool_count, 12);

    const state = JSON.parse(fs.readFileSync(path.join(root, 'state', '2026-10-06.json'), 'utf8'));
    assert.ok(state.tickers['TKAH'], 'Candidate #8 must enter watch pool');
    assert.ok(state.tickers['TKAJ'], 'Candidate #10 must enter watch pool');
    assert.ok(state.tickers['TKAL'], 'Candidate #12 must enter watch pool');
    assert.equal(state.tickers['TKAH'].active, true);
    assert.equal(state.tickers['TKAJ'].active, true);
    assert.equal(state.tickers['TKAL'].active, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// 6. Candidate #13 tidak masuk jika cap = 12
// -------------------------------------------------------------------------
test('FWE-06: Candidate #13 tidak masuk ke watch pool ketika cap = 12', async () => {
  const root = tempDir();
  const shortlistFile = path.join(root, 'fastwatcher-shortlist.json');

  const tickers = [
    'TKAA', 'TKAB', 'TKAC', 'TKAD', 'TKAE', 'TKAF', 'TKAG', 'TKAH', 'TKAI', 'TKAJ',
    'TKAK', 'TKAL', 'TKAM', 'TKAN', 'TKAO'
  ];
  const candidates = tickers.map((t, i) => fixtureCandidate(t, i + 1));

  // Materializer caps usable rows at 12
  const usable = materializer.usableRows(candidates, 12);
  assert.equal(usable.length, 12);
  assert.ok(usable.some((c) => c.ticker === 'TKAL'));
  assert.ok(!usable.some((c) => c.ticker === 'TKAM'), 'usableRows must cap at 12');

  fs.writeFileSync(shortlistFile, JSON.stringify({
    status: 'published',
    source: 'test',
    run_date: '2026-10-06',
    results: candidates
  }, null, 2));

  try {
    const deps = baseDeps(root, shortlistFile);
    const result = await guarded.run(Object.assign({}, deps, { scheduledTime: '09:10', maxShortlist: 12 }));

    assert.equal(result.shortlist_count, 12);
    assert.equal(result.active_pool_count, 12);

    const state = JSON.parse(fs.readFileSync(path.join(root, 'state', '2026-10-06.json'), 'utf8'));
    assert.ok(state.tickers['TKAL'], 'Candidate #12 must be present');
    assert.equal(state.tickers['TKAM'], undefined, 'Candidate #13 must NOT enter watch pool');
    assert.equal(state.tickers['TKAN'], undefined, 'Candidate #14 must NOT enter watch pool');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// 7. Walaupun 12 candidate watched: MAX_PUBLISH_COUNT tetap 3
// -------------------------------------------------------------------------
test('FWE-07: Walaupun 12 kandidat diawasi dan confirmed, MAX_PUBLISH_COUNT tetap strictly 3', () => {
  assert.equal(pool.MAX_PUBLISH_COUNT, 3);
  assert.equal(publisher.MAX_LIVE_PUBLISH, 3);

  const confirmed = [];
  for (let i = 1; i <= 12; i++) {
    confirmed.push({
      ticker: 'T' + String(i).padStart(2, '0'),
      publish_score: 95 - i,
      watch_score: 90 - i,
      shortlist_rank: i
    });
  }

  const publishable = pool.rankPublishable(confirmed);
  assert.equal(publishable.length, 3, 'rankPublishable must cap at strictly 3');
  assert.deepEqual(publishable.map((p) => p.ticker), ['T01', 'T02', 'T03']);
});

// -------------------------------------------------------------------------
// 8. 3-of-5 confirmation tetap wajib
// -------------------------------------------------------------------------
test('FWE-08: 3-of-5 confirmation window tetap wajib untuk konfirmasi READY_CONFIRMED', () => {
  assert.equal(pool.REQUIRED_CONFIRMATIONS, 3);
  assert.equal(pool.CONFIRMATION_WINDOW_SIZE, 5);

  const date = '2026-10-06';
  const row = fixtureCandidate('TEST', 1);

  // Tick 1: 1 pass -> READY_PENDING (not confirmed)
  const p1 = pool.process({
    sampleDate: date,
    scheduledTime: '09:05',
    shortlistRows: [row],
    observations: [fixtureObservation('TEST', '09:05')]
  });
  assert.equal(p1.state.tickers['TEST'].status, 'READY_PENDING');
  assert.equal(p1.state.tickers['TEST'].ready_streak, 1);
  assert.equal(p1.confirmed.length, 0);

  // Tick 2: 2 passes -> READY_PENDING (not confirmed)
  const p2 = pool.process({
    sampleDate: date,
    scheduledTime: '09:10',
    shortlistRows: [row],
    observations: [fixtureObservation('TEST', '09:10')],
    priorState: p1.state
  });
  assert.equal(p2.state.tickers['TEST'].status, 'READY_PENDING');
  assert.equal(p2.state.tickers['TEST'].ready_streak, 2);
  assert.equal(p2.confirmed.length, 0);

  // Tick 3: 3 passes -> READY_CONFIRMED!
  const p3 = pool.process({
    sampleDate: date,
    scheduledTime: '09:15',
    shortlistRows: [row],
    observations: [fixtureObservation('TEST', '09:15')],
    priorState: p2.state
  });
  assert.equal(p3.state.tickers['TEST'].status, 'READY_CONFIRMED');
  assert.equal(p3.state.tickers['TEST'].ready_streak, 3);
  assert.equal(p3.confirmed.length, 1);
  assert.equal(p3.confirmed[0].ticker, 'TEST');
});

// -------------------------------------------------------------------------
// 9. TP1_ALREADY_REACHED tetap BLOCKED_CHASE
// -------------------------------------------------------------------------
test('FWE-09: Ticker yang sudah mencapai TP1 pada sesi berjalan tetap ditolak BLOCKED_CHASE', () => {
  const date = '2026-10-06';
  const row = fixtureCandidate('CHAS', 1, { entry_low: 100, entry_high: 105, tp1: 110, stop_loss: 95 });

  // Observation where high has already reached TP1 (110)
  const obsReached = fixtureObservation('CHAS', '09:10', {
    entry_low: 100,
    entry_high: 105,
    tp1: 110,
    stop_loss: 95,
    current_price: 104,
    high: 111 // high reached above TP1
  });

  const processed = pool.process({
    sampleDate: date,
    scheduledTime: '09:10',
    shortlistRows: [row],
    observations: [obsReached]
  });

  const chaseEvent = processed.events.find((e) => e.ticker === 'CHAS' && e.to_status === 'BLOCKED_CHASE');
  assert.ok(chaseEvent, 'Must record transition to BLOCKED_CHASE');
  assert.ok(chaseEvent.reasons.includes('tp1_already_reached'), 'Reason must include tp1_already_reached');
  assert.equal(processed.state.tickers['CHAS'].active, false, 'Candidate must be terminally dropped from active pool');
  assert.equal(processed.confirmed.length, 0);
  assert.equal(processed.publishable.length, 0);
});

// -------------------------------------------------------------------------
// 10. Above entry tolerance tetap BLOCKED_CHASE
// -------------------------------------------------------------------------
test('FWE-10: Harga di atas adaptive entry tolerance tetap ditolak BLOCKED_CHASE', () => {
  const date = '2026-10-06';
  const row = fixtureCandidate('OVER', 1, { entry_low: 100, entry_high: 102, stop_loss: 96, tp1: 115 });

  // Observation with current_price overextended above entry tolerance
  const obsOver = fixtureObservation('OVER', '09:10', {
    entry_low: 100,
    entry_high: 102,
    stop_loss: 96,
    tp1: 115,
    current_price: 109 // far above entry_high 102
  });

  const processed = pool.process({
    sampleDate: date,
    scheduledTime: '09:10',
    shortlistRows: [row],
    observations: [obsOver]
  });

  const chaseEvent = processed.events.find((e) => e.ticker === 'OVER' && e.to_status === 'BLOCKED_CHASE');
  assert.ok(chaseEvent, 'Must record transition to BLOCKED_CHASE');
  assert.ok(
    chaseEvent.reasons.some((r) => r.includes('entry_tolerance') || r.includes('adaptive_advance_chase')),
    'Must be blocked due to entry tolerance / advance chase'
  );
  assert.equal(processed.state.tickers['OVER'].active, false, 'Candidate must be terminally dropped from active pool');
  assert.equal(processed.confirmed.length, 0);
  assert.equal(processed.publishable.length, 0);
});

// -------------------------------------------------------------------------
// 11. AVOID tetap hard reject
// -------------------------------------------------------------------------
test('FWE-11: Status AVOID tetap hard reject dan tidak pernah masuk watch pool', () => {
  const avoidCandidate = fixtureCandidate('BADS', 1, { status: 'AVOID' });
  const goodCandidate = fixtureCandidate('GOOD', 2, { status: 'READY_BREAKOUT' });

  // Check materializer usableRows
  const filtered = materializer.usableRows([avoidCandidate, goodCandidate], 12);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].ticker, 'GOOD');

  // Check mergePayload
  const merged = pool.mergePayload(
    { status: 'published', results: [avoidCandidate, goodCandidate] },
    null,
    '09:10',
    [fixtureCandidate('SUPP', 3, { status: 'AVOID' })],
    12
  );

  const mergedTickers = merged.results.map((r) => r.ticker);
  assert.ok(!mergedTickers.includes('BADS'), 'AVOID candidate must not enter merged results');
  assert.ok(!mergedTickers.includes('SUPP'), 'AVOID supplemental must not enter merged results');
  assert.ok(mergedTickers.includes('GOOD'));
});

// -------------------------------------------------------------------------
// 12. Preconfirmation/radar tidak mengirim Telegram
// -------------------------------------------------------------------------
test('FWE-12: Radar / preconfirmation tidak mengirim Telegram (kill-switch OFF by default)', async () => {
  let telegramCalled = false;
  const notifyFn = async () => {
    telegramCalled = true;
    return { sent: true };
  };

  const state = {
    schema_version: 3,
    date: '2026-10-06',
    tickers: {
      PADA: {
        active: true,
        status: 'SPIKE_RADAR',
        last_time: '09:10',
        last_watch_score: 70,
        last_publish_score: 75
      }
    }
  };

  // Default env: FAST_WATCHER_RADAR_TELEGRAM_ENABLED is unset
  const res = await radarPublisher.publishRadar({
    candidates: [{ ticker: 'PADA', status: 'SPIKE_RADAR' }],
    state,
    sampleDate: '2026-10-06',
    scheduledTime: '09:10',
    env: { FAST_WATCHER_LIVE_ENABLED: '1' },
    notifyFn
  });

  assert.equal(res.telegram_attempted, false);
  assert.equal(res.telegram_sent, 0);
  assert.equal(telegramCalled, false, 'No Telegram may be sent for radar / preconfirmation');
});

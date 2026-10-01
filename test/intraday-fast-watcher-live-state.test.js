'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const live = require('../lib/intraday-fast-watcher-live');

function makeEngine() {
  return {
    runDayTradeBatch: async batch => ({
      results: batch.map(item => ({
        ticker: item.ticker,
        board: item.board,
        last_price: 100,
        entry_low: 98,
        entry_high: 103,
        tp1: 112,
        tp2: 120,
        stop_loss: 95,
        status: 'READY_BREAKOUT'
      })),
      failed: []
    })
  };
}

function makeCollector() {
  return {
    checkProductionWorkerActive: async () => ({ active: false }),
    buildCandidateRecord: (result, time, rank) => ({
      ticker: result.ticker,
      scheduled_time: time,
      rank,
      current_price: result.last_price,
      entry_low: result.entry_low,
      entry_high: result.entry_high,
      tp1: result.tp1,
      tp2: result.tp2,
      stop_loss: result.stop_loss,
      current_status: result.status,
      freshness: { is_stale: false }
    }),
    deriveDistances: row => row,
    sanitizeRecord: row => row
  };
}

function baseOptions(root, scheduledTime) {
  return {
    sampleDate: '2026-07-29',
    scheduledTime,
    shortlistFile: path.join(root, 'daytrade-last-response.json'),
    stateDir: path.join(root, 'state'),
    eventDir: path.join(root, 'events'),
    observationRoot: path.join(root, 'observations'),
    maxShortlist: 20,
    concurrency: 4,
    readPayload: async () => ({
      status: 'published',
      radar_candidates: ['BBRI']
    }),
    engine: makeEngine(),
    collector: makeCollector(),
    checkProductionWorkerActive: async () => ({ active: false })
  };
}

test('non-dry live mode preserves normalized radar shortlist and persists confirmation state', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-watcher-live-state-'));

  const first = await live.runLiveFastWatcher(baseOptions(root, '09:11'));
  assert.equal(first.status, 'live_shadow_recorded');
  assert.equal(first.shortlist_count, 1);
  assert.equal(first.collection.shortlist_count, 1);
  assert.equal(first.event_count, 1);
  assert.equal(first.events[0].to_status, 'READY_PENDING');

  const stateFile = path.join(root, 'state', '2026-07-29.json');
  const firstState = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  assert.equal(firstState.tickers.BBRI.status, 'READY_PENDING');
  assert.equal(firstState.tickers.BBRI.ready_streak, 1);

  const second = await live.runLiveFastWatcher(baseOptions(root, '09:14'));
  assert.equal(second.status, 'live_shadow_recorded');
  assert.equal(second.shortlist_count, 1);
  assert.equal(second.event_count, 1);
  assert.equal(second.events[0].to_status, 'READY_CONFIRMED');
  assert.deepEqual(second.confirmed, [
    { ticker: 'BBRI', time: '09:14', ready_streak: 2 }
  ]);

  const secondState = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  assert.equal(secondState.tickers.BBRI.status, 'READY_CONFIRMED');
  assert.equal(secondState.tickers.BBRI.ready_streak, 2);
});

test('processor failures are returned without being relabeled as live_shadow_recorded', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-watcher-live-status-'));
  const options = baseOptions(root, '09:11');
  options.processWatcher = async () => ({
    status: 'empty_shortlist',
    error_code: 'processor_shortlist_empty',
    shortlist_count: 0,
    event_count: 0,
    confirmed: []
  });

  const result = await live.runLiveFastWatcher(options);
  assert.equal(result.status, 'empty_shortlist');
  assert.equal(result.error_code, 'processor_shortlist_empty');
  assert.equal(result.collection.status, 'live_shadow_collected');
  assert.equal(result.collection.shortlist_count, 1);
  assert.equal(result.telegram_attempted, false);
  assert.equal(result.production_state_mutated, false);
});

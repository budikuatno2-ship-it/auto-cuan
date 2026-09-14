'use strict';

/**
 * Regression guards for AUDIT_HISTORIS_REGRESI Batch 3 (Temuan #6, #7, #8).
 *
 * Mocked/local only: no network, no Telegram, no production endpoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const earlyWatchPublisher = require('../lib/intraday-fast-watcher-early-watch-publisher');
const radar = require('../lib/intraday-fast-watcher-radar-publisher');
const cache = require('../lib/daytrade-ohlcv-cache');

// ---------------------------------------------------------------------------
// Temuan #6 — Early Watch must not broadcast the engine "Wait - Poor RR" path
// ---------------------------------------------------------------------------

function poolItem(extra) {
  return Object.assign({
    active: true,
    status: 'WATCHING',
    last_reasons: []
  }, extra || {});
}

test('T6: Early Watch blocks the canonical poor-RR source status', () => {
  assert.equal(earlyWatchPublisher.isCurrentlyEarlyWatchEligible(poolItem({ source_status: 'POOR_RR' })), false);
  assert.equal(earlyWatchPublisher.isCurrentlyEarlyWatchEligible(poolItem({ source_status: 'Wait - Poor RR' })), false);
});

test('T6: Early Watch still allows a normal pre-confirmation candidate (score is not the gate)', () => {
  // The reported spam had HIGH scores (84/74) with poor RR, so a score floor
  // would not have caught it — and a score floor would wrongly block the
  // frozen informational TMPO contract. Gate is source-status based only.
  assert.equal(earlyWatchPublisher.isCurrentlyEarlyWatchEligible(poolItem({ source_status: null })), true);
  assert.equal(earlyWatchPublisher.isCurrentlyEarlyWatchEligible(poolItem({})), true);
});

test('T6: Early Watch still refuses non-active / confirmed / terminal statuses', () => {
  assert.equal(earlyWatchPublisher.isCurrentlyEarlyWatchEligible(poolItem({ active: false })), false);
  assert.equal(earlyWatchPublisher.isCurrentlyEarlyWatchEligible(poolItem({ status: 'READY_CONFIRMED' })), false);
  assert.equal(earlyWatchPublisher.isCurrentlyEarlyWatchEligible(null), false);
});

// ---------------------------------------------------------------------------
// Temuan #7 — radar score floor must apply to every non-SPIKE status
// ---------------------------------------------------------------------------

function radarPlan(extra) {
  return Object.assign({
    ticker: 'WIRG',
    status: 'RADAR PRIORITAS — 1/2 KONFIRMASI',
    internal_status: 'READY_PENDING',
    current_price: 100,
    entry_low: 95,
    entry_high: 98,
    tp1: 110,
    stop_loss: 90,
    risk_reward: 1.5,
    watch_score: 60,
    reasons: []
  }, extra || {});
}

test('T7: READY_PENDING below the score floor is rejected (WIRG score 35 leak)', () => {
  assert.equal(radar.validRadarPlan(radarPlan({ watch_score: 35 })), false);
});

test('T7: READY_PENDING with sub-1.0 R/R is rejected (PGAS 0.86x leak)', () => {
  assert.equal(radar.validRadarPlan(radarPlan({ watch_score: 60, risk_reward: 0.86 })), false);
});

test('T7: a candidate at/above both floors is still accepted', () => {
  assert.equal(radar.validRadarPlan(radarPlan({ watch_score: radar.MIN_RADAR_WATCH_SCORE, risk_reward: 1.0 })), true);
});

test('T7: missing R/R does not block (no evidence)', () => {
  assert.equal(radar.validRadarPlan(radarPlan({ watch_score: 70, risk_reward: null })), true);
});

test('T7: the score floor still applies to WAIT_PULLBACK and PENDING_VELOCITY', () => {
  assert.equal(radar.validRadarPlan(radarPlan({ internal_status: 'WAIT_PULLBACK', watch_score: 40 })), false);
  assert.equal(radar.validRadarPlan(radarPlan({ internal_status: 'PENDING_VELOCITY', watch_score: 40 })), false);
});

// ---------------------------------------------------------------------------
// Temuan #8 — candle cache older than the newest broker summary is not fresh
// ---------------------------------------------------------------------------

function candle(date, close) {
  return { time: Math.floor(Date.parse(date + 'T00:00:00Z') / 1000), date, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
}

function candlesThrough(lastDate) {
  const out = [];
  const end = Date.parse(lastDate + 'T00:00:00Z');
  for (let i = 40; i >= 0; i--) out.push(candle(new Date(end - i * 86400000).toISOString().slice(0, 10), 100 + i));
  return out;
}

async function tempCacheDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ohlcv-t8-'));
}

test('T8: with syncWithBrokerSummary on, a candle cache behind the summary is refetched', async () => {
  const dir = await tempCacheDir();
  // Candle series whose newest bar is old, but freshly written (TTL-fresh).
  await cache.writeCache(dir, 'BBCA', candlesThrough('2026-09-01'), 'test');

  let fetched = false;
  const provider = cache.createCacheProvider({
    cacheDir: dir,
    syncWithBrokerSummary: true,
    fetchFn: async () => { fetched = true; return candlesThrough('2026-09-11'); }
  });

  await provider.fetchWithCache('BBCA');
  assert.equal(fetched, true, 'cache behind the broker summary must trigger a refetch');
});

test('T8: with syncWithBrokerSummary OFF, TTL freshness alone still serves the cache', async () => {
  const dir = await tempCacheDir();
  await cache.writeCache(dir, 'BBCA', candlesThrough('2026-09-01'), 'test');

  let fetched = false;
  const provider = cache.createCacheProvider({
    cacheDir: dir,
    fetchFn: async () => { fetched = true; return candlesThrough('2026-09-11'); }
  });

  await provider.fetchWithCache('BBCA');
  assert.equal(fetched, false, 'default (opt-out) behaviour must be unchanged');
});

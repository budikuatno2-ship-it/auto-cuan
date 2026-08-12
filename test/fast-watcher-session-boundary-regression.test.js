'use strict';

// Regression coverage for a confirmed Fast Watcher session-boundary bug:
// runModeForTime() (lib/intraday-fast-watcher-live.js) — the ONLY gate
// collectLiveSnapshot uses to decide whether a scheduled live tick should
// run at all — was a flat, day-of-week-agnostic time-of-day classifier. It
// never consulted lib/intraday-volume-pace.js's tradingSchedule/
// sessionProgress, which already correctly encodes the real IDX calendar:
//   - Mon-Thu: 09:00-12:00 and 13:30-16:00 (lunch break 12:00-13:30)
//   - Friday:  09:00-11:30 and 14:00-16:00 (break 11:30-14:00)
// So a scheduled tick during lunch break (Mon-Thu 12:00-13:30) or during
// Friday's longer break (11:30-14:00) was classified as a VALID run mode
// (MIDDAY_CHECK / AFTERNOON_EXIT) and processed as if it were live market
// time — even though Yahoo would return the same frozen pre-break quote,
// risking a stale snapshot being scored as a fresh confirmation pass.
//
// The fix threads sampleDate into runModeForTime (optional second arg, so
// existing single-arg callers/tests are unaffected) and, when supplied,
// rejects any tick whose real IDX market_state (from the already-correct
// tradingSchedule/sessionProgress) is not ACTIVE_SESSION.

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../lib/intraday-fast-watcher-live');
const volumePace = require('../lib/intraday-volume-pace');

const MONDAY_THU_DATE = '2026-07-28'; // Tuesday
const FRIDAY_DATE = '2026-07-31'; // Friday

test('sanity: 2026-07-28 is a Mon-Thu trading day and 2026-07-31 is a Friday, per intraday-volume-pace', () => {
  assert.ok(volumePace.tradingSchedule(MONDAY_THU_DATE).windows.length, 'expected a Mon-Thu trading day');
  assert.deepEqual(volumePace.tradingSchedule(MONDAY_THU_DATE).windows, [{ start: 540, end: 720 }, { start: 810, end: 960 }]);
  assert.deepEqual(volumePace.tradingSchedule(FRIDAY_DATE).windows, [{ start: 540, end: 690 }, { start: 840, end: 960 }]);
});

test('runModeForTime(time) — single-arg, backward compatible: flat time bands unchanged (existing behavior/tests)', () => {
  assert.equal(live.runModeForTime('09:00'), 'MORNING_SCOUT');
  assert.equal(live.runModeForTime('11:00'), 'MIDDAY_CHECK'); // no date given -> old flat-band behavior, even though 11:00 spans the real lunch break on some days
  assert.equal(live.runModeForTime('13:33'), 'AFTERNOON_EXIT');
  assert.equal(live.runModeForTime('16:01'), null);
});

test('REGRESSION: runModeForTime(time, sampleDate) rejects a Mon-Thu lunch-break tick (12:30) that the flat bands used to accept', () => {
  // Old behavior (proven by the single-arg test above): 12:30 falls in the
  // 10:30-13:30 MIDDAY_CHECK band and was accepted unconditionally.
  assert.equal(live.runModeForTime('12:30'), 'MIDDAY_CHECK', 'sanity: flat bands alone still call this valid');
  assert.equal(live.runModeForTime('12:30', MONDAY_THU_DATE), null, 'date-aware check must reject a real Mon-Thu lunch-break tick');
});

test('REGRESSION: runModeForTime(time, sampleDate) rejects a Friday break-window tick (13:31) that the flat bands used to accept as AFTERNOON_EXIT', () => {
  assert.equal(live.runModeForTime('13:31'), 'AFTERNOON_EXIT', 'sanity: flat bands alone still call this valid');
  assert.equal(live.runModeForTime('13:31', FRIDAY_DATE), null, 'the market does not reopen until 14:00 on Friday — this must be rejected');
});

test('runModeForTime(time, sampleDate) still accepts a genuine active-session tick on both a Mon-Thu day and a Friday', () => {
  assert.equal(live.runModeForTime('09:30', MONDAY_THU_DATE), 'MORNING_SCOUT');
  assert.equal(live.runModeForTime('14:30', MONDAY_THU_DATE), 'AFTERNOON_EXIT');
  assert.equal(live.runModeForTime('10:00', FRIDAY_DATE), 'MORNING_SCOUT');
  assert.equal(live.runModeForTime('14:30', FRIDAY_DATE), 'AFTERNOON_EXIT');
});

test('runModeForTime(time, sampleDate) rejects a weekend sampleDate outright', () => {
  assert.equal(live.runModeForTime('10:00', '2026-08-01'), null); // Saturday
});

test('REGRESSION: collectLiveSnapshot end-to-end rejects a Mon-Thu lunch-break scheduledTime with outside_supported_market_window', async () => {
  const result = await live.collectLiveSnapshot({
    sampleDate: MONDAY_THU_DATE, scheduledTime: '12:45', shortlistFile: 'ignored',
    checkProductionWorkerActive: async () => ({ active: false })
  });
  assert.equal(result.status, 'invalid_input');
  assert.equal(result.error_code, 'outside_supported_market_window');
  assert.equal(result.observations.length, 0);
});

test('collectLiveSnapshot still proceeds normally for a genuine active-session scheduledTime', async () => {
  const fakeEngine = {
    runDayTradeBatch: async (batch) => ({
      results: batch.map((item) => ({
        ticker: item.ticker, board: item.board, last_price: 100,
        entry_low: 98, entry_high: 103, tp1: 112, tp2: 120,
        stop_loss: 95, status: 'READY_BREAKOUT', daytrade_score: 80,
        volume_today: 1000, avg_volume_20d: 500, volume_ratio_20d: 2
      })),
      failed: []
    })
  };
  const fakeCollector = {
    checkProductionWorkerActive: async () => ({ active: false }),
    fetchWithFreshnessFallback: async () => ({ candles: Array.from({ length: 20 }, () => ({ open: 1, high: 2, low: 1, close: 2, volume: 1 })), freshness: { is_stale: false } }),
    buildCandidateRecord: (result, time, rank, freshness) => ({
      ticker: result.ticker, scheduled_time: time, rank,
      current_price: result.last_price, entry_low: result.entry_low, entry_high: result.entry_high,
      tp1: result.tp1, tp2: result.tp2, sl: result.stop_loss,
      current_status: result.status, freshness
    }),
    deriveDistances: (row) => row,
    sanitizeRecord: (row) => row
  };
  const payload = { results: [{ ticker: 'BBRI', board: 'UTAMA', score: 100 }] };
  const result = await live.collectLiveSnapshot({
    sampleDate: MONDAY_THU_DATE, scheduledTime: '09:09', shortlistFile: 'ignored',
    maxShortlist: 5, concurrency: 4, dryRun: true,
    readPayload: async () => payload, engine: fakeEngine, collector: fakeCollector,
    checkProductionWorkerActive: async () => ({ active: false })
  });
  assert.equal(result.status, 'live_shadow_dry_run');
  assert.equal(result.completed_count, 1);
});

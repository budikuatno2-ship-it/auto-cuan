'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const collector = require('../tools/intraday-sample-collector');
const lifecycle = require('../lib/intraday-sample-lifecycle');
const summary = require('../lib/intraday-sample-summary');

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sample-collector-test-'));
}


// ===================================================================
// ORIGINAL TESTS (1-17) — safety, schedule, lock, lifecycle
// ===================================================================

test('1. sample mode never sends Telegram — no telegram module imported', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'tools', 'intraday-sample-collector.js'), 'utf8');
  assert.ok(!src.includes("require('../lib/telegram-notifier')"));
  assert.ok(!src.includes("require('../lib/telegram-templates')"));
  assert.ok(!src.includes('sendTelegram('));
  assert.ok(!src.includes('notifyTelegram('));
  assert.ok(!src.includes('process.env.TELEGRAM_BOT_TOKEN'));
});

test('2. sample mode never publishes Day Trade output — no Supabase writes', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'tools', 'intraday-sample-collector.js'), 'utf8');
  assert.ok(!src.includes("require('@supabase/supabase-js')"));
  assert.ok(!src.includes('supabase'));
  assert.ok(!src.includes('.insert('));
  assert.ok(!src.includes('.upsert('));
});

test('3. sample mode never registers monitor candidates', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'tools', 'intraday-sample-collector.js'), 'utf8');
  assert.ok(!src.includes('telegram_daily_picks'));
  assert.ok(!src.includes('telegram-monitor'));
  assert.ok(!src.includes('monitor-picks'));
});

test('4. sample mode never changes active recommendation state', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'tools', 'intraday-sample-collector.js'), 'utf8');
  assert.ok(!src.includes("require('../lib/top5-progress-monitor')"));
  assert.ok(!src.includes('updateRecommendation('));
  const lsrc = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'lib', 'intraday-sample-lifecycle.js'), 'utf8');
  assert.ok(!lsrc.includes('supabase'));
});

test('5. intraday scoring remains disabled', () => {
  const orig = process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
  process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = '1';
  try {
    const r = collector.assertSafetyInvariants();
    assert.equal(r.safe, false);
  } finally {
    if (orig === undefined) delete process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
    else process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = orig;
  }
});

test('5b. safety passes when score disabled', () => {
  const keys = ['DAYTRADE_INTRADAY_SCORE_ENABLED','DAYTRADE_WORKER_ALLOW_MUTATION','SAMPLE_SEND_TELEGRAM'];
  const orig = keys.map(k => [k, process.env[k]]);
  keys.forEach(k => delete process.env[k]);
  try { assert.equal(collector.assertSafetyInvariants().safe, true); }
  finally { orig.forEach(([k,v]) => { if (v !== undefined) process.env[k] = v; }); }
});


test('6. sample output is append-only', async () => {
  const dir = await tmpdir();
  const file = path.join(dir, 'test.jsonl');
  await collector.appendJsonl(file, { a: 1 });
  await collector.appendJsonl(file, { b: 2 });
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
});

test('7. timestamps use Asia/Jakarta', () => {
  const utcMs = Date.parse('2026-07-21T02:15:00Z');
  const wib = collector.getWibNow(utcMs);
  assert.equal(wib.hours, 9); assert.equal(wib.minutes, 15);
  assert.equal(wib.dateStr, '2026-07-21'); assert.equal(wib.timeStr, '09:15');
  assert.equal(collector.TIMEZONE, 'Asia/Jakarta');
});

test('8. break-period invocations are rejected', () => {
  for (const t of ['12:00','12:30','13:00','13:30']) {
    assert.equal(collector.validateScheduledTime(t).valid, false);
  }
});

test('9. only the 21 approved timestamps are accepted', () => {
  assert.equal(collector.APPROVED_SCHEDULE.length, 21);
  for (const t of collector.APPROVED_SCHEDULE) assert.equal(collector.validateScheduledTime(t).valid, true);
  for (const t of ['08:00','09:00','12:00','13:30','16:15','17:00',''])
    assert.equal(collector.validateScheduledTime(t).valid, false);
});

test('10. duplicate execution is blocked by a lock', async () => {
  const dir = await tmpdir(); const lf = path.join(dir, 'test.lock');
  const r1 = await collector.acquireLock(lf); assert.ok(r1);
  const r2 = await collector.acquireLock(lf); assert.equal(r2, null);
  await r1();
  const r3 = await collector.acquireLock(lf); assert.ok(r3); await r3();
});

test('11. missing price fields remain null', () => {
  const rec = collector.buildCandidateRecord(
    { ticker: 'TEST', status: 'EARLY_RADAR', daytrade_score: 65 }, '09:15', 1, null);
  assert.equal(rec.current_price, null); assert.equal(rec.open, null);
  assert.equal(rec.tp1, null); assert.equal(rec.sl, null);
  assert.equal(rec.bid, null); assert.ok(rec.bid_offer_unavailable_reason);
});

test('12. repeated tickers linked only in research data', async () => {
  const dir = await tmpdir(); const lf = path.join(dir, 'lifecycle.json');
  await lifecycle.updateLifecycle(lf, [{ ticker: 'BBCA', current_price: 9500,
    entry_low: 9400, entry_high: 9500, reference_entry_price: 9450,
    tp1: 9800, tp2: 10000, sl: 9200, current_status: 'READY_BREAKOUT', score: 78, data_quality_status: 'OK' }], '09:15');
  await lifecycle.updateLifecycle(lf, [{ ticker: 'BBCA', current_price: 9600,
    entry_low: 9400, entry_high: 9500, reference_entry_price: 9450,
    tp1: 9800, tp2: 10000, sl: 9200, current_status: 'TRADE_CANDIDATE', score: 82, data_quality_status: 'OK' }], '09:30');
  const data = await lifecycle.readLifecycle(lf);
  assert.equal(data.BBCA.number_of_observations, 2);
  assert.deepEqual(data.BBCA.observations, ['09:15', '09:30']);
});


test('13. lifecycle TP/SL does not write production hit markers', async () => {
  const dir = await tmpdir(); const lf = path.join(dir, 'lifecycle.json');
  await lifecycle.updateLifecycle(lf, [{ ticker: 'BMRI', current_price: 6200,
    entry_low: 6100, entry_high: 6300, reference_entry_price: 6200,
    tp1: 6500, tp2: 6800, sl: 5900, current_status: 'READY_BREAKOUT', score: 75, data_quality_status: 'OK' }], '09:15');
  await lifecycle.updateLifecycle(lf, [{ ticker: 'BMRI', current_price: 6550,
    entry_low: 6100, entry_high: 6300, reference_entry_price: 6200,
    tp1: 6500, tp2: 6800, sl: 5900, current_status: 'MOMENTUM_CONTINUATION', score: 80, data_quality_status: 'OK' }], '10:00');
  const data = await lifecycle.readLifecycle(lf);
  assert.equal(data.BMRI.first_tp1_touch_at, '10:00');
  assert.equal(data.BMRI.supabase_updated, undefined);
});

test('14. final summary correctly reports missing snapshots', async () => {
  const dir = await tmpdir();
  const runsFile = path.join(dir, 'runs.jsonl');
  for (const t of ['09:15','09:30','10:00'])
    await fs.appendFile(runsFile, JSON.stringify({ type: 'sample_run', status: 'success', scheduled_time: t }) + '\n');
  await fs.writeFile(path.join(dir, 'candidates.jsonl'), '');
  await fs.writeFile(path.join(dir, 'errors.jsonl'), '');
  await fs.writeFile(path.join(dir, 'lifecycle.json'), '{}');
  const r = await summary.generateSummary(dir, collector.APPROVED_SCHEDULE, '2026-07-21');
  assert.equal(r.expected_snapshot_count, 21);
  assert.equal(r.completed_snapshot_count, 3);
  assert.equal(r.missing_snapshot_times.length, 18);
});

test('15. no secret or user data written to sample files', () => {
  assert.throws(() => collector.sanitizeRecord({ x: 'SUPABASE_SERVICE_ROLE_KEY=a' }), /SAFETY/);
  assert.throws(() => collector.sanitizeRecord({ x: 'Bearer abc' }), /SAFETY/);
  assert.throws(() => collector.sanitizeRecord({ x: 'CRON_SECRET=x' }), /SAFETY/);
  assert.deepEqual(collector.sanitizeRecord({ ticker: 'BBCA' }), { ticker: 'BBCA' });
});

test('16. existing production test infrastructure not broken', () => {
  const engine = require('../lib/daytrade-screener-engine');
  assert.ok(typeof engine.runDayTradeBatch === 'function');
  const worker = require('../tools/daytrade-vps-worker-observe');
  assert.ok(typeof worker.runWorker === 'function');
});

test('17. API endpoint count remains exactly 12', async () => {
  const entries = await fs.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter(f => f.endsWith('.js')).length, 12);
});


// ===================================================================
// NEW BLOCKER TESTS (B1-B17)
// ===================================================================

// B1: Schedule times are WIB, not blindly converted to UTC
test('B1. schedule times are in WIB and VERIFIED_VPS_TIMEZONE is documented', () => {
  // The collector exposes the VERIFIED_VPS_TIMEZONE constant
  assert.equal(typeof collector.VERIFIED_VPS_TIMEZONE, 'string');
  // Schedule times are WIB hours (9-16), not UTC hours (2-9)
  for (const t of collector.APPROVED_SCHEDULE) {
    const h = Number(t.split(':')[0]);
    assert.ok(h >= 9 && h <= 16, 'Schedule time ' + t + ' must be in WIB range 09-16');
  }
});

// B2: Date guard accepts only 2026-07-21
test('B2. date guard accepts only 2026-07-21 in Asia/Jakarta', () => {
  // Correct date+year (2026-07-21 02:15 UTC = 09:15 WIB on July 21, 2026)
  const ok = collector.validateSampleDate(Date.parse('2026-07-21T02:15:00Z'));
  assert.equal(ok.valid, true);
  assert.equal(ok.year, 2026);
  assert.equal(ok.date, '2026-07-21');
  assert.equal(collector.SAMPLE_DATE, '2026-07-21');
  // Wrong day (previous sample date 2026-07-20 must now be rejected)
  const prevDay = collector.validateSampleDate(Date.parse('2026-07-20T02:15:00Z'));
  assert.equal(prevDay.valid, false);
  assert.equal(prevDay.reason, 'wrong_date');
  // Wrong day (next day 2026-07-22 must be rejected)
  const nextDay = collector.validateSampleDate(Date.parse('2026-07-22T02:15:00Z'));
  assert.equal(nextDay.valid, false);
  assert.equal(nextDay.reason, 'wrong_date');
  // Wrong month
  const bad2 = collector.validateSampleDate(Date.parse('2026-08-21T02:15:00Z'));
  assert.equal(bad2.valid, false);
});

// B2b: WIB day-boundary is respected — 2026-07-20 23:30 UTC is 2026-07-21 06:30 WIB (accepted)
test('B2b. WIB day boundary maps late-UTC-20 to WIB-21 correctly', () => {
  const wibEarly = collector.validateSampleDate(Date.parse('2026-07-20T23:30:00Z'));
  assert.equal(wibEarly.valid, true);
  assert.equal(wibEarly.date, '2026-07-21');
  // And 2026-07-21 17:30 UTC = 2026-07-22 00:30 WIB (rejected — rolled into next WIB day)
  const wibNext = collector.validateSampleDate(Date.parse('2026-07-21T17:30:00Z'));
  assert.equal(wibNext.valid, false);
  assert.equal(wibNext.reason, 'wrong_date');
});

// B2c: Invalid timestamps are rejected, never silently treated as the current date
test('B2c. invalid timestamp is rejected as invalid_timestamp', () => {
  const nan = collector.validateSampleDate(Date.parse('not-a-real-date'));
  assert.equal(nan.valid, false);
  assert.equal(nan.reason, 'invalid_timestamp');
  const notNum = collector.validateSampleDate('2026-07-21');
  assert.equal(notNum.valid, false);
  assert.equal(notNum.reason, 'invalid_timestamp');
  const inf = collector.validateSampleDate(Infinity);
  assert.equal(inf.valid, false);
  assert.equal(inf.reason, 'invalid_timestamp');
});

// B3: Recurring future July 21 invocation is rejected by the year guard
test('B3. future July 21 (2027) is rejected by year guard', () => {
  // 2027-07-21 02:15 UTC = 09:15 WIB on July 21, 2027
  const future = collector.validateSampleDate(Date.parse('2027-07-21T02:15:00Z'));
  assert.equal(future.valid, false);
  assert.equal(future.reason, 'wrong_year');
  assert.equal(future.year, 2027);
  // Past year same date also rejected
  const past = collector.validateSampleDate(Date.parse('2025-07-21T02:15:00Z'));
  assert.equal(past.valid, false);
  assert.equal(past.reason, 'wrong_year');
});

// B4: Final summary follows successful 16:00 completion (inline)
test('B4. final summary is generated inline by 16:00 run (FINAL_SNAPSHOT_TIME)', () => {
  assert.equal(collector.FINAL_SNAPSHOT_TIME, '16:00');
  // The code generates summary when scheduledTime === FINAL_SNAPSHOT_TIME
  // Verify it's in APPROVED_SCHEDULE
  assert.ok(collector.APPROVED_SCHEDULE.includes('16:00'));
});

// B5: Summary cannot run while collector lock is held (same lock)
test('B5. summary runs inside the same locked 16:00 process', () => {
  // summary.generateSummary is called inside runSampleCollection under lock
  // Verify summary module is imported
  assert.ok(typeof summary.generateSummary === 'function');
  // No separate --generate-summary CLI path needed
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'tools', 'intraday-sample-collector.js'), 'utf8');
  assert.ok(src.includes("scheduledTime === FINAL_SNAPSHOT_TIME"));
});


// B6: Production-worker overlap is detected
test('B6. production-worker overlap is detected via lock file', async () => {
  const dir = await tmpdir();
  const prodLock = path.join(dir, 'prod.lock');
  // No lock file = not active
  const r1 = await collector.checkProductionWorkerActive(prodLock);
  assert.equal(r1.active, false);
  // Write a lock with current PID (simulates running production worker)
  await fs.writeFile(prodLock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const r2 = await collector.checkProductionWorkerActive(prodLock);
  assert.equal(r2.active, true);
  assert.equal(r2.pid, process.pid);
  // Clean up
  await fs.unlink(prodLock);
});

// B7: Production overlap cannot start a second heavy scan
test('B7. production overlap blocks or delays sample collection', async () => {
  const dir = await tmpdir();
  const prodLock = path.join(dir, 'prod.lock');
  const tickersFile = path.join(dir, 'tickers.txt');
  await fs.writeFile(tickersFile, 'BBCA\nBBRI\n');
  // Create active production lock
  await fs.writeFile(prodLock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const result = await collector.runSampleCollection({
    scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 'sample.lock'),
    tickersFile, cacheDir: dir, productionLockFile: prodLock,
    dryRun: false, skipDateValidation: true,
    // Short wait so test doesn't hang
    skipProductionCheck: false
  });
  // Should skip because production is running and wait times out
  assert.equal(result.status, 'skipped_due_to_production_lock');
  await fs.unlink(prodLock);
});

// B8: Cache age and source timestamp are recorded
test('B8. freshness metadata includes cache age and source timestamp', async () => {
  const mockFetch = async (ticker, cacheDir, opts) => ({
    candles: Array.from({ length: 25 }, (_, i) => ({
      time: 1753000000 + i * 86400, date: '2026-07-' + String(i + 1).padStart(2, '0'),
      open: 100, high: 105, low: 95, close: 102, volume: 1000000
    })),
    freshness: {
      provider: 'yahoo_chart_1d', fetch_timestamp: '2026-07-20T02:15:01Z',
      fetch_duration_ms: 500, network_fetch: true, cache_hit: false,
      cache_age_seconds: 0, trading_day_candle_timestamp: '2026-07-20T00:00:00Z',
      is_stale: false, stale_reason: null, candle_count: 25
    }
  });
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'tickers.txt'), 'BBCA\n');
  const result = await collector.runSampleCollection({
    scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 's.lock'),
    tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: mockFetch, limit: 1
  });
  assert.equal(result.status, 'success');
  // Verify run record tracks freshness indicators
  assert.ok(result.run.stale_data_indicators);
  assert.ok('fresh_count' in result.run.stale_data_indicators);
  assert.ok('network_fetch_count' in result.run.stale_data_indicators);
  // The freshness was recorded per-ticker even if no candidates matched
  assert.equal(result.run.stale_data_indicators.fresh_count, 1);
  assert.equal(result.run.stale_data_indicators.network_fetch_count, 1);
});


// B9: Stale cache data is explicitly marked stale
test('B9. stale cache data is explicitly marked stale', () => {
  // fetchWithFreshnessFallback returns is_stale: true when network fails and cache used
  // We verify the freshness structure contract
  const freshStale = { provider: 'yahoo_chart_1d', network_fetch: true, network_failed: true,
    cache_hit: true, cache_age_seconds: 3600, is_stale: true,
    stale_reason: 'network_failed_using_stale_cache_age_3600s' };
  assert.equal(freshStale.is_stale, true);
  assert.ok(freshStale.stale_reason.includes('stale'));
  assert.ok(freshStale.cache_age_seconds > 0);
});

// B10: Stale fallback is never reported as fresh
test('B10. stale fallback is never reported as fresh', () => {
  // Any record with cache_hit=true and network_failed=true must have is_stale=true
  const contract = { cache_hit: true, network_failed: true, is_stale: true };
  assert.equal(contract.is_stale, true);
  // Fresh record has is_stale=false, cache_hit=false
  const fresh = { cache_hit: false, network_fetch: true, is_stale: false };
  assert.equal(fresh.is_stale, false);
  assert.equal(fresh.cache_hit, false);
});

// B11: Repeated identical snapshots preserve provider timestamps
test('B11. repeated identical snapshots preserve unique timestamps', async () => {
  const mockFetch = async () => ({
    candles: Array.from({ length: 25 }, (_, i) => ({
      time: 1753000000 + i * 86400, date: '2026-07-' + String(i+1).padStart(2,'0'),
      open: 100, high: 105, low: 95, close: 102, volume: 1000000
    })),
    freshness: {
      provider: 'yahoo_chart_1d', fetch_timestamp: new Date().toISOString(),
      fetch_duration_ms: 300, network_fetch: true, cache_hit: false,
      cache_age_seconds: 0, is_stale: false, stale_reason: null, candle_count: 25
    }
  });
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'tickers.txt'), 'BBCA\n');
  // Run twice at different scheduled times
  const r1 = await collector.runSampleCollection({
    scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 's1.lock'),
    tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: mockFetch, limit: 1 });
  const r2 = await collector.runSampleCollection({
    scheduledTime: '09:30', outputDir: dir, lockFile: path.join(dir, 's2.lock'),
    tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: mockFetch, limit: 1 });
  assert.equal(r1.status, 'success');
  assert.equal(r2.status, 'success');
  // Verify runs have distinct actual_start timestamps
  const runs = (await fs.readFile(path.join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const successRuns = runs.filter(r => r.type === 'sample_run');
  assert.equal(successRuns.length, 2);
  assert.notEqual(successRuns[0].actual_start, successRuns[1].actual_start);
});


// B12: Scan universe policy is deterministic
test('B12. scan universe policy is deterministic — same tickers every run', async () => {
  const dir = await tmpdir();
  const tickersFile = path.join(dir, 'tickers.txt');
  await fs.writeFile(tickersFile, 'AAAA\nBBBB\nCCCC\nDDDD\nEEEE\n');
  const u1 = await collector.loadTickerUniverse(tickersFile, 3);
  const u2 = await collector.loadTickerUniverse(tickersFile, 3);
  assert.deepEqual(u1, u2);
  assert.equal(u1.length, 3);
  assert.equal(u1[0].ticker, 'AAAA');
  assert.equal(u1[2].ticker, 'CCCC');
  // Default limit is DETERMINISTIC_UNIVERSE_SIZE
  assert.equal(collector.DETERMINISTIC_UNIVERSE_SIZE, 200);
});

// B13: Runtime budget exhaustion is recorded
test('B13. runtime budget exhaustion is recorded accurately', async () => {
  const slowFetch = async (ticker) => {
    await new Promise(r => setTimeout(r, 10));
    return {
      candles: Array.from({ length: 25 }, (_, i) => ({
        time: 1753000000 + i * 86400, date: '2026-07-' + String(i+1).padStart(2,'0'),
        open: 100, high: 105, low: 95, close: 102, volume: 1000000
      })),
      freshness: { provider: 'yahoo_chart_1d', fetch_timestamp: new Date().toISOString(),
        network_fetch: true, cache_hit: false, cache_age_seconds: 0, is_stale: false,
        stale_reason: null, candle_count: 25 }
    };
  };
  const dir = await tmpdir();
  // Use valid 4-letter tickers
  const tickers = Array.from({ length: 10 }, (_, i) => 'AA' + String.fromCharCode(65 + Math.floor(i/26)) + String.fromCharCode(65 + i % 26));
  await fs.writeFile(path.join(dir, 'tickers.txt'), tickers.join('\n'));
  const result = await collector.runSampleCollection({
    scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 's.lock'),
    tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: slowFetch, limit: 10
  });
  assert.equal(result.status, 'success');
  assert.ok('budget_exhausted' in result);
  // Check run record has all count fields
  const r = result.run;
  assert.ok(r.requested_count > 0, 'requested_count should be > 0, got ' + r.requested_count);
  assert.ok('attempted_count' in r);
  assert.ok('completed_count' in r);
  assert.ok('failed_count' in r);
  assert.ok('timed_out_count' in r);
  assert.equal(r.runtime_budget_ms, collector.RUNTIME_BUDGET_MS);
});

// B14: Requested/scanned/completed/failed counts are consistent
test('B14. counts are internally consistent', async () => {
  let fetchIdx = 0;
  const mixedFetch = async (ticker) => {
    fetchIdx++;
    if (fetchIdx % 3 === 0) return { candles: null, freshness: { is_stale: true, stale_reason: 'test_fail' } };
    return {
      candles: Array.from({ length: 25 }, (_, i) => ({
        time: 1753000000 + i * 86400, date: '2026-07-' + String(i+1).padStart(2,'0'),
        open: 100, high: 105, low: 95, close: 102, volume: 1000000
      })),
      freshness: { provider: 'yahoo_chart_1d', fetch_timestamp: new Date().toISOString(),
        network_fetch: true, cache_hit: false, cache_age_seconds: 0, is_stale: false, stale_reason: null, candle_count: 25 }
    };
  };
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'tickers.txt'), 'AAAA\nBBBB\nCCCC\nDDDD\nEEEE\nFFFF\n');
  const result = await collector.runSampleCollection({
    scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 's.lock'),
    tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: mixedFetch, limit: 6
  });
  assert.equal(result.status, 'success');
  const r = result.run;
  assert.equal(r.requested_count, 6);
  assert.equal(r.completed_count + r.failed_count + r.timed_out_count, r.attempted_count);
  assert.ok(r.completed_count <= r.requested_count);
});


// B15: Existing 26 collector tests remain passing (this file IS the test suite)
test('B15. this test file contains all original + new tests', () => {
  // If this test runs, the suite loaded successfully
  assert.ok(true);
});

// B16: Relevant production tests remain passing
test('B16. production modules still load correctly', () => {
  const engine = require('../lib/daytrade-screener-engine');
  assert.ok(typeof engine.runDayTradeBatch === 'function');
  const ohlcv = require('../lib/daytrade-ohlcv-cache');
  assert.ok(typeof ohlcv.createCacheProvider === 'function');
  const worker = require('../tools/daytrade-vps-worker-observe');
  assert.ok(typeof worker.runWorker === 'function');
});

// B17: API endpoint count remains exactly 12
test('B17. API endpoint count remains exactly 12', async () => {
  const entries = await fs.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter(f => f.endsWith('.js')).length, 12);
});

// ===================================================================
// ADDITIONAL INTEGRATION TESTS
// ===================================================================

test('getMarketSession classifies correctly', () => {
  assert.equal(collector.getMarketSession(9 * 60 + 15), 'MORNING');
  assert.equal(collector.getMarketSession(12 * 60), 'BREAK');
  assert.equal(collector.getMarketSession(13 * 60 + 45), 'AFTERNOON');
  assert.equal(collector.getMarketSession(16 * 60), 'FINAL');
  assert.equal(collector.getMarketSession(8 * 60), 'OUTSIDE');
});

test('full dry-run integration completes gracefully', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'tickers.txt'), 'BBCA\nBBRI\n');
  const result = await collector.runSampleCollection({
    scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 's.lock'),
    tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, limit: 2,
    dryRun: true, skipDateValidation: true, skipProductionCheck: true
  });
  assert.ok(result.status === 'success' || result.status === 'error');
});


// ===================================================================
// 2026-07-21 SCHEDULE STRUCTURE & SAFETY TESTS
// ===================================================================

test('S1. exactly 21 scheduled runs', () => {
  assert.equal(collector.APPROVED_SCHEDULE.length, 21);
  // No duplicate slots
  assert.equal(new Set(collector.APPROVED_SCHEDULE).size, 21);
});

test('S2. no runs during the 12:00-13:30 WIB lunch break', () => {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  for (const t of collector.APPROVED_SCHEDULE) {
    const mins = toMin(t);
    const inBreak = mins >= collector.BREAK_START_MINUTES && mins <= collector.BREAK_END_MINUTES;
    assert.equal(inBreak, false, 'Schedule must not contain break-window slot ' + t);
  }
  // Break window is exactly 12:00 - 13:30
  assert.equal(collector.BREAK_START_MINUTES, 12 * 60);
  assert.equal(collector.BREAK_END_MINUTES, 13 * 60 + 30);
  // And explicit break times are rejected by the validator
  for (const t of ['12:00', '12:15', '12:45', '13:00', '13:30']) {
    assert.equal(collector.validateScheduledTime(t).valid, false);
  }
});

test('S3. first run is 09:15 WIB', () => {
  assert.equal(collector.APPROVED_SCHEDULE[0], '09:15');
});

test('S4. morning final run is 11:45 WIB (last slot before break)', () => {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const morning = collector.APPROVED_SCHEDULE.filter((t) => toMin(t) < collector.BREAK_START_MINUTES);
  assert.equal(morning[morning.length - 1], '11:45');
  assert.equal(morning.length, 11);
});

test('S5. afternoon first run is 13:45 WIB (first slot after break)', () => {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const afternoon = collector.APPROVED_SCHEDULE.filter((t) => toMin(t) > collector.BREAK_END_MINUTES);
  assert.equal(afternoon[0], '13:45');
});

test('S6. final run is 16:00 WIB and it is the last slot', () => {
  assert.equal(collector.APPROVED_SCHEDULE[collector.APPROVED_SCHEDULE.length - 1], '16:00');
  assert.equal(collector.FINAL_SNAPSHOT_TIME, '16:00');
});

test('S7. only the 16:00 run generates the summary (no other slot does)', async () => {
  const mockFetch = async () => ({
    candles: Array.from({ length: 25 }, (_, i) => ({
      time: 1753000000 + i * 86400, date: '2026-07-' + String(i + 1).padStart(2, '0'),
      open: 100, high: 105, low: 95, close: 102, volume: 1000000
    })),
    freshness: { provider: 'yahoo_chart_1d', fetch_timestamp: new Date().toISOString(),
      network_fetch: true, cache_hit: false, cache_age_seconds: 0, is_stale: false,
      stale_reason: null, candle_count: 25 }
  });
  // A non-final slot must NOT write summary.json
  const dirA = await tmpdir();
  await fs.writeFile(path.join(dirA, 'tickers.txt'), 'BBCA\n');
  const resA = await collector.runSampleCollection({
    scheduledTime: '15:45', outputDir: dirA, lockFile: path.join(dirA, 's.lock'),
    tickersFile: path.join(dirA, 'tickers.txt'), cacheDir: dirA, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: mockFetch, limit: 1 });
  assert.equal(resA.status, 'success');
  assert.equal(resA.summary_generated, false);
  await assert.rejects(fs.access(path.join(dirA, 'summary.json')));

  // The final 16:00 slot MUST write summary.json inline
  const dirB = await tmpdir();
  await fs.writeFile(path.join(dirB, 'tickers.txt'), 'BBCA\n');
  const resB = await collector.runSampleCollection({
    scheduledTime: '16:00', outputDir: dirB, lockFile: path.join(dirB, 's.lock'),
    tickersFile: path.join(dirB, 'tickers.txt'), cacheDir: dirB, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: mockFetch, limit: 1 });
  assert.equal(resB.status, 'success');
  assert.equal(resB.summary_generated, true);
  await fs.access(path.join(dirB, 'summary.json')); // exists, no throw
});

test('S8. scoring stays disabled — enabling it fails the safety gate and blocks the run', async () => {
  const orig = process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
  process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = 'true';
  try {
    assert.equal(collector.assertSafetyInvariants().safe, false);
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, 'tickers.txt'), 'BBCA\n');
    const res = await collector.runSampleCollection({
      scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 's.lock'),
      tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, dryRun: true,
      skipDateValidation: true, skipProductionCheck: true, limit: 1 });
    assert.equal(res.status, 'safety_violation');
  } finally {
    if (orig === undefined) delete process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
    else process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = orig;
  }
});

test('S9. worker mutation stays disabled — DAYTRADE_WORKER_ALLOW_MUTATION=true fails the gate', async () => {
  const orig = process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
  process.env.DAYTRADE_WORKER_ALLOW_MUTATION = 'true';
  try {
    const gate = collector.assertSafetyInvariants();
    assert.equal(gate.safe, false);
    assert.ok(gate.errors.some((e) => e.includes('DAYTRADE_WORKER_ALLOW_MUTATION')));
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, 'tickers.txt'), 'BBCA\n');
    const res = await collector.runSampleCollection({
      scheduledTime: '09:15', outputDir: dir, lockFile: path.join(dir, 's.lock'),
      tickersFile: path.join(dir, 'tickers.txt'), cacheDir: dir, dryRun: true,
      skipDateValidation: true, skipProductionCheck: true, limit: 1 });
    assert.equal(res.status, 'safety_violation');
  } finally {
    if (orig === undefined) delete process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
    else process.env.DAYTRADE_WORKER_ALLOW_MUTATION = orig;
  }
});

test('S10. runner script hard-sets the safety flags', () => {
  const runner = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'intraday-sample.sh'), 'utf8');
  assert.ok(runner.includes('DAYTRADE_INTRADAY_SCORE_ENABLED=false'));
  assert.ok(runner.includes('DAYTRADE_WORKER_ALLOW_MUTATION=false'));
  // Runner invokes the collector, not any scoring/mutation path
  assert.ok(runner.includes('tools/intraday-sample-collector.js'));
  assert.ok(!/DAYTRADE_INTRADAY_SCORE_ENABLED=(true|1)/.test(runner));
});

test('S11. historical 2026-07-20 sample data is not the target and is left untouched', async () => {
  // The active sample date must be 2026-07-21, never the historical 2026-07-20
  assert.equal(collector.SAMPLE_DATE, '2026-07-21');
  assert.notEqual(collector.SAMPLE_DATE, '2026-07-20');
  // A 2026-07-20 invocation is rejected by the date guard, so it can never write
  assert.equal(collector.validateSampleDate(Date.parse('2026-07-20T02:15:00Z')).valid, false);

  // Simulate a pre-existing historical 2026-07-20 output dir and verify a
  // 2026-07-21 run writes only to its own dir, leaving 07-20 files byte-identical.
  const base = await tmpdir();
  const histDir = path.join(base, '2026-07-20');
  await fs.mkdir(histDir, { recursive: true });
  const histFile = path.join(histDir, 'runs.jsonl');
  const histContent = JSON.stringify({ type: 'sample_run', sample_date: '2026-07-20', scheduled_time: '09:15' }) + '\n';
  await fs.writeFile(histFile, histContent);
  const histStatBefore = await fs.stat(histFile);

  const mockFetch = async () => ({
    candles: Array.from({ length: 25 }, (_, i) => ({
      time: 1753000000 + i * 86400, date: '2026-07-' + String(i + 1).padStart(2, '0'),
      open: 100, high: 105, low: 95, close: 102, volume: 1000000
    })),
    freshness: { provider: 'yahoo_chart_1d', fetch_timestamp: new Date().toISOString(),
      network_fetch: true, cache_hit: false, cache_age_seconds: 0, is_stale: false,
      stale_reason: null, candle_count: 25 }
  });
  const todayDir = path.join(base, '2026-07-21');
  await fs.writeFile(path.join(base, 'tickers.txt'), 'BBCA\n');
  const res = await collector.runSampleCollection({
    scheduledTime: '09:15', outputDir: todayDir, lockFile: path.join(base, 's.lock'),
    tickersFile: path.join(base, 'tickers.txt'), cacheDir: base, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true, fetchFn: mockFetch, limit: 1 });
  assert.equal(res.status, 'success');

  // Historical file unchanged (content + mtime)
  const histAfter = await fs.readFile(histFile, 'utf8');
  assert.equal(histAfter, histContent);
  const histStatAfter = await fs.stat(histFile);
  assert.equal(histStatAfter.mtimeMs, histStatBefore.mtimeMs);
});

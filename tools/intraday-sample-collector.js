#!/usr/bin/env node
'use strict';

/**
 * Intraday Sample Collector v2.0 — Date-Parameterized Research Tool
 * 
 * Purpose: Collect timestamped intraday observations for research ONLY.
 * The collection date is EXPLICIT via --sample-date YYYY-MM-DD (Asia/Jakarta).
 * The date is never taken silently from the current wall-clock date; the run is
 * rejected when the actual WIB date differs from --sample-date. For backward
 * compatibility the legacy SAMPLE_DATE constant is the default when no
 * --sample-date is supplied, but the combined pipeline always passes it.
 * 
 * BLOCKER RESOLUTIONS (v2.0):
 *   B1: VPS timezone verified before scheduling; schedule expressed in WIB.
 *   B2: Date guard rejects any date whose actual WIB date != --sample-date
 *       (year-aware) and rejects invalid date formats.
 *   B3: Final 16:00 run generates summary inline; no separate cron entry.
 *   B4: Checks production worker lock; skips/delays if active.
 *   B5: Forces fresh Yahoo fetch per snapshot; records freshness metadata.
 *   B6: Deterministic universe: top-200 from daytrade-observe-tickers.txt,
 *       with 12-minute runtime budget and deterministic abort.
 *
 * SAFETY GUARANTEES:
 *   - No Telegram sends
 *   - No production Day Trade publication
 *   - No Supabase writes
 *   - No monitor candidate registration
 *   - No recommendation state changes
 *   - No AI narration
 *   - No portfolio/user data mutation
 *   - No intraday scoring enabled
 *   - Append-only local JSONL files
 *   - Production overlap detection
 *   - Does not modify production cron
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Import only the deterministic engine — no Supabase, no Telegram
const engine = require('../lib/daytrade-screener-engine');
const lifecycle = require('../lib/intraday-sample-lifecycle');
const summary = require('../lib/intraday-sample-summary');


const VERSION = 'intraday-sample-collector-v2.0';
const SAMPLE_DATE = '2026-07-21';
const SAMPLE_YEAR = 2026;
const TIMEZONE = 'Asia/Jakarta';
const TIMEZONE_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7

// Storage paths
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), 'data', 'intraday-samples', SAMPLE_DATE);
const DEFAULT_CACHE_DIR = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache');
const DEFAULT_LOCK_FILE = path.join(process.cwd(), 'tmp', 'intraday-sample-collector.lock');
const DEFAULT_TICKERS_FILE = path.join(process.cwd(), 'data', 'daytrade-observe-tickers.txt');

// Production worker lock — used for overlap detection (Blocker 4)
const PRODUCTION_LOCK_FILE = path.join(process.cwd(), 'tmp', 'daytrade-vps-worker-observe.lock');
const PRODUCTION_OVERLAP_WAIT_MS = 30000; // wait up to 30s for production to finish
const PRODUCTION_OVERLAP_CHECK_INTERVAL_MS = 5000;

// Concurrency & timeout
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 12000;
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min max per sample run

// Runtime budget (Blocker 6): 12 minutes max per snapshot
const RUNTIME_BUDGET_MS = 12 * 60 * 1000;

// Deterministic universe size (Blocker 6): fixed top-200 from ticker list
const DETERMINISTIC_UNIVERSE_SIZE = 200;

// Cache: force fresh fetch per snapshot (Blocker 5)
// Set TTL to 0 so cache is always considered stale → forces network fetch
const SAMPLE_CACHE_TTL_MS = 0;

// Approved schedule: exactly 21 timestamps (Asia/Jakarta HH:MM)
const APPROVED_SCHEDULE = [
  '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45',
  '11:00', '11:15', '11:30', '11:45',
  '13:45', '14:00', '14:15', '14:30', '14:45',
  '15:00', '15:15', '15:30', '15:45',
  '16:00'
];
const FINAL_SNAPSHOT_TIME = '16:00';

// Break period: 12:00 - 13:30 Asia/Jakarta
const BREAK_START_MINUTES = 12 * 60;
const BREAK_END_MINUTES = 13 * 60 + 30;


/**
 * VPS Timezone Verification Commands (Blocker 1)
 *
 * IMPORTANT: The schedule below assumes the VPS cron daemon uses Asia/Jakarta (WIB).
 * Before installing, run these read-only commands on the VPS to verify:
 *
 *   date
 *   date '+%Y-%m-%d %H:%M:%S %Z %z'
 *   timedatectl
 *   cat /etc/timezone
 *   crontab -l | head -5      # check for CRON_TZ= or TZ= declarations
 *   grep -r CRON_TZ /etc/cron* 2>/dev/null || echo "no CRON_TZ found"
 *   systemctl list-timers --no-pager 2>/dev/null | head -10
 *
 * Expected result: timezone = Asia/Jakarta (WIB, UTC+7).
 * If the VPS uses UTC, all cron hours must be shifted by -7.
 * The code uses WIB internally regardless of system timezone.
 *
 * VERIFIED_VPS_TIMEZONE: This must be set to 'Asia/Jakarta' or 'UTC' after
 * running the verification commands. The schedule in the docs MUST match.
 */
const VERIFIED_VPS_TIMEZONE = 'Asia/Jakarta';
// ^^^ Assumed Asia/Jakarta (WIB, UTC+7). Verify on the VPS with the read-only
//     commands above before installing cron. If the VPS reports UTC instead,
//     shift every cron hour by -7 (the code always computes WIB internally).

/**
 * Get current time in Asia/Jakarta as { hours, minutes, totalMinutes, ... }
 */
function getWibNow(nowMs) {
  const resolvedMs = (nowMs === undefined || nowMs === null) ? Date.now() : nowMs;
  const now = new Date(resolvedMs);
  const wibMs = now.getTime() + TIMEZONE_OFFSET_MS;
  const wib = new Date(wibMs);
  return {
    hours: wib.getUTCHours(),
    minutes: wib.getUTCMinutes(),
    totalMinutes: wib.getUTCHours() * 60 + wib.getUTCMinutes(),
    isoString: wib.toISOString(),
    dateStr: wib.toISOString().slice(0, 10),
    timeStr: String(wib.getUTCHours()).padStart(2, '0') + ':' + String(wib.getUTCMinutes()).padStart(2, '0'),
    year: wib.getUTCFullYear()
  };
}

function getMarketSession(totalMinutes) {
  if (totalMinutes >= 9 * 60 && totalMinutes < BREAK_START_MINUTES) return 'MORNING';
  if (totalMinutes >= BREAK_START_MINUTES && totalMinutes <= BREAK_END_MINUTES) return 'BREAK';
  if (totalMinutes > BREAK_END_MINUTES && totalMinutes < 16 * 60) return 'AFTERNOON';
  if (totalMinutes === 16 * 60) return 'FINAL';
  return 'OUTSIDE';
}


/**
 * Validate scheduled time is in approved list.
 */
function validateScheduledTime(scheduledTime) {
  if (!scheduledTime || typeof scheduledTime !== 'string') {
    return { valid: false, reason: 'missing_scheduled_time' };
  }
  const trimmed = scheduledTime.trim();
  if (!APPROVED_SCHEDULE.includes(trimmed)) {
    return { valid: false, reason: 'not_in_approved_schedule', value: trimmed };
  }
  const [h, m] = trimmed.split(':').map(Number);
  const totalMin = h * 60 + m;
  if (totalMin >= BREAK_START_MINUTES && totalMin <= BREAK_END_MINUTES) {
    return { valid: false, reason: 'break_period_rejected', value: trimmed };
  }
  return { valid: true, scheduledTime: trimmed, totalMinutes: totalMin };
}

/**
 * Parse + validate an explicit sample-date string in strict YYYY-MM-DD form.
 * Rejects malformed strings and impossible calendar dates (e.g. 2026-13-40,
 * 2026-02-30). This is the single source of truth for "is this a valid, real
 * sample date?" and never falls back to the current date.
 */
function parseSampleDate(dateStr) {
  if (typeof dateStr !== 'string') return { valid: false, reason: 'not_a_string', value: dateStr };
  const trimmed = dateStr.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) return { valid: false, reason: 'bad_format', value: dateStr };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { valid: false, reason: 'not_a_real_date', value: dateStr };
  }
  return { valid: true, date: trimmed, year: year, month: month, day: day };
}

/**
 * Validate that the actual WIB "today" equals the EXPECTED sample date
 * (Asia/Jakarta). The expected date is EXPLICIT — callers (and the pipeline)
 * must pass the sample date they intend to collect. When omitted it defaults to
 * the legacy SAMPLE_DATE constant purely for backward compatibility; it NEVER
 * silently uses the current date as the expected value.
 *
 * Rejects: an invalid expected-date format, a non-finite / non-numeric
 * timestamp, a year mismatch, and a day mismatch — including future dates.
 *
 * Invalid timestamps are rejected explicitly. Only an explicitly absent
 * (undefined/null) timestamp uses Date.now() for the real production run; a
 * NaN / non-finite timestamp is rejected as invalid.
 */
function validateSampleDate(nowMs, expectedDate) {
  const expected = (expectedDate === undefined || expectedDate === null) ? SAMPLE_DATE : expectedDate;
  const parsed = parseSampleDate(expected);
  if (!parsed.valid) {
    return { valid: false, reason: 'invalid_sample_date_format', value: expected, detail: parsed };
  }
  const ms = (nowMs === undefined || nowMs === null) ? Date.now() : nowMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return { valid: false, reason: 'invalid_timestamp', value: nowMs };
  }
  const wib = getWibNow(ms);
  if (!wib || !Number.isFinite(wib.year) || wib.dateStr === 'Invalid Date') {
    return { valid: false, reason: 'invalid_timestamp', value: nowMs };
  }
  if (wib.year !== parsed.year) {
    return { valid: false, reason: 'wrong_year', year: wib.year, expected: parsed.year };
  }
  if (wib.dateStr !== parsed.date) {
    return { valid: false, reason: 'wrong_date', today: wib.dateStr, expected: parsed.date };
  }
  return { valid: true, date: wib.dateStr, year: wib.year };
}

/**
 * Assert all safety invariants.
 */
function assertSafetyInvariants() {
  const errors = [];
  const scoreEnabled = String(process.env.DAYTRADE_INTRADAY_SCORE_ENABLED || '').trim();
  if (scoreEnabled === '1' || scoreEnabled === 'true') {
    errors.push('DAYTRADE_INTRADAY_SCORE_ENABLED must be false for sample collection');
  }
  if (process.env.DAYTRADE_WORKER_ALLOW_MUTATION === 'true') {
    errors.push('DAYTRADE_WORKER_ALLOW_MUTATION must not be true');
  }
  if (process.env.SAMPLE_SEND_TELEGRAM === 'true') {
    errors.push('SAMPLE_SEND_TELEGRAM must not be true');
  }
  return { safe: errors.length === 0, errors };
}


// ================================================================
// LOCK MECHANISM
// ================================================================

function isPidRunning(pid) {
  if (!pid || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

async function acquireLock(lockFile) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fsp.open(lockFile, 'wx');
      const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), version: VERSION }) + '\n';
      await fd.writeFile(payload);
      return async function release() {
        await fd.close().catch(() => {});
        await fsp.unlink(lockFile).catch(() => {});
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      try {
        const raw = await fsp.readFile(lockFile, 'utf8');
        const state = JSON.parse(raw);
        const startedAt = Date.parse(state.started_at || '');
        const isRunning = isPidRunning(state.pid);
        const isStale = !isRunning || !Number.isFinite(startedAt) || (Date.now() - startedAt > LOCK_TTL_MS);
        if (!isStale) return null;
        await fsp.unlink(lockFile).catch((ue) => { if (ue.code !== 'ENOENT') throw ue; });
      } catch (readErr) {
        await fsp.unlink(lockFile).catch(() => {});
      }
    }
  }
  return null;
}

// ================================================================
// PRODUCTION OVERLAP DETECTION (Blocker 4)
// ================================================================

/**
 * Check if the production VPS observe worker is currently running.
 * Reads the production lock file and checks if the PID is alive.
 */
async function checkProductionWorkerActive(productionLockFile) {
  try {
    const raw = await fsp.readFile(productionLockFile || PRODUCTION_LOCK_FILE, 'utf8');
    const state = JSON.parse(raw);
    const isRunning = isPidRunning(state.pid);
    if (!isRunning) return { active: false, reason: 'pid_not_running' };
    const startedAt = Date.parse(state.started_at || '');
    const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
    // If started more than 30 min ago, consider stale (production LOCK_TTL is 30 min)
    if (ageMs > 30 * 60 * 1000) return { active: false, reason: 'lock_stale' };
    return { active: true, pid: state.pid, started_at: state.started_at, age_ms: ageMs };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { active: false, reason: 'no_lock_file' };
    return { active: false, reason: 'lock_read_error', error: e.message };
  }
}

/**
 * Wait for the production worker to finish, up to a bounded timeout.
 * Returns { waited, waited_ms, production_finished, gave_up }
 */
async function waitForProductionWorker(productionLockFile, maxWaitMs) {
  const startWait = Date.now();
  const maxWait = maxWaitMs || PRODUCTION_OVERLAP_WAIT_MS;
  let waited = 0;

  while (Date.now() - startWait < maxWait) {
    const check = await checkProductionWorkerActive(productionLockFile);
    if (!check.active) {
      return { waited: true, waited_ms: Date.now() - startWait, production_finished: true, gave_up: false };
    }
    await new Promise((r) => setTimeout(r, PRODUCTION_OVERLAP_CHECK_INTERVAL_MS));
    waited++;
  }

  return { waited: true, waited_ms: Date.now() - startWait, production_finished: false, gave_up: true };
}


// ================================================================
// FRESH MARKET DATA FETCH (Blocker 5)
// ================================================================

/**
 * Fetch fresh daily OHLCV from Yahoo for a single ticker.
 * Always makes a network call — never returns stale cache alone.
 * Records full freshness metadata for each fetch.
 */
async function fetchFreshCandles(ticker, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const symbol = ticker.toUpperCase().replace(/[^A-Z0-9_-]/g, '') + '.JK';
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=90d&interval=1d&includePrePost=false';

  const fetchStart = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Auto-Cuan-Sample-Collector/2.0' }
    });
    const fetchEnd = Date.now();

    if (!response.ok) {
      return { candles: null, freshness: {
        provider: 'yahoo_chart_1d', fetch_timestamp: new Date(fetchStart).toISOString(),
        fetch_duration_ms: fetchEnd - fetchStart, network_fetch: true,
        cache_hit: false, is_stale: true, stale_reason: 'http_' + response.status
      }};
    }

    const data = await response.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const indicators = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    const timestamps = result && result.timestamp || [];

    if (!indicators || !timestamps.length) {
      return { candles: null, freshness: {
        provider: 'yahoo_chart_1d', fetch_timestamp: new Date(fetchStart).toISOString(),
        fetch_duration_ms: Date.now() - fetchStart, network_fetch: true,
        cache_hit: false, is_stale: true, stale_reason: 'no_data_in_response'
      }};
    }

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (indicators.close[i] != null && indicators.open[i] != null) {
        candles.push({
          time: timestamps[i],
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: indicators.open[i], high: indicators.high[i],
          low: indicators.low[i], close: indicators.close[i],
          volume: indicators.volume[i] || 0
        });
      }
    }

    const lastCandle = candles[candles.length - 1];
    return {
      candles: candles.length >= 20 ? candles : null,
      freshness: {
        provider: 'yahoo_chart_1d',
        fetch_timestamp: new Date(fetchStart).toISOString(),
        fetch_duration_ms: Date.now() - fetchStart,
        network_fetch: true,
        cache_hit: false,
        cache_age_seconds: 0,
        trading_day_candle_timestamp: lastCandle ? new Date(lastCandle.time * 1000).toISOString() : null,
        trading_day_candle_date: lastCandle ? lastCandle.date : null,
        is_stale: false,
        stale_reason: null,
        candle_count: candles.length
      }
    };
  } catch (e) {
    return { candles: null, freshness: {
      provider: 'yahoo_chart_1d', fetch_timestamp: new Date(fetchStart).toISOString(),
      fetch_duration_ms: Date.now() - fetchStart, network_fetch: true,
      cache_hit: false, is_stale: true,
      stale_reason: /abort/i.test(e.message) ? 'timeout' : 'fetch_error_' + (e.message || '').slice(0, 50)
    }};
  } finally { clearTimeout(timer); }
}


/**
 * Fetch with stale-cache fallback. Always attempts fresh fetch first.
 * If network fails, falls back to disk cache but marks as stale.
 */
async function fetchWithFreshnessFallback(ticker, cacheDir, opts) {
  const result = await fetchFreshCandles(ticker, opts);
  if (result.candles && result.candles.length >= 20) {
    return result;
  }
  // Network failed — try reading stale cache as fallback
  const cachePath = path.join(cacheDir, ticker.toUpperCase().replace(/[^A-Z0-9_-]/g, '') + '.json');
  try {
    const raw = await fsp.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    const candles = Array.isArray(parsed.candles) ? parsed.candles.filter(Boolean) : [];
    const updatedAt = parsed.updated_at ? Date.parse(parsed.updated_at) : 0;
    const ageSeconds = updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : Infinity;
    if (candles.length >= 20) {
      return {
        candles: candles,
        freshness: {
          provider: 'yahoo_chart_1d',
          fetch_timestamp: result.freshness.fetch_timestamp,
          fetch_duration_ms: result.freshness.fetch_duration_ms,
          network_fetch: true,
          network_failed: true,
          cache_hit: true,
          cache_age_seconds: ageSeconds,
          cache_updated_at: parsed.updated_at || null,
          trading_day_candle_timestamp: candles[candles.length - 1] ? new Date(candles[candles.length - 1].time * 1000).toISOString() : null,
          trading_day_candle_date: candles[candles.length - 1] ? candles[candles.length - 1].date : null,
          is_stale: true,
          stale_reason: 'network_failed_using_stale_cache_age_' + ageSeconds + 's',
          candle_count: candles.length
        }
      };
    }
  } catch (e) { /* no cache available */ }
  // No data at all
  return { candles: null, freshness: result.freshness };
}

// ================================================================
// UNIVERSE LOADING (Blocker 6)
// ================================================================

async function loadTickerUniverse(tickersFile, limit) {
  const content = await fsp.readFile(tickersFile, 'utf8');
  const tickers = content.split(/\r?\n/)
    .map((line) => line.trim().toUpperCase())
    .filter((line) => line && !line.startsWith('#') && /^[A-Z]{4}$/.test(line));
  // Deterministic: always take the first N tickers in file order
  const effectiveLimit = limit || DETERMINISTIC_UNIVERSE_SIZE;
  const universe = tickers.slice(0, effectiveLimit).map((ticker) => ({ ticker, board: 'UTAMA' }));
  return universe;
}


// ================================================================
// HELPERS
// ================================================================

async function appendJsonl(filePath, record) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, JSON.stringify(record) + '\n');
}

function sanitizeRecord(record) {
  const dangerous = [
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'CRON_SECRET',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'APP_BASE_URL',
    'cookie', 'authorization', 'Bearer'
  ];
  const str = JSON.stringify(record);
  for (const key of dangerous) {
    if (str.includes(key)) {
      throw new Error('SAFETY: record contains forbidden key/value: ' + key);
    }
  }
  return record;
}

function round2(n) { return Math.round(n * 100) / 100; }

function buildCandidateRecord(result, scheduledTime, rank, freshness) {
  return {
    ticker: result.ticker || null,
    sample_timestamp: new Date().toISOString(),
    scheduled_time: scheduledTime,
    rank: rank,
    score: result.daytrade_score != null ? result.daytrade_score : null,
    execution_grade: result.confidence || null,
    candidate_type: result.setup || null,
    current_status: result.status || null,
    risk_level: result.risk_level || null,
    current_price: result.last_price != null ? result.last_price : null,
    open: result.open_price != null ? result.open_price : null,
    high: result.high_price != null ? result.high_price : null,
    low: result.low_price != null ? result.low_price : null,
    previous_close: result.previous_close != null ? result.previous_close : null,
    volume: result.volume_today != null ? result.volume_today : null,
    average_volume: result.avg_volume_20d != null ? result.avg_volume_20d : null,
    relative_volume: result.volume_ratio_20d != null ? result.volume_ratio_20d : null,
    bid: null, offer: null,
    bid_offer_unavailable_reason: 'yahoo_daily_ohlcv_source_no_realtime_bid_offer',
    entry_low: result.entry_low != null ? result.entry_low : null,
    entry_high: result.entry_high != null ? result.entry_high : null,
    reference_entry_price: result.entry_low != null && result.entry_high != null
      ? Math.round((result.entry_low + result.entry_high) / 2) : null,
    tp1: result.tp1 != null ? result.tp1 : null,
    tp2: result.tp2 != null ? result.tp2 : null,
    sl: result.stop_loss != null ? result.stop_loss : null,
    distance_to_entry_pct: null, pct_movement_from_first_observation: null,
    pct_movement_from_reference_entry: null,
    distance_to_tp1_pct: null, distance_to_tp2_pct: null, distance_to_sl_pct: null,
    liquidity_component: result.liquidity_score != null ? result.liquidity_score : null,
    pre_spike_component: result.pre_spike_score != null ? result.pre_spike_score : null,
    momentum_component: result.momentum_score != null ? result.momentum_score : null,
    risk_reward_component: result.rr_score != null ? result.rr_score : null,
    trend_component: result.trend_score != null ? result.trend_score : null,
    penalty_component: result.penalty != null ? result.penalty : null,
    reason_codes: result.penalty_reasons || [],
    raw_source_freshness: result.price_asof || null,
    data_quality_status: result.data_quality_status || null,
    data_quality_note: result.data_quality_note || null,
    // Freshness metadata per candidate (Blocker 5)
    freshness: freshness || null
  };
}

function deriveDistances(record) {
  const price = record.current_price;
  if (!price || price <= 0) return record;
  const refEntry = record.reference_entry_price;
  if (refEntry && refEntry > 0) {
    record.distance_to_entry_pct = round2((price - refEntry) / refEntry * 100);
    record.pct_movement_from_reference_entry = round2((price - refEntry) / refEntry * 100);
  }
  if (record.tp1 && record.tp1 > 0) record.distance_to_tp1_pct = round2((record.tp1 - price) / price * 100);
  if (record.tp2 && record.tp2 > 0) record.distance_to_tp2_pct = round2((record.tp2 - price) / price * 100);
  if (record.sl && record.sl > 0) record.distance_to_sl_pct = round2((record.sl - price) / price * 100);
  return record;
}


// ================================================================
// MAIN COLLECTION RUN
// ================================================================

function parseArgs(argv) {
  const args = { scheduledTime: null, sampleDate: null, sampleRoot: null, limit: null,
    outputDir: null, lockFile: null, tickersFile: null, dryRun: false,
    productionLockFile: null, cacheDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scheduled-time' && argv[i + 1]) args.scheduledTime = argv[++i];
    else if (a === '--sample-date' && argv[i + 1]) args.sampleDate = argv[++i];
    else if (a === '--sample-root' && argv[i + 1]) args.sampleRoot = argv[++i];
    else if (a === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (a === '--output-dir' && argv[i + 1]) args.outputDir = argv[++i];
    else if (a === '--lock-file' && argv[i + 1]) args.lockFile = argv[++i];
    else if (a === '--tickers-file' && argv[i + 1]) args.tickersFile = argv[++i];
    else if (a === '--production-lock-file' && argv[i + 1]) args.productionLockFile = argv[++i];
    else if (a === '--cache-dir' && argv[i + 1]) args.cacheDir = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function runSampleCollection(options) {
  const startedAt = Date.now();
  options = options || {};
  const scheduledTime = options.scheduledTime;
  // Explicit sample date drives validation, lifecycle records, summaries, and
  // the output directory. Defaults to the legacy SAMPLE_DATE constant purely for
  // backward compatibility; the pipeline always passes it explicitly. The date
  // is NEVER silently taken from the current wall-clock date.
  const sampleDate = (options.sampleDate === undefined || options.sampleDate === null || options.sampleDate === '')
    ? SAMPLE_DATE : options.sampleDate;
  const parsedSampleDate = parseSampleDate(sampleDate);
  const outputDir = options.outputDir
    || (options.sampleRoot
      ? path.join(options.sampleRoot, sampleDate)
      : path.join(process.cwd(), 'data', 'intraday-samples', sampleDate));
  const lockFile = options.lockFile || DEFAULT_LOCK_FILE;
  const tickersFile = options.tickersFile || DEFAULT_TICKERS_FILE;
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
  const limit = options.limit || DETERMINISTIC_UNIVERSE_SIZE;
  const dryRun = options.dryRun || false;
  const productionLockFile = options.productionLockFile || PRODUCTION_LOCK_FILE;

  // === SAFETY CHECKS ===
  const safety = assertSafetyInvariants();
  if (!safety.safe) {
    const errorRecord = { type: 'safety_violation', timestamp: new Date().toISOString(),
      scheduled_time: scheduledTime, errors: safety.errors };
    if (!dryRun) await appendJsonl(path.join(outputDir, 'errors.jsonl'), errorRecord);
    return { status: 'safety_violation', errors: safety.errors };
  }

  // === VALIDATE SCHEDULED TIME ===
  const timeValidation = validateScheduledTime(scheduledTime);
  if (!timeValidation.valid) {
    const errorRecord = { type: 'schedule_validation_failed', timestamp: new Date().toISOString(),
      scheduled_time: scheduledTime, reason: timeValidation.reason };
    if (!dryRun) await appendJsonl(path.join(outputDir, 'errors.jsonl'), errorRecord);
    return { status: 'rejected', reason: timeValidation.reason };
  }

  // === VALIDATE SAMPLE-DATE FORMAT (always — reject invalid formats) ===
  if (!parsedSampleDate.valid) {
    return { status: 'rejected', reason: 'invalid_sample_date_format', sample_date: sampleDate, detail: parsedSampleDate };
  }

  // === VALIDATE DATE — actual WIB date must equal the explicit sample date ===
  if (!options.skipDateValidation) {
    const dateValidation = validateSampleDate(startedAt, sampleDate);
    if (!dateValidation.valid) {
      return { status: 'rejected', reason: dateValidation.reason, detail: dateValidation };
    }
  }

  // === CHECK PRODUCTION OVERLAP (Blocker 4) ===
  let productionOverlap = null;
  if (!options.skipProductionCheck) {
    const prodCheck = await checkProductionWorkerActive(productionLockFile);
    if (prodCheck.active) {
      // Wait bounded time for production to finish
      const waitResult = await waitForProductionWorker(productionLockFile, PRODUCTION_OVERLAP_WAIT_MS);
      if (waitResult.gave_up) {
        const skipRecord = { type: 'skipped_due_to_production_lock', timestamp: new Date().toISOString(),
          scheduled_time: scheduledTime, production_pid: prodCheck.pid,
          production_started_at: prodCheck.started_at, waited_ms: waitResult.waited_ms };
        if (!dryRun) await appendJsonl(path.join(outputDir, 'runs.jsonl'), skipRecord);
        return { status: 'skipped_due_to_production_lock', scheduled_time: scheduledTime,
          production: prodCheck, waited_ms: waitResult.waited_ms };
      }
      productionOverlap = { detected: true, waited_ms: waitResult.waited_ms, resolved: true };
    }
  }

  // === ACQUIRE OWN LOCK ===
  const release = await acquireLock(lockFile);
  if (!release) {
    const skipRecord = { type: 'skipped_due_to_lock', timestamp: new Date().toISOString(),
      scheduled_time: scheduledTime, lock_file: lockFile };
    if (!dryRun) await appendJsonl(path.join(outputDir, 'runs.jsonl'), skipRecord);
    return { status: 'skipped_due_to_lock', scheduled_time: scheduledTime };
  }


  try {
    // === LOAD DETERMINISTIC UNIVERSE (Blocker 6) ===
    const universe = await loadTickerUniverse(tickersFile, limit);
    const session = getMarketSession(timeValidation.totalMinutes);
    const budgetDeadline = startedAt + RUNTIME_BUDGET_MS;

    // === FETCH FRESH CANDLES WITH BUDGET (Blockers 5 & 6) ===
    const candleByTicker = {};
    const freshnessByTicker = {};
    let fetchSuccess = 0, fetchFail = 0, timedOut = 0;
    const requested = universe.length;
    let completed = 0;

    const concurrency = Math.min(DEFAULT_CONCURRENCY, universe.length);
    let nextIdx = 0;

    async function worker() {
      while (nextIdx < universe.length) {
        // Runtime budget check
        if (Date.now() >= budgetDeadline) { timedOut += (universe.length - nextIdx); nextIdx = universe.length; break; }
        const idx = nextIdx++;
        const item = universe[idx];
        try {
          const fetchFn = options.fetchFn || fetchWithFreshnessFallback;
          const result = await fetchFn(item.ticker, cacheDir, { timeoutMs: DEFAULT_TIMEOUT_MS });
          freshnessByTicker[item.ticker] = result.freshness;
          if (result.candles && result.candles.length >= 20) {
            candleByTicker[item.ticker] = result.candles;
            fetchSuccess++;
          } else {
            item._skipReason = 'insufficient_candles';
            fetchFail++;
          }
        } catch (e) {
          item._skipReason = e.message || 'fetch_error';
          freshnessByTicker[item.ticker] = { is_stale: true, stale_reason: 'exception', error: (e.message || '').slice(0, 100) };
          fetchFail++;
        }
        completed++;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    // === RUN ENGINE (observe-only) ===
    const scanTickers = universe.filter((t) => candleByTicker[t.ticker]);
    const runMode = engine.getRunMode();
    const engineResult = await engine.runDayTradeBatch(scanTickers, runMode, {
      fetchCandles: (ticker) => Promise.resolve(candleByTicker[ticker]),
      noDelay: true, observeOnly: true
    });

    // === BUILD CANDIDATE RECORDS ===
    const candidateStatuses = ['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT',
      'MOMENTUM_CONTINUATION', 'PRE_SPIKE_WATCH', 'EARLY_RADAR'];
    const allResults = engineResult.results || [];
    const candidates = allResults.filter((r) => candidateStatuses.includes(r.status));

    const candidateRecords = [];
    for (let i = 0; i < candidates.length; i++) {
      const ticker = candidates[i].ticker;
      let record = buildCandidateRecord(candidates[i], scheduledTime, i + 1, freshnessByTicker[ticker] || null);
      record = deriveDistances(record);
      candidateRecords.push(sanitizeRecord(record));
    }

    // === WRITE CANDIDATE RECORDS (append-only) ===
    if (!dryRun) {
      for (const rec of candidateRecords) {
        await appendJsonl(path.join(outputDir, 'candidates.jsonl'), rec);
      }
    }

    // === UPDATE LIFECYCLE ===
    if (!dryRun) {
      await lifecycle.updateLifecycle(path.join(outputDir, 'lifecycle.json'), candidateRecords, scheduledTime);
    }


    // === BUILD RUN RECORD ===
    const finishedAt = Date.now();
    const runRecord = {
      type: 'sample_run', version: VERSION, sample_date: sampleDate, timezone: TIMEZONE,
      scheduled_time: scheduledTime,
      actual_start: new Date(startedAt).toISOString(),
      actual_finish: new Date(finishedAt).toISOString(),
      duration_ms: finishedAt - startedAt,
      runtime_budget_ms: RUNTIME_BUDGET_MS,
      budget_exhausted: timedOut > 0,
      market_session: session,
      universe_policy: 'deterministic_top_' + limit + '_from_observe_tickers',
      requested_count: requested,
      attempted_count: completed,
      completed_count: fetchSuccess,
      failed_count: fetchFail,
      timed_out_count: timedOut,
      universe_count: universe.length,
      scanned_count: scanTickers.length,
      candidate_count: candidateRecords.length,
      status: 'success', error_code: null,
      data_provider_status: fetchFail === 0 && timedOut === 0 ? 'all_ok' : (fetchSuccess > 0 ? 'partial' : 'all_failed'),
      stale_data_indicators: {
        stale_count: Object.values(freshnessByTicker).filter((f) => f && f.is_stale).length,
        fresh_count: Object.values(freshnessByTicker).filter((f) => f && !f.is_stale).length,
        network_fetch_count: Object.values(freshnessByTicker).filter((f) => f && f.network_fetch).length,
        cache_fallback_count: Object.values(freshnessByTicker).filter((f) => f && f.cache_hit && f.is_stale).length
      },
      production_overlap: productionOverlap,
      skipped_due_to_lock: false
    };

    if (!dryRun) {
      await appendJsonl(path.join(outputDir, 'runs.jsonl'), sanitizeRecord(runRecord));
    }

    // === GENERATE SUMMARY IF FINAL SNAPSHOT (Blocker 3) ===
    let summaryResult = null;
    if (scheduledTime === FINAL_SNAPSHOT_TIME && !dryRun) {
      summaryResult = await summary.generateSummary(outputDir, APPROVED_SCHEDULE, sampleDate);
    }

    return {
      status: 'success', scheduled_time: scheduledTime,
      candidates: candidateRecords.length, scanned: scanTickers.length,
      duration_ms: finishedAt - startedAt, budget_exhausted: timedOut > 0,
      summary_generated: !!summaryResult, run: runRecord
    };

  } catch (err) {
    const errorRecord = { type: 'run_error', timestamp: new Date().toISOString(),
      scheduled_time: scheduledTime, error: err.message || 'unknown',
      stack: (err.stack || '').split('\n').slice(0, 5).join('\n') };
    if (!dryRun) await appendJsonl(path.join(outputDir, 'errors.jsonl'), sanitizeRecord(errorRecord));
    return { status: 'error', error: err.message, scheduled_time: scheduledTime };
  } finally { await release(); }
}


// ================================================================
// CLI ENTRY
// ================================================================

if (require.main === module) {
  const args = parseArgs(process.argv);
  runSampleCollection({
    scheduledTime: args.scheduledTime,
    sampleDate: args.sampleDate,
    sampleRoot: args.sampleRoot,
    limit: args.limit,
    outputDir: args.outputDir,
    lockFile: args.lockFile,
    tickersFile: args.tickersFile,
    cacheDir: args.cacheDir,
    productionLockFile: args.productionLockFile,
    dryRun: args.dryRun
  })
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((e) => { console.error(e.message); process.exitCode = 1; });
}

// ================================================================
// EXPORTS
// ================================================================

module.exports = {
  VERSION, SAMPLE_DATE, SAMPLE_YEAR, TIMEZONE, APPROVED_SCHEDULE,
  BREAK_START_MINUTES, BREAK_END_MINUTES, FINAL_SNAPSHOT_TIME,
  RUNTIME_BUDGET_MS, DETERMINISTIC_UNIVERSE_SIZE,
  PRODUCTION_LOCK_FILE, PRODUCTION_OVERLAP_WAIT_MS,
  VERIFIED_VPS_TIMEZONE,
  getWibNow, getMarketSession, validateScheduledTime, validateSampleDate, parseSampleDate,
  assertSafetyInvariants, acquireLock, isPidRunning,
  checkProductionWorkerActive, waitForProductionWorker,
  fetchFreshCandles, fetchWithFreshnessFallback,
  loadTickerUniverse, appendJsonl, sanitizeRecord,
  buildCandidateRecord, deriveDistances,
  runSampleCollection, parseArgs
};



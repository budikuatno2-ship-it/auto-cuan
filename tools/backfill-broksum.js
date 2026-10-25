'use strict';

/**
 * Historical Broker Summary Backfill Worker (All + Foreign)
 * ==========================================================
 * Backfills Foreign (flow=F, all_data=true) and unclipped All (all_data=true)
 * from 2026-10-16 backwards to 2026-01-02.
 *
 * Designed with strict quota guards:
 * - Reads x-ratelimit-remaining / x-quota-remaining after every request.
 * - Weekday reserve: 800 calls.
 * - Weekend reserve: 300 calls.
 * - Prioritizes liquid tickers (turnover >= Rp 1 Miliar) before illiquid tickers.
 * - Supports --only-foreign flag to exclusively fetch Foreign broksum.
 * - Paced at 8 req/s (125ms delay) with adaptive fallback to 5 req/s (200ms) on burst 429.
 * - Fully resumable and stateful via _backfill/state.json and lock file.
 */

const fs = require('fs');
const path = require('path');
// Load environment variables (.env / .env.local)
try {
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
    '/home/ubuntu/auto-cuan-runner/.env',
    '/home/ubuntu/auto-cuan/.env'
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (_) {}

const arjumClient = require('../lib/arjum-client');
const broksumFlow = require('../lib/broksum-flow');
const brokerAccumulationLocal = require('../lib/broker-accumulation-local');
const quotaTracker = require('../lib/arjum-quota-tracker');
const broksumValidator = require('../lib/broksum-validator');

// Default pacing: 8 req/sec (125ms delay) as verified in benchmark
const DEFAULT_DELAY_MS = 125;
const SLOWDOWN_DELAY_MS = 200; // 5 req/sec on rate burst
// Hard quota floors: Weekday floor 5,000 for J1; Weekend floor 1,000 for web/retries.
const WEEKDAY_RESERVE = Math.max(5000, Number(process.env.BACKFILL_RESERVE_AFTER_EOD) || 5000);
const WEEKEND_RESERVE = Math.max(1000, Number(process.env.BACKFILL_RESERVE_WEEKEND) || 1000);
const DEFAULT_WEEKDAY_RESERVE_BEFORE_EOD = 5000;
const WEEKDAY_RESERVE_BEFORE_EOD = Math.max(5000, Number(process.env.BACKFILL_RESERVE_BEFORE_EOD) || DEFAULT_WEEKDAY_RESERVE_BEFORE_EOD);

// 2c: read the EOD completion sentinel written by run-daily-market-update.js.
function eodDoneExists(baseDir, wibDateKey) {
  try {
    return fs.existsSync(path.join(baseDir, '_eod', wibDateKey + '.done'));
  } catch (_) { return false; }
}

// WIB date key (YYYY-MM-DD) with no external deps.
function wibDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return parts;
}

// Holiday/weekend detection without throwing when the calendar is unavailable.
function isTradingDaySafe(dateKey) {
  try {
    const cal = require('../lib/idx-trading-calendar');
    if (typeof cal.isTradingDay === 'function') {
      return cal.isTradingDay(dateKey, cal.getSeedHolidaySet ? cal.getSeedHolidaySet() : undefined);
    }
    const holidays = cal.getSeedHolidaySet ? cal.getSeedHolidaySet() : new Set();
    const d = new Date(dateKey + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day !== 0 && day !== 6 && !holidays.has(dateKey);
  } catch (_) {
    const d = new Date(dateKey + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day !== 0 && day !== 6;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────
// PROVIDER-ERROR ISOLATION (2026-10-19)
//
// The 00:07 run halted after ONE Cloudflare 502 ("origin overloaded") because
// any invalid response set quotaHalted = true. One bad response is NOT a
// budget problem. 5xx/timeouts are now retried with backoff, and if they
// persist the task is SKIPPED (queued for a later run) rather than killing the
// whole backfill.
//
// Hard halts remain ONLY for: quota exhausted / HTTP 429, an active circuit
// breaker, or N consecutive 5xx (the provider is genuinely down).
// ─────────────────────────────────────────────────────────────────────────
const PROVIDER_RETRY_DELAYS_MS = [2000, 8000, 30000];
const MAX_CONSECUTIVE_5XX = 5;

function isProviderTransient(res) {
  if (!res) return true;
  if (res.rateLimited) return false; // 429/quota → caller's hard-stop path
  const status = Number(res.status);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return true;
  if (Number.isFinite(status) && status === 504) return true; // timeout
  const msg = String(res.error || '').toLowerCase();
  if (/timeout|timed out|aborted|econnreset|etimedout|eai_again|socket hang up|network/.test(msg)) return true;
  // Missing/blank status with a transport error is also transient.
  if (!res.ok && !status && res.error) return true;
  return false;
}

function brokerSummaryHasTrades(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.derived === 'no-trade') return false;
  if (Array.isArray(data.brokers) && data.brokers.length > 0) {
    if (data.brokers.some(b => Number(b.bval || b.sval || b.bvol || b.svol || 0) > 0)) return true;
  }
  if (Array.isArray(data.broker_levels) && data.broker_levels.length > 0) {
    if (data.broker_levels.some(l => (l.buy && Number(l.buy.bval || l.buy.bvol || 0) > 0) || (l.sell && Number(l.sell.sval || l.sell.svol || 0) > 0))) return true;
  }
  if (Number(data.total_turnover || 0) > 0 || Number(data.total_volume || 0) > 0) return true;
  return false;
}

// B6 (2026-10-20): the backfill must yield to the DAILY jobs.
//
// The daily jobs have a hard, non-negotiable quota need for the current
// trading day (J1 broker summary + F + accumulation + insider, J2 candles,
// IHSG). The backfill must therefore stop while that need is still covered.
//
// IMPORTANT SEMANTICS: `reserveQuota` is a FLOOR on the REMAINING quota — the
// worker stops as soon as `remaining <= reserveQuota`. So the floor is the
// amount of quota that must stay untouched, NOT the amount the backfill may
// spend. Spending capacity is `remaining - reserve`.
//
// The floor = remaining daily-job need + a 10% retry buffer, so a day with many
// retries still keeps the daily jobs safe.
//
// Pure function so it is unit-testable without touching the filesystem.
const DAILY_JOB_BASE_NEED = 4400; // J1 (962+834+834+834) + J2 (962) rounded
const DAILY_JOB_RETRY_RATIO = 0.10;

function computeBackfillReserve(options = {}) {
  // NOTE: Number(null) === 0 and Number(undefined) === NaN, so an explicitly
  // unknown remaining must be handled BEFORE the numeric coercion.
  const remaining = (options.remaining === null || options.remaining === undefined)
    ? null
    : Number(options.remaining);
  const dailyNeed = Number.isFinite(options.dailyNeed) && options.dailyNeed > 0
    ? options.dailyNeed
    : DAILY_JOB_BASE_NEED;
  const retryBuffer = Number.isFinite(options.retryBuffer)
    ? options.retryBuffer
    : Math.ceil(dailyNeed * DAILY_JOB_RETRY_RATIO);
  const mode = options.mode === 'weekend' ? 'weekend' : 'weekday';

  // The floor: quota that must remain available for the daily jobs.
  const reserve = Math.max(0, Math.ceil(dailyNeed + retryBuffer));
  if (!Number.isFinite(remaining)) {
    // Unknown remaining quota -> be conservative and keep the old fixed reserve.
    return {
      reserve: Math.max(reserve, mode === 'weekend' ? WEEKEND_RESERVE : WEEKDAY_RESERVE),
      spendable: 0,
      dailyNeed, retryBuffer, remaining: null, mode
    };
  }
  // How much the backfill may still spend before the floor is reached.
  const spendable = Math.max(0, Math.floor(remaining - reserve));
  return { reserve, spendable, dailyNeed, retryBuffer, remaining, mode };
}

// How many requests per ticker the daily job still owes.
//
// For a ticker that has no broker summary for the target date yet, the daily
// worker spends: 1 ALL + 1 F + 1 accumulation + 1 insider = 4 requests.
// (4 is deliberately an over-estimate for F — only some tickers have foreign
// flow — because over-reserving is the safe direction.)
const DAILY_REQUESTS_PER_TICKER = 4;

// Count the universe tickers that still lack a dated broker-summary file.
function countMissingForDate(baseDir, date, tickers) {
  if (!tickers || !tickers.length) return 0;
  let missing = 0;
  for (const t of tickers) {
    const p = path.join(baseDir, 'broker-summary', t, date + '.json');
    if (!fs.existsSync(p)) missing++;
  }
  return missing;
}

// Total daily-job demand that is still outstanding right now:
//   - today's own session (today minus what J1 already wrote)
//   - the H-1 backlog (the previous trading day's pending tickers)
// A ticker's missing day is counted once per date, so a ticker that is missing
// on both days is counted twice (it really does need two days of data).
function computePendingDailyNeed(baseDir, todayKey, tickers) {
  let need = countMissingForDate(baseDir, todayKey, tickers) * DAILY_REQUESTS_PER_TICKER;
  const prevKey = previousTradingDayKey(todayKey);
  if (prevKey) {
    try {
      const markerPath = path.join(baseDir, '_daily-update-marker', prevKey + '.json');
      if (fs.existsSync(markerPath)) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        const pending = Number(marker.pending);
        if (Number.isFinite(pending) && pending > 0) {
          need += pending * DAILY_REQUESTS_PER_TICKER;
        }
      }
    } catch (_) {}
  }
  return need;
}

// Previous trading day (weekday-only; the IDX holiday table is not required
// for a conservative reserve — a holiday only makes the reserve slightly
// larger, which is the safe direction).
function previousTradingDayKey(dateKey) {
  const d = new Date(dateKey + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

// Resolve the reserve FLOOR the backfill must not dip below.
//
// While the day's EOD work is still pending, the floor is the OUTSTANDING
// daily-job demand (today's session + the H-1 backlog) plus a 10% retry
// buffer, so the backfill can never eat the quota the daily jobs still need.
// The floor is never below the static daily-job base need. Once today's EOD
// work is done (.done sentinel) that demand is already spent, so the
// historical fixed reserve applies again and the leftover becomes usable.
function resolveBackfillReserveFloor(options = {}) {
  const baseDir = options.baseDir;
  const explicitMode = options.explicitModeArg || null;
  const mode = options.mode || 'weekday';
  const todayKey = wibDateKey();
  if (eodDoneExists(baseDir, todayKey)) {
    return resolveDynamicReserveQuota(baseDir, explicitMode);
  }
  const pendingNeed = Number.isFinite(options.pendingDailyNeed) && options.pendingDailyNeed > 0
    ? options.pendingDailyNeed
    : DAILY_JOB_BASE_NEED;
  return computeBackfillReserve({ remaining: options.remaining, mode, dailyNeed: pendingNeed }).reserve;
}

function resolveDynamicReserveQuota(baseDir, explicitMode = null, now = new Date()) {
  const todayKey = wibDateKey(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', weekday: 'short'
  }).format(now);
  const isWeekendDay = parts === 'Sun' || parts === 'Sat';

  let currentMode = explicitMode;
  if (!currentMode) {
    currentMode = isWeekendDay ? 'weekend' : 'weekday';
  }

  if (currentMode === 'weekday' && !isTradingDaySafe(todayKey)) {
    currentMode = 'weekend';
  }

  if (currentMode === 'weekend') {
    return WEEKEND_RESERVE;
  }

  const doneExists = eodDoneExists(baseDir, todayKey);
  return doneExists ? WEEKDAY_RESERVE : WEEKDAY_RESERVE_BEFORE_EOD;
}

function getBaseDir(overrideDir) {
  if (overrideDir) return overrideDir;
  return process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
}

function getLockPath(baseDir) {
  const dir = path.join(baseDir, '_backfill');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'backfill.lock');
}

function getStatePath(baseDir) {
  const dir = path.join(baseDir, '_backfill');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'state.json');
}

function acquireLock(lockFile) {
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (info && info.pid) {
          try {
            process.kill(info.pid, 0);
            return false;
          } catch (_) {
            fs.unlinkSync(lockFile);
            return acquireLock(lockFile);
          }
        }
      } catch (_) {
        try { fs.unlinkSync(lockFile); } catch (_) {}
      }
    }
    return false;
  }
}

function releaseLock(lockFile) {
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (_) {}
}

/**
 * Baca antrean prioritas dari _eod/<tanggal>.anomali.json yang ditulis J1.
 * Pasangan (ticker, date) dari sini dikoreksi lebih dulu oleh backfill.
 */
function loadAnomalyQueue(baseDir, maxAgeDays = 7) {
  const queue = new Map(); // key=ticker|date -> { ticker, date, attempt, stream }
  try {
    const eodDir = path.join(baseDir, '_eod');
    if (!fs.existsSync(eodDir)) return queue;
    const cutoff = Date.now() - maxAgeDays * 86400000;
    for (const f of fs.readdirSync(eodDir)) {
      if (!f.endsWith('.anomali.json')) continue;
      const full = path.join(eodDir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) continue;
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!parsed || !Array.isArray(parsed.anomalies)) continue;
        const last = Number(parsed.last_count) || 0;
        for (const it of parsed.anomalies) {
          if (!it || !it.ticker || !it.date) continue;
          const key = `${it.ticker}|${it.date}`;
          queue.set(key, { ticker: it.ticker, date: it.date, attempt: last, stream: it.stream });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return queue;
}

// Candle lookup cache: Map<ticker, Map<date, {close,volume,value}>>
const candleCache = new Map();
function getCandleReference(candlesDir, ticker, date) {
  let map = candleCache.get(ticker);
  if (!map) {
    map = new Map();
    try {
      const f = path.join(candlesDir, `${ticker}.json`);
      if (fs.existsSync(f)) {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const c of (d.candles || [])) {
          const dd = String(c.date || c.time || '').slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(dd)) {
            map.set(dd, {
              close: Number(c.close),
              volume: Number(c.volume),
              value: c.value != null ? Number(c.value) : (c.turnover != null ? Number(c.turnover) : null)
            });
          }
        }
      }
    } catch (_) {}
    candleCache.set(ticker, map);
  }
  return map.get(date) || null;
}

/**
 * Validasi permanen: payload baru harus wajar sebelum dianggap selesai.
 * Mengembalikan { valid, flags, ratio }.
 */
function validateFetchedBroksum(payload, candlesDir, ticker, date) {
  try {
    const candle = getCandleReference(candlesDir, ticker, date);
    return broksumValidator.validateBroksumAgainstCandle(payload, candle);
  } catch (e) {
    return { valid: false, flags: ['validator_error:' + e.message], ratio: null };
  }
}

function quarantineInvalidBroksum(baseDir, ticker, date, content) {
  try {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const qDir = path.join(baseDir, `_quarantine-tidakwajar-${stamp}`, ticker);
    const qFile = path.join(qDir, `${date}.json`);
    if (!fs.existsSync(qFile)) {
      fs.mkdirSync(qDir, { recursive: true });
      fs.writeFileSync(qFile, content, 'utf8');
    }
  } catch (_) {}
}

function backupClippedBroksum(baseDir, ticker, date, content) {
  try {
    const bkpDir = path.join(baseDir, '_backup-broksum-25', ticker);
    const bkpFile = path.join(bkpDir, `${date}.json`);
    if (!fs.existsSync(bkpFile)) {
      fs.mkdirSync(bkpDir, { recursive: true });
      fs.writeFileSync(bkpFile, content, 'utf8');
    }
  } catch (_) {}
}

function resolveMaxTradingDate(options = {}) {
  if (options && options.maxDate) return String(options.maxDate).trim();
  if (options && options.endDate) return String(options.endDate).trim();
  try {
    const cal = require('../lib/idx-trading-calendar');
    const now = (options && options.now) || new Date();
    const todayKey = wibDateKey(now);
    const holidays = cal.getSeedHolidaySet ? cal.getSeedHolidaySet() : new Set();
    if (cal.isTradingDay(todayKey, holidays)) {
      return todayKey;
    }
    return cal.previousTradingDay(todayKey, holidays) || todayKey;
  } catch (_) {
    return wibDateKey();
  }
}

function loadTradingDays(candlesDir, options = {}) {
  const maxDate = resolveMaxTradingDate(options);
  const minDate = (options && (options.minDate || options.startDate)) || '2026-01-02';
  const candidates = ['IHSG.json', 'BBCA.json', 'BRPT.json', 'BMRI.json', 'BBRI.json'];
  for (const f of candidates) {
    const p = path.join(candlesDir, f);
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = (data.candles || []).filter(c => c && c.date >= minDate && c.date <= maxDate).map(c => c.date);
        if (list.length > 0) {
          const unique = Array.from(new Set(list));
          return unique.sort().reverse(); // newest to oldest
        }
      } catch (_) {}
    }
  }

  // Fallback: inspect any .json in candlesDir
  try {
    const files = fs.readdirSync(candlesDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const p = path.join(candlesDir, f);
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = (data.candles || []).filter(c => c && c.date >= minDate && c.date <= maxDate).map(c => c.date);
        if (list.length > 0) {
          const unique = Array.from(new Set(list));
          return unique.sort().reverse();
        }
      } catch (_) {}
    }
  } catch (_) {}

  return [];
}

const tickerCandleCache = new Map();

function getTickerCandleMap(candlesDir, ticker) {
  if (tickerCandleCache.has(ticker)) return tickerCandleCache.get(ticker);
  const map = new Map();
  try {
    const cFile = path.join(candlesDir, `${ticker}.json`);
    if (fs.existsSync(cFile)) {
      const data = JSON.parse(fs.readFileSync(cFile, 'utf8'));
      if (Array.isArray(data.candles)) {
        for (const c of data.candles) {
          if (c && c.date) {
            map.set(c.date, Number(c.volume != null ? c.volume : 0));
          }
        }
      }
    }
  } catch (_) {}
  tickerCandleCache.set(ticker, map);
  return map;
}

function categorizeTickersByLiquidity(baseDir, candlesDir, tickers, options = {}) {
  const maxDate = resolveMaxTradingDate(options);
  const minDate = (options && (options.minDate || options.startDate)) || '2026-01-02';
  const liquid = [];
  const regular = [];

  tickers.forEach(tk => {
    let avgTurnover = 0;
    try {
      const cFile = path.join(candlesDir, `${tk}.json`);
      if (fs.existsSync(cFile)) {
        const cd = JSON.parse(fs.readFileSync(cFile, 'utf8'));
        const inRange = (cd.candles || []).filter(c => c && c.date >= minDate && c.date <= maxDate);
        if (inRange.length > 0) {
          const sum = inRange.reduce((acc, c) => acc + (c.volume * c.close), 0);
          avgTurnover = sum / inRange.length;
        }
      }
    } catch (_) {}

    if (avgTurnover >= 1000000000) {
      liquid.push({ ticker: tk, avgTurnover });
    } else {
      regular.push({ ticker: tk, avgTurnover });
    }
  });

  liquid.sort((a, b) => b.avgTurnover - a.avgTurnover);
  return {
    liquid: liquid.map(x => x.ticker),
    regular: regular.map(x => x.ticker)
  };
}

// B3 (2026-10-20): the backfill worker must yield to the daily jobs. It takes
// the shared Arjum lock (non-blocking): if J1 or J2 is running, the backfill is
// SKIPPED for this firing instead of hammering stock.arjum.com in parallel.
//
// B3 (2026-10-23): the lock used to be held for the ENTIRE run (hours), so a
// long backfill made every J1 firing skip. The lock is now taken per BATCH: the
// backfill releases it between batches so J1 can start within one batch window.
// `BACKFILL_BATCH_SIZE` (default 50) controls the batch size.
async function run(argv) {
  const arjumSharedLock = require('../lib/arjum-shared-lock');
  const outcome = await arjumSharedLock.withArjumLock({ job: 'backfill-broksum', waitMs: 0 }, () => runUnlocked(argv));
  if (outcome && outcome.skipped) {
    console.log('[BACKFILL-LOCK] SKIPPED_ARJUM_BUSY: job Arjum harian sedang berjalan; backfill dilewati untuk firing ini.');
    return { skipped: true, reason: 'SKIPPED_ARJUM_BUSY', requestsSent: 0 };
  }
  return outcome;
}

// Batch size for the per-batch lock hand-off. Exported for tests.
function backfillBatchSize(env) {
  const e = env || process.env;
  const n = parseInt(e.BACKFILL_BATCH_SIZE, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

async function runUnlocked(argv) {
  const args = argv || process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyForeign = args.includes('--only-foreign') || process.env.ONLY_FOREIGN === 'true';

  let limit = Infinity;
  for (const a of args) {
    if (a.startsWith('--limit=')) limit = parseInt(a.slice(8), 10) || Infinity;
  }
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) limit = parseInt(args[limitIdx + 1], 10) || Infinity;

  let delayMs = DEFAULT_DELAY_MS;
  for (const a of args) {
    if (a.startsWith('--delay=')) delayMs = parseInt(a.slice(8), 10) || DEFAULT_DELAY_MS;
  }
  const delayIdx = args.indexOf('--delay');
  if (delayIdx >= 0 && args[delayIdx + 1]) delayMs = parseInt(args[delayIdx + 1], 10) || DEFAULT_DELAY_MS;

  let overrideTargetDir = null;
  for (const a of args) {
    if (a.startsWith('--target-dir=')) overrideTargetDir = a.slice(13);
  }
  const targetDirIdx = args.indexOf('--target-dir');
  if (targetDirIdx >= 0 && args[targetDirIdx + 1]) overrideTargetDir = args[targetDirIdx + 1];

  let mode = null;
  for (const a of args) {
    if (a.startsWith('--mode=')) mode = a.slice(7);
  }
  const modeIdx = args.indexOf('--mode');
  if (modeIdx >= 0 && args[modeIdx + 1]) mode = args[modeIdx + 1];

  if (!mode) {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    mode = (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';
  }

  // Set Arjum throttle delay in process env so client throttle queue matches worker pacing
  process.env.ARJUM_THROTTLE_DELAY_MS = String(delayMs);

  // B3 (2026-10-23): per-batch lock hand-off so J1 is never starved.
  const batchSize = backfillBatchSize();
  let processedTickers = 0;
  const arjumSharedLock = require('../lib/arjum-shared-lock');
  // Release the shared lock, then check whether a daily job is waiting for it.
  // If so, this run stops (state is saved) and resumes on the next firing.
  async function yieldLockToDailyJobs() {
    if (arjumSharedLock.hasLockInThisProcess()) {
      arjumSharedLock.releaseLock(arjumSharedLock.defaultLockFile());
      arjumSharedLock.__resetReentrancyForTests();
    }
    // Give a waiting daily job a moment to take the lock.
    await sleep(1500);
    const info = arjumSharedLock.readLockInfo(arjumSharedLock.defaultLockFile());
    const holder = info && info.job ? String(info.job) : '';
    if (holder && holder !== 'backfill-broksum') {
      console.log(`[BACKFILL-LOCK] Lock kini dipegang ${holder}; backfill berhenti agar job harian jalan.`);
      return true;
    }
    // Nobody waiting: take the lock back and continue.
    const reacquired = await arjumSharedLock.withArjumLock({ job: 'backfill-broksum', waitMs: 0 }, async () => true);
    return Boolean(reacquired && reacquired.skipped);
  }

  const baseDir = getBaseDir(overrideTargetDir);

  // 2c: holiday fallback. On a non-trading weekday, behave like weekend.
  const todayKey = wibDateKey();
  if (mode === 'weekday' && !isTradingDaySafe(todayKey)) {
    console.log('[MODE] ' + todayKey + ' bukan hari bursa -> beralih ke mode weekend.');
    mode = 'weekend';
  }

  const explicitModeArg = modeIdx >= 0 ? mode : null;
  const remainingNow = quotaTracker.getRemainingToday(arjumClient.getConfiguredDailyQuota());
  // The reserve floor is resolved LATER (after the universe is known) because it
  // depends on the OUTSTANDING daily-job demand, which is counted from the
  // dated broker-summary files on disk.
  let reserveQuota = 0;
  let candlesDir = null;
  for (const a of args) {
    if (a.startsWith('--candles-dir=')) candlesDir = a.slice(14);
  }
  const candlesDirIdx = args.indexOf('--candles-dir');
  if (candlesDirIdx >= 0 && args[candlesDirIdx + 1]) candlesDir = args[candlesDirIdx + 1];

  if (!candlesDir) {
    const defaultCandles = path.join(__dirname, '..', 'data', 'daily-candles');
    candlesDir = fs.existsSync(defaultCandles) ? defaultCandles : path.join(process.cwd(), 'data', 'daily-candles');
  }

  const lockFile = getLockPath(baseDir);
  const stateFile = getStatePath(baseDir);

  if (!dryRun) {
    if (!acquireLock(lockFile)) {
      console.log(`[BACKFILL-LOCKED] Worker backfill sedang berjalan di proses lain (lock: ${lockFile}). Keluar rapi.`);
      return { success: false, reason: 'locked' };
    }
  }

  console.log('=== AUTO-CUAN BROKER SUMMARY BACKFILL WORKER ===');
  console.log(`Mode:            ${mode.toUpperCase()}`);
  console.log(`Only Foreign:    ${onlyForeign} (HANYA flow=F&all_data=true)`);
  console.log(`Initial Pacing:  ${delayMs}ms (~${(1000/delayMs).toFixed(1)} req/s)`);
  console.log(`Execution Limit: ${limit === Infinity ? 'UNLIMITED' : limit}`);
  console.log(`Target Base Dir: ${baseDir}`);
  console.log(`Dry Run:         ${dryRun}`);

  let state = {
    completedTasks: {},
    lastUpdated: null,
    totalSent: 0,
    startTime: new Date().toISOString(),
    completedTickers: {}
  };

  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state = Object.assign(state, parsed);
        if (!state.completedTasks) state.completedTasks = {};
        if (!state.completedTickers) state.completedTickers = {};
      }
    } catch (_) {}
  }

  let startDate = '2026-01-02';
  for (const a of args) {
    if (a.startsWith('--start-date=')) startDate = a.slice(13).trim();
  }
  let endDate = null;
  for (const a of args) {
    if (a.startsWith('--end-date=')) endDate = a.slice(11).trim();
  }
  const dateOpts = { startDate, endDate };
  const tradingDays = loadTradingDays(candlesDir, dateOpts);
  console.log(`Trading days in scope: ${tradingDays.length} days (${tradingDays[tradingDays.length - 1]} to ${tradingDays[0]})`);

  let universeTickers = [];
  for (const a of args) {
    if (a.startsWith('--tickers=')) {
      universeTickers = a.slice(10).split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    }
  }
  const tickerArgIdx = args.indexOf('--tickers');
  if (tickerArgIdx >= 0 && args[tickerArgIdx + 1]) {
    universeTickers = args[tickerArgIdx + 1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  }

  if (universeTickers.length === 0) {
    try {
      const txt = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
      if (fs.existsSync(txt)) {
        universeTickers = fs.readFileSync(txt, 'utf8').split(/\r?\n/).map(t => t.trim().toUpperCase()).filter(Boolean);
      }
    } catch (_) {}
  }

  // B6 (2026-10-20): the reserve is a FLOOR on the remaining quota. It is the
  // amount of quota that must stay available for the DAILY jobs still owing
  // work (today's session + the H-1 backlog) plus a 10% retry buffer — so the
  // backfill can never eat the quota the daily jobs need. Once today's EOD work
  // is done (.done sentinel) that demand is already spent, so the historical
  // fixed reserve applies again and the leftover becomes usable.
  const pendingDailyNeed = computePendingDailyNeed(baseDir, todayKey, universeTickers);
  reserveQuota = resolveBackfillReserveFloor({
    baseDir,
    explicitModeArg,
    remaining: remainingNow,
    mode,
    pendingDailyNeed
  });
  console.log(`[BUDGET] Kebutuhan job harian yang masih tertunda: ${pendingDailyNeed} request; lantai kuota backfill: ${reserveQuota}`);
  console.log(`Mode:            ${mode.toUpperCase()} (Reserve Quota: ${reserveQuota})`);

  const { liquid, regular } = categorizeTickersByLiquidity(baseDir, candlesDir, universeTickers, dateOpts);
  console.log(`Tickers: ${liquid.length} liquid (turnover >= 1M) + ${regular.length} regular = ${universeTickers.length} total.`);

  // Order: liquid tickers first, then regular
  const orderedTickers = [...liquid, ...regular];

  // Fase 5: antrean prioritas dari J1 (_eod/<tanggal>.anomali.json).
  // Pasangan (ticker, date) yang ditandai J1 dikoreksi lebih dulu.
  const anomalyQueue = loadAnomalyQueue(baseDir);
  if (anomalyQueue.size > 0) {
    console.log(`[ANOMALY-QUEUE] ${anomalyQueue.size} pasangan di antrean prioritas dari J1.`);
  }
  const anomalyKeys = new Set(anomalyQueue.keys());

  let requestsSent = 0;
  let skippedCount = 0;
  let syntheticCount = 0;
  let quotaHalted = false;
  let consecutive429 = 0;
  let consecutive5xx = 0;
  let haltReason = null; // 'quota' | 'circuit_breaker' | 'provider_error' | null
  const providerSkipped = []; // tasks deferred due to persistent 5xx/timeout
  const invalidAfterRetry = [];

  function saveState() {
    if (dryRun) return;
    try {
      state.lastUpdated = new Date().toISOString();
      state.totalRequestsSentInRun = requestsSent;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) {}
  }

  try {
    for (const ticker of orderedTickers) {
      if (quotaHalted || arjumClient.isCircuitBreakerTripped()) break;
      let tickerCompletedDays = 0;

      for (const date of tradingDays) {
        if (requestsSent >= limit) {
          console.log(`[LIMIT-REACHED] Batas request ${limit} tercapai. Berhenti rapi.`);
          break;
        }

        if (arjumClient.isCircuitBreakerTripped()) {
          console.log(`[CIRCUIT-BREAKER] Circuit breaker aktif. Berhenti total.`);
          quotaHalted = true;
          break;
        }

        const taskKeyAll = `${ticker}_${date}_all`;
        const taskKeyF = `${ticker}_${date}_F`;

        // Check All file status (skipped if onlyForeign is true)
        // Fase validasi permanen: file lama juga diuji kewajarannya terhadap candle.
        // File tidak wajar (kosong/subset/imbalance) masuk kembali ke antrean.
        const allFile = path.join(baseDir, 'broker-summary', ticker, `${date}.json`);
        let needsAll = false;
        let allNeedsValidationQuarantine = false;
        if (!onlyForeign) {
          if (!fs.existsSync(allFile)) {
            needsAll = true;
          } else {
            try {
              const raw = fs.readFileSync(allFile, 'utf8');
              const parsed = JSON.parse(raw);
              if (parsed.derived === 'no-trade') {
                // derived no-trade sah hanya bila candle benar-benar tanpa volume
                const candle = getCandleReference(candlesDir, ticker, date);
                const v = broksumValidator.validateBroksumAgainstCandle(parsed, candle);
                if (v.valid) {
                  needsAll = false;
                } else {
                  needsAll = true;
                  allNeedsValidationQuarantine = true;
                }
              } else if (Array.isArray(parsed.broker_levels) && parsed.broker_levels.length === 25 && parsed.all_data !== true) {
                needsAll = true;
                backupClippedBroksum(baseDir, ticker, date, raw);
              } else {
                // Sudah lolos cek 25-level: apakah panjangnya kurang dari volume candle?
                const trimmed = raw.trim();
                if (trimmed.length < 512) {
                  // File sangat kecil (kemungkinan kosong/rusak)
                  const candle = getCandleReference(candlesDir, ticker, date);
                  if (candle && Number(candle.volume || 0) > 0) {
                    needsAll = true;
                    allNeedsValidationQuarantine = true;
                  }
                } else {
                  // Uji kewajaran penuh (rasio vs candle + keseimbangan)
                  const candle = getCandleReference(candlesDir, ticker, date);
                  const v = validateFetchedBroksum(parsed, candlesDir, ticker, date);
                  if (!v.valid && candle && (v.flags.includes('unclipped_ratio_below') || v.flags.includes('empty_broksum_but_candle_has_volume') || v.flags.includes('parse_error'))) {
                    needsAll = true;
                    allNeedsValidationQuarantine = true;
                  }
                }
              }
            } catch (_) {
              needsAll = true;
              allNeedsValidationQuarantine = true;
            }
          }
        }

        // Check Foreign file status
        const fFile = path.join(baseDir, 'broker-summary-F', ticker, `${date}.json`);
        let needsF = false;
        if (!fs.existsSync(fFile)) {
          needsF = true;
        } else {
          try {
            const raw = fs.readFileSync(fFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || (parsed.flow !== 'F' && parsed.derived !== 'no-trade')) {
              needsF = true;
            }
          } catch (_) {
            needsF = true;
          }
        }

        // Fase 5: kalau pasangan ini ada di antrean anomali J1, paksa ambil ulang.
        const inAnomalyQueue = anomalyKeys.has(`${ticker}|${date}`);
        if (inAnomalyQueue) {
          if (!onlyForeign) needsAll = true;
          needsF = true;
        }

        if (!needsAll && !needsF) {
          skippedCount += onlyForeign ? 1 : 2;
          tickerCompletedDays++;
          continue;
        }

        // Re-evaluate the reserve floor before checking limits (handles the 00:00
        // WIB rollover, when the remaining quota resets and the daily jobs are
        // no longer pending).
        reserveQuota = resolveBackfillReserveFloor({
          baseDir,
          explicitModeArg,
          remaining: quotaTracker.getRemainingToday(arjumClient.getConfiguredDailyQuota()),
          mode,
          pendingDailyNeed: computePendingDailyNeed(baseDir, todayKey, universeTickers)
        });

        // Check Candle Volume & All File for Zero-Trade Session Optimization
        // Syarat lewat: volume candle 0 DAN file all kosong / tidak ada transaksi
        const candleMap = getTickerCandleMap(candlesDir, ticker);
        const hasCandleInfo = candleMap.has(date);
        const sessionVolume = hasCandleInfo ? candleMap.get(date) : null;

        let allFileHasTrades = false;
        let allFileExists = fs.existsSync(allFile);
        if (allFileExists) {
          try {
            const rawAll = fs.readFileSync(allFile, 'utf8');
            const parsedAll = JSON.parse(rawAll);
            allFileHasTrades = brokerSummaryHasTrades(parsedAll);
          } catch (_) {}
        }

        if (hasCandleInfo && sessionVolume === 0 && allFileExists && !allFileHasTrades) {
          // Zero trading volume session & All file confirms no trades: Do NOT call Arjum API! (Quota savings)
          if (dryRun) {
            console.log(`[DRY-RUN] [NO-TRADE] ${ticker} ${date} volume=0 & all=empty -> synthetic no-trade (0 quota)`);
          } else {
            if (needsAll && !onlyForeign) {
              const targetDirAll = path.join(baseDir, 'broker-summary', ticker);
              if (!fs.existsSync(targetDirAll)) fs.mkdirSync(targetDirAll, { recursive: true });
              fs.writeFileSync(allFile, JSON.stringify({
                stock_code: ticker,
                broker_start_date: date,
                broker_end_date: date,
                flow: 'all',
                brokers: [],
                broker_levels: [],
                derived: 'no-trade'
              }, null, 2), 'utf8');
              state.completedTasks[taskKeyAll] = true;
            }

            if (needsF) {
              const targetDirF = path.join(baseDir, 'broker-summary-F', ticker);
              if (!fs.existsSync(targetDirF)) fs.mkdirSync(targetDirF, { recursive: true });
              fs.writeFileSync(fFile, JSON.stringify({
                stock_code: ticker,
                broker_start_date: date,
                broker_end_date: date,
                flow: 'F',
                brokers: [],
                derived: 'no-trade'
              }, null, 2), 'utf8');
              state.completedTasks[taskKeyF] = true;
            }
          }
          syntheticCount++;
          tickerCompletedDays++;
          continue;
        }

        // 1. Fetch All if needed (and not only-foreign)
        if (needsAll && requestsSent < limit) {
          if (dryRun) {
            console.log(`[DRY-RUN] Fetch ALL: ${ticker} ${date} (all_data=true)`);
            requestsSent++;
          } else {
            // Retry transient provider errors (5xx/timeout) with backoff before
            // giving up on this task. Quota/429 is NOT retried here.
            let resAll = null;
            for (let attempt = 0; attempt <= PROVIDER_RETRY_DELAYS_MS.length; attempt++) {
              resAll = await arjumClient.fetchBrokerSummary(ticker, date, 'all', null, {
                allData: true,
                fresh: true,
                forceLive: true,
                noFallback: true,
                bypassMarketGuard: true
              });
              requestsSent++;
              state.totalSent = (state.totalSent || 0) + 1;
              if (!isProviderTransient(resAll)) break;
              if (attempt < PROVIDER_RETRY_DELAYS_MS.length) {
                const waitMs = PROVIDER_RETRY_DELAYS_MS[attempt];
                console.warn(`[BACKFILL-RETRY] ALL ${ticker} ${date} provider error (status=${resAll && resAll.status}); retry ${attempt + 1}/${PROVIDER_RETRY_DELAYS_MS.length} in ${waitMs}ms`);
                await sleep(waitMs);
              }
            }

            const isAll200 = resAll && resAll.status === 200;
            const isAllLive = resAll && !resAll.from_cache && !resAll.fallback;
            const hasAllData = resAll && resAll.data && typeof resAll.data === 'object';
            const isFlowAll = hasAllData && resAll.data.flow === 'all';
            const isMatchingTickerAll = hasAllData && String(resAll.data.stock_code || resAll.data.code || '').trim().toUpperCase() === ticker.toUpperCase();

            if (resAll.ok && isAll200 && isAllLive && isFlowAll && isMatchingTickerAll) {
              consecutive429 = 0;

              // Fase 5: validasi permanen sebelum disimpan. Retry sekali.
              let payloadToWrite = resAll.data;
              let v = validateFetchedBroksum(payloadToWrite, candlesDir, ticker, date);
              if (!v.valid && (v.flags.includes('empty_broksum_but_candle_has_volume') || v.flags.includes('unclipped_ratio_below') || v.flags.includes('unclipped_imbalance'))) {
                console.warn(`[VALIDASI-RETRY] ${ticker} ${date} hasil tidak wajar (${v.flags.join(',')} ratio=${v.ratio}). Mengulang sekali.`);
                try {
                  const retry = await arjumClient.fetchBrokerSummary(ticker, date, 'all', null, {
                    allData: true, fresh: true, forceLive: true, noFallback: true, bypassMarketGuard: true
                  });
                  requestsSent++;
                  state.totalSent = (state.totalSent || 0) + 1;
                  const retryOk = retry && retry.ok && retry.status === 200 && retry.data
                    && !retry.from_cache && !retry.fallback && retry.data.flow === 'all'
                    && String(retry.data.stock_code || '').trim().toUpperCase() === ticker.toUpperCase();
                  if (retryOk) {
                    const v2 = validateFetchedBroksum(retry.data, candlesDir, ticker, date);
                    if (v2.valid) {
                      payloadToWrite = retry.data;
                      v = v2;
                    } else {
                      v = v2;
                    }
                  }
                } catch (e) {
                  console.warn(`[VALIDASI-RETRY-ERR] ${ticker} ${date}: ${e.message}`);
                }
              }

              if (!v.valid && (v.flags.includes('empty_broksum_but_candle_has_volume') || v.flags.includes('unclipped_ratio_below') || v.flags.includes('unclipped_imbalance'))) {
                console.error(`[VALIDASI-REJECT] ${ticker} ${date}: masih tidak wajar setelah retry (${v.flags.join(',')} ratio=${v.ratio}). Tidak disimpan sebagai selesai.`);
                invalidAfterRetry.push({ ticker, date, flags: v.flags, ratio: v.ratio });
                if (fs.existsSync(allFile)) {
                  try { quarantineInvalidBroksum(baseDir, ticker, date, fs.readFileSync(allFile, 'utf8')); } catch (_) {}
                  try { fs.unlinkSync(allFile); } catch (_) {}
                }
                needsAll = false; // biarkan antrean memungut di run berikutnya
              } else {
                const targetDir = path.join(baseDir, 'broker-summary', ticker);
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                if (allNeedsValidationQuarantine && fs.existsSync(allFile)) {
                  try { quarantineInvalidBroksum(baseDir, ticker, date, fs.readFileSync(allFile, 'utf8')); } catch (_) {}
                }
                fs.writeFileSync(allFile, JSON.stringify(Object.assign({}, payloadToWrite, {
                  _validated: { at: new Date().toISOString(), ratio: v.ratio, flags: v.flags, validator: 'broksum-validator' }
                }), null, 2), 'utf8');
                state.completedTasks[taskKeyAll] = true;
                if (requestsSent % 5 === 0 || requestsSent <= 10) {
                  console.log(`[BACKFILL] Req ${requestsSent} | Saved ALL ${ticker} ${date} | ratio=${v.ratio} | Total Sent: ${state.totalSent}`);
                  saveState();
                }
              }
            } else if (isProviderTransient(resAll)) {
              // Transient provider error (5xx/timeout): retry with backoff, then
              // SKIP this task instead of killing the whole run.
              consecutive5xx++;
              console.warn(`[BACKFILL-PROVIDER] ALL ${ticker} ${date} transient error (status=${resAll.status}, error=${resAll.error}); consecutive5xx=${consecutive5xx}`);
              if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
                console.error(`[BACKFILL-HALT] ${consecutive5xx} consecutive provider errors (>= ${MAX_CONSECUTIVE_5XX}). Provider appears down — stopping for this run.`);
                haltReason = 'provider_error';
                quotaHalted = true;
                break;
              }
              providerSkipped.push({ ticker, date, flow: 'all', status: resAll.status, error: resAll.error });
              needsAll = false;
              continue; // next date; the task stays queued for a later run
            } else {
              // B6 (2026-10-20): an invalid/garbled provider response for ONE task
              // must not kill the whole backfill. Skip the task (it stays queued
              // for a later run) and CONTINUE with the next task.
              console.warn(`[BACKFILL-SKIP] Respon tidak valid untuk ALL ${ticker} ${date}: status=${resAll.status}, ok=${resAll.ok}, fallback=${resAll.fallback}, flow=${resAll.data && resAll.data.flow}, error=${resAll.error}`);
              providerSkipped.push({ ticker, date, flow: 'all', status: resAll.status, error: resAll.error });
              needsAll = false;
              continue;
            }

            // Quota remaining check
            let remaining;
            if (resAll.headers && resAll.headers['x-ratelimit-remaining'] != null) {
              remaining = parseInt(resAll.headers['x-ratelimit-remaining'], 10);
            } else {
              remaining = quotaTracker.getRemainingToday(arjumClient.getConfiguredDailyQuota());
            }

            if (!Number.isFinite(remaining)) {
              console.log(`[BUDGET-GUARD] Kuota sisa tidak dapat ditentukan. Berhenti.`);
              quotaHalted = true;
              break;
            }

            if (remaining <= reserveQuota) {
              console.log(`[BUDGET-GUARD] Kuota sisa (${remaining}) <= cadangan (${reserveQuota}). Berhenti.`);
              quotaHalted = true;
              break;
            }

            await sleep(delayMs);
          }
        }

        if (quotaHalted) break;

        // 2. Fetch Foreign if needed
        if (needsF && requestsSent < limit) {
          if (dryRun) {
            console.log(`[DRY-RUN] Fetch FOREIGN: ${ticker} ${date} (flow=F, all_data=true)`);
            requestsSent++;
          } else {
            // Same provider-retry policy as the ALL fetch above.
            let resF = null;
            for (let attempt = 0; attempt <= PROVIDER_RETRY_DELAYS_MS.length; attempt++) {
              resF = await arjumClient.fetchBrokerSummary(ticker, date, 'F', null, {
                allData: true,
                fresh: true,
                forceLive: true,
                noFallback: true,
                bypassMarketGuard: true
              });
              requestsSent++;
              state.totalSent = (state.totalSent || 0) + 1;
              if (!isProviderTransient(resF)) break;
              if (attempt < PROVIDER_RETRY_DELAYS_MS.length) {
                const waitMs = PROVIDER_RETRY_DELAYS_MS[attempt];
                console.warn(`[BACKFILL-RETRY] FOREIGN ${ticker} ${date} provider error (status=${resF && resF.status}); retry ${attempt + 1}/${PROVIDER_RETRY_DELAYS_MS.length} in ${waitMs}ms`);
                await sleep(waitMs);
              }
            }

            const isF200 = resF && resF.status === 200;
            const isFLive = resF && !resF.from_cache && !resF.fallback;
            const hasFData = resF && resF.data && typeof resF.data === 'object';
            const isFlowF = hasFData && resF.data.flow === 'F';
            const isMatchingTickerF = hasFData && String(resF.data.stock_code || resF.data.code || '').trim().toUpperCase() === ticker.toUpperCase();

            if (resF.ok && isF200 && isFLive && isFlowF && isMatchingTickerF) {
              consecutive429 = 0;
              const targetDir = path.join(baseDir, 'broker-summary-F', ticker);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(fFile, JSON.stringify(resF.data, null, 2), 'utf8');
              state.completedTasks[taskKeyF] = true;
              tickerCompletedDays++;

              if (requestsSent % 25 === 0) {
                console.log(`[BACKFILL] Req ${requestsSent} | Saved FOREIGN ${ticker} ${date} | Total Sent: ${state.totalSent}`);
                saveState();
              }
            } else if (isProviderTransient(resF)) {
              // Transient provider error (5xx/timeout): retry with backoff, then
              // SKIP this task instead of killing the whole run.
              consecutive5xx++;
              console.warn(`[BACKFILL-PROVIDER] FOREIGN ${ticker} ${date} transient error (status=${resF.status}, error=${resF.error}); consecutive5xx=${consecutive5xx}`);
              if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
                console.error(`[BACKFILL-HALT] ${consecutive5xx} consecutive provider errors (>= ${MAX_CONSECUTIVE_5XX}). Provider appears down — stopping for this run.`);
                haltReason = 'provider_error';
                quotaHalted = true;
                break;
              }
              providerSkipped.push({ ticker, date, flow: 'F', status: resF.status, error: resF.error });
              needsF = false;
              continue; // next date; the task stays queued for a later run
            } else {
              // B6 (2026-10-20): skip the task and continue (see ALL branch).
              console.warn(`[BACKFILL-SKIP] Respon tidak valid untuk FOREIGN ${ticker} ${date}: status=${resF.status}, ok=${resF.ok}, fallback=${resF.fallback}, flow=${resF.data && resF.data.flow}, error=${resF.error}`);
              providerSkipped.push({ ticker, date, flow: 'F', status: resF.status, error: resF.error });
              needsF = false;
              continue;
            }

            // Quota remaining check
            let remaining;
            if (resF.headers && resF.headers['x-ratelimit-remaining'] != null) {
              remaining = parseInt(resF.headers['x-ratelimit-remaining'], 10);
            } else {
              remaining = quotaTracker.getRemainingToday(arjumClient.getConfiguredDailyQuota());
            }

            if (!Number.isFinite(remaining)) {
              console.log(`[BUDGET-GUARD] Kuota sisa tidak dapat ditentukan. Berhenti.`);
              quotaHalted = true;
              break;
            }

            if (remaining <= reserveQuota) {
              console.log(`[BUDGET-GUARD] Kuota sisa (${remaining}) <= cadangan (${reserveQuota}). Berhenti.`);
              quotaHalted = true;
              break;
            }

            await sleep(delayMs);
          }
        }

        if (quotaHalted) break;
      }

      if (tickerCompletedDays >= tradingDays.length) {
        state.completedTickers[ticker] = { completedAt: new Date().toISOString(), days: tickerCompletedDays };
      }

      if (quotaHalted || requestsSent >= limit) break;

      // B3 (2026-10-23): hand the shared Arjum lock back between batches so a
      // long backfill cannot starve J1. If a daily job is waiting, this run
      // stops here and resumes on the next firing (state is already saved).
      processedTickers++;
      if (processedTickers % batchSize === 0) {
        saveState();
        const yielded = await yieldLockToDailyJobs();
        if (yielded) {
          console.log(`[BACKFILL-LOCK] Menyerahkan lock setelah ${processedTickers} emiten; job harian menunggu. Berhenti untuk firing ini.`);
          haltReason = 'yielded_to_daily';
          quotaHalted = true;
          break;
        }
      }
    }
  } finally {
    saveState();
    if (!dryRun) releaseLock(lockFile);
  }

  // Distinguish WHY the run stopped. A single provider 5xx must NOT be reported
  // as a budget/quota halt (that was the 2026-10-19 mislabel).
  let statusLabel;
  if (haltReason === 'provider_error') {
    statusLabel = 'HALTED_BY_PROVIDER_ERROR';
  } else if (haltReason === 'circuit_breaker') {
    statusLabel = 'HALTED_BY_CIRCUIT_BREAKER';
  } else if (quotaHalted) {
    statusLabel = 'HALTED_BY_BUDGET_OR_QUOTA';
  } else {
    statusLabel = 'COMPLETED_OR_LIMITED';
  }

  console.log(`\n=== BACKFILL EXECUTION SUMMARY ===`);
  console.log(`Requests Sent:       ${requestsSent}`);
  console.log(`Tasks Skipped:      ${skippedCount}`);
  console.log(`Synthetic No-Trade: ${syntheticCount}`);
  console.log(`Invalid After Retry: ${invalidAfterRetry.length}`);
  console.log(`Provider Skipped:   ${providerSkipped.length}`);
  console.log(`Status:              ${statusLabel}`);
  if (providerSkipped.length > 0) {
    console.log('Task ditunda karena error provider (akan dicoba lagi di run berikutnya):');
    for (const it of providerSkipped.slice(0, 50)) {
      console.log(`  - ${it.ticker} ${it.date} flow=${it.flow} status=${it.status} error=${it.error}`);
    }
  }
  if (invalidAfterRetry.length > 0) {
    console.log('Daftar periksa (perlu investigasi manual):');
    for (const it of invalidAfterRetry.slice(0, 50)) {
      console.log(`  - ${it.ticker} ${it.date} flags=${it.flags.join(',')} ratio=${it.ratio}`);
    }
  }
  return { success: true, requestsSent, skippedCount, syntheticCount, invalidAfterRetry, quotaHalted, haltReason, providerSkipped };
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal backfill error:', err);
    process.exit(1);
  });
}

module.exports = {
  run,
  categorizeTickersByLiquidity,
  loadTradingDays,
  resolveMaxTradingDate,
  getTickerCandleMap,
  brokerSummaryHasTrades,
  resolveDynamicReserveQuota,
  resolveBackfillReserveFloor,
  computeBackfillReserve,
  computePendingDailyNeed,
  countMissingForDate,
  previousTradingDayKey,
  DAILY_JOB_BASE_NEED,
  DAILY_JOB_RETRY_RATIO,
  DAILY_REQUESTS_PER_TICKER,
  isProviderTransient,
  PROVIDER_RETRY_DELAYS_MS,
  MAX_CONSECUTIVE_5XX,
  backfillBatchSize
};

'use strict';

/**
 * Daily Bandarmologi Update (Bagian 3) — Broker Summary + Broker Accumulation
 * + Insiders refresh for TODAY's trading date, for the full ticker universe.
 *
 * Arjum's broker-summary data for the current session typically isn't
 * published until ~18:00-20:00 WIB, so this is meant to run every 30 minutes
 * through the durable run-daily-market-update coordinator. New sessions begin
 * at 18:00 WIB; incomplete dates retry every 30 minutes through the bounded
 * EOD window:
 *   - Idempotent: any ticker whose broker-summary for today is already on
 *     disk is skipped on the next firing (mirrors tools/backfill-arjum-data.js).
 *   - Wave 2 typed terminal states (lib/eod-session-state.js):
 *       COMPLETE                  -> broker rows exist for the target date
 *       NO_TRADE                  -> target-date candle proves volume == 0;
 *                                    terminal, never retried, never given
 *                                    auxiliary requests
 *       BROKER_DATA_UNAVAILABLE   -> ticker traded (or cannot be proven not to
 *                                    have traded) but the provider returned an
 *                                    empty response on the FINAL pass; terminal
 *                                    for the day, never relabeled NO_TRADE
 *       PENDING_PROVIDER          -> empty response before the final pass;
 *                                    stays retryable inside the bounded window
 *       UPSTREAM_ERROR            -> transport/server/parser/quota failure;
 *                                    follows the existing bounded retry policy
 *   - The coordinator's terminal --final pass runs at 23:30 WIB (the EOD
 *     operating window is 18:00-23:30 WIB). An empty response on that pass is
 *     terminal BROKER_DATA_UNAVAILABLE unless the target-date candle proves
 *     volume == 0 (then NO_TRADE). It is never fabricated into a cache file.
 *   - Terminal NO_TRADE / BROKER_DATA_UNAVAILABLE tickers are recorded in the
 *     marker and removed from every future retry set (no repeated quota burn).
 *   - Auxiliary (accumulation/insiders) requests are ONLY sent for COMPLETE
 *     same-day tickers; terminal empty states and pending/error rows never
 *     spend auxiliary quota. Historical targets never backfill auxiliary at
 *     all (snapshot-only endpoints, no historical date parameter).
 *   - A complete marker makes later firings a fast no-op.
 *
 * Usage:
 *   node tools/run-daily-broker-update.js --dry-run
 *   node tools/run-daily-broker-update.js
 *   node tools/run-daily-broker-update.js --final
 *   node tools/run-daily-broker-update.js --tickers BBCA,BBRI --dry-run
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const idxTradingCalendar = require('../lib/idx-trading-calendar');
const eodSessionState = require('../lib/eod-session-state');
const brokerAccumulationLocal = require('../lib/broker-accumulation-local');
const arjumFailureLog = require('../lib/arjum-failure-log');

// Same .env loading convention as tools/backfill-arjum-data.js /
// tools/run-daily-afternoon-recap.js.
try {
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local')
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJakartaDateString(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now || new Date());
}

function getJakartaTimeInfo(now) {
  const dateObj = now || new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = fmt.formatToParts(dateObj);
  let year = '', month = '', day = '', hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  const dateKey = `${year}-${month}-${day}`;
  return { dateKey, hour, minute };
}

function resolveTargetDate(options = {}) {
  const { dateArg, now, holidaySet } = options;
  if (dateArg) {
    return {
      targetDate: String(dateArg).trim(),
      shifted: false,
      reason: 'explicit_argument'
    };
  }

  const { dateKey: todayKey, hour, minute } = getJakartaTimeInfo(now);
  const isBeforeCutoff = hour < 16 || (hour === 16 && minute < 30);

  // If today is a weekend or public holiday, always shift to the last completed trading day
  if (!idxTradingCalendar.isTradingDay(todayKey, holidaySet)) {
    const prevTrading = idxTradingCalendar.previousTradingDay(todayKey, holidaySet);
    const resolved = prevTrading || todayKey;
    return {
      targetDate: resolved,
      shifted: true,
      originalDate: todayKey,
      timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      reason: 'weekend_or_holiday'
    };
  }

  if (isBeforeCutoff) {
    const prevTrading = idxTradingCalendar.previousTradingDay(todayKey, holidaySet);
    const resolved = prevTrading || todayKey;
    return {
      targetDate: resolved,
      shifted: true,
      originalDate: todayKey,
      timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      reason: 'before_market_close_cutoff'
    };
  }

  return {
    targetDate: todayKey,
    shifted: false,
    reason: 'after_cutoff_today'
  };
}

function markerPath(date) {
  const baseDir = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
  return path.join(baseDir, '_daily-update-marker', `${date}.json`);
}

function readMarker(date) {
  try {
    const p = markerPath(date);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function writeMarker(date, payload) {
    const p = markerPath(date);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const temp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
    fs.renameSync(temp, p);
}

// ─────────────────────────────────────────────────────────────────────────
// Target-date candle evidence (W2-04/W2-05/W2-08)
//
// The only deterministic proof that a session was a NO_TRADE session is the
// target date's own candle with volume == 0. This reader is read-only and
// never fetches: when the candle is absent the evidence is "unavailable" and
// the caller must fall through to the normal provider flow.
// ─────────────────────────────────────────────────────────────────────────

function resolveCandleCandidateDirs() {
  const dirs = [];
  if (process.env.CANDLE_CACHE_DIR) dirs.push(process.env.CANDLE_CACHE_DIR);
  dirs.push(path.join(process.cwd(), 'data', 'daily-candles'));
  dirs.push(path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache'));
  dirs.push(path.join(__dirname, '..', 'data', 'daily-candles'));
  dirs.push(path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache'));
  return Array.from(new Set(dirs));
}

function readTargetCandleEvidence(ticker, targetDate) {
  const key = String(targetDate || '').slice(0, 10);
  const clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return { available: false, volume: null, close: null };
  for (const dir of resolveCandleCandidateDirs()) {
    try {
      const p = path.join(dir, `${clean}.json`);
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const candles = data && (data.candles || data.data || (Array.isArray(data) ? data : null));
      if (!Array.isArray(candles)) continue;
      const row = candles.find(c => String((c && c.date) || '').slice(0, 10) === key);
      if (!row) continue;
      const vol = row.volume != null ? Number(row.volume) : NaN;
      if (!Number.isFinite(vol)) continue;
      const close = Number(row.close != null ? row.close : row.c);
      return { available: true, volume: vol, close: Number.isFinite(close) ? close : null };
    } catch (_) {}
  }
  return { available: false, volume: null, close: null };
}


function backupBroksum25IfNeeded(ticker, date, newData) {
  try {
    const baseDir = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
    const origPath = path.join(baseDir, 'broker-summary', ticker, `${date}.json`);
    const backupPath = path.join(baseDir, '_backup-broksum-25', ticker, `${date}.json`);
    if (fs.existsSync(origPath) && !fs.existsSync(backupPath)) {
      const origContent = fs.readFileSync(origPath, 'utf8');
      const origObj = JSON.parse(origContent);
      if (Array.isArray(origObj.broker_levels) && origObj.broker_levels.length <= 25) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, origContent, 'utf8');
      }
    }
  } catch (_) {}
}

function loadPriorityTickers() {
  const set = new Set();
  try {
    const pTxt = path.join(__dirname, '..', 'data', 'priority.txt');
    if (fs.existsSync(pTxt)) {
      fs.readFileSync(pTxt, 'utf8').split(/\r?\n/).forEach(t => {
        const c = t.trim().toUpperCase();
        if (c && !c.startsWith('#')) set.add(c);
      });
    }
    const dTxt = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
    if (fs.existsSync(dTxt)) {
      fs.readFileSync(dTxt, 'utf8').split(/\r?\n/).forEach(t => {
        const c = t.trim().toUpperCase();
        if (c && !c.startsWith('#') && set.size < 100) set.add(c);
      });
    }
  } catch (_) {}
  return set;
}

function brokerSummaryPayloadDate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.broker_end_date, payload.broker_start_date, payload.trade_date, payload.date];
  for (const value of candidates) {
    const key = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  }
  return null;
}

function shouldAdvanceLatestBrokerSummary(ticker, targetDate) {
  const target = String(targetDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return false;

  let newestKnown = null;
  try {
    const dates = bandarmologiService.listDiskDates('broker-summary', ticker) || [];
    for (const value of dates) {
      const key = String(value || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && (!newestKnown || key > newestKnown)) newestKnown = key;
    }
  } catch (_) {}

  try {
    const latestRaw = bandarmologiService.readDiskCache('broker-summary', ticker, 'latest');
    const latestDate = brokerSummaryPayloadDate(latestRaw);
    if (latestDate && (!newestKnown || latestDate > newestKnown)) newestKnown = latestDate;
  } catch (_) {}

  return !newestKnown || target >= newestKnown;
}

async function run(argv) {
  const args = argv || process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const isFinal = args.includes('--final');

  const isFresh = args.includes('--fresh');
  // 2a: Parity test (2026-10-18) FAILED while broker-summary is still clipped to
  // 25 levels, so local accumulation is LESS accurate than Arjum's own API.
  // Keep /api/broker-accumulation as the SINGLE daily accumulation writer.
  // ACCUM_SOURCE=local stays available for historical re-derivation once the
  // all_data=true backfill is complete.
  const accumSource = (args.find(a => a.startsWith('--accum-source=')) || '').replace('--accum-source=', '') || process.env.ACCUM_SOURCE || 'api';
  // 2b: Insider stays DAILY for all stocks while the 12.060 quota holds.
  // weekly = all stocks on Saturday 01:00 + <=100 priority daily (prepared,
  // NOT enabled). Default is 'daily'.
  const insiderMode = (args.find(a => a.startsWith('--insider-mode=')) || '').replace('--insider-mode=', '') || process.env.INSIDER_MODE || 'daily';
  const priorityTickers = loadPriorityTickers();
  let foreignRequests = 0;
  let limit = Infinity;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10) || Infinity;
  }

  let dateFromArg = null;
  const dateIdx = args.indexOf('--date');
  if (dateIdx >= 0 && args[dateIdx + 1]) dateFromArg = args[dateIdx + 1];

  const resolved = resolveTargetDate({ dateArg: dateFromArg });
  const dateArg = resolved.targetDate;
  const executionDate = String(process.env.AUTO_CUAN_EOD_TEST_TODAY || getJakartaDateString()).slice(0, 10);
  const historicalTarget = /^\d{4}-\d{2}-\d{2}$/.test(dateArg) && dateArg < executionDate;

  if (resolved.shifted) {
    console.log(`[SAFETY GUARD] Script dieksekusi sebelum pukul 16:30 WIB (${resolved.timeString} WIB) tanpa argumen --date.`);
    console.log(`  -> Target date otomatis dialihkan dari hari ini (${resolved.originalDate}) ke hari bursa aktif sebelumnya (${dateArg}) agar kuota API tidak terbuang.`);
  }

  let tickers = [];
  const tickerArgIdx = args.indexOf('--tickers');
  if (tickerArgIdx >= 0 && args[tickerArgIdx + 1]) {
    tickers = args[tickerArgIdx + 1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  } else {
    try {
      const txtFile = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
      if (fs.existsSync(txtFile)) {
        tickers = fs.readFileSync(txtFile, 'utf8').split(/\r?\n/).map(t => t.trim().toUpperCase()).filter(Boolean);
      }
    } catch (_) {}
  }

  if (isFinite(limit) && limit < tickers.length) {
    tickers = tickers.slice(0, limit);
  }

  let delayMs = 250;
  const delayIdx = args.indexOf('--delay');
  if (delayIdx >= 0 && args[delayIdx + 1]) delayMs = parseInt(args[delayIdx + 1], 10) || 250;

  const dailyLimit = arjumClient.getConfiguredDailyQuota();

  console.log('=== AUTO-CUAN DAILY BROKER UPDATE (Bagian 3) ===');
  console.log(`Target Date (WIB): ${dateArg}`);
  console.log(`Total Tickers: ${tickers.length}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : (isFresh ? 'LIVE (FRESH OVERWRITE)' : 'LIVE')}${isFinal ? ' (FINAL ATTEMPT for tonight)' : ''}`);
  if (historicalTarget) {
    console.log('Historical safety: broker-summary only; accumulation/insider snapshot endpoints are not date-addressable and will not be backfilled.');
  }
  console.log(`Daily Quota: ${dailyLimit} | Already used today (cross-process, all scripts): ${arjumClient.getUsedQuotaToday()}`);
  console.log('----------------------------------------------------');

  // Mandatory per project spec: skip entirely on a non-trading day (weekend
  // or IDX/KSEI holiday) rather than spending quota on a session that never
  // happened. Falls back to a weekend-only guard when Supabase credentials
  // are unavailable (idx-trading-calendar.js's own designed degrade), so
  // this still works before/without the holiday table being seeded.
  let supabase = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('../lib/hybrid-supabase-client');
      supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (_) {}
  }
  const guard = await idxTradingCalendar.marketDayGuard(supabase, { now: new Date(`${dateArg}T12:00:00+07:00`) });
  if (!guard.shouldRun) {
    console.log(`[LIBUR: ${guard.reason}] ${dateArg} bukan hari bursa (calendar source: ${guard.calendarSource}). Worker berhenti, tidak ada request dikirim.`);
    return { skipped: true, reason: guard.reason };
  }
  console.log(`Trading day check: OK (calendar source: ${guard.calendarSource})`);

  tickers = [...new Set(tickers)].sort();
  const universeHash = crypto.createHash('sha256').update(tickers.join(',')).digest('hex');
  const existingMarker = readMarker(dateArg);
  if (!isFresh && existingMarker && existingMarker.complete && existingMarker.version === 2 && existingMarker.universe_hash === universeHash) {
    console.log(`[SUDAH SELESAI] Marker ${dateArg} sudah lengkap sejak ${existingMarker.completed_at}. Tidak ada yang perlu dikerjakan.`);
    return;
  }
  if (!isFresh && existingMarker && existingMarker.complete && Number(existingMarker.total_tickers) !== tickers.length) {
    console.log(`[UNIVERSE BERUBAH] Marker ${dateArg} mencatat ${existingMarker.total_tickers} ticker, universe aktif sekarang ${tickers.length}. Hanya ticker yang belum punya dated cache yang akan diproses ulang.`);
  }

  if (!dryRun && !arjumClient.hasArjumApiKey()) {
    console.error('ERROR: ARJUM_API_KEY tidak ditemukan di environment atau .env.');
    throw new Error('ARJUM_API_KEY is required');
  }

  // Per-run quota accounting (W2-18). Structured counters, no secrets.
  let totalRequested = 0;
  let brokerRequests = 0;
  let accumulationRequests = 0;
  let insiderRequests = 0;
  let requestsSkippedNoTrade = 0;
  let requestsSkippedTerminal = 0;
  let doneCount = 0;
  let newBrokerSummaryCount = 0;
  let pendingCount = 0; // PENDING_PROVIDER: traded-or-unproven, provider may still publish.
  let noTradeCount = 0; // NO_TRADE: target-date candle proves volume == 0.
  let brokerDataUnavailableCount = 0; // Traded-but-empty on the terminal --final pass.
  let errorCount = 0;
  let quotaReached = false;
  let auxiliaryPending = 0;
  // BUG-INSIDER-STALE-CACHE: count sessions where the insider endpoint returned
  // no trade newer than the target date (honest "no new trades" accounting).
  let insiderNoNewTradesCount = 0;
  const retryableTickers = new Set();
  const terminalTickers = new Set();

  // B1/B2 (2026-10-20): per-run Arjum failure accounting so an all-failed run is
  // never again a bare "error 921" with no kind on record. `earlyOutcomes` feeds
  // the circuit breaker (first-20-all-failed / >50%-of-first-50) so a provider
  // outage stops the job instead of burning the whole daily quota.
  const failureSummary = arjumFailureLog.createFailureSummary({ maxSamplesPerKind: 5 });
  const earlyOutcomes = [];
  let circuitTripped = false;
  let circuitReason = '';
  const CIRCUIT_MIN_FIRST = 20;
  const CIRCUIT_WINDOW = 50;

  function noteNetworkOutcome(res, ticker) {
    let kind = null;
    if (res && res.ok) {
      earlyOutcomes.push({ kind: null });
    } else {
      const classified = failureSummary.recordFailure(res, { ticker });
      kind = classified.kind;
      earlyOutcomes.push({ kind });
    }
    // Evaluate the breaker after EVERY attempt (success or failure), not only
    // after failures: rule 2 is a ratio over the first 50 attempts, so it can
    // only be reached on a call that may itself have succeeded.
    if (!circuitTripped && earlyOutcomes.length <= CIRCUIT_WINDOW) {
      const verdict = arjumFailureLog.shouldTripEarly({
        outcomes: earlyOutcomes,
        minFirst: CIRCUIT_MIN_FIRST,
        ratioWindow: CIRCUIT_WINDOW,
        failureRatio: 0.5
      });
      if (verdict.trip) {
        circuitTripped = true;
        circuitReason = verdict.reason;
      }
    }
  }

  // Terminal sets persisted by an earlier run of the SAME date are honored on
  // every later firing (and reopened only by --fresh or a universe change),
  // so terminal rows are never re-requested (W2-06).
  const priorMarkerTerminal = new Set();
  if (!isFresh && existingMarker && existingMarker.version === 2) {
    for (const list of [existingMarker.no_trade_tickers, existingMarker.broker_data_unavailable_tickers, existingMarker.no_data_tickers]) {
      if (Array.isArray(list)) list.forEach(t => priorMarkerTerminal.add(t));
    }
  }
  // Review fix (P2): --fresh discards prior terminal claims entirely. If a
  // formerly NO_TRADE ticker now returns valid rows, it must not remain listed
  // in the new marker's terminal arrays.
  const noTradeTickers = new Set(!isFresh && Array.isArray(existingMarker && existingMarker.no_trade_tickers) ? existingMarker.no_trade_tickers : []);
  const brokerDataUnavailableTickers = new Set(!isFresh && Array.isArray(existingMarker && existingMarker.broker_data_unavailable_tickers) ? existingMarker.broker_data_unavailable_tickers : []);

  function checkApiQuota(res) {
    if (!res.ok) {
      const classified = arjumClient.classifyFailure(res);
      if (classified.reason === 'quota_exceeded') {
        quotaReached = true;
        console.log(`\n[BERHENTI: KUOTA API HABIS] ${classified.detail || 'quota exceeded'}. Sisa ticker akan dicoba lagi di run berikutnya.`);
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < tickers.length; i++) {
    if (quotaReached) break;
    if (circuitTripped) break;
    const ticker = tickers[i];
    let shouldRefreshAuxiliary = false;

    // 0. Deterministic target-date trading evidence FIRST (W2-04/W2-05/W2-08).
    // A valid target-date candle with volume == 0 proves the session was a
    // NO_TRADE session: terminal, no broker request, no auxiliary request.
    const candleEvidence = readTargetCandleEvidence(ticker, dateArg);

    // 1. Broker Summary for TODAY — the critical, evening-gated data.
    // Retry firings must be quota-safe: if the dated summary is already valid,
    // reuse it and retry only missing dated accumulation/insider caches.
    const cached = !isFresh && bandarmologiService.readDiskCache('broker-summary', ticker, dateArg);
    const normalized = cached && bandarmologiService.normalizeBrokerSummary(cached, dateArg);
    const cachedDate = cached && brokerSummaryPayloadDate(cached);
    const alreadyCached = normalized && (!cachedDate || cachedDate === dateArg) && ((normalized.top_buyers || []).length || (normalized.top_sellers || []).length);

    if (alreadyCached) {
      doneCount++;
      terminalTickers.add(ticker);
      shouldRefreshAuxiliary = true;
    } else if (candleEvidence.available && candleEvidence.volume === 0) {
      // Proven no-trade session (terminal): never retried, never given any
      // broker/auxiliary request again for this date.
      noTradeCount++;
      noTradeTickers.add(ticker);
      terminalTickers.add(ticker);
      requestsSkippedNoTrade++;
    } else if (priorMarkerTerminal.has(ticker)) {
      // Terminal outcome recorded by an earlier run of this date.
      if (noTradeTickers.has(ticker)) noTradeCount++;
      else { brokerDataUnavailableCount++; brokerDataUnavailableTickers.add(ticker); }
      terminalTickers.add(ticker);
      requestsSkippedTerminal++;
    } else if (dryRun) {
      totalRequested++;
      brokerRequests++;
    } else {
      if (arjumClient.getUsedQuotaToday() >= dailyLimit) { quotaReached = true; break; }
      totalRequested++;
      brokerRequests++;
      const res = await arjumClient.fetchBrokerSummary(ticker, dateArg, 'all', null, {
        allData: true,
        fresh: true,
        forceLive: true,
        noFallback: true
      });
      const isAllValid = res.ok && res.data && !res.from_cache && !res.fallback && res.data.flow === 'all';
      noteNetworkOutcome(res, ticker);
      if (isAllValid && (!brokerSummaryPayloadDate(res.data) || brokerSummaryPayloadDate(res.data) === dateArg)) {
        const norm = bandarmologiService.normalizeBrokerSummary(res.data, dateArg, ticker, { skipLivePrice: historicalTarget });
        const hasAnyRows = (norm.top_buyers && norm.top_buyers.length > 0) || (norm.top_sellers && norm.top_sellers.length > 0);
        const state = eodSessionState.classifyBrokerOutcome({
          hasRows: hasAnyRows,
          candleAvailable: candleEvidence.available,
          candleVolume: candleEvidence.volume,
          isFinal
        });

        if (state === eodSessionState.EOD_STATES.COMPLETE) {
          const advanceLatest = shouldAdvanceLatestBrokerSummary(ticker, dateArg);
          backupBroksum25IfNeeded(ticker, dateArg, res.data);
          persistDatedCache('broker-summary', ticker, dateArg, res.data);
          if (advanceLatest) {
            bandarmologiService.writeDiskCache('broker-summary', ticker, 'latest', res.data);
          } else {
            console.log(`[HISTORICAL] ${ticker} ${dateArg} disimpan sebagai dated cache; latest.json yang lebih baru dipertahankan.`);
          }

          // Fetch Foreign Broker Summary (flow=F&all_data=true, strictly live network only)
          try {
            if (arjumClient.getUsedQuotaToday() < dailyLimit) {
              totalRequested++;
              foreignRequests++;
              const resF = await arjumClient.fetchBrokerSummary(ticker, dateArg, 'F', null, {
                allData: true,
                fresh: true,
                forceLive: true,
                noFallback: true
              });
              const isFValid = resF.ok && resF.data && !resF.from_cache && !resF.fallback && resF.data.flow === 'F' &&
                String(resF.data.stock_code || resF.data.code || '').trim().toUpperCase() === ticker.toUpperCase();
              if (isFValid) {
                persistDatedCache('broker-summary-F', ticker, dateArg, resF.data);
                if (advanceLatest) {
                  bandarmologiService.writeDiskCache('broker-summary-F', ticker, 'latest', resF.data);
                }
              }
            }
          } catch (_) {}

          doneCount++;
          newBrokerSummaryCount++;
          terminalTickers.add(ticker);
          shouldRefreshAuxiliary = true;
        } else if (state === eodSessionState.EOD_STATES.NO_TRADE) {
          // Deterministic zero-volume proof (mid-run reclassification).
          noTradeCount++;
          noTradeTickers.add(ticker);
          terminalTickers.add(ticker);
          requestsSkippedNoTrade++;
        } else if (state === eodSessionState.EOD_STATES.BROKER_DATA_UNAVAILABLE) {
          // Traded (or unprovable) but the provider had nothing on the
          // terminal --final pass (23:30 WIB). Terminal for the day; NEVER
          // relabeled NO_TRADE, never fabricated into a cache file.
          brokerDataUnavailableCount++;
          brokerDataUnavailableTickers.add(ticker);
          terminalTickers.add(ticker);
        } else {
          // PENDING_PROVIDER: keep it in the bounded retry set so late
          // publication can still arrive during the EOD window.
          pendingCount++;
          retryableTickers.add(ticker);
        }
      } else {
        if (checkApiQuota(res)) break;
        errorCount++;
        retryableTickers.add(ticker);
      }
      if (circuitTripped) {
        console.log(`\n[CIRCUIT BREAKER] Menghentikan run: ${circuitReason}. Sisa ticker tidak dipanggil untuk menyelamatkan kuota harian.`);
        break;
      }
      await sleep(delayMs);
    }

    if (quotaReached) break;

    // 2-3. Auxiliary refresh: ONLY for tickers whose broker summary is
    // COMPLETE for this same-day target (shouldRefreshAuxiliary is set only in
    // that branch). Terminal no-trade / unavailable rows and pending/error
    // rows never spend auxiliary quota (W2-05). Historical targets never
    // backfill auxiliary at all (snapshot-only endpoints).
    if (shouldRefreshAuxiliary && !historicalTarget) {
      if (!dryRun && (isFresh || !bandarmologiService.readDiskCache('broker-accumulation', ticker, dateArg))) {
        if (accumSource === 'local') {
          // Compute accumulation locally from rolling daily broker-summary without spending API quota
          try {
            const dates = bandarmologiService.listDiskDates('broker-summary', ticker) || [];
            const sortedDates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= dateArg).sort();
            const window80 = sortedDates.slice(-80);
            const dailySeries = window80.map(d => ({
              date: d,
              broksum: bandarmologiService.readDiskCache('broker-summary', ticker, d)
            })).filter(x => x.broksum != null);

            const localAcc = brokerAccumulationLocal.computeBrokerAccumulation(ticker, dailySeries);
            if (localAcc) {
              bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'series', localAcc);
              persistDatedCache('broker-accumulation', ticker, dateArg, localAcc);
            }
          } catch (_) {}
        } else {
          if (arjumClient.getUsedQuotaToday() >= dailyLimit) { quotaReached = true; break; }
          totalRequested++;
          accumulationRequests++;
          const accRes = await arjumClient.fetchBrokerAccumulation(ticker, { forceLive: true, noFallback: true });
          if (accRes.ok && accRes.data && !accRes.from_cache && !accRes.fallback) {
            bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'series', accRes.data);
            persistDatedCache('broker-accumulation', ticker, dateArg, accRes.data);
          } else if (checkApiQuota(accRes)) {
            break;
          } else {
            auxiliaryPending++; errorCount++;
            retryableTickers.add(ticker);
          }
          await sleep(delayMs);
        }
      } else if (dryRun && !bandarmologiService.readDiskCache('broker-accumulation', ticker, dateArg)) {
        totalRequested++;
        accumulationRequests++;
      }

      if (quotaReached) break;

      // Insiders: an empty result is normal, not an error.
      //
      // BUG-INSIDER-STALE-CACHE (2026-10-13): audit forensics proved the dated
      // insider files for AADI/BBCA were byte-identical (same MD5) for 7
      // consecutive sessions. The vendor's insider endpoint is a rolling
      // snapshot of the LAST KNOWN trades; when no new insider transaction has
      // occurred, it keeps returning the same payload and the writer stored a
      // fresh-looking dated file every day, so downstream freshness checks saw
      // "fresh data" that was actually months old (latest real trade: 2026-08-19).
      // The fetcher must compare the payload's newest trade date against the
      // target trading date and only record a genuine update when a real
      // insider trade exists on/after that date. Otherwise the dated file is
      // stamped with an explicit no_new_trades marker so checksums differ per
      // date and consumers can tell "no new trades" from "new data".
      // daily/all = full universe (documented in the report + cron flags);
      // weekly = prepared-but-not-enabled mode: priority subset daily, full
      // universe weekly. The gate below must mirror that intent — the old
      // `insiderMode === 'all' || priority` form silently degraded the
      // default 'daily' mode to the priority subset only.
      const shouldFetchInsider = insiderMode === 'weekly' ? priorityTickers.has(ticker) : true;
      if (!dryRun && shouldFetchInsider && (isFresh || !bandarmologiService.readDiskCache('insiders', ticker, dateArg))) {
        if (arjumClient.getUsedQuotaToday() >= dailyLimit) { quotaReached = true; break; }
        totalRequested++;
        insiderRequests++;
        const insRes = await arjumClient.fetchInsiders(ticker, 1, 15, { forceLive: true, noFallback: true });
        if (insRes.ok && insRes.data && !insRes.from_cache && !insRes.fallback) {
          const latestTradeDate = latestInsiderTradeDate(insRes.data);
          const hasNewTrades = latestTradeDate != null && latestTradeDate >= dateArg;
          const stampedInsiderPayload = Object.assign({}, insRes.data, {
            _cache_meta: {
              target_date: dateArg,
              latest_insider_trade_date: latestTradeDate,
              no_new_insider_trades: !hasNewTrades,
              fetched_at: new Date().toISOString()
            }
          });
          bandarmologiService.writeDiskCache('insiders', ticker, 'p1', stampedInsiderPayload);
          persistDatedCache('insiders', ticker, dateArg, stampedInsiderPayload);
          if (!hasNewTrades) {
            // Honest accounting: no real trade for this session.
            insiderNoNewTradesCount++;
          }
        } else if (checkApiQuota(insRes)) {
          break;
        } else {
          auxiliaryPending++; errorCount++;
          retryableTickers.add(ticker);
        }
        await sleep(delayMs);
      } else if (dryRun && !bandarmologiService.readDiskCache('insiders', ticker, dateArg)) {
        totalRequested++;
        insiderRequests++;
      }
    } else if (dryRun && !alreadyCached && !(candleEvidence.available && candleEvidence.volume === 0) && !priorMarkerTerminal.has(ticker) && !historicalTarget) {
      // Dry-run keeps counting the non-historical three-request worst case for
      // tickers that would actually be attempted.
      totalRequested += 2;
      accumulationRequests++;
      insiderRequests++;
    }
  }

  const terminalCount = doneCount + noTradeCount + brokerDataUnavailableCount;
  const remaining = tickers.length - terminalCount;
  // Auxiliary obligations apply ONLY to COMPLETE (broker rows present) tickers:
  // a proven no-trade session has no broker data to accompany. Historical
  // targets have no auxiliary obligations at all.
  const auxiliaryComplete = historicalTarget ? true : tickers.every(ticker => {
    if (terminalTickers.has(ticker) && !bandarmologiService.readDiskCache('broker-summary', ticker, dateArg)) return true;
    return bandarmologiService.readDiskCache('broker-accumulation', ticker, dateArg) &&
      bandarmologiService.readDiskCache('insiders', ticker, dateArg);
  });
  const complete = !dryRun && tickers.length > 0 && remaining === 0 && auxiliaryComplete && auxiliaryPending === 0 && errorCount === 0 && !quotaReached && !circuitTripped;

  console.log('\n----------------------------------------------------');
  console.log('=== RINGKASAN DAILY BROKER UPDATE ===');
  console.log(`Total Permintaan Terkirim (run ini): ${totalRequested}`);
  console.log(`  - broker-summary: ${brokerRequests} | accumulation: ${accumulationRequests} | insiders: ${insiderRequests}`);
  console.log(`  - dilewati (NO_TRADE): ${requestsSkippedNoTrade} | dilewati (terminal lain): ${requestsSkippedTerminal}`);
  console.log(`Total Terpakai Hari Ini (lintas-proses): ${arjumClient.getUsedQuotaToday()} / ${dailyLimit}`);
  console.log(`Broker Summary Selesai:        ${doneCount}/${tickers.length}`);
  console.log(`Broker Summary Baru (run ini): ${newBrokerSummaryCount}`);
  console.log(`Belum Terbit (Pending Arjum):  ${pendingCount}`);
  console.log(`NO_TRADE (volume nol):         ${noTradeCount}`);
  console.log(`Broker Data Unavailable:       ${brokerDataUnavailableCount}`);
  console.log(`Insider tanpa trade baru:      ${insiderNoNewTradesCount} (stempel no_new_insider_trades)`);
  console.log(`Error / Gagal:                 ${errorCount}`);
  console.log(`Retryable (bounded window):    ${retryableTickers.size}`);
  console.log(`Terminal (tidak di-retry):     ${terminalTickers.size}`);
  console.log(`Kuota Habis:                   ${quotaReached ? 'YA' : 'TIDAK'}`);
  if (circuitTripped) {
    console.log(`Pemutus Sirkuit:               AKTIF (${circuitReason})`);
  }
  // B1: always print the failure breakdown by kind, so a future incident has
  // the failure TYPE on record (not just an aggregate count).
  console.log(failureSummary.formatSummary());

  if (dryRun) {
    console.log('Status: DRY-RUN, tidak ada perubahan disimpan.');
    return;
  }

  if (newBrokerSummaryCount > 0) {
    try {
      const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');
      console.log('\n[INTEL] Menjalankan pre-calculation 4 sinyal intelijen bandarmologi...');
      bandarmologiIntelService.computeAndSaveIntel({ tickers, date: dateArg });
      console.log('[INTEL] Pre-calculation sinyal intelijen bandarmologi selesai.');
    } catch (intelErr) {
      console.warn('[INTEL] Warning: Gagal pre-calculate sinyal intelijen:', intelErr && intelErr.message ? intelErr.message : intelErr);
    }
  }

  // W2-09: typed quality metadata travels with the marker while legacy fields
  // (complete, no_data_tickers, no_data, pending, done, errors) stay intact
  // for existing consumers.
  const markerQuality = {
    trade_date: dateArg,
    master_universe_count: tickers.length,
    effective_universe_count: tickers.length,
    traded_count: doneCount + brokerDataUnavailableCount + pendingCount + errorCount,
    no_trade_count: noTradeCount,
    broker_data_unavailable_count: brokerDataUnavailableCount,
    upstream_error_count: errorCount,
    pending_provider_count: pendingCount,
    broker_complete: remaining === 0,
    auxiliary_mode: historicalTarget ? 'historical_snapshot_not_backfillable' : 'same_day_required',
    accumulation_count: tickers.filter(t => bandarmologiService.readDiskCache('broker-accumulation', t, dateArg)).length,
    insider_count: tickers.filter(t => bandarmologiService.readDiskCache('insiders', t, dateArg)).length
  };

  if (complete) {
    writeMarker(dateArg, {
      version: 2, universe_hash: universeHash, no_data_tickers: [...new Set([...noTradeTickers, ...brokerDataUnavailableTickers])],
      no_trade_tickers: [...noTradeTickers],
      broker_data_unavailable_tickers: [...brokerDataUnavailableTickers],
      date: dateArg,
      complete: true,
      completed_at: new Date().toISOString(),
      broker_summary_rows: doneCount,
      no_data: noTradeCount + brokerDataUnavailableCount,
      auxiliary_mode: markerQuality.auxiliary_mode,
      auxiliary_complete: historicalTarget ? null : auxiliaryComplete,
      total_tickers: tickers.length,
      ...markerQuality
    });
    console.log(`Status: SELESAI — ${doneCount} ticker punya broker summary, ${noTradeCount} NO_TRADE, ${brokerDataUnavailableCount} broker-data-unavailable untuk ${dateArg}.`);
    return;
  }

  writeMarker(dateArg, {
    version: 2, universe_hash: universeHash, no_data_tickers: [...new Set([...noTradeTickers, ...brokerDataUnavailableTickers])],
    no_trade_tickers: [...noTradeTickers],
    broker_data_unavailable_tickers: [...brokerDataUnavailableTickers],
    auxiliary_pending: auxiliaryPending,
    date: dateArg,
    complete: false,
    updated_at: new Date().toISOString(),
    done: doneCount,
    pending: pendingCount,
    no_data: noTradeCount + brokerDataUnavailableCount,
    errors: errorCount,
    auxiliary_mode: markerQuality.auxiliary_mode,
    auxiliary_complete: historicalTarget ? null : auxiliaryComplete,
    total_tickers: tickers.length,
    ...markerQuality
  });

  if (circuitTripped) {
    // B2: a systemic provider outage. Do NOT quietly continue; alert and fail
    // loudly so an operator/alarm sees it (the 2026-10-19 run failed 921/921
    // and still reported success-like output).
    console.log(`Status: GAGAL (PEMUTUS SIRKUIT) — ${circuitReason}; ${errorCount} request gagal dari ${totalRequested}. Penyebab: ${JSON.stringify(failureSummary.countsByKind())}.`);
    await notifyCircuitBreaker(dateArg, failureSummary, circuitReason, errorCount);
    process.exitCode = 5;
    return { date: dateArg, circuitTripped: true, circuitReason, errorCount, requested: totalRequested, failures: failureSummary.toJSON() };
  }

  if (isFinal) {
    console.log(`Status: GAGAL — jendela EOD (18:00-23:30 WIB) berakhir dengan ${remaining} ticker belum punya broker summary ${dateArg}.`);
    process.exitCode = 4;
  } else if (quotaReached) {
    console.log(`Status: TERHENTI SEMENTARA (kuota habis) — ${remaining} ticker akan dicoba lagi di run 30 menit berikutnya.`);
    process.exitCode = 2;
  } else {
    console.log(`Status: BELUM LENGKAP — ${remaining} ticker (kemungkinan besar belum dipublish Arjum) akan dicoba lagi di run 30 menit berikutnya.`);
    process.exitCode = 3;
  }
}

/**
 * B2 alerting: announce a systemic Arjum outage to the admin console (stderr,
 * which the runner captures) and Telegram admin. Never throws.
 */
async function notifyCircuitBreaker(dateArg, failureSummary, reason, errorCount) {
  const counts = failureSummary.countsByKind();
  const line = `[ALERT] Arjum PEMUTUS SIRKUIT ${dateArg}: ${reason}. gagal=${errorCount} jenis=${JSON.stringify(counts)}`;
  try { console.error(line); } catch (_) {}
  try {
    const notifier = require('../lib/telegram-notifier');
    if (typeof notifier.sendTelegramMessage === 'function') {
      await notifier.sendTelegramMessage(
        `🚨 Auto-Cuan: job broker harian ${dateArg} DIHENTIKAN oleh pemutus sirkuit.\n` +
        `Alasan: ${reason}\nRequest gagal: ${errorCount}\nJenis: ${JSON.stringify(counts)}\n` +
        `Sisa ticker tidak dipanggil untuk menyelamatkan kuota. Cek penyedia data (Arjum).`,
        { skip_market_guard: true, alert_key: 'arjum_circuit_breaker_' + dateArg, cooldownMs: 30 * 60 * 1000 }
      );
    }
  } catch (_) {}
}

/**
 * BUG-INSIDER-STALE-CACHE: returns the newest trade date (YYYY-MM-DD) present
 * in an insider payload, or null when the payload has no parseable trade date.
 * Accepts the vendor shapes seen in production: { items: [{date}] },
 * { data: { items: [...] } }, { data: [...] }.
 */
function latestInsiderTradeDate(payload) {
  if (!payload) return null;
  let items = [];
  if (Array.isArray(payload)) items = payload;
  else if (Array.isArray(payload.items)) items = payload.items;
  else if (payload.data && Array.isArray(payload.data.items)) items = payload.data.items;
  else if (payload.data && Array.isArray(payload.data)) items = payload.data;
  if (!items.length) return null;

  let newest = null;
  for (const item of items) {
    const raw = item && (item.date || item.trade_date || item.transaction_date);
    if (!raw) continue;
    const stamp = String(raw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) continue;
    if (newest == null || stamp > newest) newest = stamp;
  }
  return newest;
}

function persistDatedCache(endpoint, ticker, date, data) {
  bandarmologiService.writeDiskCache(endpoint, ticker, date, data);
  const saved = bandarmologiService.readDiskCache(endpoint, ticker, date);
  if (JSON.stringify(saved) !== JSON.stringify(data)) throw new Error('Dated cache could not be persisted: ' + endpoint + '/' + ticker + '/' + date);
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal worker error:', err);
    process.exit(1);
  });
}

module.exports = { run, getJakartaDateString, getJakartaTimeInfo, resolveTargetDate, markerPath, readMarker, writeMarker, brokerSummaryPayloadDate, shouldAdvanceLatestBrokerSummary, readTargetCandleEvidence, latestInsiderTradeDate };

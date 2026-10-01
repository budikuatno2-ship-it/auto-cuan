'use strict';

/**
 * Live Intraday Shadow Scoring (research / evaluation ONLY)
 * =========================================================
 *
 * Purpose
 *   Run the intraday shadow-scoring evaluator LIVE during market hours on a
 *   future collection day — one scheduled snapshot at a time — WITHOUT enabling
 *   production intraday scoring, mutating any recommendation/portfolio state,
 *   touching Supabase, or sending Telegram.
 *
 *   This module builds on top of the historical evaluator's PURE scoring
 *   primitives (lib/intraday-shadow-scoring.js) and adds three things the
 *   historical evaluator does not have:
 *
 *     1. A confirmed-candidate gate (provisional Top 5 vs confirmed Top 5).
 *        The historical evaluation showed ATLA appeared for only ONE snapshot
 *        yet still entered the shadow Top 5 at rank 5. The confirmed gate stops
 *        transient one-snapshot candidates from entering the *confirmed* Top 5
 *        while still logging them as provisional.
 *
 *     2. Forward-return tracking for each confirmed Top 5 observation at
 *        +15m / +30m / +60m / end-of-day, computed ONLY from future snapshots
 *        that already exist. It never invents prices or profitability and never
 *        feeds forward information back into the ranking (no look-ahead).
 *
 *     3. A safe LIVE runner that processes exactly one scheduled snapshot per
 *        invocation, reads the existing intraday sample data read-only, writes
 *        only into a SEPARATE live output directory, uses atomic writes + a
 *        lock, requires an EXPLICIT sample date and scheduled time, and never
 *        silently falls back to the current wall-clock time.
 *
 * Hard safety guarantees (shared with the historical evaluator):
 *   - DAYTRADE_INTRADAY_SCORE_ENABLED must be false/0 (production scoring OFF)
 *   - DAYTRADE_WORKER_ALLOW_MUTATION must not be true
 *   - TELEGRAM_ENABLED must be 0
 *   - Imports NO Telegram notifier, NO Supabase client; performs NO DB writes;
 *     never rewrites the original intraday sample source files.
 *
 * Determinism: outputs contain NO wall-clock timestamp. Every value is derived
 * from the input sample data and the EXPLICIT (date, scheduled_time) arguments,
 * so reruns over the same input produce byte-identical output files.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Reuse the historical evaluator's PURE primitives so scoring stays a single
// source of truth. The historical module imports no Supabase / Telegram / DB
// mutation code — it only borrows the shared production-scoring gate.
const shadow = require('./intraday-shadow-scoring');

const GENERATOR_VERSION = 'intraday-shadow-scoring-live-v1.0';

// -----------------------------------------------------------------------------
// Schedule (mirrors tools/intraday-sample-collector.js APPROVED_SCHEDULE).
// Declared here independently so this module stays pure (requiring the
// collector would transitively pull the heavy day-trade screener engine).
// -----------------------------------------------------------------------------
const APPROVED_SCHEDULE = Object.freeze([
  '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45',
  '11:00', '11:15', '11:30', '11:45',
  '13:45', '14:00', '14:15', '14:30', '14:45',
  '15:00', '15:15', '15:30', '15:45',
  '16:00'
]);
const FINAL_SNAPSHOT_TIME = '16:00';
const BREAK_START_MINUTES = 12 * 60;      // 12:00
const BREAK_END_MINUTES = 13 * 60 + 30;   // 13:30

// Supported collection dates (same set the historical evaluator recognises).
const DEFAULT_SUPPORTED_DATES = shadow.DEFAULT_SUPPORTED_DATES;

// -----------------------------------------------------------------------------
// Confirmed-candidate gate configuration
// -----------------------------------------------------------------------------
// A candidate is CONFIRMED (eligible for the confirmed Top 5) when it has
// appeared in at least CONFIRM_CONSECUTIVE consecutive snapshots, OR in at
// least CONFIRM_WINDOW_MIN of the last CONFIRM_WINDOW valid snapshots. Once a
// candidate has been confirmed it is not permanently penalised: while it keeps
// appearing it stays confirmed (sticky), so a genuine candidate is never demoted
// back to "transient" just because of an earlier single-snapshot appearance.
const CONFIRM_CONSECUTIVE = 2;
const CONFIRM_WINDOW = 3;
const CONFIRM_WINDOW_MIN = 2;

const CONFIRM_STATE_CONFIRMED = 'CONFIRMED';
const CONFIRM_STATE_PROVISIONAL = 'PROVISIONAL';

// -----------------------------------------------------------------------------
// Forward-return configuration
// -----------------------------------------------------------------------------
// Neutral band (documented threshold): a raw forward return whose magnitude is
// within +/- NEUTRAL_THRESHOLD_PCT of the reference price is classified NEUTRAL
// (neither a favorable HIT nor an adverse MISS). Above +band => HIT, below
// -band => MISS.
const NEUTRAL_THRESHOLD_PCT = 0.5;

// Forward-return horizons. +15/+30/+60 map onto exact clock offsets; EOD maps
// onto the final snapshot of the trading day (FINAL_SNAPSHOT_TIME).
const FORWARD_HORIZONS = Object.freeze([
  { key: 't_plus_15', minutes: 15, label: '+15m' },
  { key: 't_plus_30', minutes: 30, label: '+30m' },
  { key: 't_plus_60', minutes: 60, label: '+60m' },
  { key: 'eod', minutes: null, label: 'end_of_day' }
]);

// A hit rate is only reported for a horizon once at least this many confirmed
// observations have a RESOLVED forward price at that horizon. Below this the
// summary emits a small-sample warning and makes NO profitability claim.
const MIN_HIT_RATE_SAMPLE = 5;

// Lock TTL: a live snapshot run should complete quickly; a lock older than this
// (whose owner PID is gone) is considered stale and may be reclaimed.
const LOCK_TTL_MS = 15 * 60 * 1000;

// -----------------------------------------------------------------------------
// Time helpers
// -----------------------------------------------------------------------------
function timeToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesToTime(mins) {
  if (!Number.isFinite(mins) || mins < 0 || mins >= 24 * 60) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// -----------------------------------------------------------------------------
// Scheduled-time validation (rejects unsupported / break-period times)
// -----------------------------------------------------------------------------
/**
 * Validate a scheduled snapshot time. Only times in APPROVED_SCHEDULE are
 * accepted; the lunch-break window is rejected. Returns a structured result and
 * NEVER falls back to the current time.
 */
function validateScheduledTime(scheduledTime) {
  if (scheduledTime === undefined || scheduledTime === null || scheduledTime === '') {
    return { valid: false, reason: 'missing_scheduled_time', value: scheduledTime };
  }
  if (typeof scheduledTime !== 'string') {
    return { valid: false, reason: 'not_a_string', value: scheduledTime };
  }
  const trimmed = scheduledTime.trim();
  const mins = timeToMinutes(trimmed);
  if (mins === null) {
    return { valid: false, reason: 'bad_time_format', value: scheduledTime };
  }
  // Reject the lunch-break window first so a break-time gets the clearest reason
  // (the approved schedule already contains no break-window times).
  if (mins >= BREAK_START_MINUTES && mins <= BREAK_END_MINUTES) {
    return { valid: false, reason: 'break_period_rejected', value: trimmed };
  }
  if (!APPROVED_SCHEDULE.includes(trimmed)) {
    return { valid: false, reason: 'not_in_approved_schedule', value: trimmed };
  }
  return { valid: true, scheduledTime: trimmed, totalMinutes: mins };
}

// -----------------------------------------------------------------------------
// Lock (prevents overlapping live runs). Mirrors the collector's approach but
// is self-contained (no heavy imports).
// -----------------------------------------------------------------------------
function isPidRunning(pid) {
  if (!pid || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * Acquire an exclusive lock. Returns an async release() function on success, or
 * null if another live run currently holds a non-stale lock.
 */
async function acquireLock(lockFile) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fsp.open(lockFile, 'wx');
      const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), version: GENERATOR_VERSION }) + '\n';
      await fd.writeFile(payload);
      let released = false;
      return async function release() {
        if (released) return;
        released = true;
        await fd.close().catch(() => {});
        await fsp.unlink(lockFile).catch(() => {});
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      // Lock exists — reclaim only if its owner PID is gone or it is stale.
      try {
        const raw = await fsp.readFile(lockFile, 'utf8');
        const state = JSON.parse(raw);
        const startedAt = Date.parse(state.started_at || '');
        const running = isPidRunning(state.pid);
        const stale = !running || !Number.isFinite(startedAt) || (Date.now() - startedAt > LOCK_TTL_MS);
        if (!stale) return null;
        await fsp.unlink(lockFile).catch((ue) => { if (ue.code !== 'ENOENT') throw ue; });
      } catch (readErr) {
        // Unreadable lock file — treat as stale and remove.
        await fsp.unlink(lockFile).catch(() => {});
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Confirmation gate
// -----------------------------------------------------------------------------
/**
 * Decide whether a ticker is confirmed at snapshot index `currentIndex`, given
 * the set of snapshot indices in which it has appeared (across the ordered list
 * of valid snapshots) and whether it was already confirmed on a prior snapshot.
 *
 * Rules (see CONFIRM_* constants):
 *   - TWO_CONSECUTIVE_SNAPSHOTS: appeared now and in the immediately preceding
 *     valid snapshot.
 *   - TWO_OF_LAST_THREE_SNAPSHOTS: appeared in >= 2 of the last 3 valid snapshots
 *     (including the current one).
 *   - STICKY_PREVIOUSLY_CONFIRMED: already confirmed earlier and appears now —
 *     do not permanently penalise a candidate that has proven itself.
 *   - SINGLE_SNAPSHOT_UNCONFIRMED: appears now but satisfies none of the above
 *     (ATLA-style transient) -> remains PROVISIONAL only.
 *
 * No look-ahead: only appearances at indices <= currentIndex are considered.
 */
function computeConfirmation(appearedIndexSet, currentIndex, previouslyConfirmed) {
  const appearedNow = appearedIndexSet.has(currentIndex);
  if (!appearedNow) {
    return { confirmed: false, state: CONFIRM_STATE_PROVISIONAL, reason: 'NOT_PRESENT_THIS_SNAPSHOT' };
  }

  const consecutive = currentIndex >= 1 && appearedIndexSet.has(currentIndex - 1);

  let windowAppearances = 0;
  const windowStart = Math.max(0, currentIndex - (CONFIRM_WINDOW - 1));
  for (let j = currentIndex; j >= windowStart; j--) {
    if (appearedIndexSet.has(j)) windowAppearances++;
  }
  const twoOfThree = windowAppearances >= CONFIRM_WINDOW_MIN;

  if (consecutive) {
    return { confirmed: true, state: CONFIRM_STATE_CONFIRMED, reason: 'TWO_CONSECUTIVE_SNAPSHOTS' };
  }
  if (twoOfThree) {
    return { confirmed: true, state: CONFIRM_STATE_CONFIRMED, reason: 'TWO_OF_LAST_THREE_SNAPSHOTS' };
  }
  if (previouslyConfirmed) {
    return { confirmed: true, state: CONFIRM_STATE_CONFIRMED, reason: 'STICKY_PREVIOUSLY_CONFIRMED' };
  }
  return { confirmed: false, state: CONFIRM_STATE_PROVISIONAL, reason: 'SINGLE_SNAPSHOT_UNCONFIRMED' };
}

// -----------------------------------------------------------------------------
// Forward-return computation (no look-ahead / never invents prices)
// -----------------------------------------------------------------------------
function pctReturn(refPrice, futurePrice) {
  if (!Number.isFinite(refPrice) || refPrice === 0 || !Number.isFinite(futurePrice)) return null;
  return shadow.round2(((futurePrice - refPrice) / refPrice) * 100);
}

/**
 * Classify a raw return against the documented neutral band.
 */
function classifyHit(rawReturnPct) {
  if (!Number.isFinite(rawReturnPct)) return null;
  if (rawReturnPct > NEUTRAL_THRESHOLD_PCT) return 'HIT';
  if (rawReturnPct < -NEUTRAL_THRESHOLD_PCT) return 'MISS';
  return 'NEUTRAL';
}

/**
 * Compute forward returns for a single confirmed observation.
 *
 * @param {object} args
 *   ticker            - ticker symbol
 *   refTimeMinutes    - reference snapshot time (minutes since midnight)
 *   refPrice          - reference price at the observation snapshot
 *   refPriceSource    - where refPrice came from ('current_price' | 'reference_entry_price')
 *   processedTimesSet - Set<string HH:MM> of snapshots processed so far (<= run target)
 *   targetRunMinutes  - the run's target scheduled time (minutes) — the frontier
 *   priceAt           - fn(ticker, 'HH:MM') -> number|null (present price or null)
 *
 * Only snapshots that (a) exist in the source AND (b) are at or before the run's
 * target time are considered "available". Anything later is explicitly reported
 * as not-yet-available rather than invented.
 */
function computeForwardReturns(args) {
  const {
    refTimeMinutes, refPrice, processedTimesSet, targetRunMinutes, priceAt, ticker
  } = args;

  const horizons = {};
  const excursionReturns = []; // all resolved future returns, for MFE/MAE
  let resolvedCount = 0;

  for (const h of FORWARD_HORIZONS) {
    let targetTime;
    let targetMinutes;
    if (h.key === 'eod') {
      targetTime = FINAL_SNAPSHOT_TIME;
      targetMinutes = timeToMinutes(FINAL_SNAPSHOT_TIME);
    } else {
      targetMinutes = refTimeMinutes + h.minutes;
      targetTime = minutesToTime(targetMinutes);
    }

    const entry = { target_time: targetTime, available: false, price: null, raw_return_pct: null, hit_status: null, missing_reason: null };

    if (targetTime === null) {
      entry.missing_reason = 'invalid_target_time';
      horizons[h.key] = entry;
      continue;
    }
    if (targetMinutes <= refTimeMinutes) {
      // e.g. EOD when the reference IS the final snapshot.
      entry.missing_reason = 'target_not_after_reference';
      horizons[h.key] = entry;
      continue;
    }
    if (targetMinutes > targetRunMinutes) {
      // The future snapshot has not been collected yet in this live run.
      entry.missing_reason = (h.key === 'eod') ? 'eod_snapshot_not_yet_available' : 'future_snapshot_not_yet_available';
      horizons[h.key] = entry;
      continue;
    }
    if (!processedTimesSet.has(targetTime)) {
      // No snapshot was scheduled/collected at that exact clock offset.
      entry.missing_reason = (h.key === 'eod') ? 'eod_snapshot_missing' : 'no_snapshot_at_offset';
      horizons[h.key] = entry;
      continue;
    }
    const futurePrice = priceAt(ticker, targetTime);
    if (!Number.isFinite(futurePrice)) {
      entry.missing_reason = (h.key === 'eod') ? 'ticker_absent_at_eod' : 'ticker_absent_in_future_snapshot';
      horizons[h.key] = entry;
      continue;
    }
    // Resolved.
    const raw = pctReturn(refPrice, futurePrice);
    entry.available = true;
    entry.price = futurePrice;
    entry.raw_return_pct = raw;
    entry.hit_status = classifyHit(raw);
    horizons[h.key] = entry;
    if (Number.isFinite(raw)) { excursionReturns.push(raw); resolvedCount++; }
  }

  // Maximum favorable / adverse excursion over ALL resolved future points
  // (never invents; empty => null).
  let mfe = null;
  let mae = null;
  if (excursionReturns.length) {
    mfe = shadow.round2(Math.max.apply(null, excursionReturns));
    mae = shadow.round2(Math.min.apply(null, excursionReturns));
  }

  return {
    horizons,
    mfe_pct: mfe,
    mae_pct: mae,
    sample_size: resolvedCount,
    excursion_points: excursionReturns.length
  };
}

// -----------------------------------------------------------------------------
// Core live evaluation (pure — performs no writes)
// -----------------------------------------------------------------------------
/**
 * Evaluate a single date's samples cumulatively THROUGH the target scheduled
 * time. Ranking at each snapshot uses ONLY snapshots at or before that snapshot
 * (no look-ahead). Forward returns for confirmed picks use only snapshots that
 * already exist (at or before the run's target time).
 *
 * @returns evaluation object (pure data; no I/O).
 */
async function evaluateLiveThroughTime(inputDateDir, dateStr, targetTime, opts) {
  opts = opts || {};
  const targetMinutes = timeToMinutes(targetTime);

  const runsRead = await shadow.readJsonlSafe(path.join(inputDateDir, 'runs.jsonl'));
  const candsRead = await shadow.readJsonlSafe(path.join(inputDateDir, 'candidates.jsonl'));
  // summary.json / lifecycle.json read ONLY for context — never rewritten.
  const summaryRead = await shadow.readJsonSafe(path.join(inputDateDir, 'summary.json'));
  const lifecycleRead = await shadow.readJsonSafe(path.join(inputDateDir, 'lifecycle.json'));

  const missingFiles = [];
  if (runsRead.missing) missingFiles.push('runs.jsonl');
  if (candsRead.missing) missingFiles.push('candidates.jsonl');
  if (summaryRead.missing) missingFiles.push('summary.json');
  if (lifecycleRead.missing) missingFiles.push('lifecycle.json');

  // Success-run snapshot times at or before the target.
  const successRuns = runsRead.records.filter((r) => r && r.type === 'sample_run' && r.status === 'success');
  const runTimes = successRuns
    .map((r) => (typeof r.scheduled_time === 'string' ? r.scheduled_time.trim() : ''))
    .filter((t) => t && timeToMinutes(t) !== null && timeToMinutes(t) <= targetMinutes);

  // Group candidate observations by snapshot time (only <= target time).
  const bySnapshot = new Map();
  const priceByTickerTime = new Map(); // ticker -> Map(time -> price)
  let unassignedCandidates = 0;
  let futureCandidatesIgnored = 0; // rows strictly after target (never used — no look-ahead)
  let forwardReturnFieldSeen = false;

  for (const rec of candsRead.records) {
    if (!rec || typeof rec !== 'object') { unassignedCandidates++; continue; }
    if (rec.forward_return_pct != null || rec.realized_return_pct != null ||
        rec.forward_return != null || rec.next_day_return_pct != null) {
      forwardReturnFieldSeen = true;
    }
    const st = typeof rec.scheduled_time === 'string' ? rec.scheduled_time.trim() : '';
    if (!st) { unassignedCandidates++; continue; }
    const stMin = timeToMinutes(st);
    if (stMin === null) { unassignedCandidates++; continue; }
    if (stMin > targetMinutes) { futureCandidatesIgnored++; continue; } // strict no look-ahead
    if (!bySnapshot.has(st)) bySnapshot.set(st, []);
    bySnapshot.get(st).push(rec);

    const ticker = shadow.safeTicker(rec.ticker);
    if (ticker) {
      if (!priceByTickerTime.has(ticker)) priceByTickerTime.set(ticker, new Map());
      const price = shadow.num(rec.current_price);
      const refEntry = shadow.num(rec.reference_entry_price);
      priceByTickerTime.get(ticker).set(st, { current_price: price, reference_entry_price: refEntry });
    }
  }

  // Ordered list of VALID snapshots (union of run + candidate times, <= target).
  const evaluatedSnapshots = Array.from(new Set(runTimes.concat(Array.from(bySnapshot.keys()))))
    .filter(Boolean)
    .sort((a, b) => timeToMinutes(a) - timeToMinutes(b));

  const snapshotIndex = new Map();
  evaluatedSnapshots.forEach((t, i) => snapshotIndex.set(t, i));

  // Appearance index sets per ticker (which snapshot indices it appeared in).
  const appearedByTicker = new Map();
  for (const [time, cands] of bySnapshot.entries()) {
    const idx = snapshotIndex.get(time);
    for (const rec of cands) {
      const ticker = shadow.safeTicker(rec.ticker);
      if (!ticker) continue;
      if (!appearedByTicker.has(ticker)) appearedByTicker.set(ticker, new Set());
      appearedByTicker.get(ticker).add(idx);
    }
  }

  // Price lookup helper.
  function priceAt(ticker, time) {
    const m = priceByTickerTime.get(ticker);
    if (!m) return null;
    const p = m.get(time);
    if (!p) return null;
    if (Number.isFinite(p.current_price)) return p.current_price;
    if (Number.isFinite(p.reference_entry_price)) return p.reference_entry_price;
    return null;
  }
  function refPriceFor(ticker, time) {
    const m = priceByTickerTime.get(ticker);
    if (!m) return { price: null, source: null };
    const p = m.get(time);
    if (!p) return { price: null, source: null };
    if (Number.isFinite(p.current_price)) return { price: p.current_price, source: 'current_price' };
    if (Number.isFinite(p.reference_entry_price)) return { price: p.reference_entry_price, source: 'reference_entry_price' };
    return { price: null, source: null };
  }

  const processedTimesSet = new Set(evaluatedSnapshots);

  // Score each snapshot chronologically, threading persistence state.
  const scoreState = new Map();
  const everConfirmed = new Set();
  const allScored = [];
  const provisionalTop5PerSnapshot = [];
  const confirmedTop5PerSnapshot = [];
  const forwardReturnRecords = [];

  for (const time of evaluatedSnapshots) {
    const idx = snapshotIndex.get(time);
    const candidates = bySnapshot.get(time) || [];
    const scored = shadow.scoreSnapshot(candidates, time, scoreState);

    // Confirmation state for each scored candidate.
    for (const s of scored) {
      const appeared = appearedByTicker.get(s.ticker) || new Set();
      const conf = computeConfirmation(appeared, idx, everConfirmed.has(s.ticker));
      s.confirmation_state = conf.state;
      s.confirmation_reason = conf.reason;
      s.confirmed = conf.confirmed;
      if (conf.confirmed) everConfirmed.add(s.ticker);
      const ref = refPriceFor(s.ticker, time);
      s.current_price = ref.price;
      s.reference_price_source = ref.source;
    }

    // Provisional Top 5 = existing shadow ranking (every candidate eligible).
    const provisional = scored.filter((s) => s.in_top5);
    provisional.forEach((s) => { s.in_provisional_top5 = true; });

    // Confirmed Top 5 = top 5 among CONFIRMED candidates only (re-ranked).
    const confirmedSorted = scored.filter((s) => s.confirmed).slice().sort(shadow.compareScored);
    const confirmedTop5 = confirmedSorted.slice(0, shadow.TOP_N);
    confirmedTop5.forEach((s, i) => { s.confirmed_rank = i + 1; s.in_confirmed_top5 = true; });

    // Provisional members excluded from the confirmed Top 5 (and why).
    const confirmedSet = new Set(confirmedTop5.map((s) => s.ticker));
    const excludedProvisional = provisional
      .filter((s) => !confirmedSet.has(s.ticker))
      .map((s) => ({
        ticker: s.ticker,
        provisional_rank: s.rank,
        confirmation_state: s.confirmation_state,
        confirmation_reason: s.confirmation_reason,
        reason: s.confirmed ? 'CONFIRMED_BUT_OUTRANKED' : 'NOT_YET_CONFIRMED'
      }));

    for (const s of scored) allScored.push(s);

    provisionalTop5PerSnapshot.push({
      snapshot: time,
      candidate_count: candidates.length,
      provisional_top5: provisional.map((s) => ({
        ticker: s.ticker,
        rank: s.rank,
        shadow_score: s.shadow_score,
        confirmation_state: s.confirmation_state,
        confirmation_reason: s.confirmation_reason,
        is_first_appearance: s.is_first_appearance
      }))
    });

    confirmedTop5PerSnapshot.push({
      snapshot: time,
      confirmed_candidate_count: confirmedSorted.length,
      confirmed_top5: confirmedTop5.map((s) => ({
        ticker: s.ticker,
        confirmed_rank: s.confirmed_rank,
        provisional_rank: s.rank,
        shadow_score: s.shadow_score,
        confirmation_state: s.confirmation_state,
        confirmation_reason: s.confirmation_reason
      })),
      excluded_provisional: excludedProvisional
    });

    // Forward returns: one record per CONFIRMED Top 5 observation.
    for (const s of confirmedTop5) {
      const ref = refPriceFor(s.ticker, time);
      const fwd = computeForwardReturns({
        ticker: s.ticker,
        refTimeMinutes: idx !== undefined ? timeToMinutes(time) : null,
        refPrice: ref.price,
        refPriceSource: ref.source,
        processedTimesSet,
        targetRunMinutes: targetMinutes,
        priceAt
      });
      forwardReturnRecords.push({
        date: dateStr,
        snapshot: time,
        ticker: s.ticker,
        confirmed_rank: s.confirmed_rank,
        confirmation_state: s.confirmation_state,
        confirmation_reason: s.confirmation_reason,
        reference_price: ref.price,
        reference_price_source: ref.source,
        reference_price_available: Number.isFinite(ref.price),
        neutral_threshold_pct: NEUTRAL_THRESHOLD_PCT,
        horizons: fwd.horizons,
        mfe_pct: fwd.mfe_pct,
        mae_pct: fwd.mae_pct,
        sample_size: fwd.sample_size,
        note: Number.isFinite(ref.price)
          ? 'Forward returns computed only from already-existing future snapshots; unresolved horizons are explicitly unavailable.'
          : 'Reference price unavailable in source; no forward return can be computed for this observation.'
      });
    }
  }

  const summary = buildLiveSummary({
    dateStr,
    targetTime,
    evaluatedSnapshots,
    missingFiles,
    unassignedCandidates,
    futureCandidatesIgnored,
    malformedCandidateLines: candsRead.malformed,
    malformedRunLines: runsRead.malformed,
    scoreState,
    everConfirmed,
    appearedByTicker,
    allScored,
    provisionalTop5PerSnapshot,
    confirmedTop5PerSnapshot,
    forwardReturnRecords,
    forwardReturnFieldSeen
  });

  return {
    date: dateStr,
    scheduled_time: targetTime,
    scores: allScored.map(projectScoredForOutput),
    provisional_top5: provisionalTop5PerSnapshot,
    confirmed_top5: confirmedTop5PerSnapshot,
    forward_returns: forwardReturnRecords,
    summary
  };
}

/**
 * Project a scored record into the stable output shape for shadow-scores.jsonl.
 */
function projectScoredForOutput(s) {
  return {
    ticker: s.ticker,
    snapshot: s.snapshot,
    appearance_index: s.appearance_index,
    is_first_appearance: s.is_first_appearance,
    base_score: s.base_score,
    persistence_bonus: s.persistence_bonus,
    momentum_bonus: s.momentum_bonus,
    shadow_score: s.shadow_score,
    rank: s.rank,
    in_top5: s.in_top5,
    in_provisional_top5: !!s.in_provisional_top5,
    in_confirmed_top5: !!s.in_confirmed_top5,
    confirmed_rank: s.confirmed_rank != null ? s.confirmed_rank : null,
    confirmed: !!s.confirmed,
    confirmation_state: s.confirmation_state,
    confirmation_reason: s.confirmation_reason,
    current_price: s.current_price != null ? s.current_price : null,
    reference_price_source: s.reference_price_source != null ? s.reference_price_source : null,
    source_score: s.source_score,
    score_components: s.score_components,
    reason_codes: s.reason_codes,
    reasons: s.reasons,
    data_quality_status: s.data_quality_status || null
  };
}

// -----------------------------------------------------------------------------
// Top-5 turnover (symmetric difference between consecutive snapshots)
// -----------------------------------------------------------------------------
function turnoverSeries(perSnapshot, key) {
  const sets = perSnapshot.map((s) => new Set((s[key] || []).map((t) => t.ticker)));
  const turnovers = [];
  for (let i = 1; i < sets.length; i++) {
    const prev = sets[i - 1];
    const cur = sets[i];
    let changed = 0;
    for (const t of cur) if (!prev.has(t)) changed++;
    for (const t of prev) if (!cur.has(t)) changed++;
    turnovers.push(changed);
  }
  return turnovers;
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
function buildLiveSummary(ctx) {
  const {
    dateStr, targetTime, evaluatedSnapshots, missingFiles, unassignedCandidates,
    futureCandidatesIgnored, malformedCandidateLines, malformedRunLines,
    scoreState, everConfirmed, appearedByTicker, allScored,
    provisionalTop5PerSnapshot, confirmedTop5PerSnapshot, forwardReturnRecords,
    forwardReturnFieldSeen
  } = ctx;

  const tickers = Array.from(appearedByTicker.keys()).sort();
  const confirmedTickers = Array.from(everConfirmed).sort();
  const provisionalOnlyTickers = tickers.filter((t) => !everConfirmed.has(t)).sort();

  // Transient candidates FILTERED from the confirmed Top 5: entered a
  // provisional Top 5 at least once but were never confirmed (ATLA-style).
  const provisionalTop5Members = new Set();
  provisionalTop5PerSnapshot.forEach((s) => s.provisional_top5.forEach((t) => provisionalTop5Members.add(t.ticker)));
  const confirmedTop5Members = new Set();
  confirmedTop5PerSnapshot.forEach((s) => s.confirmed_top5.forEach((t) => confirmedTop5Members.add(t.ticker)));
  const transientFiltered = Array.from(provisionalTop5Members)
    .filter((t) => !everConfirmed.has(t))
    .sort();

  // One-snapshot candidates (appeared exactly once across processed snapshots).
  const oneSnapshotCandidates = tickers.filter((t) => (appearedByTicker.get(t) || new Set()).size === 1).sort();

  // Turnover.
  const provisionalTurnover = turnoverSeries(provisionalTop5PerSnapshot, 'provisional_top5');
  const confirmedTurnover = turnoverSeries(confirmedTop5PerSnapshot, 'confirmed_top5');

  // Forward-return aggregation per horizon.
  const forwardSummary = aggregateForwardReturns(forwardReturnRecords);

  // Warnings.
  const warnings = [];
  if (evaluatedSnapshots.length === 0) {
    warnings.push('NO_EVALUATED_SNAPSHOTS: no valid snapshots at or before ' + targetTime + ' for ' + dateStr);
  }
  for (const w of forwardSummary.warnings) warnings.push(w);
  if (transientFiltered.length) {
    warnings.push('TRANSIENT_FILTERED_FROM_CONFIRMED: ' + transientFiltered.join(', ') +
      ' entered a provisional Top 5 but were never confirmed and are excluded from the confirmed Top 5.');
  }

  return {
    generator_version: GENERATOR_VERSION,
    date: dateStr,
    scheduled_time: targetTime,
    processed_through_time: targetTime,
    timezone: 'Asia/Jakarta',
    mode: 'live_shadow_evaluation_only',

    safety: {
      DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
      DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
      TELEGRAM_ENABLED: '0',
      production_scoring_enabled: false,
      mutations_performed: false,
      telegram_sent: false,
      supabase_writes: false,
      portfolio_mutated: false,
      source_files_rewritten: false
    },

    total_evaluated_snapshots: evaluatedSnapshots.length,
    evaluated_snapshot_times: evaluatedSnapshots,

    missing_or_malformed: {
      missing_files: missingFiles,
      malformed_candidate_lines: malformedCandidateLines,
      malformed_run_lines: malformedRunLines,
      unassigned_candidate_records: unassignedCandidates,
      future_candidate_rows_ignored_no_lookahead: futureCandidatesIgnored
    },

    candidate_counts: {
      total_unique_candidates: tickers.length,
      confirmed_candidates: confirmedTickers.length,
      provisional_only_candidates: provisionalOnlyTickers.length,
      one_snapshot_candidates: oneSnapshotCandidates.length
    },

    confirmation: {
      rules: {
        consecutive_snapshots_required: CONFIRM_CONSECUTIVE,
        window_snapshots: CONFIRM_WINDOW,
        window_min_appearances: CONFIRM_WINDOW_MIN,
        sticky_once_confirmed: true
      },
      confirmed_tickers: confirmedTickers,
      provisional_only_tickers: provisionalOnlyTickers,
      one_snapshot_candidates: oneSnapshotCandidates,
      transient_filtered_from_confirmed_top5: transientFiltered,
      transient_filtered_count: transientFiltered.length
    },

    top5_turnover: {
      provisional_between_snapshots: provisionalTurnover,
      avg_provisional_turnover: provisionalTurnover.length ? shadow.round2(shadow.mean(provisionalTurnover)) : 0,
      confirmed_between_snapshots: confirmedTurnover,
      avg_confirmed_turnover: confirmedTurnover.length ? shadow.round2(shadow.mean(confirmedTurnover)) : 0
    },

    forward_returns: forwardSummary.report,

    warnings
  };
}

/**
 * Aggregate forward-return records into per-horizon sample sizes and hit rates.
 * Hit rates are ONLY reported when at least MIN_HIT_RATE_SAMPLE observations are
 * resolved for that horizon. No profitability claim is ever made.
 */
function aggregateForwardReturns(records) {
  const warnings = [];
  const byHorizon = {};
  for (const h of FORWARD_HORIZONS) {
    byHorizon[h.key] = { resolved: 0, hits: 0, misses: 0, neutrals: 0 };
  }

  for (const rec of records) {
    for (const h of FORWARD_HORIZONS) {
      const hz = rec.horizons[h.key];
      if (hz && hz.available && hz.hit_status) {
        const bucket = byHorizon[h.key];
        bucket.resolved++;
        if (hz.hit_status === 'HIT') bucket.hits++;
        else if (hz.hit_status === 'MISS') bucket.misses++;
        else bucket.neutrals++;
      }
    }
  }

  const sampleSizes = {};
  const hitRates = {};
  for (const h of FORWARD_HORIZONS) {
    const b = byHorizon[h.key];
    sampleSizes[h.key] = b.resolved;
    const sufficient = b.resolved >= MIN_HIT_RATE_SAMPLE;
    hitRates[h.key] = {
      resolved: b.resolved,
      hits: b.hits,
      misses: b.misses,
      neutrals: b.neutrals,
      sufficient_sample: sufficient,
      hit_rate: sufficient ? shadow.round2((b.hits / b.resolved) * 100) : null,
      note: sufficient
        ? 'Hit rate = HITs / resolved observations (favorable beyond +/-' + NEUTRAL_THRESHOLD_PCT + '% neutral band).'
        : 'Insufficient resolved sample (' + b.resolved + ' < ' + MIN_HIT_RATE_SAMPLE + '); hit rate withheld — no profitability claim.'
    };
    if (records.length && !sufficient) {
      warnings.push('SMALL_FORWARD_SAMPLE_' + h.key.toUpperCase() + ': only ' + b.resolved +
        ' resolved observation(s) (< ' + MIN_HIT_RATE_SAMPLE + '); hit rate withheld.');
    }
  }

  const anySufficient = FORWARD_HORIZONS.some((h) => byHorizon[h.key].resolved >= MIN_HIT_RATE_SAMPLE);

  return {
    warnings,
    report: {
      neutral_threshold_pct: NEUTRAL_THRESHOLD_PCT,
      min_hit_rate_sample: MIN_HIT_RATE_SAMPLE,
      total_confirmed_observations: records.length,
      observations_with_reference_price: records.filter((r) => r.reference_price_available).length,
      sample_sizes_by_horizon: sampleSizes,
      hit_rates_by_horizon: hitRates,
      profitability_claimed: false,
      sufficient_evidence_for_any_hit_rate: anySufficient,
      note: anySufficient
        ? 'Hit rates reported only for horizons with sufficient resolved samples; this remains a shadow diagnostic, not a profitability claim.'
        : 'Insufficient resolved forward data to claim any hit rate or profitability. Shadow diagnostics only.'
    }
  };
}

// -----------------------------------------------------------------------------
// Output writing (atomic; never touches source files)
// -----------------------------------------------------------------------------
async function writeLiveOutputs(outputDateDir, evaluation) {
  const scoresPath = path.join(outputDateDir, 'shadow-scores.jsonl');
  const provPath = path.join(outputDateDir, 'provisional-top5.jsonl');
  const confPath = path.join(outputDateDir, 'confirmed-top5.jsonl');
  const fwdPath = path.join(outputDateDir, 'forward-returns.jsonl');
  const summaryPath = path.join(outputDateDir, 'live-shadow-summary.json');

  await shadow.atomicWriteFile(scoresPath, shadow.toJsonl(evaluation.scores));
  await shadow.atomicWriteFile(provPath, shadow.toJsonl(evaluation.provisional_top5));
  await shadow.atomicWriteFile(confPath, shadow.toJsonl(evaluation.confirmed_top5));
  await shadow.atomicWriteFile(fwdPath, shadow.toJsonl(evaluation.forward_returns));
  await shadow.atomicWriteFile(summaryPath, JSON.stringify(evaluation.summary, null, 2) + '\n');

  return {
    scores: scoresPath,
    provisional_top5: provPath,
    confirmed_top5: confPath,
    forward_returns: fwdPath,
    summary: summaryPath
  };
}

// -----------------------------------------------------------------------------
// Orchestration — process exactly ONE scheduled snapshot (cumulative through it)
// -----------------------------------------------------------------------------
/**
 * Run the live shadow scoring for one explicit (date, scheduled_time).
 *
 * @param {object} opts
 *   inputRoot       required — root dir containing <date>/ sample directories (read-only)
 *   outputRoot      required — root dir for live outputs (must be OUTSIDE inputRoot)
 *   date            required — explicit sample date (YYYY-MM-DD)
 *   scheduledTime   required — explicit scheduled snapshot time (HH:MM)
 *   supportedDates  optional — allowed date set (defaults to the sample dates)
 *   env             optional — env object for safety checks (defaults to process.env)
 *   lockFile        optional — path to the lock file (defaults under outputRoot/.locks)
 *   dryRun          optional — compute but do not write output files
 *   skipLock        optional — bypass locking (tests only)
 * @returns result object
 */
async function runLiveShadowSnapshot(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const supportedDates = opts.supportedDates || DEFAULT_SUPPORTED_DATES;

  // 1. Safety gate (production scoring / mutation / telegram must be OFF).
  const safety = shadow.assertShadowSafety(env);
  if (!safety.safe) {
    return { status: 'safety_violation', errors: safety.errors };
  }

  // 2. Required arguments — NEVER default the date/time to the current clock.
  const missing = [];
  if (!opts.inputRoot) missing.push('inputRoot');
  if (!opts.outputRoot) missing.push('outputRoot');
  if (opts.date === undefined || opts.date === null || opts.date === '') missing.push('date');
  if (opts.scheduledTime === undefined || opts.scheduledTime === null || opts.scheduledTime === '') missing.push('scheduledTime');
  if (missing.length) {
    return { status: 'error', errors: ['missing required argument(s): ' + missing.join(', ')] };
  }

  // 3. Safe output-path guard (refuse output inside the source directories).
  try {
    shadow.assertSafeOutputRoot(opts.inputRoot, opts.outputRoot);
  } catch (e) {
    return { status: 'unsafe_output_path', errors: [e.message] };
  }

  // 4. Validate the explicit date and time up front — reject unsupported.
  const dv = shadow.validateSupportedDate(opts.date, supportedDates);
  if (!dv.valid) {
    return { status: 'rejected', reason: dv.reason, errors: ['invalid date: ' + JSON.stringify(opts.date) + ' (' + dv.reason + ')'] };
  }
  const tv = validateScheduledTime(opts.scheduledTime);
  if (!tv.valid) {
    return { status: 'rejected', reason: tv.reason, errors: ['invalid scheduled time: ' + JSON.stringify(opts.scheduledTime) + ' (' + tv.reason + ')'] };
  }

  const date = dv.date;
  const scheduledTime = tv.scheduledTime;

  // 5. Acquire the lock (prevents overlapping live runs).
  let release = null;
  const lockFile = opts.lockFile || path.join(opts.outputRoot, '.locks', 'intraday-shadow-scoring-live.lock');
  if (!opts.skipLock) {
    release = await acquireLock(lockFile);
    if (!release) {
      return { status: 'skipped_due_to_lock', date, scheduled_time: scheduledTime, lock_file: lockFile };
    }
  }

  try {
    // 6. Evaluate cumulatively THROUGH the target scheduled time (pure).
    const inputDateDir = path.join(opts.inputRoot, date);
    const outputDateDir = path.join(opts.outputRoot, date);
    const evaluation = await evaluateLiveThroughTime(inputDateDir, date, scheduledTime, opts);

    let outputs = null;
    if (!opts.dryRun) {
      outputs = await writeLiveOutputs(outputDateDir, evaluation);
    }

    return {
      status: 'success',
      date,
      scheduled_time: scheduledTime,
      evaluation,
      outputs,
      lock_file: opts.skipLock ? null : lockFile,
      enforced_safety: {
        DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
        DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
        TELEGRAM_ENABLED: '0'
      }
    };
  } finally {
    if (release) await release();
  }
}

module.exports = {
  GENERATOR_VERSION,
  APPROVED_SCHEDULE,
  FINAL_SNAPSHOT_TIME,
  BREAK_START_MINUTES,
  BREAK_END_MINUTES,
  DEFAULT_SUPPORTED_DATES,
  CONFIRM_CONSECUTIVE,
  CONFIRM_WINDOW,
  CONFIRM_WINDOW_MIN,
  CONFIRM_STATE_CONFIRMED,
  CONFIRM_STATE_PROVISIONAL,
  NEUTRAL_THRESHOLD_PCT,
  FORWARD_HORIZONS,
  MIN_HIT_RATE_SAMPLE,
  LOCK_TTL_MS,
  // time helpers
  timeToMinutes,
  minutesToTime,
  validateScheduledTime,
  // lock
  isPidRunning,
  acquireLock,
  // gate
  computeConfirmation,
  // forward returns
  pctReturn,
  classifyHit,
  computeForwardReturns,
  aggregateForwardReturns,
  // evaluation
  evaluateLiveThroughTime,
  buildLiveSummary,
  turnoverSeries,
  // outputs
  writeLiveOutputs,
  // orchestration
  runLiveShadowSnapshot
};

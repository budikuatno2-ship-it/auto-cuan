'use strict';

/**
 * Fast Watcher Early Watch — CORE persistence/tracking engine (FAST_WATCHER_EARLY_WATCH_V1).
 *
 * Purpose: capture a frozen record the FIRST time a ticker enters the current
 * Fast Watcher WATCHING state (per the V7 pool engine in
 * lib/intraday-fast-watcher-pool.js), then keep observing it for a bounded
 * research horizon EVEN AFTER it drops out of the live candidate pool.
 *
 * This is now a LIVE feature (informational, not shadow-only): with
 * FAST_WATCHER_EARLY_WATCH_ENABLED on, it can produce a real, once-per-
 * ticker/date "Early Watch" Telegram alert and a once-per-ticker/date
 * anti-chase warning. It is still NOT a trade/BUY signal and NEVER
 * strengthens, weakens, or bypasses the frozen 2/2 confirmation rule.
 *
 * This CORE module deliberately stays free of Telegram/Supabase concerns —
 * exactly like lib/intraday-fast-watcher-pool.js stays free of them and
 * leaves publishing to lib/intraday-fast-watcher-publisher.js. All Telegram
 * message-building/sending for Early Watch lives in the sibling file
 * lib/intraday-fast-watcher-early-watch-publisher.js, which this module
 * never requires. This file:
 *   - never calls Telegram, Supabase, or any publisher/recommendation code;
 *   - never mutates lib/intraday-fast-watcher-pool.js state or behavior;
 *   - never changes the frozen 2/2 (REQUIRED_CONFIRMATIONS) confirmation rule;
 *   - is gated OFF by default via FAST_WATCHER_EARLY_WATCH_ENABLED.
 * The actual notification decision is delegated to an injected
 * `sendNotifications` callback (see runEarlyWatch below) so this file never
 * needs to know how/whether Telegram is sent; if no callback is injected,
 * nothing is ever sent, by construction.
 *
 * Data contract note (executable price): the only price source in this
 * runtime is the Yahoo `interval=1d` chart feed's current-session candle
 * close (see tools/intraday-sample-collector.js fetchFreshCandles) — the
 * same "Fast Watcher current_price" already used for scoring. Prior
 * retrospective research (V7 window, 2026-08-04..2026-08-12) showed this
 * price is NOT a proven executable fill (see TMPO/REAL/BBKP anti-chase
 * evidence). This module therefore records that signal honestly as
 * `reference_price_source: 'fast_watcher_daily_candle_current_price'` and
 * NEVER promotes it to `executable_price` — that field stays null with an
 * explicit unavailable reason until a genuine intraday execution feed is
 * wired in (a future, separately-approved change).
 *
 * Resource footprint: zero additional network calls. Follow-up checkpoints
 * are filled OPPORTUNISTICALLY from observations the guarded-live run
 * already fetched for the pool this tick — no per-ticker background
 * process, no extra Yahoo requests, bounded per-ticker state.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const watcher = require('./intraday-fast-watcher');
const pool = require('./intraday-fast-watcher-pool');
const momentum = require('./intraday-fast-watcher-momentum');
const volumePace = require('./intraday-volume-pace');

const VERSION = 'FAST_WATCHER_EARLY_WATCH_V1';
// Preferred, live-feature flag going forward.
const ENV_FLAG = 'FAST_WATCHER_EARLY_WATCH_ENABLED';
// Legacy name from the original shadow-only PR. Honored indefinitely for
// backward compatibility: EITHER flag being true enables the feature
// (union semantics), so anyone who already set the shadow flag keeps
// working unchanged. FAST_WATCHER_EARLY_WATCH_ENABLED is the name to use
// going forward; the legacy flag can be retired once the VPS config is
// confirmed migrated.
const LEGACY_ENV_FLAG = 'FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED';
const HORIZON_MINUTES = Object.freeze([15, 30, 60]);
const HORIZON_KEYS = Object.freeze({ 15: 'm15', 30: 'm30', 60: 'm60' });
const EXECUTABLE_PRICE_UNAVAILABLE_REASON = 'no_intraday_execution_price_source_in_production_runtime';
const REFERENCE_PRICE_SOURCE = 'fast_watcher_daily_candle_current_price';
const DEFAULT_STATE_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-early-watch-v1', 'state');
const DEFAULT_EVENT_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-early-watch-v1', 'events');

function flagTrue(value) {
  return String(value || 'false').toLowerCase() === 'true';
}

function isEnabled(env) {
  const e = env || process.env;
  return flagTrue(e[ENV_FLAG]) || flagTrue(e[LEGACY_ENV_FLAG]);
}

function finite(value) {
  const n = Number(value);
  return typeof value === 'boolean' || value === null || value === undefined || value === '' ? null : (Number.isFinite(n) ? n : null);
}

function round2(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

function earlyWatchId(date, ticker) {
  return crypto.createHash('sha256').update([date, ticker, VERSION].join('|')).digest('hex');
}

// ---------------------------------------------------------------------------
// Session / active-minute math — thin wrapper reusing the canonical IDX
// session calendar in lib/intraday-volume-pace.js (handles Mon-Thu lunch
// break and the shorter Friday session). Never recompute session windows here.
// ---------------------------------------------------------------------------
function activeMinutesAt(sampleDate, time) {
  if (!watcher.validDate(sampleDate) || !watcher.validTime(time)) return null;
  const progress = volumePace.sessionProgress(sampleDate, time);
  return typeof progress.active_trading_minutes === 'number' ? progress.active_trading_minutes : null;
}

function activeMinutesElapsed(sampleDate, fromTime, toTime) {
  const from = activeMinutesAt(sampleDate, fromTime);
  const to = activeMinutesAt(sampleDate, toTime);
  if (from == null || to == null) return null;
  return Math.max(0, to - from);
}

function isSessionEnded(sampleDate, time) {
  const schedule = volumePace.tradingSchedule(sampleDate);
  const minute = volumePace.toMinutes(time);
  if (!schedule || !schedule.windows.length || minute == null) return false;
  const lastWindow = schedule.windows[schedule.windows.length - 1];
  return minute >= lastWindow.end;
}

// ---------------------------------------------------------------------------
// Event detection — which tickers just entered WATCHING for the first time
// today, purely by diffing pool.js state snapshots. Does not read or alter
// any pool.js internals beyond the already-public tracker fields.
// ---------------------------------------------------------------------------
function detectNewFirstWatchTickers(priorPoolState, processedPoolState, sampleDate) {
  if (!processedPoolState || !processedPoolState.tickers) return [];
  const priorCompatible = priorPoolState
    && priorPoolState.date === sampleDate
    && priorPoolState.rule_version === pool.RULE_VERSION;
  const priorKeys = new Set(priorCompatible ? Object.keys(priorPoolState.tickers || {}) : []);
  return Object.keys(processedPoolState.tickers).filter(ticker => !priorKeys.has(ticker));
}

function componentScores(rawObservation, lastMetrics) {
  const obs = rawObservation || {};
  const metrics = lastMetrics || {};
  return {
    liquidity_component: finite(obs.liquidity_component ?? obs.liquidity_score ?? metrics.liquidity_component),
    momentum_component: finite(obs.momentum_component ?? obs.momentum_score ?? metrics.momentum_component),
    risk_reward_component: finite(metrics.risk_reward ?? obs.risk_reward ?? obs.rr),
    trend_component: finite(obs.trend_component ?? obs.trend_score),
    penalty_component: finite(obs.penalty_component ?? obs.penalty_score)
  };
}

function qualityFlags(rawObservation) {
  const obs = rawObservation || {};
  if (obs.data_quality_status == null && obs.data_quality_valid == null && obs.data_quality_needs_revalidation == null) return null;
  return {
    data_quality_status: obs.data_quality_status ?? null,
    data_quality_valid: obs.data_quality_valid ?? null,
    data_quality_needs_revalidation: obs.data_quality_needs_revalidation ?? null
  };
}

/**
 * Build the frozen FIRST_WATCH snapshot for one ticker from its post-process
 * pool.js tracker item. Pure function — no I/O, no invented values.
 */
function buildFirstWatchRecord(options) {
  const { sampleDate, scheduledTime, ticker, item, now } = options;
  const rawObservation = (item && item.last_observation) || null;
  const lastMetrics = (item && item.last_metrics) || null;
  const referencePrice = finite(item && item.first_price);
  return {
    type: 'FIRST_WATCH',
    schema_version: 1,
    early_watch_id: earlyWatchId(sampleDate, ticker),
    version: VERSION,
    source_rule_version: pool.RULE_VERSION,
    ticker,
    trading_date: sampleDate,
    trigger_timestamp: now ? new Date(now).toISOString() : new Date().toISOString(),
    trigger_time_wib: (item && item.first_time) || scheduledTime || null,
    scheduled_time: scheduledTime || null,
    active_trading_minutes: activeMinutesAt(sampleDate, (item && item.first_time) || scheduledTime),
    reference_price: referencePrice,
    reference_price_source: referencePrice != null ? REFERENCE_PRICE_SOURCE : null,
    original_status: 'WATCHING',
    score: finite(item && item.source_score),
    candidate_type: (rawObservation && (rawObservation.candidate_type || rawObservation.setup)) || null,
    score_components: componentScores(rawObservation, lastMetrics),
    advance_pct: finite(lastMetrics && lastMetrics.advance_pct),
    // Confirmation progress toward the frozen, unchanged 2/2 rule
    // (pool.js REQUIRED_CONFIRMATIONS), read directly off the pool tracker's
    // own confirmation-window count — never re-derived or estimated.
    confirmation_count: item && Number.isInteger(item.ready_streak) ? item.ready_streak : null,
    required_confirmations: pool.REQUIRED_CONFIRMATIONS,
    source_plan_id: (item && item.locked_plan_lock_id) || null,
    plan_lock_id: (item && item.locked_plan_lock_id) || null,
    setup_id: (item && item.locked_setup_id) || null,
    shortlist_rank: finite(item && item.shortlist_rank),
    source_origin: (item && item.source_origin) || null,
    source_status: (item && item.source_status) || null,
    reason_codes: (item && item.last_reasons) || [],
    freshness: (rawObservation && rawObservation.freshness) || null,
    quality_flags: qualityFlags(rawObservation),
    existing_anti_chase_limit_pct: momentum.MAX_ADVANCE_PCT,
    // Informational only: never a BUY/trade signal, never a confirmed
    // recommendation, never a Supabase write from this module.
    informational_only: true,
    supabase_write: false,
    production_recommendation: false
  };
}

// ---------------------------------------------------------------------------
// State update / outcome tracking
// ---------------------------------------------------------------------------
function emptyCheckpoint() {
  return { filled: false, time: null, active_minutes_after_trigger: null, price: null, price_source: null, return_pct: null, reason: null };
}

function initTrackerState(record) {
  return {
    early_watch_id: record.early_watch_id,
    ticker: record.ticker,
    trading_date: record.trading_date,
    trigger_time_wib: record.trigger_time_wib,
    reference_price: record.reference_price,
    reference_price_source: record.reference_price_source,
    // Carried forward so the publisher can build the Early Watch Telegram
    // message on a LATER run than capture (e.g. if reference_price wasn't
    // known yet at FIRST_WATCH time) without re-reading pool.js state.
    score: record.score,
    candidate_type: record.candidate_type,
    confirmation_count: record.confirmation_count,
    checkpoints: {
      next_observation: emptyCheckpoint(),
      m15: emptyCheckpoint(),
      m30: emptyCheckpoint(),
      m60: emptyCheckpoint()
    },
    mfe_pct: null,
    mae_pct: null,
    max_move_from_reference_pct: null,
    first_plus1_time: null,
    first_plus2_time: null,
    first_minus1_time: null,
    first_minus2_time: null,
    last_seen_time: null,
    last_seen_active_minutes: null,
    still_in_pool: true,
    tracking_complete: false,
    completion_reason: null,
    completion_appended: false,
    // Notification dedup — AT-MOST-ONCE ATTEMPT contract, crash-safe.
    // `_attempted` is the durable gate: lib/intraday-fast-watcher-early-watch-publisher.js
    // persists it to disk BEFORE making the outbound Telegram call, so a
    // crash/restart between "attempted" and "sent" can never cause a
    // resend — at the cost of possibly missing that one informational
    // alert if the process dies mid-send. `_sent`/`_failure_reason` are
    // best-effort delivery bookkeeping, not the dedup gate. At most one
    // attempt of each per ticker/trading_date/early_watch_version, ever.
    early_watch_notification_attempted: false,
    early_watch_notification_attempted_at: null,
    early_watch_notification_sent: false,
    early_watch_notification_sent_at: null,
    early_watch_notification_failure_reason: null,
    anti_chase_notification_attempted: false,
    anti_chase_notification_attempted_at: null,
    anti_chase_notification_sent: false,
    anti_chase_notification_sent_at: null,
    anti_chase_notification_failure_reason: null
  };
}

/**
 * Apply one opportunistic price sample (already fetched by the guarded-live
 * run for its own purposes — no new network I/O) to an open tracker.
 * Pure, immutable-style update: returns a new tracker object.
 */
function applyObservationToTracker(tracker, sample) {
  if (!tracker || tracker.tracking_complete) return tracker;
  const { time, price, priceSource } = sample;
  if (tracker.reference_price == null || price == null) return tracker;
  const elapsed = activeMinutesElapsed(tracker.trading_date, tracker.trigger_time_wib, time);
  if (elapsed == null || elapsed <= 0) return tracker;

  const next = JSON.parse(JSON.stringify(tracker));
  const movePct = round2(((price - tracker.reference_price) / tracker.reference_price) * 100);

  next.last_seen_time = time;
  next.last_seen_active_minutes = elapsed;
  next.mfe_pct = next.mfe_pct == null ? movePct : Math.max(next.mfe_pct, movePct);
  next.mae_pct = next.mae_pct == null ? movePct : Math.min(next.mae_pct, movePct);
  next.max_move_from_reference_pct = next.max_move_from_reference_pct == null
    ? Math.abs(movePct)
    : Math.max(next.max_move_from_reference_pct, Math.abs(movePct));
  if (movePct >= 1 && next.first_plus1_time == null) next.first_plus1_time = time;
  if (movePct >= 2 && next.first_plus2_time == null) next.first_plus2_time = time;
  if (movePct <= -1 && next.first_minus1_time == null) next.first_minus1_time = time;
  if (movePct <= -2 && next.first_minus2_time == null) next.first_minus2_time = time;

  if (!next.checkpoints.next_observation.filled) {
    next.checkpoints.next_observation = {
      filled: true, time, active_minutes_after_trigger: elapsed, price, price_source: priceSource,
      return_pct: movePct, reason: null
    };
  }
  for (const minutes of HORIZON_MINUTES) {
    const key = HORIZON_KEYS[minutes];
    if (!next.checkpoints[key].filled && elapsed >= minutes) {
      next.checkpoints[key] = {
        filled: true, time, active_minutes_after_trigger: elapsed, price, price_source: priceSource,
        return_pct: movePct, reason: null
      };
    }
  }
  return next;
}

function censorOpenCheckpoints(tracker, reason) {
  const next = JSON.parse(JSON.stringify(tracker));
  for (const key of ['next_observation', 'm15', 'm30', 'm60']) {
    if (!next.checkpoints[key].filled) next.checkpoints[key] = Object.assign(emptyCheckpoint(), { reason });
  }
  return next;
}

function allCheckpointsTerminal(tracker) {
  return ['next_observation', 'm15', 'm30', 'm60'].every(key => tracker.checkpoints[key].filled || tracker.checkpoints[key].reason);
}

function buildCompletionRecord(tracker, options) {
  const { now, completionReason, sessionEnd } = options;
  const returns = {};
  for (const [key, label] of [['next_observation', 'return_next_observation'], ['m15', 'return_15m'], ['m30', 'return_30m'], ['m60', 'return_60m']]) {
    returns[label] = tracker.checkpoints[key].filled ? tracker.checkpoints[key].return_pct : null;
  }
  const exceeded = tracker.max_move_from_reference_pct != null && tracker.max_move_from_reference_pct > momentum.MAX_ADVANCE_PCT;
  return {
    type: 'TRACKING_COMPLETE',
    schema_version: 1,
    early_watch_id: tracker.early_watch_id,
    version: VERSION,
    ticker: tracker.ticker,
    trading_date: tracker.trading_date,
    completed_at: now ? new Date(now).toISOString() : new Date().toISOString(),
    completion_reason: completionReason,
    session_end: Boolean(sessionEnd),
    still_in_pool: tracker.still_in_pool,
    reference_price: tracker.reference_price,
    reference_price_source: tracker.reference_price_source,
    checkpoints: tracker.checkpoints,
    returns,
    mfe_pct: tracker.mfe_pct,
    mae_pct: tracker.mae_pct,
    first_plus1_time: tracker.first_plus1_time,
    first_plus2_time: tracker.first_plus2_time,
    first_minus1_time: tracker.first_minus1_time,
    first_minus2_time: tracker.first_minus2_time,
    executable_price: null,
    executable_price_available: false,
    executable_price_unavailable_reason: EXECUTABLE_PRICE_UNAVAILABLE_REASON,
    pre_execution_move_pct: null,
    existing_anti_chase_limit_pct: momentum.MAX_ADVANCE_PCT,
    existing_anti_chase_exceeded: exceeded,
    max_move_from_reference_pct: tracker.max_move_from_reference_pct,
    missing_data_reason: tracker.reference_price == null ? 'reference_price_unavailable_at_trigger' : null,
    early_watch_notification_attempted: tracker.early_watch_notification_attempted === true,
    early_watch_notification_sent: tracker.early_watch_notification_sent === true,
    anti_chase_notification_attempted: tracker.anti_chase_notification_attempted === true,
    anti_chase_notification_sent: tracker.anti_chase_notification_sent === true,
    informational_only: true
  };
}

// ---------------------------------------------------------------------------
// Serialization / I/O — mirrors lib/intraday-fast-watcher.js's atomic
// write + append-only event log pattern.
// ---------------------------------------------------------------------------
async function readState(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeStateAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(temp, file);
}

async function appendEvents(file, records) {
  if (!records.length) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
}

/**
 * Pure core: given the current early-watch state plus this run's pool
 * before/after snapshots and observation samples, compute the next
 * early-watch state and any newly-appendable records. No I/O.
 */
function computeNextState(options) {
  const {
    sampleDate, scheduledTime, now,
    priorPoolState, processedPoolState, observations
  } = options;
  let state = options.earlyWatchState && options.earlyWatchState.date === sampleDate
    ? JSON.parse(JSON.stringify(options.earlyWatchState))
    : { schema_version: 1, version: VERSION, date: sampleDate, updated_at: null, tickers: {} };
  state.version = VERSION;
  state.date = sampleDate;

  const newRecords = [];
  const newTickers = detectNewFirstWatchTickers(priorPoolState, processedPoolState, sampleDate);
  for (const ticker of newTickers) {
    if (state.tickers[ticker]) continue; // idempotent: never duplicate a FIRST_WATCH per ticker/date/version
    const item = processedPoolState.tickers[ticker];
    const record = buildFirstWatchRecord({ sampleDate, scheduledTime, ticker, item, now });
    state.tickers[ticker] = initTrackerState(record);
    newRecords.push(record);
  }

  const samplesByTicker = new Map();
  for (const obs of observations || []) {
    const ticker = watcher.normalizeTicker(obs && (obs.ticker || obs.symbol || obs.code));
    const time = watcher.observationTime(obs);
    const price = finite(obs && (obs.current_price ?? obs.last_price ?? obs.price));
    if (!ticker || !time || price == null) continue;
    samplesByTicker.set(ticker, { time, price, priceSource: REFERENCE_PRICE_SOURCE });
  }

  const sessionEnded = isSessionEnded(sampleDate, scheduledTime);
  const completionRecords = [];
  for (const ticker of Object.keys(state.tickers)) {
    let tracker = state.tickers[ticker];
    if (tracker.tracking_complete) continue;
    const poolItem = processedPoolState && processedPoolState.tickers && processedPoolState.tickers[ticker];
    tracker.still_in_pool = Boolean(poolItem && poolItem.active === true);
    const sample = samplesByTicker.get(ticker);
    if (sample) tracker = applyObservationToTracker(tracker, sample);
    if (sessionEnded && !allCheckpointsTerminal(tracker)) {
      tracker = censorOpenCheckpoints(tracker, 'session_end_censored');
    }
    if (allCheckpointsTerminal(tracker) && !tracker.tracking_complete) {
      tracker.tracking_complete = true;
      tracker.completion_reason = sessionEnded ? 'session_end_censored' : 'all_checkpoints_filled';
      if (!tracker.completion_appended) {
        tracker.completion_appended = true;
        completionRecords.push(buildCompletionRecord(tracker, { now, completionReason: tracker.completion_reason, sessionEnd: sessionEnded }));
      }
    }
    state.tickers[ticker] = tracker;
  }

  state.updated_at = now ? new Date(now).toISOString() : new Date().toISOString();
  return { state, newRecords, completionRecords };
}

/**
 * Orchestrator — the single additive hook the existing guarded-live runner
 * calls. Everything upstream (pool.js state machine, confirmation, publish,
 * Telegram) is computed BEFORE this is invoked and is never touched by it.
 *
 * `options.sendNotifications`, if provided, is called as
 * `async (state, processedPoolState, context) => ({ state, early_watch_sent,
 * anti_chase_sent, failures })`. It is optional and defaults to a no-op —
 * this core module never sends anything by itself. A failure inside it is
 * caught here and never prevents the tracking state itself from being
 * persisted.
 *
 * `context.persist` is a REAL, durable `(state) => writeStateAtomic(...)`
 * write against the SAME state file this function itself writes. The
 * injected `sendNotifications` implementation (see
 * lib/intraday-fast-watcher-early-watch-publisher.js) is expected to call
 * it to durably record a notification "attempted" reservation BEFORE
 * making the outbound Telegram call — that ordering, not this function's
 * own final write below, is what makes the at-most-once-attempt contract
 * crash-safe. This function's own write after `sendNotifications` returns
 * is a second, harmless, idempotent write that also captures whatever
 * "sent"/"failure_reason" bookkeeping happened.
 */
async function noopSendNotifications(state) {
  return { state, early_watch_sent: 0, anti_chase_sent: 0, failures: [] };
}

async function runEarlyWatch(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (!isEnabled(env)) return { enabled: false, informational_only: true, status: 'disabled', version: VERSION };
  if (!watcher.validDate(opts.sampleDate) || !watcher.validTime(opts.scheduledTime)) {
    return { enabled: true, informational_only: true, status: 'invalid_input', version: VERSION };
  }
  const stateDir = opts.stateDir || DEFAULT_STATE_DIR;
  const eventDir = opts.eventDir || DEFAULT_EVENT_DIR;
  const stateFile = path.join(stateDir, `${opts.sampleDate}.json`);
  const eventFile = path.join(eventDir, `${opts.sampleDate}.jsonl`);
  const priorEarlyWatchState = await (opts.readState || readState)(stateFile);
  const writeState = opts.writeState || writeStateAtomic;

  const { state, newRecords, completionRecords } = computeNextState({
    sampleDate: opts.sampleDate,
    scheduledTime: opts.scheduledTime,
    now: opts.now,
    priorPoolState: opts.priorPoolState || null,
    processedPoolState: opts.processedPoolState || null,
    observations: opts.observations || [],
    earlyWatchState: priorEarlyWatchState
  });

  let finalState = state;
  let earlyWatchSent = 0;
  let antiChaseSent = 0;
  let notificationFailures = [];
  if (!opts.dryRun) {
    try {
      const sendNotifications = opts.sendNotifications || noopSendNotifications;
      const notified = await sendNotifications(state, opts.processedPoolState || null, {
        env, now: opts.now, notifyFn: opts.notifyFn,
        persist: (nextState) => writeState(stateFile, nextState)
      });
      if (notified && notified.state) finalState = notified.state;
      earlyWatchSent = (notified && notified.early_watch_sent) || 0;
      antiChaseSent = (notified && notified.anti_chase_sent) || 0;
      notificationFailures = (notified && notified.failures) || [];
    } catch (error) {
      // Main Fast Watcher tracking/persistence must never be broken by a
      // notification failure — record it and keep the tracking state as-is.
      notificationFailures = [{ ticker: null, type: 'send_notifications', reason: 'exception', error: error && error.message }];
    }
    await writeState(stateFile, finalState);
    await (opts.appendEvents || appendEvents)(eventFile, [...newRecords, ...completionRecords]);
  }

  return {
    enabled: true,
    informational_only: true,
    status: opts.dryRun ? 'dry_run' : 'recorded',
    version: VERSION,
    sample_date: opts.sampleDate,
    scheduled_time: opts.scheduledTime,
    captured_count: newRecords.length,
    completed_count: completionRecords.length,
    tracked_open_count: Object.values(finalState.tickers).filter(t => !t.tracking_complete).length,
    state_file: stateFile,
    event_file: eventFile,
    early_watch_telegram_sent: earlyWatchSent,
    anti_chase_telegram_sent: antiChaseSent,
    notification_failures: notificationFailures,
    supabase_write: false,
    production_recommendation_registered: false
  };
}

module.exports = {
  VERSION,
  ENV_FLAG,
  LEGACY_ENV_FLAG,
  HORIZON_MINUTES,
  EXECUTABLE_PRICE_UNAVAILABLE_REASON,
  REFERENCE_PRICE_SOURCE,
  DEFAULT_STATE_DIR,
  DEFAULT_EVENT_DIR,
  isEnabled,
  earlyWatchId,
  activeMinutesAt,
  activeMinutesElapsed,
  isSessionEnded,
  detectNewFirstWatchTickers,
  buildFirstWatchRecord,
  initTrackerState,
  applyObservationToTracker,
  censorOpenCheckpoints,
  allCheckpointsTerminal,
  buildCompletionRecord,
  computeNextState,
  readState,
  writeStateAtomic,
  appendEvents,
  runEarlyWatch
};

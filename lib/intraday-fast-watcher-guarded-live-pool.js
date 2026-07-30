'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const RULE_VERSION = 'FAST_WATCHER_GUARDED_LIVE_ADAPTIVE_V1';
const TIMEZONE = 'Asia/Jakarta';
const DEFAULT_MAX_POOL = 20;
const MAX_POOL_LIMIT = 20;
const INITIAL_TTL_MINUTES = 12;
const EXTENSION_MINUTES = 12;
const MAX_TTL_MINUTES = 48;
const REQUIRED_CONFIRMATIONS = 2;
const MAX_PUBLISH_PER_RUN = 3;
const DEFAULT_STATE_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-guarded-live-state');
const DEFAULT_EVENT_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-guarded-live-events');
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const DEFAULT_SOURCE_TIMEOUT_MS = 10000;

const READY_STATUSES = new Set(['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT', 'ENTRY_READY', 'QUALIFIED', 'SENDABLE', 'CONFIRMED']);
const WATCH_STATUSES = new Set(['PRE_SPIKE_WATCH', 'MOMENTUM_CONTINUATION', 'EARLY_RADAR', 'RECLAIM_CANDIDATE', 'WAIT_PULLBACK']);
const HARD_REJECT_STATUSES = new Set(['AVOID', 'REJECTED', 'BLOCKED', 'INVALID', 'NO_ACTION']);

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value == null ? '' : value).trim().toLowerCase());
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
  return /^[A-Z]{3,5}$/.test(ticker) ? ticker : null;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function toMinutes(value) {
  if (!validTime(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function timeFromTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = parts.find(part => part.type === 'hour');
  const minute = parts.find(part => part.type === 'minute');
  return hour && minute ? `${hour.value}:${minute.value}` : null;
}

function statusPriority(value) {
  const status = String(value || '').trim().toUpperCase();
  if (status === 'A_PLUS_SETUP') return 0;
  if (status === 'TRADE_CANDIDATE') return 1;
  if (status === 'READY_BREAKOUT') return 2;
  if (status === 'PRE_SPIKE_WATCH') return 3;
  if (status === 'MOMENTUM_CONTINUATION') return 4;
  if (status === 'EARLY_RADAR') return 5;
  if (status === 'RECLAIM_CANDIDATE') return 6;
  if (status === 'WAIT_PULLBACK') return 7;
  if (status === 'SPECULATIVE') return 9;
  if (HARD_REJECT_STATUSES.has(status)) return 20;
  return 8;
}

function safeSourceRow(row, index) {
  if (typeof row === 'string') {
    const ticker = normalizeTicker(row);
    return ticker ? { ticker, source_rank: index + 1, status: 'EARLY_RADAR', daytrade_score: null } : null;
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const ticker = normalizeTicker(row.ticker || row.symbol || row.code || row.stock_code);
  if (!ticker) return null;
  return {
    ticker,
    stock_name: row.stock_name || row.name || ticker,
    board: row.board || null,
    status: String(row.status || row.current_status || row.signal_status || '').trim().toUpperCase() || 'EARLY_RADAR',
    setup: row.setup || row.candidate_type || null,
    daytrade_score: finite(row.daytrade_score) ?? finite(row.score) ?? finite(row.final_score),
    source_rank: finite(row.source_rank) ?? finite(row.rank) ?? index + 1,
    last_price: finite(row.last_price) ?? finite(row.current_price) ?? finite(row.price),
    open_price: finite(row.open_price) ?? finite(row.open),
    high_price: finite(row.high_price) ?? finite(row.high),
    low_price: finite(row.low_price) ?? finite(row.low),
    volume_today: finite(row.volume_today) ?? finite(row.volume),
    avg_volume_20d: finite(row.avg_volume_20d) ?? finite(row.average_volume),
    volume_ratio_20d: finite(row.volume_ratio_20d) ?? finite(row.relative_volume),
    value_today: finite(row.value_today),
    avg_value_7d: finite(row.avg_value_7d),
    change_pct: finite(row.change_pct),
    range_position: finite(row.range_position),
    distance_to_breakout_pct: finite(row.distance_to_breakout_pct),
    entry_low: finite(row.entry_low),
    entry_high: finite(row.entry_high),
    stop_loss: finite(row.stop_loss) ?? finite(row.sl),
    tp1: finite(row.tp1),
    tp2: finite(row.tp2),
    risk_reward: finite(row.risk_reward),
    liquidity_score: finite(row.liquidity_score) ?? finite(row.liquidity_component),
    prespike_score: finite(row.prespike_score) ?? finite(row.pre_spike_component),
    momentum_score: finite(row.momentum_score) ?? finite(row.momentum_component),
    risk_reward_score: finite(row.risk_reward_score) ?? finite(row.risk_reward_component),
    trend_score: finite(row.trend_score) ?? finite(row.trend_component),
    penalty_score: finite(row.penalty_score) ?? finite(row.penalty_component),
    resistance: finite(row.resistance),
    support: finite(row.support),
    rsi14: finite(row.rsi14),
    ma20: finite(row.ma20),
    ma50: finite(row.ma50),
    invalidation: row.invalidation || null,
    tf_1d_context: row.tf_1d_context || null,
    tf_2d_context: row.tf_2d_context || null,
    tf_3d_context: row.tf_3d_context || null,
    tf_5d_context: row.tf_5d_context || null,
    tf_10d_context: row.tf_10d_context || null,
    tf_20d_context: row.tf_20d_context || null,
    multi_timeframe_bias: row.multi_timeframe_bias || null,
    multi_timeframe_notes: row.multi_timeframe_notes || null,
    volume_phase: row.volume_phase || null,
    atr14: finite(row.atr14) ?? finite(row.structural_context && row.structural_context.atr14),
    risk_label: row.risk_label || row.risk_level || null,
    quality_grade: row.quality_grade || row.execution_grade || null,
    calculated_at: row.calculated_at || row.updated_at || null,
    run_id: row.run_id || null,
    run_mode: row.run_mode || null
  };
}

function extractSourceRows(payload, maxPool) {
  const limit = Number.isInteger(maxPool) ? maxPool : DEFAULT_MAX_POOL;
  let raw = [];
  if (payload && Array.isArray(payload.results)) raw = payload.results;
  else if (payload && Array.isArray(payload.rows)) raw = payload.rows;
  else if (payload && Array.isArray(payload.radar_candidates)) raw = payload.radar_candidates;
  else if (Array.isArray(payload)) raw = payload;
  const seen = new Set();
  const rows = raw.map(safeSourceRow).filter(Boolean).filter(row => {
    if (seen.has(row.ticker)) return false;
    seen.add(row.ticker);
    return !HARD_REJECT_STATUSES.has(row.status) && row.status !== 'SPECULATIVE';
  });
  rows.sort((a, b) => statusPriority(a.status) - statusPriority(b.status) || (finite(b.daytrade_score) ?? -999) - (finite(a.daytrade_score) ?? -999) || a.source_rank - b.source_rank || a.ticker.localeCompare(b.ticker));
  return rows.slice(0, Math.min(limit, MAX_POOL_LIMIT)).map((row, index) => Object.assign({}, row, { source_rank: index + 1 }));
}

function sourceMeta(payload) {
  const meta = payload && payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const calculatedAt = payload && (payload.calculated_at || payload.updated_at) || meta.calculated_at || meta.updated_at || null;
  return {
    status: String(payload && payload.status || meta.status || '').trim().toLowerCase() || null,
    run_id: payload && payload.run_id || meta.run_id || null,
    calculated_at: calculatedAt,
    run_mode: payload && payload.run_mode || meta.run_mode || null,
    source_time: timeFromTimestamp(calculatedAt)
  };
}

function sourceFingerprint(payload, rows) {
  const meta = sourceMeta(payload);
  return crypto.createHash('sha256').update(JSON.stringify({
    run_id: meta.run_id,
    calculated_at: meta.calculated_at,
    rows: (rows || []).map(row => [row.ticker, row.status, row.daytrade_score, row.last_price, row.volume_today])
  })).digest('hex').slice(0, 20);
}

function baselineFromSource(row, fallbackTime) {
  return {
    scheduled_time: timeFromTimestamp(row.calculated_at) || fallbackTime,
    current_price: row.last_price,
    volume: row.volume_today,
    relative_volume: row.volume_ratio_20d,
    score: row.daytrade_score,
    current_status: row.status,
    entry_low: row.entry_low,
    entry_high: row.entry_high,
    sl: row.stop_loss,
    tp1: row.tp1,
    tp2: row.tp2,
    freshness: { is_stale: false },
    source_baseline: true
  };
}

function freshPoolState(sampleDate) {
  return {
    schema_version: 1,
    date: sampleDate,
    rule_version: RULE_VERSION,
    source_fingerprint: null,
    source_run_id: null,
    source_calculated_at: null,
    updated_at: null,
    tickers: {},
    published_identities: []
  };
}

function trackerRankScore(tracker) {
  const progress = finite(tracker.last_evaluation && tracker.last_evaluation.watch_score) || 0;
  const sourceScore = finite(tracker.source_row && tracker.source_row.daytrade_score) || 0;
  const priority = 20 - statusPriority(tracker.source_row && tracker.source_row.status);
  return progress * 2 + sourceScore + priority * 4 + (tracker.confirmation_streak || 0) * 20;
}

function mergePool(state, sourceRows, options) {
  const nowMinute = toMinutes(options.scheduledTime);
  const sourceTime = options.sourceTime && validTime(options.sourceTime) ? options.sourceTime : options.scheduledTime;
  const sourceMinute = toMinutes(sourceTime);
  const maxPool = Math.min(Number(options.maxPool) || DEFAULT_MAX_POOL, MAX_POOL_LIMIT);
  const currentTickers = new Set(sourceRows.map(row => row.ticker));
  for (const tracker of Object.values(state.tickers || {})) tracker.in_latest_source = currentTickers.has(tracker.ticker);

  for (const row of sourceRows) {
    let tracker = state.tickers[row.ticker];
    if (!tracker || tracker.active === false || tracker.drop_reason) {
      const firstMinute = sourceMinute == null ? nowMinute : sourceMinute;
      tracker = {
        ticker: row.ticker,
        active: true,
        in_latest_source: true,
        first_seen_time: sourceTime,
        first_seen_minute: firstMinute,
        last_source_time: sourceTime,
        expires_minute: Math.min(firstMinute + INITIAL_TTL_MINUTES, firstMinute + MAX_TTL_MINUTES),
        max_expires_minute: firstMinute + MAX_TTL_MINUTES,
        source_row: row,
        baseline: baselineFromSource(row, sourceTime),
        observations: [],
        confirmation_streak: 0,
        status: 'WATCHING',
        published_identity: null,
        db_published: false,
        telegram_status: 'not_attempted',
        telegram_attempts: 0,
        drop_reason: null
      };
      state.tickers[row.ticker] = tracker;
    } else {
      tracker.active = true;
      tracker.in_latest_source = true;
      tracker.last_source_time = sourceTime;
      tracker.source_row = Object.assign({}, tracker.source_row || {}, row);
      if (!tracker.baseline || tracker.baseline.current_price == null) tracker.baseline = baselineFromSource(row, sourceTime);
      tracker.expires_minute = Math.min(Math.max(tracker.expires_minute || nowMinute, nowMinute + INITIAL_TTL_MINUTES), tracker.max_expires_minute || nowMinute + MAX_TTL_MINUTES);
    }
  }

  const candidates = Object.values(state.tickers).filter(tracker => tracker.active !== false && !tracker.drop_reason && (tracker.max_expires_minute == null || nowMinute <= tracker.max_expires_minute));
  candidates.sort((a, b) => trackerRankScore(b) - trackerRankScore(a) || a.ticker.localeCompare(b.ticker));
  const keep = new Set(candidates.slice(0, maxPool).map(tracker => tracker.ticker));
  for (const tracker of candidates) {
    if (!keep.has(tracker.ticker)) {
      tracker.active = false;
      tracker.status = 'DROPPED_POOL_CAP';
      tracker.drop_reason = 'pool_cap_replaced_by_stronger_candidate';
      tracker.confirmation_streak = 0;
    }
  }
  return state;
}

module.exports = {
  RULE_VERSION, TIMEZONE, DEFAULT_MAX_POOL, MAX_POOL_LIMIT,
  INITIAL_TTL_MINUTES, EXTENSION_MINUTES, MAX_TTL_MINUTES,
  REQUIRED_CONFIRMATIONS, MAX_PUBLISH_PER_RUN,
  DEFAULT_STATE_DIR, DEFAULT_EVENT_DIR, DEFAULT_LOCK_STALE_MS,
  DEFAULT_SOURCE_TIMEOUT_MS, READY_STATUSES, WATCH_STATUSES,
  HARD_REJECT_STATUSES, enabled, finite, round2, normalizeTicker,
  validDate, validTime, toMinutes, timeFromTimestamp, statusPriority,
  safeSourceRow, extractSourceRows, sourceMeta, sourceFingerprint,
  baselineFromSource, freshPoolState, trackerRankScore, mergePool
};

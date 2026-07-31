'use strict';

const crypto = require('node:crypto');
const watcher = require('./intraday-fast-watcher');
const momentum = require('./intraday-fast-watcher-momentum');

const RULE_VERSION = 'FAST_WATCHER_ADAPTIVE_MOMENTUM_V2';
const INITIAL_WATCH_MINUTES = 12;
const WATCH_EXTENSION_MINUTES = 12;
const MAX_WATCH_MINUTES = 48;
const REQUIRED_CONFIRMATIONS = 2;
const MAX_PUBLISH_COUNT = 3;
const MIN_EXTENSION_SCORE = 42;
const SUPPLEMENTAL_STATUSES = new Set([
  'READY_BREAKOUT', 'A_PLUS_SETUP', 'TRADE_CANDIDATE', 'PRE_SPIKE_WATCH', 'EARLY_RADAR',
  'WAIT_PULLBACK', 'MOMENTUM_CONTINUATION', 'RECLAIM_CANDIDATE', 'WATCHING'
]);

function eventId(date, ticker, time, from, to) {
  return crypto.createHash('sha256').update([date, ticker, time, from || '-', to, RULE_VERSION].join('|')).digest('hex');
}
function setupId(date, ticker, metrics) {
  return crypto.createHash('sha256').update([date, ticker, metrics.entry_low, metrics.entry_high, metrics.stop_loss, metrics.tp1, RULE_VERSION].join('|')).digest('hex');
}
function trackerFor(row, minute) {
  return {
    active: true, in_latest_shortlist: true, shortlist_rank: row.source_rank, board: row.board || null,
    source_score: row.score, source_status: row.source_status || null, status: 'WATCHING', ready_streak: 0,
    first_price: null, first_time: null, first_observation_minute: minute,
    expires_at_minute: minute == null ? null : minute + INITIAL_WATCH_MINUTES,
    max_expires_at_minute: minute == null ? null : minute + MAX_WATCH_MINUTES,
    extension_count: 0, last_time: null, last_observation_minute: null, last_price: null,
    last_volume: null, last_volume_rate: null, last_watch_score: null, last_publish_score: null,
    stagnant_count: 0, processed_keys: [], last_reasons: [], last_observation: null, last_metrics: null
  };
}
function resetTrackerForReentry(item, row, minute) {
  // A ticker that returns after expiry starts a genuinely new watch cycle.
  // Do not inherit the previous cycle's age, streak, observations, or scores.
  Object.assign(item, trackerFor(row, minute));
  return item;
}

function activeRows(state, scheduledTime) {
  if (!state || !state.tickers) return [];
  const minute = momentum.toMinutes(scheduledTime);
  return Object.entries(state.tickers).map(([ticker, item]) => {
    if (!item || item.active !== true) return null;
    if (minute != null && item.max_expires_at_minute != null && minute >= item.max_expires_at_minute) return null;
    if (['INVALIDATED', 'STALE', 'INVALID_DATA', 'BLOCKED_CHASE', 'DROPPED_FROM_WATCH_POOL'].includes(item.status)) return null;
    return {
      ticker, board: item.board || null, source_rank: item.shortlist_rank || 999, score: item.source_score,
      source_status: item.source_status || 'CARRIED_WATCH_POOL', watch_score: item.last_watch_score,
      publish_score: item.last_publish_score, ready_streak: item.ready_streak || 0, carried: true
    };
  }).filter(Boolean);
}
function mergePayload(payload, priorState, scheduledTime, supplemental, maxShortlist) {
  const current = watcher.buildShortlist(payload, watcher.MAX_SHORTLIST_LIMIT);
  const byTicker = new Map();
  (current.ok ? current.rows : []).forEach((row, index) => {
    byTicker.set(row.ticker, Object.assign({}, row, { carried: false, pool_priority: 300 + Math.max(0, 50 - index) + (row.score || 0) * 0.2 }));
  });
  for (const item of activeRows(priorState, scheduledTime)) {
    const priority = 250 + (Number(item.watch_score) || 0) + (Number(item.ready_streak) || 0) * 15;
    const existing = byTicker.get(item.ticker);
    if (existing) existing.pool_priority = Math.max(existing.pool_priority || 0, priority);
    else byTicker.set(item.ticker, Object.assign({}, item, { pool_priority: priority }));
  }
  for (const item of supplemental || []) {
    const ticker = watcher.normalizeTicker(item && (item.ticker || item.symbol || item.code));
    if (!ticker || byTicker.has(ticker)) continue;
    const status = String(item.status || item.source_status || '').toUpperCase();
    if (status && !SUPPLEMENTAL_STATUSES.has(status)) continue;
    const score = Number.isFinite(Number(item.daytrade_score ?? item.score)) ? Number(item.daytrade_score ?? item.score) : 0;
    byTicker.set(ticker, { ticker, board: item.board || null, source_rank: byTicker.size + 1, score, source_status: status || null, carried: false, pool_priority: 100 + score });
  }
  const limit = Number.isInteger(maxShortlist) ? maxShortlist : 20;
  const rows = [...byTicker.values()].sort((a, b) => (b.pool_priority || 0) - (a.pool_priority || 0) || (a.source_rank || 999) - (b.source_rank || 999) || a.ticker.localeCompare(b.ticker)).slice(0, limit).map((row, index) => Object.assign({}, row, { source_rank: index + 1 }));
  return { status: 'published', results: rows };
}
function observationKey(ticker, time, obs) {
  return `${ticker}|${time}|${crypto.createHash('sha256').update(JSON.stringify(obs)).digest('hex').slice(0, 12)}`;
}
function rankPublishable(rows) {
  return rows.sort((a, b) => (b.publish_score || 0) - (a.publish_score || 0) || (b.watch_score || 0) - (a.watch_score || 0) || (a.shortlist_rank || 999) - (b.shortlist_rank || 999) || a.ticker.localeCompare(b.ticker)).slice(0, MAX_PUBLISH_COUNT);
}
function process(options) {
  const date = options.sampleDate;
  const throughMinute = momentum.toMinutes(options.scheduledTime);
  const shortlistRows = options.shortlistRows || [];
  const state = options.priorState && options.priorState.date === date ? JSON.parse(JSON.stringify(options.priorState)) : { schema_version: 2, date, rule_version: RULE_VERSION, updated_at: null, tickers: {} };
  state.schema_version = 2; state.date = date; state.rule_version = RULE_VERSION; state.shortlist = shortlistRows.map(row => row.ticker);
  const events = [];
  for (const item of Object.values(state.tickers)) item.in_latest_shortlist = false;
  for (const row of shortlistRows) {
    if (!state.tickers[row.ticker]) state.tickers[row.ticker] = trackerFor(row, throughMinute);
    const item = state.tickers[row.ticker];

    // Re-entry after an expired/dropped cycle must not reuse the old timer.
    // Otherwise a fresh READY_PENDING candidate can be dropped immediately
    // by max_watch_age_reached before receiving its second confirmation.
    if (item.status === 'DROPPED_FROM_WATCH_POOL') {
      resetTrackerForReentry(item, row, throughMinute);
    }

    item.active = true; item.in_latest_shortlist = row.carried !== true; item.shortlist_rank = row.source_rank;
    item.board = row.board || item.board || null; item.source_score = row.score != null ? row.score : item.source_score; item.source_status = row.source_status || item.source_status || null;
  }
  const rows = (options.observations || []).map(obs => ({ obs, ticker: watcher.normalizeTicker(obs && (obs.ticker || obs.symbol || obs.code)), time: watcher.observationTime(obs) })).filter(row => row.ticker && row.time).sort((a, b) => momentum.toMinutes(a.time) - momentum.toMinutes(b.time) || a.ticker.localeCompare(b.ticker));
  for (const row of rows) {
    const item = state.tickers[row.ticker];
    if (!item || item.active !== true) continue;
    const key = observationKey(row.ticker, row.time, row.obs);
    const processed = new Set(item.processed_keys || []);
    if (processed.has(key)) continue;
    processed.add(key); item.processed_keys = [...processed].slice(-200);
    const minute = momentum.toMinutes(row.time);
    const raw = momentum.metricsFrom(row.obs);
    if (item.first_price == null && raw.current_price != null && raw.current_price > 0) {
      item.first_price = raw.current_price; item.first_time = row.time; item.first_observation_minute = minute;
      item.expires_at_minute = minute + INITIAL_WATCH_MINUTES; item.max_expires_at_minute = minute + MAX_WATCH_MINUTES;
    }
    const result = momentum.evaluate(row.obs, item);
    const from = item.status || 'WATCHING';
    let to = result.status;
    if (result.passes) {
      item.ready_streak = (item.ready_streak || 0) + 1; item.stagnant_count = 0;
      to = item.ready_streak >= REQUIRED_CONFIRMATIONS ? 'READY_CONFIRMED' : 'READY_PENDING';
    } else {
      item.ready_streak = 0;
      item.stagnant_count = item.last_watch_score != null && result.metrics.watch_score <= item.last_watch_score + 1 ? (item.stagnant_count || 0) + 1 : 0;
    }
    if (minute != null && item.expires_at_minute != null && minute >= item.expires_at_minute - 2 && item.expires_at_minute < item.max_expires_at_minute && result.metrics.watch_score >= MIN_EXTENSION_SCORE && item.stagnant_count < 2) {
      item.expires_at_minute = Math.min(item.expires_at_minute + WATCH_EXTENSION_MINUTES, item.max_expires_at_minute);
      item.extension_count = (item.extension_count || 0) + 1;
      result.reasons = [...new Set([...(result.reasons || []), 'adaptive_watch_extended'])].sort();
    }
    item.status = to; item.last_time = row.time; item.last_observation_minute = minute; item.last_reasons = result.reasons;
    item.last_metrics = result.metrics; item.last_observation = row.obs; item.last_price = result.metrics.current_price;
    item.last_volume = result.metrics.volume; item.last_volume_rate = result.metrics.volume_rate;
    item.last_watch_score = result.metrics.watch_score; item.last_publish_score = result.metrics.publish_score;
    if (to !== from) events.push({ event_id: eventId(date, row.ticker, row.time, from, to), date, time: row.time, ticker: row.ticker, from_status: from, to_status: to, ready_streak: item.ready_streak, reasons: result.reasons, engine_class: result.engine_class, metrics: result.metrics, rule_version: RULE_VERSION, shadow_only: false });
  }
  if (throughMinute != null) {
    for (const [ticker, item] of Object.entries(state.tickers)) {
      if (!item.active) continue;
      let reason = null;
      if (['INVALIDATED', 'STALE', 'INVALID_DATA', 'BLOCKED_CHASE'].includes(item.status)) reason = 'terminal_safety_status';
      else if (item.max_expires_at_minute != null && throughMinute >= item.max_expires_at_minute) reason = 'max_watch_age_reached';
      else if (item.expires_at_minute != null && throughMinute >= item.expires_at_minute && item.status !== 'READY_CONFIRMED') reason = 'adaptive_watch_expired';
      else if (item.stagnant_count >= 2 && item.in_latest_shortlist === false && (item.last_watch_score || 0) < MIN_EXTENSION_SCORE) reason = 'momentum_stagnant';
      if (!reason) continue;
      const from = item.status || 'WATCHING'; item.active = false; item.status = 'DROPPED_FROM_WATCH_POOL'; item.ready_streak = 0;
      events.push({ event_id: eventId(date, ticker, options.scheduledTime || item.last_time || '00:00', from, item.status), date, time: options.scheduledTime || item.last_time || '00:00', ticker, from_status: from, to_status: item.status, reasons: [reason], rule_version: RULE_VERSION, shadow_only: false });
    }
  }
  state.updated_at = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const confirmed = Object.entries(state.tickers).filter(([, item]) => item.active && item.status === 'READY_CONFIRMED').map(([ticker, item]) => ({ ticker, time: item.last_time, ready_streak: item.ready_streak, watch_score: item.last_watch_score, publish_score: item.last_publish_score, setup_id: setupId(date, ticker, item.last_metrics || {}), observation: Object.assign({}, item.last_observation || {}, { metrics: item.last_metrics || {} }), shortlist_rank: item.shortlist_rank }));
  return { state, events, confirmed, publishable: rankPublishable(confirmed), active_pool_count: Object.values(state.tickers).filter(item => item.active).length, processed_observation_count: rows.length, shortlist_count: shortlistRows.length };
}

module.exports = { RULE_VERSION, INITIAL_WATCH_MINUTES, WATCH_EXTENSION_MINUTES, MAX_WATCH_MINUTES, REQUIRED_CONFIRMATIONS, MAX_PUBLISH_COUNT, SUPPLEMENTAL_STATUSES, resetTrackerForReentry, activeRows, mergePayload, process, rankPublishable, setupId };

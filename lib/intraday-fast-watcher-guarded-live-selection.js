'use strict';

const crypto = require('node:crypto');
const pool = require('./intraday-fast-watcher-guarded-live-pool');
const momentum = require('./intraday-fast-watcher-guarded-live-momentum');
const {
  RULE_VERSION, REQUIRED_CONFIRMATIONS, MAX_PUBLISH_PER_RUN,
  EXTENSION_MINUTES, MAX_TTL_MINUTES, finite, round2, normalizeTicker,
  toMinutes
} = pool;
const { evaluateMomentum } = momentum;

function eventIdentity(sampleDate, tracker, evaluation) {
  const source = tracker.source_row || {};
  const obs = evaluation.observation || {};
  return crypto.createHash('sha256').update(JSON.stringify([
    sampleDate,
    tracker.ticker,
    obs.plan_lock_id || null,
    source.run_id || null,
    source.entry_low || obs.entry_low,
    source.entry_high || obs.entry_high,
    source.stop_loss || obs.stop_loss,
    source.tp1 || obs.tp1,
    RULE_VERSION
  ])).digest('hex');
}

function applyObservations(state, observations, options) {
  const nowMinute = toMinutes(options.scheduledTime);
  const events = [];
  const eligibleConfirmed = [];
  const byTicker = new Map((observations || []).map(row => [normalizeTicker(row && row.ticker), row]));

  for (const tracker of Object.values(state.tickers || {})) {
    if (!tracker || tracker.active === false || tracker.drop_reason) continue;
    const observation = byTicker.get(tracker.ticker);
    if (!observation) {
      if (tracker.expires_minute != null && nowMinute > tracker.expires_minute) {
        tracker.active = false;
        tracker.status = 'EXPIRED_STAGNANT';
        tracker.drop_reason = 'adaptive_ttl_expired_without_progress';
        tracker.confirmation_streak = 0;
        events.push({ ticker: tracker.ticker, to_status: tracker.status, reasons: [tracker.drop_reason] });
      }
      continue;
    }

    const evaluation = evaluateMomentum(tracker, observation);
    tracker.last_evaluation = evaluation;
    tracker.last_observation_time = options.scheduledTime;
    tracker.observations = Array.isArray(tracker.observations) ? tracker.observations : [];
    tracker.observations.push(observation);
    tracker.observations = tracker.observations.slice(-8);

    if (evaluation.hard_reasons.length) {
      tracker.active = false;
      tracker.status = 'INVALIDATED';
      tracker.drop_reason = evaluation.hard_reasons.join(',');
      tracker.confirmation_streak = 0;
      events.push({ ticker: tracker.ticker, to_status: tracker.status, reasons: evaluation.hard_reasons, metrics: evaluation.metrics });
      continue;
    }

    if (evaluation.passes) {
      tracker.confirmation_streak = (tracker.confirmation_streak || 0) + 1;
      tracker.status = tracker.confirmation_streak >= REQUIRED_CONFIRMATIONS ? 'READY_CONFIRMED' : 'READY_PENDING';
      tracker.expires_minute = Math.min(Math.max(tracker.expires_minute || nowMinute, nowMinute + EXTENSION_MINUTES), tracker.max_expires_minute || nowMinute + MAX_TTL_MINUTES);
    } else {
      tracker.confirmation_streak = 0;
      tracker.status = 'WATCHING';
      if (tracker.expires_minute != null && nowMinute > tracker.expires_minute) {
        tracker.active = false;
        tracker.status = 'EXPIRED_STAGNANT';
        tracker.drop_reason = 'adaptive_ttl_expired_without_progress';
      }
    }

    events.push({ ticker: tracker.ticker, to_status: tracker.status, confirmation_streak: tracker.confirmation_streak, reasons: evaluation.reasons, metrics: evaluation.metrics, watch_score: evaluation.watch_score });
    if (tracker.active !== false && tracker.status === 'READY_CONFIRMED' && evaluation.publish_ready) {
      const identity = eventIdentity(options.sampleDate, tracker, evaluation);
      eligibleConfirmed.push({ tracker, evaluation, identity });
    }
  }

  eligibleConfirmed.sort((a, b) => b.evaluation.watch_score - a.evaluation.watch_score || (finite(b.tracker.source_row && b.tracker.source_row.daytrade_score) || 0) - (finite(a.tracker.source_row && a.tracker.source_row.daytrade_score) || 0) || a.tracker.ticker.localeCompare(b.tracker.ticker));
  const topConfirmed = eligibleConfirmed.slice(0, MAX_PUBLISH_PER_RUN);
  const publishable = topConfirmed.filter(item => !item.tracker.published_identity && !(state.published_identities || []).includes(item.identity));
  const refreshable = topConfirmed.filter(item => item.tracker.published_identity || (state.published_identities || []).includes(item.identity));
  return { state, events, publishable, refreshable, top_confirmed: topConfirmed };
}

function buildPublishRow(item, options) {
  const source = item.tracker.source_row || {};
  const obs = item.evaluation.observation || {};
  const metrics = item.evaluation.metrics || {};
  const now = options.nowIso || new Date().toISOString();
  const risk = obs.current_price != null && obs.stop_loss != null ? obs.current_price - obs.stop_loss : null;
  const reward = obs.tp1 != null && obs.current_price != null ? obs.tp1 - obs.current_price : null;
  const rr = risk != null && risk > 0 && reward != null ? reward / risk : finite(source.risk_reward);
  return {
    ticker: item.tracker.ticker,
    stock_name: source.stock_name || item.tracker.ticker,
    board: source.board || null,
    status: 'TRADE_CANDIDATE',
    setup: 'FAST_WATCHER_CONFIRMED',
    daytrade_score: finite(obs.score) ?? finite(source.daytrade_score) ?? Math.round(item.evaluation.watch_score),
    liquidity_score: finite(obs.liquidity_component) ?? finite(source.liquidity_score),
    prespike_score: finite(obs.pre_spike_component) ?? finite(source.prespike_score),
    momentum_score: finite(obs.momentum_component) ?? finite(source.momentum_score),
    risk_reward_score: finite(obs.risk_reward_component) ?? finite(source.risk_reward_score),
    trend_score: finite(obs.trend_component) ?? finite(source.trend_score),
    penalty_score: finite(obs.penalty_component) ?? finite(source.penalty_score),
    last_price: obs.current_price,
    change_pct: finite(source.change_pct),
    open_price: obs.open ?? source.open_price,
    high_price: obs.high ?? source.high_price,
    low_price: obs.low ?? source.low_price,
    volume_today: obs.volume,
    value_today: finite(source.value_today),
    avg_volume_20d: obs.average_volume ?? source.avg_volume_20d,
    avg_value_7d: finite(source.avg_value_7d),
    volume_ratio_20d: obs.relative_volume,
    rsi14: finite(source.rsi14),
    ma20: finite(source.ma20),
    ma50: finite(source.ma50),
    resistance: finite(source.resistance),
    support: finite(source.support),
    range_position: finite(source.range_position),
    distance_to_breakout_pct: finite(source.distance_to_breakout_pct),
    entry_low: obs.entry_low,
    entry_high: obs.entry_high,
    stop_loss: obs.stop_loss,
    tp1: obs.tp1,
    tp2: obs.tp2,
    risk_reward: round2(rr),
    invalidation: source.invalidation || ('Harga turun ke/bawah ' + obs.stop_loss),
    time_plan: 'Intraday — Fast Watcher guarded live',
    notes: 'Fast Watcher confirmed: 2 consecutive momentum checks; watch score ' + item.evaluation.watch_score + '; price Δ ' + metrics.price_change_pct + '%; volume Δ ' + metrics.volume_growth_pct + '%; RVOL ' + metrics.relative_volume + '.',
    run_mode: source.run_mode || 'FAST_WATCHER',
    calculated_at: now,
    run_id: 'fw-' + options.sampleDate + '-' + item.identity.slice(0, 16),
    tf_1d_context: source.tf_1d_context || null,
    tf_2d_context: source.tf_2d_context || null,
    tf_3d_context: source.tf_3d_context || null,
    tf_5d_context: source.tf_5d_context || null,
    tf_10d_context: source.tf_10d_context || null,
    tf_20d_context: source.tf_20d_context || null,
    multi_timeframe_bias: source.multi_timeframe_bias || null,
    multi_timeframe_notes: source.multi_timeframe_notes || null,
    volume_phase: source.volume_phase || null,
    risk_label: source.risk_label || null,
    quality_grade: source.quality_grade || null
  };
}

function formatTelegramMessage(item, options) {
  const obs = item.evaluation.observation;
  const metrics = item.evaluation.metrics;
  return [
    '🚀 FAST WATCHER — MOMENTUM CONFIRMED',
    '',
    'Ticker: ' + item.tracker.ticker,
    'Waktu: ' + options.sampleDate + ' ' + options.scheduledTime + ' WIB',
    'Harga: ' + obs.current_price,
    'Area entry: ' + obs.entry_low + '–' + obs.entry_high,
    'Stop loss: ' + obs.stop_loss,
    'TP1: ' + obs.tp1,
    obs.tp2 != null ? 'TP2: ' + obs.tp2 : null,
    'Perubahan harga: ' + metrics.price_change_pct + '%',
    'Pertumbuhan volume: ' + metrics.volume_growth_pct + '%',
    'Relative volume: ' + metrics.relative_volume,
    'Pace volume sesi: ' + (metrics.relative_volume_pace != null ? metrics.relative_volume_pace + 'x' : '-'),
    'Akselerasi volume interval: ' + (metrics.interval_volume_pace != null ? metrics.interval_volume_pace + 'x' : '-'),
    'R/R ke TP1: ' + metrics.rr_to_tp1,
    'Watch score: ' + item.evaluation.watch_score,
    'Konfirmasi: ' + item.tracker.confirmation_streak + 'x berturut-turut',
    '',
    metrics.controlled_breakout ? 'Status: breakout masih dalam batas anti-chase.' : 'Status: harga masih dalam area entry.',
    'Bukan order otomatis. Tetap gunakan disiplin risiko.'
  ].filter(Boolean).join('\n');
}

module.exports = {
  eventIdentity, applyObservations, buildPublishRow, formatTelegramMessage
};

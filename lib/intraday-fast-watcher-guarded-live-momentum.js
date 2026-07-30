'use strict';

const pool = require('./intraday-fast-watcher-guarded-live-pool');
const {
  READY_STATUSES, WATCH_STATUSES, finite, round2, normalizeTicker,
  validTime, toMinutes
} = pool;

function normalizeObservation(obs) {
  const row = obs || {};
  return {
    ticker: normalizeTicker(row.ticker),
    scheduled_time: row.scheduled_time || row.observation_time || null,
    current_price: finite(row.current_price) ?? finite(row.last_price) ?? finite(row.price),
    open: finite(row.open) ?? finite(row.open_price),
    high: finite(row.high) ?? finite(row.high_price),
    low: finite(row.low) ?? finite(row.low_price),
    volume: finite(row.volume) ?? finite(row.volume_today),
    average_volume: finite(row.average_volume) ?? finite(row.avg_volume_20d),
    relative_volume: finite(row.relative_volume) ?? finite(row.volume_ratio_20d),
    score: finite(row.score) ?? finite(row.daytrade_score),
    current_status: String(row.current_status || row.status || '').trim().toUpperCase() || null,
    entry_low: finite(row.entry_low),
    entry_high: finite(row.entry_high),
    stop_loss: finite(row.stop_loss) ?? finite(row.sl),
    tp1: finite(row.tp1),
    tp2: finite(row.tp2),
    liquidity_component: finite(row.liquidity_component) ?? finite(row.liquidity_score),
    pre_spike_component: finite(row.pre_spike_component) ?? finite(row.prespike_score),
    momentum_component: finite(row.momentum_component) ?? finite(row.momentum_score),
    risk_reward_component: finite(row.risk_reward_component) ?? finite(row.risk_reward_score),
    trend_component: finite(row.trend_component) ?? finite(row.trend_score),
    penalty_component: finite(row.penalty_component) ?? finite(row.penalty_score),
    freshness: row.freshness || null,
    structural_context: row.structural_context || null,
    plan_lock_id: row.plan_lock_id || null,
    selected_trade_plan: row.selected_trade_plan || null,
    raw: row
  };
}

function percentChange(current, previous) {
  return current != null && previous != null && previous > 0 ? ((current - previous) / previous) * 100 : null;
}

const SESSION_MINUTES = 320;

function tradingElapsedMinutes(value) {
  const minute = toMinutes(value);
  if (minute == null) return null;
  const morningStart = 9 * 60;
  const morningEnd = 12 * 60;
  const afternoonStart = 13 * 60 + 30;
  const afternoonEnd = 15 * 60 + 50;
  if (minute <= morningStart) return 1;
  if (minute <= morningEnd) return Math.max(1, minute - morningStart);
  if (minute < afternoonStart) return morningEnd - morningStart;
  if (minute <= afternoonEnd) return (morningEnd - morningStart) + (minute - afternoonStart);
  return SESSION_MINUTES;
}

function evaluateMomentum(tracker, observation) {
  const obs = normalizeObservation(observation);
  const previousRaw = tracker.observations && tracker.observations.length ? tracker.observations[tracker.observations.length - 1] : tracker.baseline;
  const previous = normalizeObservation(previousRaw || {});
  const reasons = [];
  const hardReasons = [];
  const currentMinute = toMinutes(obs.scheduled_time);
  const previousMinute = toMinutes(previous.scheduled_time);
  const intervalMinutes = currentMinute != null && previousMinute != null ? Math.max(1, currentMinute - previousMinute) : null;
  const priceChangePct = percentChange(obs.current_price, previous.current_price);
  const advanceFromFirstPct = percentChange(obs.current_price, finite(tracker.baseline && tracker.baseline.current_price));
  const volumeGrowthPct = percentChange(obs.volume, previous.volume);
  const elapsedMinutes = tradingElapsedMinutes(obs.scheduled_time);
  const elapsedFraction = elapsedMinutes == null ? null : Math.max(1 / SESSION_MINUTES, Math.min(1, elapsedMinutes / SESSION_MINUTES));
  const relativeVolumePace = obs.relative_volume != null && elapsedFraction != null ? obs.relative_volume / elapsedFraction : null;
  const volumeDelta = obs.volume != null && previous.volume != null ? Math.max(0, obs.volume - previous.volume) : null;
  const intervalVolumePace = volumeDelta != null && obs.average_volume != null && obs.average_volume > 0 && intervalMinutes != null
    ? (volumeDelta / obs.average_volume) / Math.max(1 / SESSION_MINUTES, intervalMinutes / SESSION_MINUTES)
    : null;
  const atr14 = finite(obs.structural_context && obs.structural_context.atr14) ?? finite(tracker.source_row && tracker.source_row.atr14);
  const atrPct = atr14 != null && obs.current_price ? (atr14 / obs.current_price) * 100 : null;
  const noisePct = Math.max(0.12, Math.min(0.55, (atrPct == null ? 1.5 : atrPct) * 0.10));
  const chaseTolerancePct = Math.max(0.8, Math.min(2.5, (atrPct == null ? 2 : atrPct) * 0.35));
  const entryOvershootPct = obs.entry_high != null && obs.entry_high > 0 && obs.current_price != null ? ((obs.current_price - obs.entry_high) / obs.entry_high) * 100 : null;
  const risk = obs.current_price != null && obs.stop_loss != null ? obs.current_price - obs.stop_loss : null;
  const reward = obs.tp1 != null && obs.current_price != null ? obs.tp1 - obs.current_price : null;
  const rrToTp1 = risk != null && risk > 0 && reward != null ? reward / risk : null;
  const stale = Boolean(obs.freshness && obs.freshness.is_stale === true);

  if (!obs.ticker || !validTime(obs.scheduled_time)) hardReasons.push('invalid_identity_or_time');
  if (obs.current_price == null || obs.current_price <= 0) hardReasons.push('invalid_current_price');
  if (stale) hardReasons.push('stale_data');
  if (obs.entry_low == null || obs.entry_high == null || obs.entry_low > obs.entry_high) hardReasons.push('invalid_entry_zone');
  if (obs.stop_loss == null || obs.stop_loss <= 0) hardReasons.push('invalid_stop_loss');
  if (obs.tp1 == null || obs.tp1 <= 0) hardReasons.push('invalid_tp1');
  if (obs.current_price != null && obs.stop_loss != null && obs.current_price <= obs.stop_loss) hardReasons.push('stop_touched');
  if (obs.current_price != null && obs.tp1 != null && obs.current_price >= obs.tp1) hardReasons.push('tp1_already_reached');
  if (advanceFromFirstPct != null && advanceFromFirstPct > 6) hardReasons.push('advance_above_6_pct');
  if (entryOvershootPct != null && entryOvershootPct > chaseTolerancePct) hardReasons.push('entry_overshoot_chase');
  if (rrToTp1 != null && rrToTp1 < 0.8) hardReasons.push('rr_below_minimum');

  let watchScore = 0;
  const status = obs.current_status || (tracker.source_row && tracker.source_row.status) || '';
  if (READY_STATUSES.has(status)) watchScore += 22;
  else if (status === 'PRE_SPIKE_WATCH' || status === 'MOMENTUM_CONTINUATION') watchScore += 17;
  else if (WATCH_STATUSES.has(status)) watchScore += 10;
  else reasons.push('engine_not_ready_treated_as_context_only');

  const priceSignal = priceChangePct != null && priceChangePct >= noisePct;
  const priceHolding = priceChangePct != null && priceChangePct >= -noisePct;
  if (priceSignal) watchScore += priceChangePct >= noisePct * 2 ? 24 : 19;
  else if (priceHolding) watchScore += 8;
  else reasons.push('price_not_improving');

  const volumeGrowing = obs.volume != null && previous.volume != null && obs.volume > previous.volume;
  // Raw daily RVOL is naturally small near the open. Use session-adjusted pace and
  // interval acceleration so early momentum is not missed merely because the day
  // is incomplete.
  const relativeVolumeStrong = (relativeVolumePace != null && relativeVolumePace >= 1.0)
    || (intervalVolumePace != null && intervalVolumePace >= 1.0)
    || (obs.relative_volume != null && obs.relative_volume >= 1.05);
  const bestVolumePace = Math.max(relativeVolumePace == null ? -Infinity : relativeVolumePace, intervalVolumePace == null ? -Infinity : intervalVolumePace);
  if (Number.isFinite(bestVolumePace)) {
    if (bestVolumePace >= 2.0) watchScore += 22;
    else if (bestVolumePace >= 1.4) watchScore += 17;
    else if (bestVolumePace >= 1.0) watchScore += 12;
    else if (bestVolumePace >= 0.75) watchScore += 6;
    else reasons.push('volume_pace_below_0_75');
  } else if (obs.relative_volume != null) {
    if (obs.relative_volume >= 1.5) watchScore += 22;
    else if (obs.relative_volume >= 1.2) watchScore += 17;
    else if (obs.relative_volume >= 1.05) watchScore += 11;
    else reasons.push('relative_volume_pace_unavailable');
  } else reasons.push('relative_volume_missing');
  if (volumeGrowing) {
    if (volumeGrowthPct != null && volumeGrowthPct >= 5) watchScore += 13;
    else watchScore += 7;
  } else reasons.push('volume_not_growing');

  const insideEntry = obs.current_price != null && obs.entry_low != null && obs.entry_high != null && obs.current_price >= obs.entry_low && obs.current_price <= obs.entry_high;
  const controlledBreakout = entryOvershootPct != null && entryOvershootPct > 0 && entryOvershootPct <= chaseTolerancePct;
  if (insideEntry) watchScore += 12;
  else if (controlledBreakout) watchScore += 9;
  else if (obs.current_price != null && obs.entry_low != null && obs.current_price < obs.entry_low) reasons.push('below_entry_zone');

  if (rrToTp1 != null) {
    if (rrToTp1 >= 1.5) watchScore += 11;
    else if (rrToTp1 >= 1) watchScore += 7;
    else if (rrToTp1 >= 0.8) watchScore += 2;
  }
  if ((finite(obs.momentum_component) || 0) > 0) watchScore += Math.min(6, Math.max(0, finite(obs.momentum_component) / 3));
  if ((finite(obs.liquidity_component) || 0) > 0) watchScore += Math.min(5, Math.max(0, finite(obs.liquidity_component) / 4));

  watchScore = round2(Math.min(100, watchScore));
  const strongEngineContext = READY_STATUSES.has(status) || status === 'PRE_SPIKE_WATCH' || status === 'MOMENTUM_CONTINUATION';
  const momentumTrigger = priceSignal || strongEngineContext;
  const volumeTrigger = relativeVolumeStrong && volumeGrowing;
  const passes = hardReasons.length === 0 && watchScore >= 58 && momentumTrigger && volumeTrigger && (insideEntry || controlledBreakout);
  const publishReady = passes && watchScore >= 65 && rrToTp1 != null && rrToTp1 >= 1;

  return {
    passes,
    publish_ready: publishReady,
    status: hardReasons.length ? 'HARD_REJECT' : (passes ? 'MOMENTUM_PASS' : 'WATCHING'),
    hard_reasons: [...new Set(hardReasons)].sort(),
    reasons: [...new Set(reasons)].sort(),
    watch_score: watchScore,
    metrics: {
      current_price: obs.current_price,
      previous_price: previous.current_price,
      price_change_pct: round2(priceChangePct),
      advance_from_first_pct: round2(advanceFromFirstPct),
      volume: obs.volume,
      previous_volume: previous.volume,
      volume_growth_pct: round2(volumeGrowthPct),
      relative_volume: obs.relative_volume,
      relative_volume_pace: round2(relativeVolumePace),
      interval_volume_pace: round2(intervalVolumePace),
      elapsed_session_fraction: round2(elapsedFraction),
      interval_minutes: intervalMinutes,
      atr_pct: round2(atrPct),
      noise_pct: round2(noisePct),
      entry_overshoot_pct: round2(entryOvershootPct),
      chase_tolerance_pct: round2(chaseTolerancePct),
      rr_to_tp1: round2(rrToTp1),
      inside_entry: insideEntry,
      controlled_breakout: controlledBreakout,
      engine_status: status
    },
    observation: obs
  };
}

module.exports = {
  normalizeObservation, percentChange, SESSION_MINUTES,
  tradingElapsedMinutes, evaluateMomentum
};

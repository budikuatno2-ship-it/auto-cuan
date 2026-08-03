'use strict';

const volumePace = require('./intraday-volume-pace');

const READY_VALUES = new Set([
  'READY', 'ENTRY_READY', 'QUALIFIED', 'SENDABLE', 'CONFIRMED',
  'A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT'
]);
const NEAR_MISS_VALUES = new Set([
  'EARLY_RADAR', 'PRE_SPIKE_WATCH', 'WAIT_PULLBACK', 'MOMENTUM_CONTINUATION',
  'RECLAIM_CANDIDATE', 'WATCHING', 'WAIT'
]);
const HARD_REJECT_VALUES = new Set([
  'BLOCKED', 'REJECTED', 'NO_ACTION', 'INVALID', 'SPECULATIVE', 'AVOID'
]);
const MAX_ADVANCE_PCT = 6;
const MOMENTUM_FLOW_VERSION = 'MOMENTUM_FLOW_PROXY_V1';
const AVERAGE_TRADING_MINUTES = 330;

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round2(value) { return Math.round(value * 100) / 100; }
function toMinutes(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return null;
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}
function observationTime(row) {
  return row && (row.scheduled_time || row.observation_time || row.wib_time || row.time) || null;
}
function explicitReady(obs) {
  if (!obs || typeof obs !== 'object') return { value: null, source: null, status: null };
  if (obs.production_eligible === true) return { value: true, source: 'production_eligible', status: 'PRODUCTION_ELIGIBLE' };
  if (obs.production_eligible === false) return { value: false, source: 'production_eligible', status: 'NOT_READY' };
  if (obs.ready === true) return { value: true, source: 'ready', status: 'READY' };
  if (obs.ready === false) return { value: false, source: 'ready', status: 'NOT_READY' };
  for (const field of ['production_status', 'eligibility_status', 'signal_status', 'decision', 'current_status', 'status', 'source_status']) {
    const status = String(obs[field] || '').trim().toUpperCase();
    if (READY_VALUES.has(status)) return { value: true, source: field, status };
    if (NEAR_MISS_VALUES.has(status) || HARD_REJECT_VALUES.has(status) || status === 'NOT_READY') {
      return { value: false, source: field, status };
    }
  }
  return { value: null, source: null, status: null };
}
function classifyEngine(ready) {
  if (ready.value === true) return 'ready';
  if (NEAR_MISS_VALUES.has(ready.status)) return 'near_miss';
  if (HARD_REJECT_VALUES.has(ready.status)) return 'hard_reject';
  return ready.value === false ? 'not_ready' : 'unknown';
}
function metricsFrom(obs) {
  const observation = obs && typeof obs === 'object' ? obs : {};
  const structural = observation.structural_context && typeof observation.structural_context === 'object' ? observation.structural_context : {};
  const plan = observation.selected_trade_plan && typeof observation.selected_trade_plan === 'object' ? observation.selected_trade_plan : {};
  const entryLow = finite(observation.entry_low ?? observation.buy_low) ?? finite(plan.entry_zone_low);
  const entryHigh = finite(observation.entry_high ?? observation.buy_high) ?? finite(plan.entry_zone_high);
  const tp1 = finite(observation.tp1 ?? observation.target_1) ?? finite(plan.tp1);
  const stopLoss = finite(observation.stop_loss ?? observation.sl) ?? finite(plan.stop_loss);
  let riskReward = finite(observation.risk_reward ?? observation.rr) ?? finite(plan.rr_to_tp1);
  if (riskReward == null && entryHigh != null && tp1 != null && stopLoss != null && entryHigh > stopLoss) {
    riskReward = round2((tp1 - entryHigh) / (entryHigh - stopLoss));
  }
  const paceRatio = finite(observation.intraday_volume_pace_ratio);
  const effectiveRatio = finite(observation.effective_volume_ratio);
  const legacyRatio = finite(observation.relative_volume ?? observation.volume_ratio_20d);
  const resolvedRatio = paceRatio ?? effectiveRatio ?? legacyRatio;
  const volumeSignalSource = paceRatio != null
    ? 'intraday_volume_pace'
    : effectiveRatio != null
      ? 'effective_volume_ratio'
      : legacyRatio != null ? 'legacy_relative_volume' : 'unavailable';
  return {
    current_price: finite(observation.current_price ?? observation.last_price ?? observation.price),
    entry_low: entryLow,
    entry_high: entryHigh,
    tp1,
    stop_loss: stopLoss,
    open: finite(observation.open ?? observation.open_price),
    high: finite(observation.high ?? observation.high_price),
    low: finite(observation.low ?? observation.low_price),
    volume: finite(observation.volume ?? observation.volume_today),
    average_volume: finite(observation.avg_volume_20d_ex_today ?? observation.average_volume ?? observation.avg_volume_20d),
    relative_volume: resolvedRatio,
    legacy_relative_volume: legacyRatio,
    intraday_volume_pace_ratio: paceRatio,
    volume_pace_vs_20d: finite(observation.volume_pace_vs_20d),
    volume_pace_vs_prev_day: finite(observation.volume_pace_vs_prev_day),
    previous_day_volume: finite(observation.previous_day_volume),
    avg_volume_20d_ex_today: finite(observation.avg_volume_20d_ex_today),
    projected_full_day_volume: finite(observation.projected_full_day_volume),
    session_progress_fraction: finite(observation.session_progress_fraction),
    effective_session_progress: finite(observation.effective_session_progress),
    volume_pace_confidence: String(observation.volume_pace_confidence || '').trim().toUpperCase() || null,
    volume_pace_version: String(observation.volume_pace_version || '').trim() || null,
    volume_signal_source: volumeSignalSource,
    atr14: finite(observation.atr14) ?? finite(structural.atr14),
    score: finite(observation.score ?? observation.daytrade_score),
    momentum_component: finite(observation.momentum_component ?? observation.momentum_score),
    liquidity_component: finite(observation.liquidity_component ?? observation.liquidity_score),
    risk_reward: riskReward,
    minimum_risk_reward: finite(observation.minimum_risk_reward) ?? finite(plan.minimum_rr_to_tp1) ?? 1,
    plan_lock_id: String(observation.plan_lock_id || plan.plan_lock_id || '').trim() || null,
    stale: Boolean(observation.freshness && observation.freshness.is_stale === true) || Boolean(observation.is_stale === true || observation.data_stale === true)
  };
}
function volatilityPct(metrics) {
  if (!metrics.current_price || metrics.current_price <= 0) return 1;
  if (metrics.atr14 && metrics.atr14 > 0) return clamp((metrics.atr14 / metrics.current_price) * 100, 0.35, 6);
  if (metrics.high != null && metrics.low != null && metrics.high >= metrics.low) {
    return clamp(((metrics.high - metrics.low) / metrics.current_price) * 100, 0.35, 6);
  }
  return 1;
}
function interpolate(value, points) {
  if (value == null || !Number.isFinite(value)) return 0;
  if (value <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (value <= current[0]) {
      const ratio = (value - previous[0]) / Math.max(1e-9, current[0] - previous[0]);
      return previous[1] + ratio * (current[1] - previous[1]);
    }
  }
  return points[points.length - 1][1];
}
function momentumFlowProxy(input) {
  const data = input || {};
  const priceVelocity = data.elapsed && data.price_change_pct != null
    ? data.price_change_pct / data.elapsed
    : null;
  const volumeRateVsAverage = data.volume_rate != null && data.average_volume != null && data.average_volume > 0
    ? data.volume_rate / (data.average_volume / AVERAGE_TRADING_MINUTES)
    : null;
  const rangePosition = data.current_price != null && data.high != null && data.low != null && data.high > data.low
    ? clamp((data.current_price - data.low) / (data.high - data.low), 0, 1)
    : null;

  const components = {
    price_velocity: round2(interpolate(priceVelocity, [
      [-0.01, 0], [0, 0], [0.05, 8], [0.15, 16], [0.30, 24], [0.50, 30]
    ])),
    volume_acceleration: round2(interpolate(data.volume_acceleration, [
      [-0.05, 0], [0, 0], [0.05, 6], [0.20, 12], [0.50, 20], [1, 25]
    ])),
    relative_volume: round2(interpolate(data.relative_volume, [
      [0.70, 0], [1, 5], [1.25, 10], [1.50, 14], [2, 18], [3, 20]
    ])),
    volume_rate: round2(interpolate(volumeRateVsAverage, [
      [0.30, 0], [0.75, 3], [1, 5], [2, 9], [4, 13], [6, 15]
    ])),
    range_position: round2(interpolate(rangePosition, [
      [0.45, 0], [0.60, 2], [0.70, 4], [0.80, 7], [0.90, 9], [0.97, 10]
    ]))
  };

  const available = [priceVelocity, data.volume_acceleration, data.relative_volume, volumeRateVsAverage, rangePosition]
    .filter(value => value != null && Number.isFinite(value)).length;
  const score = round2(clamp(Object.values(components).reduce((sum, value) => sum + value, 0), 0, 100));
  const temporalReady = priceVelocity != null && volumeRateVsAverage != null;
  const label = !temporalReady
    ? 'DATA_AWAL'
    : score >= 75 ? 'KUAT' : score >= 60 ? 'MENINGKAT' : score >= 45 ? 'BELUM_MEYAKINKAN' : 'LEMAH';
  const confidence = available >= 4 ? 'HIGH' : available === 3 ? 'MEDIUM' : 'LOW';
  const publishBonus = !temporalReady
    ? 0
    : score >= 85 ? 6 : score >= 75 ? 4 : score >= 60 ? 2 : score < 35 ? -4 : score < 45 ? -2 : 0;

  return {
    version: MOMENTUM_FLOW_VERSION,
    proxy_only: true,
    score,
    label,
    confidence,
    available_components: available,
    publish_bonus: publishBonus,
    price_velocity_pct_per_min: priceVelocity == null ? null : round2(priceVelocity),
    volume_rate_vs_average: volumeRateVsAverage == null ? null : round2(volumeRateVsAverage),
    range_position: rangePosition == null ? null : round2(rangePosition),
    volume_signal_source: data.volume_signal_source || 'unavailable',
    components
  };
}
function scoreObservation(obs, tracker) {
  tracker = tracker || {};
  const ready = explicitReady(obs);
  const engineClass = classifyEngine(ready);
  const metrics = metricsFrom(obs);
  const currentMinute = toMinutes(observationTime(obs));
  const lastMinute = finite(tracker.last_observation_minute);
  const elapsed = currentMinute != null && lastMinute != null ? Math.max(1, currentMinute - lastMinute) : null;
  const lastPrice = finite(tracker.last_price);
  const firstPrice = finite(tracker.first_price);
  const lastVolume = finite(tracker.last_volume);
  const volPct = volatilityPct(metrics);
  const priceChangePct = lastPrice && metrics.current_price ? ((metrics.current_price - lastPrice) / lastPrice) * 100 : null;
  const advancePct = firstPrice && metrics.current_price ? ((metrics.current_price - firstPrice) / firstPrice) * 100 : null;
  const normalizedImpulse = priceChangePct == null ? 0 : priceChangePct / Math.max(0.15, volPct * 0.28);
  const volumeDelta = metrics.volume != null && lastVolume != null ? metrics.volume - lastVolume : null;
  const volumeRate = volumeDelta != null && elapsed ? Math.max(0, volumeDelta) / elapsed : null;
  const previousRate = finite(tracker.last_volume_rate);
  const volumeAcceleration = volumeRate != null && previousRate != null && previousRate > 0 ? (volumeRate - previousRate) / previousRate : null;
  const flow = momentumFlowProxy({
    elapsed,
    price_change_pct: priceChangePct,
    volume_rate: volumeRate,
    volume_acceleration: volumeAcceleration,
    relative_volume: metrics.relative_volume,
    average_volume: metrics.average_volume,
    current_price: metrics.current_price,
    high: metrics.high,
    low: metrics.low,
    volume_signal_source: metrics.volume_signal_source
  });

  let watch = engineClass === 'ready' ? 34 : (engineClass === 'near_miss' ? 14 : (engineClass === 'unknown' ? 4 : 0));
  if (engineClass === 'hard_reject') watch -= 50;
  if (metrics.entry_low != null && metrics.entry_high != null && metrics.entry_low <= metrics.entry_high && metrics.current_price) {
    if (metrics.current_price >= metrics.entry_low && metrics.current_price <= metrics.entry_high) watch += 20;
    else if (metrics.current_price < metrics.entry_low) {
      const below = ((metrics.entry_low - metrics.current_price) / metrics.entry_low) * 100;
      watch += below <= volPct ? 9 : -Math.min(15, below * 2);
    } else {
      const above = ((metrics.current_price - metrics.entry_high) / metrics.entry_high) * 100;
      watch += above <= clamp(volPct * 0.35, 0.25, 1.25) ? 8 : -30;
    }
  }
  if (normalizedImpulse >= 1) watch += 18;
  else if (normalizedImpulse >= 0.45) watch += 12;
  else if (normalizedImpulse >= 0.15) watch += 6;
  else if (normalizedImpulse <= -0.65) watch -= 16;
  else if (normalizedImpulse < -0.2) watch -= 7;

  if (metrics.relative_volume != null) {
    if (metrics.relative_volume >= 2) watch += 18;
    else if (metrics.relative_volume >= 1.35) watch += 13;
    else if (metrics.relative_volume >= 1.05) watch += 7;
    else if (metrics.relative_volume < 0.7) watch -= 8;
  }
  if (volumeAcceleration != null) {
    if (volumeAcceleration >= 0.35) watch += 12;
    else if (volumeAcceleration >= 0.05) watch += 6;
    else if (volumeAcceleration <= -0.45) watch -= 10;
  } else if (volumeDelta != null && volumeDelta > 0) watch += 3;
  if (metrics.momentum_component != null) watch += metrics.momentum_component >= 18 ? 8 : (metrics.momentum_component >= 12 ? 4 : 0);
  if (metrics.liquidity_component != null) watch += metrics.liquidity_component >= 15 ? 5 : (metrics.liquidity_component < 5 ? -6 : 0);
  if (metrics.risk_reward != null) watch += metrics.risk_reward >= 1.8 ? 10 : (metrics.risk_reward >= 1.3 ? 5 : (metrics.risk_reward < 1 ? -15 : 0));
  if (metrics.score != null) watch += clamp((metrics.score - 50) / 5, -5, 8);
  watch = round2(clamp(watch, 0, 100));
  let publish = watch + (engineClass === 'ready' ? 8 : 0) - (engineClass === 'near_miss' ? 4 : 0) - (tracker.in_latest_shortlist === false ? 4 : 0);
  publish += flow.publish_bonus;
  publish = round2(clamp(publish, 0, 100));

  const volumeStrong = metrics.relative_volume == null
    ? volumeAcceleration != null && volumeAcceleration >= 0.05
    : metrics.relative_volume >= 1.05 || (volumeAcceleration != null && volumeAcceleration >= 0.05);
  const inEntry = metrics.current_price != null && metrics.entry_low != null && metrics.entry_high != null && metrics.current_price >= metrics.entry_low && metrics.current_price <= metrics.entry_high;
  const baselineMomentum = lastPrice == null && inEntry && metrics.relative_volume != null && metrics.relative_volume >= 1.25 && metrics.momentum_component != null && metrics.momentum_component >= 12;
  const momentumStrong = baselineMomentum || normalizedImpulse >= 0.25 || (priceChangePct != null && priceChangePct > 0 && volumeAcceleration != null && volumeAcceleration >= 0.2);
  const nearMissThreshold = baselineMomentum ? 62 : 70;
  const nearMissPass = engineClass === 'near_miss' && publish >= nearMissThreshold && momentumStrong && volumeStrong;
  const enginePass = engineClass === 'ready' && publish >= 58;
  return {
    ready, engine_class: engineClass, passes: enginePass || nearMissPass,
    entry_eligible: enginePass || nearMissPass,
    informational_spike: false,
    momentum_strong: momentumStrong, volume_strong: volumeStrong,
    metrics: Object.assign({}, metrics, {
      volatility_pct: round2(volPct), price_change_pct: priceChangePct == null ? null : round2(priceChangePct),
      advance_pct: advancePct == null ? null : round2(advancePct), normalized_impulse: round2(normalizedImpulse),
      volume_delta: volumeDelta, volume_rate: volumeRate == null ? null : round2(volumeRate),
      volume_acceleration: volumeAcceleration == null ? null : round2(volumeAcceleration),
      momentum_flow_version: flow.version,
      momentum_flow_proxy: flow.proxy_only,
      momentum_flow_score: flow.score,
      momentum_flow_label: flow.label,
      momentum_flow_confidence: flow.confidence,
      momentum_flow_available_components: flow.available_components,
      momentum_flow_publish_bonus: flow.publish_bonus,
      momentum_flow_volume_source: flow.volume_signal_source,
      price_velocity_pct_per_min: flow.price_velocity_pct_per_min,
      volume_rate_vs_average: flow.volume_rate_vs_average,
      range_position: flow.range_position,
      momentum_flow_components: flow.components,
      watch_score: watch, publish_score: publish
    })
  };
}
function spikeRadarResult(scored, reason, tracker) {
  const m = scored.metrics;
  const strongRange = m.current_price != null && m.open != null && m.current_price > m.open && m.range_position != null && m.range_position >= 0.7;
  const strongVolume = m.relative_volume != null && m.relative_volume >= 1.35;
  const strongMomentum = scored.momentum_strong || m.momentum_flow_score >= 60 || strongRange;
  if (!strongVolume || !strongMomentum) {
    return Object.assign(scored, { passes: false, entry_eligible: false, informational_spike: false, status: 'BLOCKED_CHASE', reasons: [reason] });
  }
  return Object.assign(scored, {
    passes: false,
    entry_eligible: false,
    informational_spike: true,
    status: tracker && tracker.locked_setup_id ? 'SPIKE_RADAR' : 'BLOCKED_CHASE',
    reasons: [reason, 'spike_detected_informational_only', 'not_entry_eligible_do_not_chase']
  });
}
function evaluate(obs, tracker) {
  const scored = scoreObservation(obs, tracker);
  const m = scored.metrics;
  if (m.current_price == null || m.current_price <= 0) return Object.assign(scored, { passes: false, entry_eligible: false, status: 'INVALID_DATA', reasons: ['invalid_current_price'] });
  if (m.stale) return Object.assign(scored, { passes: false, entry_eligible: false, status: 'STALE', reasons: ['stale'] });
  if (scored.engine_class === 'hard_reject') return Object.assign(scored, { passes: false, entry_eligible: false, status: 'INVALIDATED', reasons: ['engine_hard_reject'] });
  if (m.entry_low == null || m.entry_high == null || m.entry_low > m.entry_high) return Object.assign(scored, { passes: false, entry_eligible: false, status: 'INVALID_DATA', reasons: ['invalid_entry_zone'] });
  if (m.stop_loss != null && m.current_price <= m.stop_loss) return Object.assign(scored, { passes: false, entry_eligible: false, status: 'INVALIDATED', reasons: ['stop_touched'] });
  const highestPriceSinceLock = finite(tracker && tracker.highest_price_since_lock) ?? m.high;
  if (m.tp1 == null || m.current_price >= m.tp1 || (highestPriceSinceLock != null && highestPriceSinceLock >= m.tp1)) {
    return Object.assign(scored, { passes: false, entry_eligible: false, status: 'BLOCKED_CHASE', reasons: [m.tp1 == null ? 'invalid_tp1' : 'tp1_already_reached'] });
  }
  const maxAdvance = clamp(Math.max(2.5, m.volatility_pct * 1.5), 2.5, MAX_ADVANCE_PCT);
  if (m.advance_pct != null && m.advance_pct > maxAdvance) return spikeRadarResult(scored, 'adaptive_advance_chase', tracker);
  const reasons = [];
  if (m.current_price > m.entry_high) {
    const above = ((m.current_price - m.entry_high) / m.entry_high) * 100;
    if (above > clamp(m.volatility_pct * 0.35, 0.25, 1.25)) return spikeRadarResult(scored, 'above_adaptive_entry_tolerance', tracker);
    reasons.push('adaptive_entry_overshoot_tolerated');
  }
  if (m.risk_reward == null) return Object.assign(scored, { passes: false, entry_eligible: false, status: 'WATCHING', reasons: ['missing_risk_reward'] });
  if (m.risk_reward < m.minimum_risk_reward) return Object.assign(scored, { passes: false, entry_eligible: false, status: 'WATCHING', reasons: ['risk_reward_below_minimum'] });
  if (scored.engine_class === 'near_miss' && scored.passes) reasons.push('adaptive_near_miss_momentum');
  if (scored.momentum_strong) reasons.push('relative_price_momentum');
  if (scored.volume_strong) reasons.push('relative_volume_support');
  if (m.volume_signal_source === 'intraday_volume_pace') reasons.push('intraday_volume_pace_support');
  if (m.momentum_flow_score >= 75) reasons.push('momentum_flow_proxy_strong');
  else if (m.momentum_flow_label !== 'DATA_AWAL' && m.momentum_flow_score < 45) reasons.push('momentum_flow_proxy_weak');
  if (!scored.passes) reasons.push(scored.engine_class === 'ready' ? 'publish_score_below_threshold' : 'engine_not_ready');
  return Object.assign(scored, { entry_eligible: scored.passes, status: scored.passes ? 'READY_PASS' : 'WATCHING', reasons: [...new Set(reasons)].sort() });
}

module.exports = {
  READY_VALUES,
  NEAR_MISS_VALUES,
  HARD_REJECT_VALUES,
  MAX_ADVANCE_PCT,
  MOMENTUM_FLOW_VERSION,
  AVERAGE_TRADING_MINUTES,
  finite,
  clamp,
  round2,
  toMinutes,
  explicitReady,
  metricsFrom,
  volatilityPct,
  momentumFlowProxy,
  scoreObservation,
  spikeRadarResult,
  evaluate,
  VOLUME_PACE_VERSION: volumePace.VERSION
};

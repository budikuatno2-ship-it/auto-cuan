'use strict';

const base = require('./daytrade-screener-engine');
const volumePace = require('./intraday-volume-pace');
const lifecycle = require('./reversal-breakout-lifecycle');

const VERSION = 'DAYTRADE_VOLUME_PACE_RECALL_V1';
const ENTRY_READY_STATUSES = new Set(['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT']);
const RADAR_STATUSES = new Set([
  'EARLY_RADAR', 'PRE_SPIKE_WATCH', 'MOMENTUM_CONTINUATION',
  'RECLAIM_CANDIDATE', 'WAIT_PULLBACK', 'SPECULATIVE'
]);
const TERMINAL_ENTRY_STATUSES = new Set([
  'INVALID_BELOW_SL', 'TP1_HIT', 'TP2_HIT'
]);
const BEARISH_CANDLE_PATTERNS = new Set([
  'Shooting Star', 'Gravestone Doji', 'Bearish Engulfing', 'Bearish Marubozu',
  'Distribution candle', 'Rejection candle', 'Failed breakout candle',
  'Evening Star', 'Three Black Crows'
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isSafeStructure(result) {
  if (!result || result.data_quality_valid === false || result.data_quality_needs_revalidation === true) return false;
  if (TERMINAL_ENTRY_STATUSES.has(String(result.entry_status || '').toUpperCase())) return false;
  const current = finite(result.last_price);
  const stop = finite(result.stop_loss);
  const tp1 = finite(result.tp1);
  if (current == null || current <= 0) return false;
  if (stop != null && current <= stop) return false;
  if (tp1 != null && current >= tp1) return false;
  return true;
}

function completedValueBaseline(pace, fallback) {
  const value = finite(pace && pace.avg_value_7d_ex_today);
  return value != null && value > 0 ? value : fallback;
}

function effectiveAnalysis(candles, ticker, sampleDate, scheduledTime) {
  const analysis = base.analyzeDayTrade(candles, ticker);
  if (!analysis) return null;
  const rawRatio = finite(analysis.volume_ratio_20d);
  const pace = volumePace.calculateVolumePace({
    sample_date: sampleDate,
    scheduled_time: scheduledTime,
    volume_today: analysis.volume_today,
    avg_volume_20d: analysis.avg_volume_20d,
    avg_volume_sample_count: Math.min(20, Array.isArray(candles) ? candles.length : 20),
    candles
  });
  const effectiveRatio = finite(pace.intraday_volume_pace_ratio) ?? rawRatio;
  const enriched = Object.assign({}, analysis, pace, {
    raw_volume_ratio_20d: rawRatio,
    effective_volume_ratio: effectiveRatio,
    volume_signal_ratio: effectiveRatio,
    volume_ratio_20d: effectiveRatio,
    avg_volume_20d: finite(pace.avg_volume_20d_ex_today) ?? analysis.avg_volume_20d,
    avg_value_7d: completedValueBaseline(pace, analysis.avg_value_7d),
    volume_signal_source: pace.intraday_volume_pace_ratio != null
      ? 'intraday_volume_pace'
      : 'legacy_volume_ratio_20d'
  });
  return { analysis: enriched, pace, raw_ratio: rawRatio };
}

function adjustedVolumeComponents(result, analysis) {
  const liquidity = base.scoreLiquidity(analysis);
  const prespike = base.scorePreSpike(analysis);
  const momentum = base.scoreMomentum(analysis);
  const penalty = base.calculatePenalty(analysis);
  const oldLiquidity = finite(result.liquidity_score) ?? 0;
  const oldPrespike = finite(result.prespike_score) ?? 0;
  const oldMomentum = finite(result.momentum_score) ?? 0;
  const oldPenalty = finite(result.penalty_score) ?? 0;
  const delta = (liquidity.score - oldLiquidity)
    + (prespike - oldPrespike)
    + (momentum - oldMomentum)
    + (penalty.penalty - oldPenalty);
  return { liquidity, prespike, momentum, penalty, delta };
}

function safeRadarStatus(classification, originalStatus) {
  const status = String(classification && classification.status || '').toUpperCase();
  if (ENTRY_READY_STATUSES.has(status)) return 'EARLY_RADAR';
  if (RADAR_STATUSES.has(status)) return status;
  return originalStatus;
}

function applyVolumePaceRecall(result, candles, context) {
  const row = result && typeof result === 'object' ? result : null;
  if (!row || !Array.isArray(candles) || candles.length < 20) return row;
  const sampleDate = context.sampleDate;
  const scheduledTime = context.scheduledTime;
  const effective = effectiveAnalysis(candles, row.ticker, sampleDate, scheduledTime);
  if (!effective) return row;

  const output = Object.assign({}, row, effective.pace, {
    daytrade_volume_pace_version: VERSION,
    raw_volume_ratio_20d: effective.raw_ratio,
    effective_volume_ratio: effective.analysis.effective_volume_ratio,
    volume_signal_ratio: effective.analysis.volume_signal_ratio,
    volume_signal_source: effective.analysis.volume_signal_source
  });

  if (effective.pace.intraday_volume_pace_ratio == null || !isSafeStructure(row)) {
    output.volume_pace_recall_applied = false;
    output.volume_pace_recall_reason = effective.pace.volume_pace_unavailable_reason || 'safety_structure_blocked';
    return output;
  }

  const components = adjustedVolumeComponents(row, effective.analysis);
  const originalScore = finite(row.daytrade_score) ?? 0;
  const adjustedScore = clamp(originalScore + components.delta, 0, 100);
  const levels = base.calculateLevels(effective.analysis);
  const candleDowngrade = (finite(row.candle_score) ?? 0) < 0 || BEARISH_CANDLE_PATTERNS.has(String(row.candle_pattern || ''));
  const classification = base.classifyStatus(
    adjustedScore,
    effective.analysis,
    levels,
    components.liquidity,
    components.penalty,
    row.board,
    context.runMode,
    candleDowngrade
  );

  const originalStatus = String(row.status || '').toUpperCase();
  const originalReady = ENTRY_READY_STATUSES.has(originalStatus);
  const radarStatus = originalReady ? originalStatus : safeRadarStatus(classification, originalStatus);
  const recallScore = originalReady ? originalScore : Math.min(adjustedScore, 74);
  const promoted = !originalReady && radarStatus !== originalStatus;
  const scoreChanged = recallScore !== originalScore;

  output.daytrade_score = recallScore;
  output.liquidity_score = components.liquidity.score;
  output.prespike_score = components.prespike;
  output.momentum_score = components.momentum;
  output.penalty_score = components.penalty.penalty;
  output.status = radarStatus;
  output.volume_pace_recall_applied = promoted || scoreChanged;
  output.volume_pace_recall_score_delta = recallScore - originalScore;
  output.volume_pace_recomputed_status = classification.status;
  output.volume_ratio_20d = effective.analysis.effective_volume_ratio;

  if (promoted) {
    output.setup = radarStatus === 'WAIT_PULLBACK'
      ? 'Volume Pace — Wait / Jangan Chase'
      : 'Volume Pace — Radar Intraday';
    output.notes = `Volume pace ${effective.analysis.effective_volume_ratio.toFixed(2)}x terdeteksi. `
      + 'Status hanya dinaikkan ke radar/watchlist, bukan sinyal beli. '
      + String(row.notes || '');
    output.entry_timing = radarStatus === 'WAIT_PULLBACK'
      ? 'Spike terdeteksi — bukan sinyal beli. Jangan chase.'
      : 'Radar volume pace — tunggu konfirmasi harga dan entry area.';
  }
  return output;
}

async function runDayTradeBatch(tickers, runMode, options) {
  const opts = Object.assign({}, options || {});
  const captured = new Map();
  const sourceFetch = opts.fetchCandles || base.fetchDayTradeCandles;
  opts.fetchCandles = async function fetchAndCapture(ticker, item) {
    const candles = await sourceFetch(ticker, item);
    if (Array.isArray(candles)) captured.set(ticker, candles);
    return candles;
  };
  const result = await base.runDayTradeBatch(tickers, runMode, opts);
  const sampleDate = opts.sampleDate || base.getWibDateStr();
  const scheduledTime = opts.scheduledTime || String(base.getWibTimeStr() || '').slice(0, 5);
  return Object.assign({}, result, {
    results: (result.results || []).map(row => {
      const recalled = applyVolumePaceRecall(row, captured.get(row.ticker), {
        sampleDate,
        scheduledTime,
        runMode
      });
      return lifecycle.applyLifecycle(recalled, { mode: 'daytrade' });
    }),
    volume_pace_version: volumePace.VERSION,
    volume_pace_recall_version: VERSION,
    lifecycle_version: lifecycle.VERSION
  });
}

module.exports = Object.assign({}, base, {
  VERSION,
  ENTRY_READY_STATUSES,
  RADAR_STATUSES,
  effectiveAnalysis,
  adjustedVolumeComponents,
  applyVolumePaceRecall,
  runDayTradeBatch
});
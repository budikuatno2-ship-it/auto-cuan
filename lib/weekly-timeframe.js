'use strict';

const classicChartPatterns = require('./classic-chart-patterns');

const MAX_SWING_CLASSIC_PATTERN_BONUS = 2;
const MIN_SWING_CLASSIC_PATTERN_PENALTY = -4;
const SWING_CLASSIC_PATTERN_SCORE_VERSION = 'swing-classic-pattern-score-v1';

function toNum(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getDateKey(c) {
  return c && (c.date || c.datetime || c.timestamp || c.time || c.t);
}

function weekKey(dateValue) {
  var d = new Date(dateValue);
  if (isNaN(d.getTime())) return null;
  var day = d.getUTCDay();
  var diffToMonday = (day + 6) % 7;
  var monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday));
  return monday.toISOString().slice(0, 10);
}

function resampleDailyToWeekly(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  var sorted = candles.slice().filter(function(c) {
    return c && getDateKey(c) && toNum(c.open) != null && toNum(c.high) != null && toNum(c.low) != null && toNum(c.close) != null;
  }).sort(function(a, b) { return new Date(getDateKey(a)).getTime() - new Date(getDateKey(b)).getTime(); });

  var weeks = [];
  var current = null;
  for (var i = 0; i < sorted.length; i++) {
    var c = sorted[i];
    var key = weekKey(getDateKey(c));
    if (!key) continue;
    var high = toNum(c.high);
    var low = toNum(c.low);
    var volume = toNum(c.volume) || 0;
    if (!current || current.week_start !== key) {
      if (current) weeks.push(current);
      current = {
        week_start: key,
        open: toNum(c.open),
        high: high,
        low: low,
        close: toNum(c.close),
        volume: volume
      };
    } else {
      current.high = Math.max(current.high, high);
      current.low = Math.min(current.low, low);
      current.close = toNum(c.close);
      current.volume += volume;
    }
  }
  if (current) weeks.push(current);
  return weeks;
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  var slice = values.slice(-period);
  return slice.reduce(function(a, b) { return a + b; }, 0) / period;
}

function deriveSwingClassicPatternAdjustment(patternResult, weeklyLabel) {
  var result = patternResult || {};
  var primary = result.primary_pattern || (Array.isArray(result.patterns) ? result.patterns[0] : null);
  if (!primary) return 0;
  var raw = toNum(primary.score_adjustment);
  if (raw == null) raw = toNum(result.score_adjustment) || 0;
  var bias = String(primary.bias || '').toLowerCase();

  // Bullish chart context may strengthen ranking only when the weekly frame is
  // not explicitly weak. Bearish context remains a conservative downgrade.
  if (bias === 'bullish') {
    if (weeklyLabel === 'WEEKLY_WEAK') return 0;
    return Math.max(0, Math.min(MAX_SWING_CLASSIC_PATTERN_BONUS, raw));
  }
  if (bias === 'bearish') {
    return Math.max(MIN_SWING_CLASSIC_PATTERN_PENALTY, Math.min(0, raw));
  }
  return 0;
}

function evaluateWeeklyTimeframe(candles) {
  var daily = Array.isArray(candles) ? candles : [];
  var weekly = resampleDailyToWeekly(daily);
  var classic = classicChartPatterns.detectClassicChartPatterns(daily.slice(0, -1), { timeframe: '1D_T_MINUS_1' });

  if (weekly.length < 10) {
    var unknownPatternAdjustment = deriveSwingClassicPatternAdjustment(classic, 'WEEKLY_UNKNOWN');
    return {
      weekly_tf_label: 'WEEKLY_UNKNOWN',
      weekly_tf_score_adjustment: 0,
      weekly_tf_notes: 'Data weekly belum cukup untuk MA10.',
      weekly_close: weekly.length ? weekly[weekly.length - 1].close : null,
      weekly_ma10: null,
      weekly_candles: weekly,
      classic_chart_patterns: classic.patterns || [],
      primary_classic_pattern: classic.primary_pattern || null,
      classic_pattern_score_adjustment: unknownPatternAdjustment,
      classic_pattern_rule_version: classic.rule_version || classicChartPatterns.VERSION,
      classic_pattern_score_version: SWING_CLASSIC_PATTERN_SCORE_VERSION
    };
  }
  var closes = weekly.map(function(w) { return w.close; });
  var ma10 = sma(closes, 10);
  var last = weekly[weekly.length - 1];
  var prev = weekly[weekly.length - 2] || null;
  var lowerLow = !!(prev && last.low < prev.low);
  var higherHigh = !!(prev && last.high > prev.high);
  var higherLow = !!(prev && last.low >= prev.low);

  var label = 'WEEKLY_NEUTRAL';
  var notes = [];
  if (ma10 != null && last.close < ma10) {
    label = 'WEEKLY_WEAK';
    notes.push('Weekly close di bawah MA10.');
  } else if (lowerLow) {
    label = 'WEEKLY_WEAK';
    notes.push('Weekly membentuk lower-low.');
  } else if (ma10 != null && last.close > ma10 && !lowerLow) {
    label = higherHigh || higherLow ? 'WEEKLY_SUPPORT' : 'WEEKLY_NEUTRAL';
    notes.push(label === 'WEEKLY_SUPPORT' ? 'Weekly close di atas MA10 dan struktur tidak lemah.' : 'Weekly di atas MA10, struktur belum kuat.');
  }

  var adj = label === 'WEEKLY_SUPPORT' ? 3 : (label === 'WEEKLY_WEAK' ? -4 : 0);
  var classicAdjustment = deriveSwingClassicPatternAdjustment(classic, label);
  if (classic.primary_pattern && classicAdjustment !== 0) {
    notes.push('Pattern T-1 ' + classic.primary_pattern.label + ' memberi penyesuaian ranking ' + (classicAdjustment > 0 ? '+' : '') + classicAdjustment + '.');
  }
  return {
    weekly_tf_label: label,
    weekly_tf_score_adjustment: adj,
    weekly_tf_notes: notes.join(' '),
    weekly_close: Number(last.close.toFixed(4)),
    weekly_ma10: ma10 == null ? null : Number(ma10.toFixed(4)),
    weekly_higher_high: higherHigh,
    weekly_higher_low: higherLow,
    weekly_lower_low: lowerLow,
    weekly_candles: weekly,
    classic_chart_patterns: classic.patterns || [],
    primary_classic_pattern: classic.primary_pattern || null,
    classic_pattern_score_adjustment: classicAdjustment,
    classic_pattern_rule_version: classic.rule_version || classicChartPatterns.VERSION,
    classic_pattern_score_version: SWING_CLASSIC_PATTERN_SCORE_VERSION
  };
}

function applyWeeklyTimeframeScore(score, weeklyContext) {
  var base = toNum(score);
  if (base == null) base = 0;
  var weeklyAdj = weeklyContext && toNum(weeklyContext.weekly_tf_score_adjustment) != null ? Number(weeklyContext.weekly_tf_score_adjustment) : 0;
  var patternAdj = weeklyContext && toNum(weeklyContext.classic_pattern_score_adjustment) != null ? Number(weeklyContext.classic_pattern_score_adjustment) : 0;
  return Math.max(0, Math.min(100, base + weeklyAdj + patternAdj));
}

module.exports = {
  MAX_SWING_CLASSIC_PATTERN_BONUS: MAX_SWING_CLASSIC_PATTERN_BONUS,
  MIN_SWING_CLASSIC_PATTERN_PENALTY: MIN_SWING_CLASSIC_PATTERN_PENALTY,
  SWING_CLASSIC_PATTERN_SCORE_VERSION: SWING_CLASSIC_PATTERN_SCORE_VERSION,
  resampleDailyToWeekly: resampleDailyToWeekly,
  deriveSwingClassicPatternAdjustment: deriveSwingClassicPatternAdjustment,
  evaluateWeeklyTimeframe: evaluateWeeklyTimeframe,
  applyWeeklyTimeframeScore: applyWeeklyTimeframeScore
};

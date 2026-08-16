'use strict';

// Deterministic technical context. Pattern evidence may provide a small,
// bounded Swing ranking adjustment, but never changes action/status/safety.
const classicChartPatterns = require('./classic-chart-patterns');
const lifecycle = require('./reversal-breakout-lifecycle');

const MAX_SETUP_SCORE_BONUS = 3;
const MAX_SWING_PATTERN_SCORE_ADJUSTMENT = 5;
const MIN_SWING_PATTERN_SCORE_ADJUSTMENT = -4;
const SWING_PATTERN_SCORE_VERSION = 'swing-pattern-score-v1';
const SETUPS = {
  VCP: { label: 'VCP Setup', bonus: 2 },
  STAGE_2_TREND: { label: 'Trend Template', bonus: 2 },
  SMART_MONEY: { label: 'Smart Money Before Rally', bonus: 2 },
  UPTREND_PULLBACK: { label: 'Uptrend Pullback', bonus: 2 },
  BULLISH_HARAMI_PLUS: { label: 'Bullish Harami+', bonus: 2 }
};

function n(value) { value = Number(value); return Number.isFinite(value) ? value : null; }
function average(values) { return values.length ? values.reduce(function(a, b) { return a + b; }, 0) / values.length : null; }
function ma(values, period) { return values.length >= period ? average(values.slice(-period)) : null; }
function pctDistance(a, b) { return a && b ? Math.abs(a - b) / b : null; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function text(row) { return Object.keys(row || {}).map(function(k) { return String(row[k] == null ? '' : row[k]); }).join(' ').toLowerCase(); }
const STRUCTURED_ACTION_STATUS_FIELDS = [
  'action', 'action_label', 'signal_action', 'signal_action_label', 'telegram_action_label',
  'status', 'final_status', 'display_status', 'public_status', 'signal_status'
];

const CLASSIC_LABEL_ALLOWLIST = new Set([
  'Ascending Triangle', 'Descending Triangle', 'Symmetrical Triangle',
  'Bull Flag', 'Bear Flag', 'Bull Pennant', 'Bear Pennant',
  'Cup and Handle', 'Inverted Cup and Handle',
  'Rising Wedge', 'Falling Wedge',
  'Head and Shoulders', 'Inverse Head and Shoulders',
  'Double Top', 'Double Bottom', 'Gap Up', 'Gap Down'
]);

function hasStructuredSell(row) {
  return STRUCTURED_ACTION_STATUS_FIELDS.some(function(field) { return /\bSELL\b/i.test(String((row || {})[field] || '')); });
}

function isSafetyBlocked(candidate) {
  var row = candidate || {};
  var combined = text(row);
  var status = String(row.status || row.final_status || row.display_status || '').toUpperCase();
  return row.corporate_action_guard === 'BLOCKED' ||
    /\b(avoid|hindari|low_tp|very high risk|stale_level|needs_revalidation|history_insufficient|new_listing)\b/i.test(combined) ||
    /AVOID|HINDARI|LOW_TP|STALE_LEVEL|NEEDS_REVALIDATION|HISTORY_INSUFFICIENT|NEW_LISTING/.test(status) ||
    hasStructuredSell(row);
}

function boardDiagnostic(candidate) {
  var board = String((candidate || {}).board || (candidate || {}).board_status || (candidate || {}).trading_status || '').trim();
  if (!board) return { blocked: false, diagnostic: 'board_status_missing' };
  if (/\b(FCA|SUSPEN|SPECIAL\s*WATCH|WATCHLIST|PROBLEM)/i.test(board)) return { blocked: true, diagnostic: 'board_or_status_blocked:' + board };
  return { blocked: false, diagnostic: 'board_status_ok:' + board };
}

function candleValues(candles) {
  var clean = (Array.isArray(candles) ? candles : []).filter(function(c) {
    return c && n(c.open) != null && n(c.high) != null && n(c.low) != null && n(c.close) != null;
  });
  return {
    candles: clean, closes: clean.map(function(c) { return n(c.close); }),
    volumes: clean.map(function(c) { return Math.max(0, n(c.volume) || 0); })
  };
}

function resolveCandles(candidate, context, explicitCandles) {
  if (Array.isArray(explicitCandles)) return explicitCandles;
  if (context && Array.isArray(context.candles)) return context.candles;
  var row = candidate || {};
  var keys = ['candles', 'daily_candles', 'ohlcv', 'price_history'];
  for (var i = 0; i < keys.length; i += 1) if (Array.isArray(row[keys[i]])) return row[keys[i]];
  return [];
}

function normalizedOfficialPattern(value) {
  if (value && typeof value === 'object') value = value.pattern_label || value.setup_label || value.label || value.name || value.pattern;
  value = String(value == null ? '' : value).trim();
  return CLASSIC_LABEL_ALLOWLIST.has(value) ? value : null;
}

function classicPatternsFromCandidate(row) {
  var patterns = [];
  var containers = [row || {}];
  if (row && row.raw_payload && typeof row.raw_payload === 'object') containers.push(row.raw_payload);
  containers.forEach(function(container) {
    var arrays = [container.classic_chart_patterns, container.classicPatterns, container.chart_patterns];
    arrays.forEach(function(values) {
      (Array.isArray(values) ? values : []).forEach(function(value) {
        var label = normalizedOfficialPattern(value);
        if (!label || patterns.some(function(pattern) { return pattern.label === label; })) return;
        var source = value && typeof value === 'object' ? value : {};
        patterns.push({
          type: String(source.type || label).toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
          label: label,
          bias: source.bias || 'Context',
          confidence: n(source.confidence) || 0.65,
          score_adjustment: n(source.score_adjustment) || 0,
          status: source.status || 'candidate',
          reason: source.reason || 'Pattern resmi dari screener.'
        });
      });
    });
    [container.pattern_label, container.candle_pattern, container.candle_pattern_label].forEach(function(value) {
      var label = normalizedOfficialPattern(value);
      if (label && !patterns.some(function(pattern) { return pattern.label === label; })) {
        patterns.push({ type:label.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), label:label, bias:'Context', confidence:0.65, score_adjustment:0, status:'candidate', reason:'Pattern resmi dari screener.' });
      }
    });
  });
  return patterns;
}

function detectSmartSetupLabels(candidate, candles, options) {
  var row = candidate || {}, resolvedCandles = resolveCandles(row, options, candles), values = candleValues(resolvedCandles), cs = values.candles;
  var price = n(row.last_price) || n(row.latest_price) || n(row.current_price) || n(row.price) || (values.closes.length ? values.closes[values.closes.length - 1] : null);
  var ma20 = n(row.ma20) || ma(values.closes, 20), ma50 = n(row.ma50) || ma(values.closes, 50);
  var ma60 = n(row.ma60) || ma(values.closes, 60), ma150 = n(row.ma150) || ma(values.closes, 150), ma200 = n(row.ma200) || ma(values.closes, 200);
  var rsi = n(row.rsi14) || n(row.rsi), vol20 = n(row.avg_volume_20d) || n(row.avg_volume) || ma(values.volumes, 20);
  var last = cs[cs.length - 1], prev = cs[cs.length - 2], labels = [], diagnostics = [];
  var liquidity = n(row.avg_tx_value_7d) || n(row.avg_transaction_value) || n(row.avg_value_20d);
  var adequateLiquidity = liquidity == null ? true : liquidity >= 100000000;
  var near20 = pctDistance(price, ma20) != null && pctDistance(price, ma20) <= 0.04;
  var trendUp = !!(price && ma20 && ma50 && price >= ma50 && ma20 >= ma50);
  var neutralRsi = rsi == null || (rsi >= 42 && rsi <= 68);
  var add = function(type, reason) { labels.push({ setup_label: SETUPS[type].label, setup_type: type, setup_reason: reason, setup_score_bonus: SETUPS[type].bonus }); };

  if (price == null) diagnostics.push('price_missing');
  if (!cs.length) diagnostics.push('candles_missing_or_invalid');
  if (!adequateLiquidity) diagnostics.push('liquidity_inadequate');
  if (price && ma20 && ma60 && near20 && ma20 > ma60 && neutralRsi && adequateLiquidity && cs.length >= 20) {
    var recentRanges = cs.slice(-5).map(function(c) { return (n(c.high) - n(c.low)) / n(c.close); });
    var priorRanges = cs.slice(-15, -5).map(function(c) { return (n(c.high) - n(c.low)) / n(c.close); });
    var dryVolume = vol20 && last && n(last.volume) <= vol20 * 0.9;
    if (average(recentRanges) < average(priorRanges) * 0.85 && dryVolume) add('VCP', 'Range contracts near MA20 with drying volume in an uptrend.');
  }
  if (price && ma50 && ma150 && ma200 && price > ma50 && ma50 > ma150 && ma150 > ma200 && (!values.closes.length || ma(values.closes.slice(0, -20), 200) == null || ma200 >= ma(values.closes.slice(0, -20), 200))) add('STAGE_2_TREND', 'Price and long moving averages are positively aligned.');
  if (last && price && ma20 && vol20 && n(last.volume) >= vol20 * 1.5 && price >= ma20 && neutralRsi && !(row.volume_phase === 'DISTRIBUTION_RISK' || row.is_distribution === true)) add('SMART_MONEY', 'Strong-volume reclaim closes at or above the short trend level.');
  if (trendUp && near20 && neutralRsi && adequateLiquidity && n(row.risk_reward) != null && n(row.risk_reward) >= 1.2) add('UPTREND_PULLBACK', 'Healthy pullback is holding near MA20 within a positive trend.');
  if (last && prev && n(prev.close) < n(prev.open) && n(last.close) > n(last.open) && n(last.open) >= n(prev.close) && n(last.open) <= n(prev.open) && n(last.close) <= n(prev.open) && neutralRsi && (!vol20 || n(last.volume) >= vol20 * 0.8)) add('BULLISH_HARAMI_PLUS', 'Bullish inside-body reversal has non-weak volume confirmation.');

  var classic = cs.length >= 20 ? classicChartPatterns.detectClassicChartPatterns(cs, { ticker:row.ticker }) : { patterns:classicPatternsFromCandidate(row), primary_pattern:null, score_adjustment:0, diagnostics:[] };
  if (!classic.patterns.length) classic.patterns = classicPatternsFromCandidate(row);
  if (!classic.primary_pattern && classic.patterns.length) classic.primary_pattern = classic.patterns[0];
  if (!classic.score_adjustment && classic.patterns.length) {
    classic.score_adjustment = classic.patterns.reduce(function(best, pattern) {
      var adjustment = n(pattern.score_adjustment) || 0;
      return Math.abs(adjustment) > Math.abs(best) ? adjustment : best;
    }, 0);
  }

  return {
    smart_setup_labels: labels,
    primary_smart_setup: labels[0] || null,
    smart_setup_score_bonus: Math.min(MAX_SETUP_SCORE_BONUS, labels.reduce(function(total, item) { return total + item.setup_score_bonus; }, 0)),
    smart_setup_reason: labels.length ? labels[0].setup_reason : null,
    smart_setup_diagnostics: diagnostics.concat(classic.diagnostics || []),
    classic_chart_patterns: classic.patterns || [],
    primary_classic_pattern: classic.primary_pattern || null,
    classic_pattern_score_adjustment: clamp(n(classic.score_adjustment) || 0, MIN_SWING_PATTERN_SCORE_ADJUSTMENT, 4),
    classic_pattern_rule_version: classic.rule_version || classicChartPatterns.VERSION
  };
}

function isSwingCandidate(row, context) {
  if (context && String(context.mode || '').toLowerCase() === 'swing') return true;
  var category = String((row || {}).category || (row || {}).screener_type || '').toLowerCase();
  return !!((row || {}).swing_tier || (row || {}).tradeability || category.indexOf('swing') >= 0);
}

function applySwingPatternScore(row, context, blocked) {
  if (!row || !isSwingCandidate(row, context)) return row;
  if (row.swing_pattern_score_version === SWING_PATTERN_SCORE_VERSION) return row;
  var baseScore = n(row.score);
  if (baseScore == null) return row;
  var adjustment = blocked ? 0 : (n(row.smart_setup_score_bonus) || 0) + (n(row.classic_pattern_score_adjustment) || 0);
  adjustment = clamp(adjustment, MIN_SWING_PATTERN_SCORE_ADJUSTMENT, MAX_SWING_PATTERN_SCORE_ADJUSTMENT);
  row.score_before_pattern_adjustment = baseScore;
  row.swing_pattern_score_adjustment = adjustment;
  row.swing_pattern_adjusted_score = clamp(baseScore + adjustment, 0, 100);
  row.swing_pattern_score_version = SWING_PATTERN_SCORE_VERSION;
  row.swing_pattern_score_applied = adjustment !== 0;
  // Read/runtime ranking only. Persisted actions, statuses and safety decisions stay unchanged.
  row.score = row.swing_pattern_adjusted_score;
  return row;
}

function applySmartSetupLabels(candidate, context) {
  var row = candidate || {}, result = detectSmartSetupLabels(row, context && context.candles, context);
  var price = n(row.last_price) || n(row.latest_price) || n(row.current_price) || n(row.price);
  var board = boardDiagnostic(row), blocked = isSafetyBlocked(row) || board.blocked;
  result.smart_setup_diagnostics.push(board.diagnostic);
  if (price != null && price < 50) { blocked = true; result.smart_setup_diagnostics.push('price_below_50_downgraded'); }
  if (price != null && price >= 50 && price <= 55) {
    result.smart_setup_diagnostics.push('price_near_50_requires_stronger_liquidity_confirmation');
    var near50Liquidity = n(row.avg_tx_value_7d) || n(row.avg_transaction_value) || n(row.avg_value_20d);
    if (near50Liquidity == null || near50Liquidity < 500000000) { blocked = true; result.smart_setup_diagnostics.push('price_near_50_liquidity_not_confirmed'); }
  }
  row.smart_setup_labels = result.smart_setup_labels;
  row.primary_smart_setup = result.primary_smart_setup;
  if (!row.setup_label) row.setup_label = result.primary_smart_setup && result.primary_smart_setup.setup_label || null;
  if (!row.setup_type) row.setup_type = result.primary_smart_setup && result.primary_smart_setup.setup_type || (result.primary_classic_pattern && result.primary_classic_pattern.type) || null;
  row.setup_reason = row.setup_reason || result.smart_setup_reason || (result.primary_classic_pattern && result.primary_classic_pattern.reason) || null;
  row.smart_setup_reason = result.smart_setup_reason;
  row.smart_setup_diagnostics = result.smart_setup_diagnostics;
  row.smart_setup_score_bonus = blocked ? 0 : result.smart_setup_score_bonus;
  row.smart_setup_actionable = !blocked;
  row.classic_chart_patterns = result.classic_chart_patterns;
  row.primary_classic_pattern = result.primary_classic_pattern;
  row.classic_pattern_score_adjustment = blocked ? 0 : result.classic_pattern_score_adjustment;
  row.classic_pattern_rule_version = result.classic_pattern_rule_version;
  if (blocked) row.smart_setup_diagnostics.push('setup_bonus_suppressed_by_safety_gate');
  applySwingPatternScore(row, context, blocked);
  lifecycle.applyLifecycle(row, { mode: isSwingCandidate(row, context) ? 'swing' : 'daytrade', blocked: blocked });
  return row;
}

module.exports = {
  MAX_SETUP_SCORE_BONUS: MAX_SETUP_SCORE_BONUS,
  MAX_SWING_PATTERN_SCORE_ADJUSTMENT: MAX_SWING_PATTERN_SCORE_ADJUSTMENT,
  MIN_SWING_PATTERN_SCORE_ADJUSTMENT: MIN_SWING_PATTERN_SCORE_ADJUSTMENT,
  SWING_PATTERN_SCORE_VERSION: SWING_PATTERN_SCORE_VERSION,
  detectSmartSetupLabels: detectSmartSetupLabels,
  applySmartSetupLabels: applySmartSetupLabels,
  applySwingPatternScore: applySwingPatternScore,
  isSafetyBlocked: isSafetyBlocked,
  normalizedOfficialPattern: normalizedOfficialPattern
};
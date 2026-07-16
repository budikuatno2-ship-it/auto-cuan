'use strict';

// Deterministic, display-only technical context.  This module never changes an
// action, status, safety gate, or the candidate's base screener score.
const MAX_SETUP_SCORE_BONUS = 3;
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
function text(row) { return Object.keys(row || {}).map(function(k) { return String(row[k] == null ? '' : row[k]); }).join(' ').toLowerCase(); }

function isSafetyBlocked(candidate) {
  var row = candidate || {};
  var combined = text(row);
  var status = String(row.status || row.final_status || row.display_status || '').toUpperCase();
  return row.corporate_action_guard === 'BLOCKED' ||
    /\b(avoid|hindari|sell|low_tp|very high risk|stale_level|needs_revalidation|history_insufficient|new_listing)\b/i.test(combined) ||
    /AVOID|HINDARI|SELL|LOW_TP|STALE_LEVEL|NEEDS_REVALIDATION|HISTORY_INSUFFICIENT|NEW_LISTING/.test(status);
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

function detectSmartSetupLabels(candidate, candles, options) {
  var row = candidate || {}, values = candleValues(candles), cs = values.candles;
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

  return { smart_setup_labels: labels, primary_smart_setup: labels[0] || null, smart_setup_score_bonus: Math.min(MAX_SETUP_SCORE_BONUS, labels.reduce(function(total, item) { return total + item.setup_score_bonus; }, 0)), smart_setup_reason: labels.length ? labels[0].setup_reason : null, smart_setup_diagnostics: diagnostics };
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
  row.setup_label = result.primary_smart_setup && result.primary_smart_setup.setup_label || null;
  row.setup_type = result.primary_smart_setup && result.primary_smart_setup.setup_type || null;
  row.setup_reason = result.smart_setup_reason;
  row.smart_setup_reason = result.smart_setup_reason;
  row.smart_setup_diagnostics = result.smart_setup_diagnostics;
  row.smart_setup_score_bonus = blocked ? 0 : result.smart_setup_score_bonus;
  row.smart_setup_actionable = !blocked;
  if (blocked) row.smart_setup_diagnostics.push('setup_bonus_suppressed_by_safety_gate');
  return row;
}

module.exports = { MAX_SETUP_SCORE_BONUS: MAX_SETUP_SCORE_BONUS, detectSmartSetupLabels: detectSmartSetupLabels, applySmartSetupLabels: applySmartSetupLabels, isSafetyBlocked: isSafetyBlocked };

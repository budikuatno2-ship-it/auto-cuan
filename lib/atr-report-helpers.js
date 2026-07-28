/*
 * Pure helper functions for ATR validation reports.
 * No network, Supabase, or filesystem writes are performed here.
 */

'use strict';

const reportHelpers = require('./report-helpers');
const classicChartPatterns = require('./classic-chart-patterns');

const MAX_DAYTRADE_CLASSIC_PATTERN_BONUS = 2;
const MIN_DAYTRADE_CLASSIC_PATTERN_PENALTY = -3;
const DAYTRADE_CLASSIC_PATTERN_SCORE_VERSION = 'daytrade-classic-pattern-score-v1';

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = Math.pow(10, decimals == null ? 2 : decimals);
  return Math.round(value * factor) / factor;
}

function getField(row, names) {
  const raw = (row && row.raw_payload) || {};
  for (const name of names) {
    const direct = toNumber(row && row[name]);
    if (direct !== null) return direct;
    const rawValue = toNumber(raw && raw[name]);
    if (rawValue !== null) return rawValue;
  }
  return null;
}

function normalizePick(row) {
  const raw = (row && row.raw_payload) || {};
  const entry1 = getField(row, ['entry1', 'entry_low', 'entryLow', 'entry', 'entry_price']);
  const entry2 = getField(row, ['entry2', 'entry_high', 'entryHigh']);
  const entryReference = entry1 !== null && entry2 !== null ? round((entry1 + entry2) / 2, 4) : (entry1 !== null ? entry1 : entry2);
  return {
    ticker: String((row && (row.ticker || row.symbol)) || raw.ticker || raw.symbol || '').toUpperCase(),
    source: reportHelpers.getMonitorSource(row) || 'unknown',
    date: (row && row.date) || raw.date || null,
    status: (row && row.status) || raw.status || null,
    outcome: reportHelpers.classifyOutcome(row),
    score: row && row.score !== undefined ? row.score : raw.score,
    entry1,
    entry2,
    entryReference,
    sl: getField(row, ['sl', 'stop_loss', 'stopLoss', 'stoploss']),
    tp1: getField(row, ['tp1', 'tp1n', 'take_profit_1']),
    tp2: getField(row, ['tp2', 'tp2n', 'take_profit_2'])
  };
}

function trueRange(current, previous) {
  if (!current) return null;
  const high = toNumber(current.high);
  const low = toNumber(current.low);
  const prevClose = previous ? toNumber(previous.close) : null;
  if (high === null || low === null) return null;
  const ranges = [high - low];
  if (prevClose !== null) {
    ranges.push(Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return Math.max.apply(null, ranges);
}

function calculateAtr(candles, period) {
  const p = period || 14;
  if (!Array.isArray(candles) || candles.length < p + 1) return null;
  const normalized = candles.filter(c => toNumber(c.high) !== null && toNumber(c.low) !== null && toNumber(c.close) !== null);
  if (normalized.length < p + 1) return null;
  const trs = [];
  for (let i = 1; i < normalized.length; i++) {
    const tr = trueRange(normalized[i], normalized[i - 1]);
    if (tr !== null) trs.push(tr);
  }
  if (trs.length < p) return null;
  const recent = trs.slice(-p);
  return recent.reduce((sum, n) => sum + n, 0) / p;
}

function distancePercent(entry, level) {
  if (entry === null || level === null || !Number.isFinite(entry) || entry === 0) return null;
  return Math.abs(level - entry) / entry * 100;
}

function distanceAtrMultiple(entry, level, atr) {
  if (entry === null || level === null || atr === null || !Number.isFinite(atr) || atr <= 0) return null;
  return Math.abs(level - entry) / atr;
}

function classifySl(multiple) {
  if (multiple === null || !Number.isFinite(multiple)) return 'SL_UNKNOWN';
  if (multiple < 1.0) return 'SL_TOO_TIGHT';
  if (multiple <= 2.5) return 'SL_OK';
  return 'SL_TOO_WIDE';
}

function classifyTp1(multiple) {
  if (multiple === null || !Number.isFinite(multiple)) return 'TP1_UNKNOWN';
  return multiple <= 2.5 ? 'TP1_REALISTIC' : 'TP1_STRETCHED';
}

function classifyTp2(multiple) {
  if (multiple === null || !Number.isFinite(multiple)) return 'TP2_UNKNOWN';
  return multiple > 4 ? 'TP2_STRETCHED' : 'TP2_NOT_STRETCHED';
}

function validatePick(row, candles) {
  const pick = normalizePick(row);
  const atr = calculateAtr(candles, 14);
  const reason = !pick.ticker ? 'missing_ticker' : (!Array.isArray(candles) || candles.length < 15 ? 'missing_ohlcv' : (atr === null ? 'insufficient_ohlcv' : null));
  const slMultiple = distanceAtrMultiple(pick.entryReference, pick.sl, atr);
  const tp1Multiple = distanceAtrMultiple(pick.entryReference, pick.tp1, atr);
  const tp2Multiple = distanceAtrMultiple(pick.entryReference, pick.tp2, atr);
  return Object.assign({}, pick, {
    atr14: atr,
    slDistancePct: distancePercent(pick.entryReference, pick.sl),
    tp1DistancePct: distancePercent(pick.entryReference, pick.tp1),
    tp2DistancePct: distancePercent(pick.entryReference, pick.tp2),
    slAtrMultiple: slMultiple,
    tp1AtrMultiple: tp1Multiple,
    tp2AtrMultiple: tp2Multiple,
    slClass: classifySl(slMultiple),
    tp1Class: classifyTp1(tp1Multiple),
    tp2Class: classifyTp2(tp2Multiple),
    reason: pick.entryReference === null ? 'missing_entry' : (reason || (pick.sl === null && pick.tp1 === null && pick.tp2 === null ? 'missing_levels' : null))
  });
}

function buildWarningNotes(meta) {
  const notes = [];
  if (meta && meta.sl_atr_class === 'SL_TOO_TIGHT') notes.push('Risk: SL ketat vs volatilitas harian; rawan noise.');
  if (meta && meta.tp1_atr_class === 'TP1_STRETCHED') notes.push('Target: TP1 cukup jauh vs ATR; butuh momentum kuat.');
  if (meta && meta.tp2_atr_class === 'TP2_STRETCHED') notes.push('Target: TP2 agresif; anggap target lanjutan.');
  return notes;
}

function buildAtrWarningMetadata(row, candles) {
  const validated = validatePick(row || {}, candles);
  if (validated.atr14 === null) return null;
  const meta = {
    atr14: round(validated.atr14, 4),
    sl_atr_multiple: round(validated.slAtrMultiple, 4),
    tp1_atr_multiple: round(validated.tp1AtrMultiple, 4),
    tp2_atr_multiple: round(validated.tp2AtrMultiple, 4),
    sl_atr_class: validated.slClass,
    tp1_atr_class: validated.tp1Class,
    tp2_atr_class: validated.tp2Class
  };
  meta.atr_warning_notes = buildWarningNotes(meta);
  return meta;
}

function isBlockedDayTradePatternScore(row) {
  const status = String((row && (row.status || row.final_status || row.display_status)) || '').toUpperCase();
  const entryStatus = String((row && row.entry_status) || '').toUpperCase();
  const risk = String((row && (row.risk_label_v2 || row.risk_label || row.derived_risk)) || '').toUpperCase();
  const dataQuality = String((row && row.data_quality_status) || '').toUpperCase();
  return /AVOID|HINDARI|WAIT_PULLBACK|SPECULATIVE|INVALID|STALE|REVALIDATION|HISTORY_INSUFFICIENT/.test(status) ||
    /CHASE_RISK|EXTENDED|TP1_HIT|TP2_HIT|INVALID_BELOW_SL/.test(entryStatus) ||
    risk === 'VERY HIGH RISK' ||
    (row && (row.trading_plan_valid === false || row.data_quality_valid === false || row.false_breakout_risk === true)) ||
    /SHORT_HISTORY|MISSING_REFERENCE|SPARSE_TRADING_DAYS|INVALID_CANDLE|CORPORATE_ACTION_RISK|NEEDS_REVALIDATION/.test(dataQuality);
}

function deriveDayTradeClassicPatternAdjustment(row, patternResult) {
  const result = patternResult || {};
  const primary = result.primary_pattern || (Array.isArray(result.patterns) ? result.patterns[0] : null);
  if (!primary || isBlockedDayTradePatternScore(row || {})) return 0;

  const bias = String(primary.bias || '').toLowerCase();
  const patternStatus = String(primary.status || 'candidate').toLowerCase();
  if (bias === 'bearish') {
    return /confirmed|breakdown|near_breakdown/.test(patternStatus) ? MIN_DAYTRADE_CLASSIC_PATTERN_PENALTY : -2;
  }
  if (bias !== 'bullish') return 0;

  const volume = getField(row || {}, ['volume_ratio_20d', 'volume_ratio_avg20', 'volume_ratio']);
  const change = getField(row || {}, ['change_pct']) || 0;
  const entryDistance = getField(row || {}, ['entry_distance_pct']);
  const overextended = change > 5 || (entryDistance !== null && entryDistance > 4) || (row && row._overextendedMA20 === true);
  if (overextended || volume === null || volume < 0.8) return 0;
  if (/confirmed|breakout|near_breakout/.test(patternStatus) && volume >= 1.0) return MAX_DAYTRADE_CLASSIC_PATTERN_BONUS;
  return 1;
}

function buildDayTradeClassicPatternMetadata(row, candles) {
  if (!row || toNumber(row.daytrade_score) === null || !Array.isArray(candles) || candles.length < 21) return null;
  const result = classicChartPatterns.detectClassicChartPatterns(candles.slice(0, -1), {
    ticker: row.ticker || row.symbol || null,
    timeframe: '1D_T_MINUS_1'
  });
  const adjustment = deriveDayTradeClassicPatternAdjustment(row, result);
  return {
    classic_chart_patterns: result.patterns || [],
    primary_classic_pattern: result.primary_pattern || null,
    classic_pattern_score_adjustment: adjustment,
    classic_pattern_rule_version: result.rule_version || classicChartPatterns.VERSION,
    classic_pattern_score_version: DAYTRADE_CLASSIC_PATTERN_SCORE_VERSION
  };
}

function attachDayTradeClassicPatternScore(row, candles) {
  if (!row || typeof row !== 'object' || row.classic_pattern_score_version === DAYTRADE_CLASSIC_PATTERN_SCORE_VERSION) return row;
  const meta = buildDayTradeClassicPatternMetadata(row, candles);
  if (!meta) return row;
  const base = toNumber(row.daytrade_score);
  Object.assign(row, meta);
  row.score_before_classic_pattern_adjustment = base;
  row.daytrade_score = Math.max(0, Math.min(100, base + meta.classic_pattern_score_adjustment));
  row.classic_pattern_score_applied = meta.classic_pattern_score_adjustment !== 0;
  return row;
}

function attachAtrWarningMetadata(row, candles) {
  if (!row || typeof row !== 'object') return row;
  const meta = buildAtrWarningMetadata(row, candles);
  if (meta) Object.assign(row, meta);
  attachDayTradeClassicPatternScore(row, candles);
  return row;
}

function getClassValue(row, names) {
  const raw = (row && row.raw_payload) || {};
  for (const name of names) {
    const value = row && row[name] != null ? row[name] : (raw && raw[name]);
    if (value != null && value !== '') return String(value);
  }
  return null;
}

function deriveAtrScorePenalty(rowOrCandidate) {
  const row = rowOrCandidate || {};
  const hasAtr = toNumber(row.atr14) !== null ||
    toNumber(row.atr) !== null ||
    toNumber(row.atr_14) !== null ||
    toNumber(row.sl_atr_multiple) !== null ||
    toNumber(row.tp1_atr_multiple) !== null ||
    toNumber(row.tp2_atr_multiple) !== null;
  if (!hasAtr) {
    return { atr_score_penalty: 0, atr_penalty_reasons: [], atr_risk_adjustment: 0 };
  }

  const slClass = getClassValue(row, ['sl_atr_class', 'slClass']);
  const tp1Class = getClassValue(row, ['tp1_atr_class', 'tp1Class']);
  const tp2Class = getClassValue(row, ['tp2_atr_class', 'tp2Class']);
  const reasons = [];
  let penalty = 0;
  let riskAdjustment = 0;

  if (slClass === 'SL_TOO_TIGHT') {
    penalty -= 4;
    riskAdjustment = 1;
    reasons.push('SL_TOO_TIGHT:-4');
  }
  if (tp1Class === 'TP1_STRETCHED') {
    penalty -= 3;
    reasons.push('TP1_STRETCHED:-3');
  }
  if (tp2Class === 'TP2_STRETCHED') {
    penalty -= 1;
    reasons.push('TP2_STRETCHED:-1');
  }

  if (penalty < -7) {
    penalty = -7;
    reasons.push('ATR_PENALTY_CAP:-7');
  }

  return {
    atr_score_penalty: penalty,
    atr_penalty_reasons: reasons,
    atr_risk_adjustment: riskAdjustment
  };
}

function average(values) {
  const valid = values.filter(v => v !== null && Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((sum, n) => sum + n, 0) / valid.length;
}

function buildSummary(rows) {
  const bySource = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const source = row.source || 'unknown';
    if (!bySource[source]) bySource[source] = { count: 0, sl: [], tp1: [], tp2: [], slTooTight: 0, tp1Stretched: 0, slTooTightSlHit: 0, tp1StretchedTpHit: 0, waitingExpiredByAtrClass: {} };
    const s = bySource[source];
    s.count++;
    s.sl.push(row.slAtrMultiple); s.tp1.push(row.tp1AtrMultiple); s.tp2.push(row.tp2AtrMultiple);
    if (row.slClass === 'SL_TOO_TIGHT') s.slTooTight++;
    if (row.tp1Class === 'TP1_STRETCHED') s.tp1Stretched++;
    if (row.slClass === 'SL_TOO_TIGHT' && row.outcome === 'SL_HIT') s.slTooTightSlHit++;
    if (row.tp1Class === 'TP1_STRETCHED' && (row.outcome === 'TP1_HIT' || row.outcome === 'TP2_HIT')) s.tp1StretchedTpHit++;
    if (row.outcome === 'WAITING' || row.outcome === 'EXPIRED') {
      const key = row.outcome + ':' + row.slClass;
      s.waitingExpiredByAtrClass[key] = (s.waitingExpiredByAtrClass[key] || 0) + 1;
    }
  }
  for (const s of Object.values(bySource)) {
    s.avgSlAtr = average(s.sl); s.avgTp1Atr = average(s.tp1); s.avgTp2Atr = average(s.tp2);
    s.pctSlTooTight = s.count ? s.slTooTight / s.count * 100 : null;
    s.pctTp1Stretched = s.count ? s.tp1Stretched / s.count * 100 : null;
    delete s.sl; delete s.tp1; delete s.tp2;
  }
  return { total: rows.length, bySource };
}

module.exports = {
  MAX_DAYTRADE_CLASSIC_PATTERN_BONUS,
  MIN_DAYTRADE_CLASSIC_PATTERN_PENALTY,
  DAYTRADE_CLASSIC_PATTERN_SCORE_VERSION,
  toNumber,
  round,
  normalizePick,
  trueRange,
  calculateAtr,
  distancePercent,
  distanceAtrMultiple,
  classifySl,
  classifyTp1,
  classifyTp2,
  validatePick,
  buildWarningNotes,
  buildAtrWarningMetadata,
  isBlockedDayTradePatternScore,
  deriveDayTradeClassicPatternAdjustment,
  buildDayTradeClassicPatternMetadata,
  attachDayTradeClassicPatternScore,
  attachAtrWarningMetadata,
  deriveAtrScorePenalty,
  buildSummary
};

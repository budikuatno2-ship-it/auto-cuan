'use strict';

const { canonicalConfig, normalizeEvaluationRecord } = require('./screener-evaluation-contract');

const MAX_ENVELOPE_RECORDS = 75;
const MAX_ENVELOPE_BYTES = 512 * 1024;
const ENVELOPE_VERSION = 1;

function nullableNumber(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function boundedRequestString(value, max) {
  if (value == null || value === '') return null;
  const text = String(value);
  return /^[A-Za-z0-9_.:+/-]+$/.test(text) && text.length <= max ? text : null;
}
function sha(value, length) { const text=String(value || '').toLowerCase(); return new RegExp('^[a-f0-9]{'+length+'}$').test(text) ? text : (length === 40 ? '0'.repeat(40) : '0'.repeat(64)); }

function rejectionCodes(candidate) {
  if (candidate.daytrade_score >= 50) return [];
  return ['SCORE_BELOW_PERSISTENCE_THRESHOLD'];
}

/** Pure mapping of the candidate at runDayTradeBatch's calculation boundary. */
function adaptDayTradeCandidate(candidate, context) {
  context = context || {};
  const display = nullableNumber(candidate.daytrade_score);
  const passed = display >= 50;
  const config = canonicalConfig({
    adapter: 'daytrade-evaluation-v1',
    persistence_score_min: 50,
    engine_status_contract: 'classifyStatus',
    envelope_record_cap: MAX_ENVELOPE_RECORDS,
    envelope_byte_cap: MAX_ENVELOPE_BYTES
  });
  return normalizeEvaluationRecord({
    schema_version: 1, strategy: 'DAY_TRADE', run_id: context.runId,
    run_mode: context.runMode, batch_index: context.batchIndex,
    scheduled_slot: boundedRequestString(context.scheduledSlot, 64),
    scheduler_source: boundedRequestString(context.schedulerSource, 128),
    code_sha: sha(context.codeSha, 40), config_hash: config.hash,
    ticker: candidate.ticker, candidate_revision: 1,
    observed_at: context.observedAt,
    feature_as_of_ts: null,
    feature_as_of_provenance: 'unavailable_engine_does_not_expose_source_timestamp',
    data_source: 'daytrade_engine_batch_calculation', data_lag_ms: null,
    ohlcv_sofar: {
      open: nullableNumber(candidate.open_price), high: nullableNumber(candidate.high_price),
      low: nullableNumber(candidate.low_price), close: nullableNumber(candidate.last_price),
      volume: nullableNumber(candidate.volume_today),
      provenance: 'engine_analysis_current_sofar_fields'
    },
    rvol_raw: nullableNumber(candidate.volume_ratio_20d), rvol_seasonal: null,
    rvol_seasonal_provenance: 'unavailable_no_validated_seasonal_curve',
    score_components_raw: {
      liquidity: nullableNumber(candidate.liquidity_score) || 0,
      prespike: nullableNumber(candidate.prespike_score) || 0,
      momentum: nullableNumber(candidate.momentum_score) || 0,
      risk_reward: nullableNumber(candidate.risk_reward_score) || 0,
      trend: nullableNumber(candidate.trend_score) || 0,
      penalty: nullableNumber(candidate.penalty_score) || 0,
      candle: nullableNumber(candidate.candle_score) || 0,
      atr_adjustment: nullableNumber(candidate.atr_score_penalty) || 0
    },
    score_raw: nullableNumber(candidate.daytrade_score_raw), score_display: display,
    status: candidate.status, passed, rejection_codes: rejectionCodes(candidate),
    gate_trace: { schema_version: 1, rule_set_version: 'daytrade-persistence-v1', gates: {
      persistence_score: { value: display, threshold: 50, operator: '>=', passed, rule_version: '1' }
    } },
    levels: { raw: null, normalized: {
      entry_low: nullableNumber(candidate.entry_low), entry_high: nullableNumber(candidate.entry_high),
      stop_loss: nullableNumber(candidate.stop_loss), tp1: nullableNumber(candidate.tp1), tp2: nullableNumber(candidate.tp2)
    }, provenance: 'raw_pre_normalization_levels_unavailable;normalized_from_calculation_point' },
    publication: { published: false, rank: null }
  });
}

function captureRequested(req, env) {
  const flag = req && req.query && String(req.query.evaluation_capture || '').toLowerCase();
  return String((env || process.env).DAYTRADE_EVALUATION_ADAPTER_ENABLED || '').toLowerCase() === 'true' && (flag === '1' || flag === 'true');
}

function buildEvaluationEnvelope(candidates, context, limits) {
  limits = limits || {};
  const maxRecords = limits.maxRecords || MAX_ENVELOPE_RECORDS;
  const maxBytes = limits.maxBytes || MAX_ENVELOPE_BYTES;
  try {
    if (!Array.isArray(candidates) || candidates.length > maxRecords) throw new RangeError('record_count_cap');
    const records = candidates.map(candidate => adaptDayTradeCandidate(candidate, context));
    const envelope = { schema_version: ENVELOPE_VERSION, strategy: 'DAY_TRADE', run_id: context.runId, batch_index: context.batchIndex, records,
      omitted_field_provenance: { feature_as_of_ts: 'unavailable_engine_does_not_expose_source_timestamp', rvol_seasonal: 'unavailable_no_validated_seasonal_curve', levels_raw: 'unavailable_after_tick_normalization', pre_calculation_failures: context.failedCount ? 'not_candidates_no_engine_status_or_calculation' : 'none' } };
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (bytes > maxBytes) throw new RangeError('response_byte_cap');
    envelope.serialized_bytes = bytes;
    return { envelope, diagnostic: null };
  } catch (error) {
    return { envelope: null, diagnostic: { omitted: true, reason: error instanceof RangeError ? error.message : 'validation_failed', candidate_count: Math.min(Array.isArray(candidates) ? candidates.length : 0, maxRecords + 1), record_cap: maxRecords, byte_cap: maxBytes } };
  }
}

function attachEvaluationCapture(payload, req, candidates, context, limits) {
  if (!captureRequested(req, context && context.env)) return payload;
  const built = buildEvaluationEnvelope(candidates, context, limits);
  const copy = Object.assign({}, payload);
  if (built.envelope) copy.evaluation = built.envelope;
  else copy.evaluation_diagnostic = built.diagnostic;
  return copy;
}

module.exports = { ENVELOPE_VERSION, MAX_ENVELOPE_RECORDS, MAX_ENVELOPE_BYTES, adaptDayTradeCandidate, buildEvaluationEnvelope, captureRequested, attachEvaluationCapture };

'use strict';

const crypto = require('node:crypto');
const SCHEMA_VERSION = 1;
const GATE_TRACE_SCHEMA_VERSION = 1;
const MAX_GATE_COUNT = 32;
const MAX_GATE_TRACE_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const GATE_OPERATORS = new Set(['>', '>=', '<', '<=', '==', '!=', 'IN', 'EXISTS']);
// Exact classifications emitted by classifyStatus in the real Day Trade engine.
const STATUSES = new Set(['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT', 'MOMENTUM_CONTINUATION', 'RECLAIM_CANDIDATE', 'EARLY_RADAR', 'PRE_SPIKE_WATCH', 'WAIT_PULLBACK', 'SPECULATIVE', 'AVOID']);
const TOP_LEVEL_KEYS = new Set(['schema_version', 'strategy', 'run_id', 'run_mode', 'batch_index', 'scheduled_slot', 'scheduler_source', 'code_sha', 'config_hash', 'ticker', 'candidate_revision', 'observed_at', 'feature_as_of_ts', 'feature_as_of_provenance', 'data_source', 'data_lag_ms', 'ohlcv_sofar', 'rvol_raw', 'rvol_seasonal', 'rvol_seasonal_provenance', 'score_components_raw', 'score_components_provenance', 'score_raw', 'score_display', 'status', 'passed', 'rejection_codes', 'gate_trace', 'levels', 'publication']);
const REQUIRED_KEYS = ['schema_version', 'strategy', 'run_id', 'run_mode', 'batch_index', 'scheduled_slot', 'scheduler_source', 'code_sha', 'config_hash', 'ticker', 'candidate_revision', 'observed_at', 'feature_as_of_ts', 'feature_as_of_provenance', 'data_source', 'data_lag_ms', 'ohlcv_sofar', 'rvol_raw', 'rvol_seasonal', 'rvol_seasonal_provenance', 'score_components_raw', 'score_components_provenance', 'score_raw', 'score_display', 'status', 'passed', 'rejection_codes', 'gate_trace', 'levels', 'publication'];
const FORBIDDEN_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|service[_-]?role|user[_-]?id|account|email|chat[_-]?id)/i;
const FORBIDDEN_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:supabase|telegram)[-_ ]?(?:key|token|secret)\b|https?:\/\/(?:api\.)?telegram\.org\/bot|\bbot\d{6,}:[A-Za-z0-9_-]{20,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:chat|account|user)[-_ ]?id\s*[:=]\s*-?\d{5,}\b)/i;

function plainObject(value) { return !!value && Object.getPrototypeOf(value) === Object.prototype; }
function boundedString(value, name, max = 128, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value || value.length > max) throw new TypeError(name + ' must be a bounded string');
  if (FORBIDDEN_VALUE.test(value)) throw new TypeError(name + ' contains secret or account data');
  return value;
}
function finiteNumber(value, name, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(name + ' must be finite');
  return value;
}
function timestamp(value, name, nullable = false) {
  if (nullable && value === null) return value;
  boundedString(value, name, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(name + ' must be an ISO UTC timestamp');
  return value;
}
function exactKeys(value, allowed, name) {
  if (!plainObject(value)) throw new TypeError(name + ' must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(name + ' contains unsupported field: ' + key);
}
function normalizeJson(value, path = '$') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { boundedString(value, path, 4096); return value; }
  if (typeof value === 'number') { finiteNumber(value, path); return value; }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJson(item, path + '[' + index + ']'));
  if (!plainObject(value)) throw new TypeError(path + ' is not a plain JSON value');
  return Object.keys(value).sort().reduce((out, key) => {
    if (FORBIDDEN_KEY.test(key)) throw new TypeError(path + '.' + key + ' is a forbidden sensitive field');
    if (value[key] === undefined || typeof value[key] === 'function' || typeof value[key] === 'symbol') throw new TypeError(path + '.' + key + ' is not JSON');
    out[key] = normalizeJson(value[key], path + '.' + key); return out;
  }, {});
}
function canonicalJson(value) { return JSON.stringify(normalizeJson(value)); }
function canonicalConfig(value) { const json = canonicalJson(value); return { json, hash: crypto.createHash('sha256').update(Buffer.from(json, 'utf8')).digest('hex') }; }

function normalizeGateTrace(trace) {
  exactKeys(trace, ['schema_version', 'rule_set_version', 'gates'], 'gate_trace');
  if (trace.schema_version !== GATE_TRACE_SCHEMA_VERSION) throw new TypeError('gate_trace requires supported schema_version');
  boundedString(trace.rule_set_version, 'gate_trace.rule_set_version', 64);
  if (!plainObject(trace.gates)) throw new TypeError('gate_trace.gates must be an object');
  const names = Object.keys(trace.gates); if (names.length > MAX_GATE_COUNT) throw new RangeError('gate_trace has too many gates');
  const normalized = { schema_version: GATE_TRACE_SCHEMA_VERSION, rule_set_version: trace.rule_set_version, gates: {} };
  names.sort().forEach(name => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new TypeError('invalid gate name: ' + name);
    const gate = trace.gates[name]; exactKeys(gate, ['value', 'threshold', 'operator', 'passed', 'rule_version'], 'gate ' + name);
    if (!GATE_OPERATORS.has(gate.operator) || typeof gate.passed !== 'boolean') throw new TypeError('invalid gate: ' + name);
    boundedString(gate.rule_version, 'gate rule_version', 64);
    normalized.gates[name] = normalizeJson({ value: gate.value, threshold: gate.threshold, operator: gate.operator, passed: gate.passed, rule_version: gate.rule_version });
  });
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_GATE_TRACE_BYTES) throw new RangeError('gate_trace exceeds byte limit');
  return normalized;
}

function normalizeEvaluationRecord(record) {
  if (!plainObject(record)) throw new TypeError('evaluation record must be an object');
  for (const key of Object.keys(record)) if (!TOP_LEVEL_KEYS.has(key)) throw new TypeError('unsupported evaluation field: ' + key);
  for (const key of REQUIRED_KEYS) if (!Object.prototype.hasOwnProperty.call(record, key)) throw new TypeError('missing evaluation field: ' + key);
  if (record.schema_version !== SCHEMA_VERSION || record.strategy !== 'DAY_TRADE') throw new TypeError('unsupported evaluation record');
  boundedString(record.run_id, 'run_id', 128); boundedString(record.ticker, 'ticker', 20);
  boundedString(record.run_mode, 'run_mode', 64); if (!Number.isInteger(record.batch_index) || record.batch_index < 0 || record.batch_index > 1000) throw new TypeError('batch_index is invalid'); boundedString(record.scheduled_slot, 'scheduled_slot', 64, true); boundedString(record.scheduler_source, 'scheduler_source', 128, true); boundedString(record.data_source, 'data_source', 128);
  if (!/^[a-f0-9]{40}$/.test(record.code_sha) || !/^[a-f0-9]{64}$/.test(record.config_hash)) throw new TypeError('code/config hash is invalid');
  if (!/^[A-Z0-9.-]{1,20}$/.test(record.ticker) || !Number.isInteger(record.candidate_revision) || record.candidate_revision < 1 || record.candidate_revision > 1000000) throw new TypeError('candidate identity is invalid');
  timestamp(record.observed_at, 'observed_at'); timestamp(record.feature_as_of_ts, 'feature_as_of_ts', true); boundedString(record.feature_as_of_provenance, 'feature_as_of_provenance', 128);
  if (record.data_lag_ms !== null && (!Number.isInteger(record.data_lag_ms) || record.data_lag_ms < 0)) throw new TypeError('data_lag_ms is invalid');
  exactKeys(record.ohlcv_sofar, ['open', 'high', 'low', 'close', 'volume', 'provenance'], 'ohlcv_sofar'); for (const key of ['open', 'high', 'low', 'close', 'volume']) finiteNumber(record.ohlcv_sofar[key], 'ohlcv_sofar.' + key, true); boundedString(record.ohlcv_sofar.provenance, 'ohlcv provenance', 128);
  finiteNumber(record.rvol_raw, 'rvol_raw', true); finiteNumber(record.rvol_seasonal, 'rvol_seasonal', true); boundedString(record.rvol_seasonal_provenance, 'rvol_seasonal_provenance', 128); finiteNumber(record.score_raw, 'score_raw'); finiteNumber(record.score_display, 'score_display');
  if (!plainObject(record.score_components_raw) || Object.keys(record.score_components_raw).length > 32) throw new TypeError('score_components_raw is invalid'); for (const [key, value] of Object.entries(record.score_components_raw)) { if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new TypeError('invalid score component'); finiteNumber(value, 'score component', true); } boundedString(record.score_components_provenance, 'score_components_provenance', 256);
  if (typeof record.passed !== 'boolean' || !STATUSES.has(record.status)) throw new TypeError('result fields are invalid');
  if (!Array.isArray(record.rejection_codes) || record.rejection_codes.length > 32 || new Set(record.rejection_codes).size !== record.rejection_codes.length || record.rejection_codes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code))) throw new TypeError('rejection_codes are invalid');
  if (!record.passed && record.rejection_codes.length === 0) throw new TypeError('rejected records require rejection_codes');
  if (record.passed && record.rejection_codes.length) throw new TypeError('passed records cannot contain rejection_codes');
  if (record.passed !== (record.score_display >= 50)) throw new TypeError('passed contradicts the production score threshold');
  exactKeys(record.levels, ['raw', 'normalized', 'provenance'], 'levels'); boundedString(record.levels.provenance, 'levels provenance', 128); normalizeJson(record.levels.raw); normalizeJson(record.levels.normalized);
  exactKeys(record.publication, ['published', 'rank'], 'publication'); if (typeof record.publication.published !== 'boolean' || (record.publication.rank !== null && (!Number.isInteger(record.publication.rank) || record.publication.rank < 1))) throw new TypeError('publication is invalid');
  if (record.publication.published !== (record.publication.rank !== null)) throw new TypeError('publication rank contradicts published');
  if (record.publication.published && !record.passed) throw new TypeError('rejected records cannot be published');
  const normalized = normalizeJson(Object.assign({}, record, { gate_trace: normalizeGateTrace(record.gate_trace) }));
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_RECORD_BYTES) throw new RangeError('evaluation record exceeds byte limit'); return normalized;
}
module.exports = { STATUSES, SCHEMA_VERSION, GATE_TRACE_SCHEMA_VERSION, MAX_GATE_TRACE_BYTES, MAX_RECORD_BYTES, canonicalJson, canonicalConfig, normalizeGateTrace, normalizeEvaluationRecord };

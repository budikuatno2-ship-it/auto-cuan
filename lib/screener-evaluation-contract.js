'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const GATE_TRACE_SCHEMA_VERSION = 1;
const MAX_GATE_COUNT = 32;
const MAX_GATE_TRACE_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const GATE_OPERATORS = new Set(['>', '>=', '<', '<=', '==', '!=', 'IN', 'EXISTS']);
const FORBIDDEN_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|service[_-]?role|user[_-]?id|account)/i;

function normalizeJson(value, path = '$') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(path + ' contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJson(item, path + '[' + index + ']'));
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(path + ' is not a plain JSON value');
  return Object.keys(value).sort().reduce((out, key) => {
    if (FORBIDDEN_KEY.test(key)) throw new TypeError(path + '.' + key + ' is a forbidden sensitive field');
    if (value[key] === undefined || typeof value[key] === 'function' || typeof value[key] === 'symbol') {
      throw new TypeError(path + '.' + key + ' is not JSON');
    }
    out[key] = normalizeJson(value[key], path + '.' + key);
    return out;
  }, {});
}

function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value));
}

function canonicalConfig(value) {
  const json = canonicalJson(value);
  return { json, hash: crypto.createHash('sha256').update(Buffer.from(json, 'utf8')).digest('hex') };
}

function normalizeGateTrace(trace) {
  if (!trace || trace.schema_version !== GATE_TRACE_SCHEMA_VERSION || typeof trace.rule_set_version !== 'string' || !trace.rule_set_version || trace.rule_set_version.length > 64) {
    throw new TypeError('gate_trace requires supported schema_version and bounded rule_set_version');
  }
  const gates = trace.gates;
  if (!gates || Object.getPrototypeOf(gates) !== Object.prototype) throw new TypeError('gate_trace.gates must be an object');
  const names = Object.keys(gates);
  if (names.length > MAX_GATE_COUNT) throw new RangeError('gate_trace has too many gates');
  const normalized = { schema_version: GATE_TRACE_SCHEMA_VERSION, rule_set_version: trace.rule_set_version, gates: {} };
  names.sort().forEach((name) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new TypeError('invalid gate name: ' + name);
    const gate = gates[name];
    if (!gate || Object.getPrototypeOf(gate) !== Object.prototype || !GATE_OPERATORS.has(gate.operator) || typeof gate.passed !== 'boolean' || typeof gate.rule_version !== 'string' || !gate.rule_version || gate.rule_version.length > 64) {
      throw new TypeError('invalid gate: ' + name);
    }
    normalized.gates[name] = normalizeJson({ value: gate.value, threshold: gate.threshold, operator: gate.operator, passed: gate.passed, rule_version: gate.rule_version }, '$.gates.' + name);
  });
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_GATE_TRACE_BYTES) throw new RangeError('gate_trace exceeds byte limit');
  return normalized;
}

function normalizeEvaluationRecord(record) {
  if (!record || record.schema_version !== SCHEMA_VERSION || record.strategy !== 'DAY_TRADE') throw new TypeError('unsupported evaluation record');
  if (typeof record.run_id !== 'string' || !record.run_id || typeof record.ticker !== 'string' || !/^[A-Z0-9.-]{1,20}$/.test(record.ticker)) throw new TypeError('record identity is invalid');
  if (record.passed === false && (!Array.isArray(record.rejection_codes) || record.rejection_codes.length === 0)) throw new TypeError('rejected records require rejection_codes');
  const copy = Object.assign({}, record, { gate_trace: normalizeGateTrace(record.gate_trace) });
  const normalized = normalizeJson(copy);
  const bytes = Buffer.byteLength(JSON.stringify(normalized));
  if (bytes > MAX_RECORD_BYTES) throw new RangeError('evaluation record exceeds byte limit');
  return normalized;
}

module.exports = { SCHEMA_VERSION, GATE_TRACE_SCHEMA_VERSION, MAX_GATE_TRACE_BYTES, MAX_RECORD_BYTES, canonicalJson, canonicalConfig, normalizeGateTrace, normalizeEvaluationRecord };

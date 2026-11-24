'use strict';

// F2 advanced detector: pattern lifecycle state machine.
// States: FORMING -> PROVISIONAL -> CONFIRMED -> INVALIDATED | EXPIRED
//         PROJECTION (dashed forward scenario, labeled SKENARIO)
// Every transition records {detected_at, confirmed_at, invalidated_at,
// reason, source_hash, algorithm_version}.
// Illegal transitions are rejected (throw).

const VERSION = 'chart-core-lifecycle-v1';
const crypto = require('crypto');

var STATES = ['FORMING', 'PROVISIONAL', 'CONFIRMED', 'INVALIDATED', 'EXPIRED', 'PROJECTION'];

var TRANSITIONS = {
  FORMING: ['PROVISIONAL', 'INVALIDATED', 'EXPIRED', 'PROJECTION'],
  PROVISIONAL: ['CONFIRMED', 'INVALIDATED', 'EXPIRED', 'PROJECTION'],
  CONFIRMED: ['INVALIDATED', 'EXPIRED', 'PROJECTION'],
  INVALIDATED: [],
  EXPIRED: [],
  PROJECTION: ['INVALIDATED', 'EXPIRED']
};

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function sourceHash(payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Create a lifecycle record.
 * @param {object} spec { pattern, direction, invalidationLevel, maxAgeBars,
 *                        detectedAt (bar index), source (any serializable) }
 * @returns {object} lifecycle record with state FORMING.
 */
function createLifecycle(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec required');
  if (!spec.pattern) throw new Error('pattern required');
  return {
    pattern: spec.pattern,
    direction: spec.direction || 'neutral',
    state: 'FORMING',
    invalidation_level: isNum(spec.invalidationLevel) ? spec.invalidationLevel : null,
    max_age_bars: isNum(spec.maxAgeBars) ? spec.maxAgeBars : null,
    detected_at: isNum(spec.detectedAt) ? spec.detectedAt : null,
    confirmed_at: null,
    invalidated_at: null,
    expired_at: null,
    reason: null,
    source_hash: sourceHash(spec.source || spec),
    algorithm_version: VERSION,
    history: [],
    projection: null
  };
}

/**
 * Apply a state transition. Throws on illegal transitions.
 * @param {object} record lifecycle record (mutated and returned)
 * @param {string} toState target state
 * @param {object} [meta] { at (bar index), reason }
 */
function transition(record, toState, meta) {
  if (STATES.indexOf(toState) === -1) {
    throw new Error('Unknown state: ' + toState);
  }
  if (TRANSITIONS[record.state].indexOf(toState) === -1) {
    throw new Error('Illegal transition: ' + record.state + ' -> ' + toState);
  }
  var at = meta && isNum(meta.at) ? meta.at : null;
  var reason = meta && meta.reason ? meta.reason : null;

  record.history.push({ from: record.state, to: toState, at: at, reason: reason });
  record.state = toState;
  record.reason = reason;

  if (toState === 'PROVISIONAL') {
    // detected_at set at creation; keep as-is.
  } else if (toState === 'CONFIRMED') {
    record.confirmed_at = at;
  } else if (toState === 'INVALIDATED') {
    record.invalidated_at = at;
  } else if (toState === 'EXPIRED') {
    record.expired_at = at;
  } else if (toState === 'PROJECTION') {
    record.projection = {
      labeled: 'SKENARIO',
      at: at,
      reason: reason
    };
  }
  return record;
}

/**
 * Evaluate a lifecycle against the current bar: handles invalidation on
 * level breach and expiry on age. Returns the (possibly mutated) record.
 * @param {object} record lifecycle record
 * @param {object} ctx { currentBar (index), currentPrice }
 */
function evaluate(record, ctx) {
  if (!ctx || !isNum(ctx.currentBar)) return record;
  var price = isNum(ctx.currentPrice) ? ctx.currentPrice : null;

  // Invalidation on level breach (only while not terminal).
  if (record.invalidation_level !== null &&
      (record.state === 'FORMING' || record.state === 'PROVISIONAL' || record.state === 'CONFIRMED' || record.state === 'PROJECTION')) {
    var bearishPattern = record.direction === 'bullish';
    var breached = bearishPattern
      ? price !== null && price < record.invalidation_level
      : price !== null && price > record.invalidation_level;
    if (breached) {
      return transition(record, 'INVALIDATED', {
        at: ctx.currentBar,
        reason: 'price breached invalidation level ' + record.invalidation_level
      });
    }
  }

  // Expiry on age.
  if (record.max_age_bars !== null && record.detected_at !== null &&
      (record.state === 'FORMING' || record.state === 'PROVISIONAL' || record.state === 'CONFIRMED' || record.state === 'PROJECTION')) {
    if (ctx.currentBar - record.detected_at > record.max_age_bars) {
      return transition(record, 'EXPIRED', {
        at: ctx.currentBar,
        reason: 'max age ' + record.max_age_bars + ' bars exceeded'
      });
    }
  }
  return record;
}

module.exports = {
  VERSION: VERSION,
  STATES: STATES,
  TRANSITIONS: TRANSITIONS,
  createLifecycle: createLifecycle,
  transition: transition,
  evaluate: evaluate,
  sourceHash: sourceHash
};

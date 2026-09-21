'use strict';

const test = require('node:test');
const assert = require('node:assert');
const analyzeApi = require('../api/analyze');

test('BUG-ANL-01: transientSimulation(undefined) must return null when no simulation parameters are provided', () => {
  const { transientSimulation } = analyzeApi.__test;
  // Currently: transientSimulation(undefined) returns { label: 'SIMULASI', available_funds_idr: null, add_lots: null, setup_still_valid: null }
  // because output.label defaults to 'SIMULASI', causing Object.values(output).some(...) to always return true.
  const result = transientSimulation(undefined);
  assert.strictEqual(result, null, 'transientSimulation(undefined) must return null');

  const emptyResult = transientSimulation({});
  assert.strictEqual(emptyResult, null, 'transientSimulation({}) must return null');
});

test('BUG-SH-01: AI Confirmation in sector-hot must downgrade Rebound Speculative and Watchlist upon AI REJECT', () => {
  // Simulating the flawed conditional logic in api/sector-hot.js:771-778:
  // if (r.ai_status === 'REJECT' && r.status === 'Swing Ready') { r.final_status = 'Watchlist'; }
  // else { r.final_status = r.status; }
  function evaluateFinalStatus(candidate, aiStatus) {
    const r = Object.assign({}, candidate);
    r.ai_status = aiStatus;
    if (r.ai_status === 'REJECT' && r.status === 'Swing Ready') {
      r.final_status = 'Watchlist';
    } else if (r.ai_status === 'CAUTION' && r.status === 'Swing Ready') {
      r.final_status = r.status;
    } else {
      r.final_status = r.status;
    }
    return r.final_status;
  }

  const reboundCandidate = { ticker: 'MEDC', status: 'Rebound Speculative' };
  const finalStatusRebound = evaluateFinalStatus(reboundCandidate, 'REJECT');
  // AI rejected the rebound candidate, so final_status should not remain 'Rebound Speculative'
  assert.notStrictEqual(
    finalStatusRebound,
    'Rebound Speculative',
    'AI REJECT on Rebound Speculative should downgrade final_status'
  );

  const watchlistCandidate = { ticker: 'ASII', status: 'Watchlist' };
  const finalStatusWatchlist = evaluateFinalStatus(watchlistCandidate, 'REJECT');
  assert.notStrictEqual(
    finalStatusWatchlist,
    'Watchlist',
    'AI REJECT on Watchlist should downgrade final_status to Invalid'
  );
});

test('BUG-SH-02: callAIConfirmation in sector-hot trims whitespace in ai_red_flags to avoid broken postgres array matching', () => {
  // Simulating line 1459-1469 in api/sector-hot.js:
  // parts[2].trim().split(',').slice(0, 3) where codes is ['TREND_OK', ' RSI_LOW']
  // codes.filter(...) returns untrimmed ' RSI_LOW'
  const rawCodesString = 'TREND_OK, RSI_LOW';
  const codes = rawCodesString.trim().split(',').slice(0, 3);
  const filtered = codes.filter((c) => {
    const ct = c.trim();
    return ct === 'TREND_WEAK' || ct === 'RSI_LOW' || ct === 'RSI_HIGH' || ct === 'VOL_WEAK' || ct === 'RR_LOW' || ct === 'ENTRY_FAR' || ct === 'OVEREXT';
  });

  // Current code pushes untrimmed ' RSI_LOW' into ai_red_flags
  // It should be trimmed 'RSI_LOW'
  assert.deepStrictEqual(filtered, ['RSI_LOW'], 'Red flags must be trimmed strings');
});

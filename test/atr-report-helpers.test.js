'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const atr = require('../lib/atr-report-helpers');
const script = require('../tools/report-atr-validation');

function candles(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ high: 110 + i, low: 100 + i, close: 105 + i });
  return out;
}

test('calculateAtr computes ATR(14) from daily true ranges', () => {
  assert.equal(atr.calculateAtr(candles(15), 14), 10);
});

test('distance-to-ATR multiple calculation uses absolute entry-level distance', () => {
  assert.equal(atr.distanceAtrMultiple(100, 95, 5), 1);
  assert.equal(atr.distanceAtrMultiple(100, 115, 5), 3);
});

test('SL and TP classifications follow report thresholds', () => {
  assert.equal(atr.classifySl(0.99), 'SL_TOO_TIGHT');
  assert.equal(atr.classifySl(1), 'SL_OK');
  assert.equal(atr.classifySl(2.5), 'SL_OK');
  assert.equal(atr.classifySl(2.51), 'SL_TOO_WIDE');
  assert.equal(atr.classifyTp1(2.5), 'TP1_REALISTIC');
  assert.equal(atr.classifyTp1(2.51), 'TP1_STRETCHED');
  assert.equal(atr.classifyTp2(4), 'TP2_NOT_STRETCHED');
  assert.equal(atr.classifyTp2(4.01), 'TP2_STRETCHED');
});

test('buildSummary groups by source and aggregates ATR classifications', () => {
  const summary = atr.buildSummary([
    { source: 'daytrade', slAtrMultiple: 0.5, tp1AtrMultiple: 3, tp2AtrMultiple: 5, slClass: 'SL_TOO_TIGHT', tp1Class: 'TP1_STRETCHED', outcome: 'SL_HIT' },
    { source: 'daytrade', slAtrMultiple: 2, tp1AtrMultiple: 2, tp2AtrMultiple: 3, slClass: 'SL_OK', tp1Class: 'TP1_REALISTIC', outcome: 'WAITING' },
    { source: 'swing', slAtrMultiple: 3, tp1AtrMultiple: 4, tp2AtrMultiple: 6, slClass: 'SL_TOO_WIDE', tp1Class: 'TP1_STRETCHED', outcome: 'TP1_HIT' }
  ]);
  assert.equal(summary.bySource.daytrade.count, 2);
  assert.equal(summary.bySource.daytrade.slTooTight, 1);
  assert.equal(summary.bySource.daytrade.slTooTightSlHit, 1);
  assert.equal(summary.bySource.swing.tp1StretchedTpHit, 1);
});

test('validatePick handles missing OHLCV and missing levels gracefully', () => {
  const row = atr.validatePick({ ticker: 'BBCA', entry1: 100, raw_payload: { monitor_source: 'daytrade' } }, null);
  assert.equal(row.reason, 'missing_ohlcv');
  assert.equal(row.slClass, 'SL_UNKNOWN');
  assert.equal(row.tp1Class, 'TP1_UNKNOWN');
});

test('validatePicks performs read-only validation through injected provider without writes', async () => {
  let fetches = 0;
  const provider = { fetchWithCache: async () => { fetches++; return candles(15); }, getStats: () => ({}) };
  const result = await script.validatePicks([{ ticker: 'BBCA', entry1: 100, sl: 95, tp1: 110, tp2: 125, raw_payload: { monitor_source: 'daytrade' } }], { provider });
  assert.equal(fetches, 1);
  assert.equal(result.rows[0].slClass, 'SL_TOO_TIGHT');
  assert.equal(typeof provider.writeCache, 'undefined');
});

test('buildAtrWarningMetadata maps validation output to signal warning fields', () => {
  const row = { ticker: 'BBCA', entry_low: 100, entry_high: 100, stop_loss: 96, tp1: 120, tp2: 130 };
  const meta = atr.buildAtrWarningMetadata(row, candles(15));
  assert.equal(meta.atr14, 10);
  assert.equal(meta.sl_atr_multiple, 0.4);
  assert.equal(meta.tp1_atr_multiple, 2);
  assert.equal(meta.tp2_atr_multiple, 3);
  assert.equal(meta.sl_atr_class, 'SL_TOO_TIGHT');
  assert.equal(meta.tp1_atr_class, 'TP1_REALISTIC');
  assert.equal(meta.tp2_atr_class, 'TP2_NOT_STRETCHED');
  assert.deepEqual(meta.atr_warning_notes, ['Risk: SL ketat vs volatilitas harian; rawan noise.']);
});

test('attachAtrWarningMetadata leaves signal unchanged when ATR unavailable', () => {
  const signal = { ticker: 'BBCA', entry1: 100, sl: 95, tp1: 110, tp2: 125 };
  const result = atr.attachAtrWarningMetadata(signal, null);
  assert.equal(result, signal);
  assert.equal(result.atr14, undefined);
});

test('deriveAtrScorePenalty applies SL_TOO_TIGHT -4', () => {
  assert.deepEqual(atr.deriveAtrScorePenalty({ atr14: 10, sl_atr_class: 'SL_TOO_TIGHT' }), {
    atr_score_penalty: -4,
    atr_penalty_reasons: ['SL_TOO_TIGHT:-4'],
    atr_risk_adjustment: 1
  });
});

test('deriveAtrScorePenalty applies TP1_STRETCHED -3', () => {
  const result = atr.deriveAtrScorePenalty({ atr14: 10, tp1_atr_class: 'TP1_STRETCHED' });
  assert.equal(result.atr_score_penalty, -3);
  assert.deepEqual(result.atr_penalty_reasons, ['TP1_STRETCHED:-3']);
});

test('deriveAtrScorePenalty applies TP2_STRETCHED -1', () => {
  const result = atr.deriveAtrScorePenalty({ atr14: 10, tp2_atr_class: 'TP2_STRETCHED' });
  assert.equal(result.atr_score_penalty, -1);
  assert.deepEqual(result.atr_penalty_reasons, ['TP2_STRETCHED:-1']);
});

test('deriveAtrScorePenalty caps combined ATR penalty at -7', () => {
  const result = atr.deriveAtrScorePenalty({
    atr14: 10,
    sl_atr_class: 'SL_TOO_TIGHT',
    tp1_atr_class: 'TP1_STRETCHED',
    tp2_atr_class: 'TP2_STRETCHED'
  });
  assert.equal(result.atr_score_penalty, -7);
  assert.ok(result.atr_penalty_reasons.includes('ATR_PENALTY_CAP:-7'));
});

test('deriveAtrScorePenalty returns no penalty when ATR unavailable', () => {
  const result = atr.deriveAtrScorePenalty({ sl_atr_class: 'SL_TOO_TIGHT', tp1_atr_class: 'TP1_STRETCHED' });
  assert.deepEqual(result, { atr_score_penalty: 0, atr_penalty_reasons: [], atr_risk_adjustment: 0 });
});

test('ATR penalty clamp keeps score from going below zero without blocking candidate', () => {
  const candidate = { atr14: 10, sl_atr_class: 'SL_TOO_TIGHT', tp1_atr_class: 'TP1_STRETCHED', tp2_atr_class: 'TP2_STRETCHED', status: 'Watchlist' };
  const penalty = atr.deriveAtrScorePenalty(candidate);
  const adjustedScore = Math.max(0, Math.min(100, 3 + penalty.atr_score_penalty));
  assert.equal(adjustedScore, 0);
  assert.equal(candidate.status, 'Watchlist');
});

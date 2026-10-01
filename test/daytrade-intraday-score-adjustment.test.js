'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-score-adjustment');

function candidate(extra) {
  return Object.assign({
    ticker: 'AAA',
    daytrade_score: 70,
    score: 50,
    intraday_score_adjustment_preview: 5,
    intraday_score_adjustment_reasons: ['VWAP_SUPPORT +3'],
    intraday_priority_label: 'INTRADAY_OK'
  }, extra || {});
}

test('flag absent means score unchanged', () => {
  const input = candidate();
  const output = lib.applyIntradayScoreAdjustment(input, { env: {} });
  assert.equal(output, input);
  assert.equal(output.daytrade_score, 70);
});

test('flag off means score unchanged', () => {
  const input = candidate();
  const output = lib.applyIntradayScoreAdjustment(input, { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '0' } });
  assert.equal(output, input);
  assert.equal(output.daytrade_score, 70);
});

test('flag on + positive adjustment changes score', () => {
  const output = lib.applyIntradayScoreAdjustment(candidate({ intraday_score_adjustment_preview: 7 }), { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.notEqual(output, candidate);
  assert.equal(output.daytrade_score, 77);
  assert.equal(output.base_daytrade_score, 70);
  assert.equal(output.intraday_score_adjustment_applied, 7);
  assert.deepEqual(output.intraday_score_adjustment_reasons, ['VWAP_SUPPORT +3']);
  assert.equal(output.intraday_priority_label, 'INTRADAY_OK');
});

test('flag on + negative adjustment changes score', () => {
  const output = lib.applyIntradayScoreAdjustment(candidate({ intraday_score_adjustment_preview: -8 }), { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.equal(output.daytrade_score, 62);
  assert.equal(output.intraday_score_adjustment_applied, -8);
});

test('cap at 100', () => {
  const output = lib.applyIntradayScoreAdjustment(candidate({ daytrade_score: 98, intraday_score_adjustment_preview: 10 }), { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.equal(output.daytrade_score, 100);
});

test('floor at 0', () => {
  const output = lib.applyIntradayScoreAdjustment(candidate({ daytrade_score: 3, intraday_score_adjustment_preview: -10 }), { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.equal(output.daytrade_score, 0);
});

test('missing adjustment means unchanged', () => {
  const input = candidate({ intraday_score_adjustment_preview: undefined });
  const output = lib.applyIntradayScoreAdjustment(input, { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.equal(output, input);
  assert.equal(output.daytrade_score, 70);
});

test('non-finite adjustment means unchanged', () => {
  for (const value of [Infinity, -Infinity, NaN, 'not-a-number']) {
    const input = candidate({ intraday_score_adjustment_preview: value });
    const output = lib.applyIntradayScoreAdjustment(input, { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
    assert.equal(output, input);
    assert.equal(output.daytrade_score, 70);
  }
});

test('uses score when daytrade_score is missing', () => {
  const output = lib.applyIntradayScoreAdjustment(candidate({ daytrade_score: undefined, score: 40, intraday_score_adjustment_preview: 4 }), { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.equal(output.score, 44);
  assert.equal(output.base_daytrade_score, 40);
});

test('list helper preserves list order and applies per candidate without sorting', () => {
  const rows = [candidate({ ticker: 'BBB', daytrade_score: 80, intraday_score_adjustment_preview: -10 }), candidate({ ticker: 'AAA', daytrade_score: 60, intraday_score_adjustment_preview: 30 })];
  const output = lib.applyIntradayScoreAdjustmentToList(rows, { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.deepEqual(output.map((r) => r.ticker), ['BBB', 'AAA']);
  assert.deepEqual(output.map((r) => r.daytrade_score), [70, 90]);
});

test('no unsupported persistence fields leak into DB payload mapping', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'api', 'sector-hot.js'), 'utf8');
  const start = source.indexOf('var batchRows = passedResults.map(function(r)');
  assert.notEqual(start, -1);
  const end = source.indexOf('var { error: insErr }', start);
  const mapping = source.slice(start, end);
  assert.equal(/base_daytrade_score/.test(mapping), false);
  assert.equal(/intraday_score_adjustment_applied/.test(mapping), false);
  assert.equal(/intraday_score_adjustment_reasons/.test(mapping), false);
  assert.equal(/intraday_priority_label/.test(mapping), false);
});

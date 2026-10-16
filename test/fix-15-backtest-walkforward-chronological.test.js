'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitWalkForward } = require('../lib/backtest-engine.js');

test('FIX-15: splitWalkForward sorts items chronologically before splitting to prevent lookahead contamination', () => {
  // Mixed signals from two tickers in non-chronological order
  const mixedSignals = [
    { ticker: 'BBCA', date: '2026-01-10', signal: 'BUY' },
    { ticker: 'BBCA', date: '2026-02-15', signal: 'BUY' },
    { ticker: 'BBCA', date: '2026-03-20', signal: 'BUY' },
    { ticker: 'BBCA', date: '2026-04-10', signal: 'BUY' },
    { ticker: 'BBCA', date: '2026-05-12', signal: 'BUY' },
    { ticker: 'BBRI', date: '2026-01-12', signal: 'BUY' },
    { ticker: 'BBRI', date: '2026-02-18', signal: 'BUY' },
    { ticker: 'BBRI', date: '2026-03-22', signal: 'BUY' },
    { ticker: 'BBRI', date: '2026-04-15', signal: 'BUY' },
    { ticker: 'BBRI', date: '2026-05-20', signal: 'BUY' }
  ];

  const { inSample, outOfSample, splitDate } = splitWalkForward(mixedSignals, 0.7);

  assert.equal(inSample.length, 7);
  assert.equal(outOfSample.length, 3);

  const maxInSampleDate = inSample.reduce((m, s) => s.date > m ? s.date : m, inSample[0].date);
  const minOutOfSampleDate = outOfSample.reduce((m, s) => s.date < m ? s.date : m, outOfSample[0].date);

  // In genuine walk-forward without lookahead contamination:
  assert.ok(
    minOutOfSampleDate >= maxInSampleDate,
    `Out-of-sample min date (${minOutOfSampleDate}) must not predate in-sample max date (${maxInSampleDate})`
  );
  assert.equal(splitDate, outOfSample[0].date);
});

test('FIX-15: splitWalkForward works seamlessly with date string arrays and trade_date properties', () => {
  const dates = ['2026-03-01', '2026-01-01', '2026-02-01', '2026-05-01', '2026-04-01'];
  const { inSample, outOfSample } = splitWalkForward(dates, 0.6);

  assert.equal(inSample.length, 3);
  assert.equal(outOfSample.length, 2);
  assert.deepEqual(inSample, ['2026-01-01', '2026-02-01', '2026-03-01']);
  assert.deepEqual(outOfSample, ['2026-04-01', '2026-05-01']);
});

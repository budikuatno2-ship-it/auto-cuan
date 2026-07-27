'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../tools/acquire-pattern-abcd-data');

function payload(timestamp = 1704074400, values = {}) {
  return { chart: { result: [{
    timestamp: [timestamp],
    indicators: { quote: [{
      open: [values.open ?? 10.123], high: [values.high ?? 12.129],
      low: [values.low ?? 9.001], close: [values.close ?? 11.555],
      volume: [values.volume ?? 20]
    }] }
  }] } };
}
function tickers(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('A' + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
  return out;
}

test('normalizes IDX/Yahoo tickers and rejects malformed symbols', () => {
  assert.equal(A.normalizeTicker(' bbca.jk '), 'BBCA');
  assert.equal(A.normalizeTicker('../x'), null);
});

test('Yahoo timestamps use the production Jakarta date policy rather than UTC midnight', () => {
  assert.equal(A.yahooDate(1704074400), '2024-01-01');
  assert.equal(A.yahooDate(1704042000), '2024-01-01');
  assert.equal(A.yahooDate('1704074400'), null);
  assert.equal(A.yahooDate(1.5), null);
});

test('Yahoo normalization rounds like /api/candles and rejects duplicate Jakarta dates', () => {
  const row = A.normalizeYahoo(payload(), { from: '2024-01-01', to: '2024-01-31' })[0];
  assert.deepEqual(row, { time: '2024-01-01', open: 10.12, high: 12.13, low: 9, close: 11.56, volume: 20 });
  const duplicate = payload();
  duplicate.chart.result[0].timestamp.push(1704042000);
  for (const key of ['open', 'high', 'low', 'close', 'volume']) duplicate.chart.result[0].indicators.quote[0][key].push(10);
  assert.throws(() => A.normalizeYahoo(duplicate), /duplicate_yahoo_date/);
});

test('date range and concurrency options are strict and completed-candle only', () => {
  const base = { from: '2024-01-01', to: '2024-01-31', limit: 30, minCandles: 1, concurrency: 3, now: new Date('2024-02-02T00:00:00Z') };
  assert.doesNotThrow(() => A.validateOptions(base));
  assert.throws(() => A.validateOptions({ ...base, from: '2024-02-30' }), /real YYYY-MM-DD/);
  assert.throws(() => A.validateOptions({ ...base, concurrency: Number.NaN }), /concurrency/);
  assert.throws(() => A.validateOptions({ ...base, to: '2024-02-02' }), /earlier than the current Jakarta date/);
});

test('bounded worker isolates failures without leaking raw exception text', async () => {
  let active = 0;
  let maximum = 0;
  const result = await A.mapBounded(['A', 'B', 'C'], 2, async value => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (value === 'B') throw new Error('PRIVATE /home/user/token');
    return value;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(result, [{ value: 'A' }, { error: 'fetch_failed' }, { value: 'C' }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token|\/home/);
});

test('run produces deterministic hashes and atomically removes stale dataset files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abcd-acquire-'));
  const universe = path.join(root, 'universe.txt');
  fs.writeFileSync(universe, tickers(30).join('\n') + '\n');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => payload() });
  const common = {
    universe,
    from: '2024-01-01',
    to: '2024-01-31',
    limit: 30,
    minCandles: 1,
    concurrency: 3,
    fetchFn: fakeFetch,
    now: new Date('2024-02-02T00:00:00Z')
  };
  const output1 = path.join(root, 'data1');
  const manifest1 = path.join(root, 'reports', 'm1.json');
  fs.mkdirSync(output1);
  fs.writeFileSync(path.join(output1, 'STALE.json'), 'stale');
  const first = await A.run({ ...common, output: output1, manifest: manifest1 });
  const output2 = path.join(root, 'data2');
  const manifest2 = path.join(root, 'reports', 'm2.json');
  const second = await A.run({ ...common, output: output2, manifest: manifest2 });
  assert.equal(first.datasetSha256, second.datasetSha256);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(fs.readFileSync(manifest1, 'utf8'), fs.readFileSync(manifest2, 'utf8'));
  assert.equal(fs.existsSync(path.join(output1, 'STALE.json')), false);
  assert.equal(fs.readdirSync(output1).filter(name => name.endsWith('.json')).length, 30);
  assert.equal('acquisitionDateUtc' in first, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('BUG-09: Prioritize actual trade session date over execution timestamp in daytrade runtime', async (t) => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'daytrade-runtime.js'), 'utf8');

  // Load into vm sandbox
  const sandbox = {
    document: {},
    window: {},
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const formatDtDisplayTimestamp = sandbox.formatDtDisplayTimestamp;
  assert.equal(typeof formatDtDisplayTimestamp, 'function', 'formatDtDisplayTimestamp must be defined');

  await t.test('1. prioritizes as_of_trade_date over calculated_at', () => {
    const meta = {
      as_of_trade_date: '2026-10-23',
      calculated_at: '2026-10-24T10:00:00.000Z'
    };
    const formatted = formatDtDisplayTimestamp(meta);
    assert.match(formatted, /Data Bursa: 23 Okt 2026/, 'Must display actual trade date');
    assert.match(formatted, /Dihitung:/, 'Must display calculated_at as secondary timestamp');
  });

  await t.test('2. supports trade_date and target_date aliases', () => {
    const meta1 = { trade_date: '2026-10-23' };
    const formatted1 = formatDtDisplayTimestamp(meta1);
    assert.match(formatted1, /Data Bursa: 23 Okt 2026/);

    const meta2 = { target_date: '2026-10-23' };
    const formatted2 = formatDtDisplayTimestamp(meta2);
    assert.match(formatted2, /Data Bursa: 23 Okt 2026/);
  });

  await t.test('3. falls back to calculated_at when trade date is absent', () => {
    const meta = {
      calculated_at: '2026-10-24T10:00:00.000Z'
    };
    const formatted = formatDtDisplayTimestamp(meta);
    assert.ok(!formatted.includes('Data Bursa:'), 'Must not include Data Bursa prefix when trade date missing');
    assert.ok(formatted !== '—');
  });

  await t.test('4. returns dash when meta is empty or null', () => {
    assert.equal(formatDtDisplayTimestamp(null), '—');
    assert.equal(formatDtDisplayTimestamp({}), '—');
  });
});

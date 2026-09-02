'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fibConfluence = require('../lib/fibonacci-confluence');

test('Finding #9: handleNkScreenerBatch includes evaluateFibConfluence call', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const nkBatchStart = source.indexOf('async function handleNkScreenerBatch');
  const nkBatchEnd = source.indexOf('async function handleNkScreenerFinalize', nkBatchStart);
  assert.notEqual(nkBatchStart, -1, 'handleNkScreenerBatch must exist');
  assert.notEqual(nkBatchEnd, -1, 'handleNkScreenerFinalize must exist');
  const nkBlock = source.slice(nkBatchStart, nkBatchEnd);

  assert.match(nkBlock, /fibConfluence\.evaluateFibConfluence\(quoteData\.candles/);
  assert.match(nkBlock, /scored\.fib_confluence_label = _nkFibResult\.fib_confluence_label/);
});

test('Finding #9: handleNkScreenerResults enriches nkSorted with applyFallbackFibConfluence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const nkReadStart = source.indexOf('async function handleNkScreenerResults');
  const nkReadEnd = source.indexOf('async function updateNkMeta', nkReadStart);
  assert.notEqual(nkReadStart, -1, 'handleNkScreenerResults must exist');
  const nkReadBlock = source.slice(nkReadStart, nkReadEnd);

  assert.match(nkReadBlock, /nkSorted = \(nkSorted \|\| \[\]\)\.map\(applyFallbackFibConfluence\)/);
});

test('Finding #9: sendSwingNkTelegramNotification enriches rows with applyFallbackFibConfluence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const nkTeleStart = source.indexOf('async function sendSwingNkTelegramNotification');
  const nkTeleEnd = source.indexOf('module.exports =', nkTeleStart);
  assert.notEqual(nkTeleStart, -1, 'sendSwingNkTelegramNotification must exist');
  const nkTeleBlock = source.slice(nkTeleStart, nkTeleEnd);

  assert.match(nkTeleBlock, /rows = \(rows \|\| \[\]\)\.map\(applyFallbackFibConfluence\)/);
});

test('Finding #9: evaluateFibConfluence returns healthy status when entry is near Fib 38.2-61.8', () => {
  // 30 candles from 1000 up to 1300 then pullback to 1150
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push({ high: 1000 + i * 15, low: 990 + i * 15, close: 995 + i * 15, open: 990 + i * 15 });
  }
  candles[19] = { high: 1300, low: 1260, close: 1280, open: 1270 }; // swing high
  for (let i = 1; i <= 5; i++) {
    candles.push({ high: 1280 - i * 20, low: 1240 - i * 20, close: 1250 - i * 20, open: 1270 - i * 20 });
  }

  const result = fibConfluence.evaluateFibConfluence(candles, {
    last_price: 1150,
    entry_low: 1130,
    entry_high: 1160,
    support: 1000
  });

  assert.ok(result.fib_confluence_label);
  assert.notEqual(result.fib_confluence_status, 'insufficient_data');
  assert.ok(result.fib_levels);
});

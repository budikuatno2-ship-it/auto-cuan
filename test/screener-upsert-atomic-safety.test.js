'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Finding #7: Swing Konglo uses atomic upsert and post-upsert stale cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const swingSaveStart = source.indexOf('if (upsertRows.length > 0) {');
  const swingSaveEnd = source.indexOf('// 5. Update meta — only mark ok if rows were saved', swingSaveStart);
  const swingBlock = source.slice(swingSaveStart, swingSaveEnd);

  // Must not have unqualified delete before upsert
  assert.equal(swingBlock.includes(".delete().neq('ticker', '')"), false, 'Must not delete all rows before upsert');
  assert.match(swingBlock, /from\('swing_screener_latest'\)[\s\S]*?\.upsert\(batch,\s*\{\s*onConflict:\s*'ticker'\s*\}\)/, 'Must upsert onConflict ticker');
  assert.match(swingBlock, /delete\(\)[\s\S]*?\.in\('ticker',\s*staleTickers\)/, 'Must prune stale tickers after upsert');
});

test('Finding #7: Day Trade batches use atomic upsert tagged with run_id without batch 0 wipe', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const dtBatchStart = source.indexOf('var passedResults = results.filter(function(r) { return r.daytrade_score >= 50; });');
  const dtBatchEnd = source.indexOf('// 8. Accumulate meta counts', dtBatchStart);
  const dtBatchBlock = source.slice(dtBatchStart, dtBatchEnd);

  // Must not delete on batchIndex === 0
  assert.equal(dtBatchBlock.includes('batchIndex === 0'), false, 'Must not wipe table on batchIndex === 0');
  assert.equal(dtBatchBlock.includes(".delete().neq('ticker', '')"), false, 'Must not delete table on batch 0');
  assert.match(dtBatchBlock, /from\('daytrade_screener_latest'\)\.upsert\(batchRows,\s*\{\s*onConflict:\s*'ticker'\s*\}\)/, 'Must upsert onConflict ticker');
  assert.match(dtBatchBlock, /run_id:\s*runId/, 'Must tag batchRows with runId');
});

test('Finding #7: finalizeDtScreener isolates current run_id and cleans up old run_id rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const finStart = source.indexOf('async function finalizeDtScreener');
  const finEnd = source.indexOf('function getDtRunningStartedAt', finStart);
  const finBlock = source.slice(finStart, finEnd);

  assert.match(finBlock, /r\.run_id === runId/, 'Must prioritize current run_id');
  assert.match(finBlock, /from\('daytrade_screener_latest'\)\.delete\(\)\.in\('ticker',\s*tickersToRemove\)/, 'Must trim non-top50 and stale run_id tickers');
});

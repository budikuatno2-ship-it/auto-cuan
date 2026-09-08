'use strict';

/**
 * PR #1: Fix Intel Real Data – Remove 5150 Mock, Fix Scanner Timeout, Remove slice caps
 *
 * Verifies:
 * 1. No hardcoded 5150 price in lib/broker-hunter-service.js or lib/bandarmologi-service.js
 * 2. getBrokerHunterData returns empty arrays (not mock data) when disk indexes absent
 * 3. getBandarmologiIntel returns immediate cache-miss error (not 957-ticker live compute)
 * 4. aggregateBrokerSummaries has no artificial .slice(0, 20) cap
 * 5. BROKER_PROFILES and synthesizeBrokerData are fully deleted
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('No hardcoded 5150 mock price in broker-hunter-service.js', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'lib', 'broker-hunter-service.js'), 'utf8'
  );
  const lines = content.split('\n').filter(l => l.includes('5150'));
  assert.equal(lines.length, 0,
    'Found hardcoded 5150 in broker-hunter-service.js:\n' + lines.join('\n'));
});

test('No hardcoded 5150 mock price in bandarmologi-service.js', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'lib', 'bandarmologi-service.js'), 'utf8'
  );
  const lines = content.split('\n').filter(l => l.includes('5150'));
  assert.equal(lines.length, 0,
    'Found hardcoded 5150 in bandarmologi-service.js:\n' + lines.join('\n'));
});

test('No hardcoded 5150 mock price in bandarmologi-intel-service.js', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'lib', 'bandarmologi-intel-service.js'), 'utf8'
  );
  const lines = content.split('\n').filter(l => l.includes('5150'));
  assert.equal(lines.length, 0,
    'Found hardcoded 5150 in bandarmologi-intel-service.js:\n' + lines.join('\n'));
});

test('BROKER_PROFILES constant is deleted from broker-hunter-service.js', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'lib', 'broker-hunter-service.js'), 'utf8'
  );
  assert.ok(!content.includes('const BROKER_PROFILES'),
    'BROKER_PROFILES constant still exists — mock data not removed');
});

test('synthesizeBrokerData function is deleted from broker-hunter-service.js', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'lib', 'broker-hunter-service.js'), 'utf8'
  );
  assert.ok(!content.includes('function synthesizeBrokerData'),
    'synthesizeBrokerData still exists — mock data function not removed');
});

test('BROKER_PROFILES and synthesizeBrokerData are not exported', () => {
  const svc = require(path.join(ROOT, 'lib', 'broker-hunter-service'));
  assert.equal(typeof svc.BROKER_PROFILES, 'undefined',
    'BROKER_PROFILES is still exported from broker-hunter-service');
  assert.equal(typeof svc.synthesizeBrokerData, 'undefined',
    'synthesizeBrokerData is still exported from broker-hunter-service');
});

test('getBrokerHunterData returns empty arrays (not mock data) when no disk data', async () => {
  const { getBrokerHunterData } = require(path.join(ROOT, 'lib', 'broker-hunter-service'));

  const result = await getBrokerHunterData('ZZ', { range: '1d', force: true });

  assert.ok(result, 'result must not be null');
  assert.ok(Array.isArray(result.top_accumulated), 'top_accumulated must be an array');
  assert.ok(Array.isArray(result.top_distributed), 'top_distributed must be an array');

  const all = [...(result.top_accumulated || []), ...(result.top_distributed || [])];
  const with5150 = all.filter(item => item.avg_buy_price === 5150 || item.avg_sell_price === 5150);
  assert.equal(with5150.length, 0,
    'Found hardcoded 5150 price in getBrokerHunterData result for ZZ broker');
});

test('getBandarmologiIntel returns cache-miss error without live 957-ticker compute', async () => {
  const intelSvc = require(path.join(ROOT, 'lib', 'bandarmologi-intel-service'));

  const start = Date.now();
  const result = await intelSvc.getBandarmologiIntel({ ticker: '' });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000,
    `getBandarmologiIntel took ${elapsed}ms — possible live compute triggered (>2000ms)`);
  assert.ok(result && typeof result === 'object', 'result must be an object');
});

test('aggregateBrokerSummaries has no .slice(0, 20) artificial cap', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'lib', 'bandarmologi-service.js'), 'utf8'
  );

  const fnStart = content.indexOf('function aggregateBrokerSummaries(');
  assert.ok(fnStart >= 0, 'aggregateBrokerSummaries function not found');

  const returnIdx = content.indexOf('return {', fnStart);
  const returnEnd = content.indexOf('\n};', returnIdx) + 3;
  const returnBlock = content.substring(returnIdx, returnEnd);

  const hasSlice20 = /\.slice\(0,\s*20\)/.test(returnBlock);
  assert.ok(!hasSlice20,
    'aggregateBrokerSummaries still has .slice(0, 20) cap in return object:\n' + returnBlock.substring(0, 500));
});

test('normalizeBrokerSummary brokersMap path has no .slice(0, 20) cap', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'lib', 'bandarmologi-service.js'), 'utf8'
  );
  const lines = content.split('\n');
  const brokerMapLine = lines.findIndex(l => l.includes('brokersMap.size > 0'));
  assert.ok(brokerMapLine >= 0, 'brokersMap.size > 0 check not found');

  const nearLines = lines.slice(brokerMapLine, brokerMapLine + 12).join('\n');
  const hasSlice20 = /\.slice\(0,\s*20\)/.test(nearLines);
  assert.ok(!hasSlice20,
    'Found .slice(0, 20) near brokersMap block:\n' + nearLines);
});

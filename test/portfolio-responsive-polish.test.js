'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-planner-v1.js'), 'utf8');
const planner = require(path.join(ROOT, 'public', 'portfolio-planner-v1.js'));

test('portfolio calculation contract remains unchanged after UI polish', () => {
  const result = planner.calculate({
    capitalIdr: '5000000',
    riskProfile: 'MEDIUM',
    riskBps: 100,
    reserveBps: 1000,
    maxPositions: 4,
    entryPriceIdr: '1000',
    stopLossIdr: '950',
    tp1Idr: '1100',
    tp2Idr: '1200'
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.recommendedLots.value, 9);
  assert.equal(result.result.positionValueIdr.value, 900000);
  assert.equal(result.result.estimatedStopLossIdr.value, 45000);
});

test('portfolio copy and checkbox receive the requested UI corrections', () => {
  assert.match(source, /ambil keputusan dengan lebih tenang\./);
  assert.match(source, /Sektor Hot Terbaru/);
  assert.match(source, /Ringkasan sektor dari cache server terakhir yang tersedia\./);
  assert.match(source, /portfolio-check-row/);
  assert.match(source, /#riskValid\{width:18px!important;height:18px!important;min-height:0!important/);
});

test('portfolio tabs wrap cleanly without sticky gradient or a document observer', () => {
  assert.match(source, /#app \.tabs\{position:static!important;[\s\S]*flex-wrap:wrap!important;[\s\S]*background:none!important/);
  assert.match(source, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(source, /new MutationObserver/);
});

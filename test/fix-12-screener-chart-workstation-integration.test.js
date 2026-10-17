'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Workstation = require('../public/chart-workstation.js');

test('FIX-12: AutoCuanChartWorkstation exports switchTicker supporting 1 and 3 arguments', () => {
  assert.equal(typeof Workstation.switchTicker, 'function', 'switchTicker must be exported on AutoCuanChartWorkstation');

  // Create an instance for testing
  const dummyCandles = [
    { time: '2026-10-01', open: 1000, high: 1050, low: 950, close: 1020, volume: 10000 },
    { time: '2026-10-02', open: 1020, high: 1060, low: 1010, close: 1050, volume: 12000 }
  ];
  Workstation.getOrCreateInstance('mainChart', dummyCandles, {}, 'BBCA');

  // Test 1-argument call: switchTicker('BBRI')
  const inst1 = Workstation.switchTicker('BBRI');
  assert.ok(inst1);
  assert.equal(inst1.ticker, 'BBRI');

  // Test 3-argument call: switchTicker('mainChart', 'ASII', { preset: 'scalping', planLevels: { entry: 5000, sl: 4800, tp1: 5300, tp2: 5500 } })
  const inst2 = Workstation.switchTicker('mainChart', 'ASII', {
    preset: 'scalping',
    planLevels: { entry: 5000, sl: 4800, tp1: 5300, tp2: 5500 }
  });
  assert.ok(inst2);
  assert.equal(inst2.ticker, 'ASII');
  assert.equal(inst2.state.activePreset, 'scalping');
  assert.deepEqual(inst2.options.planLevels, { entry: 5000, sl: 4800, tp1: 5300, tp2: 5500 });
});

test('FIX-12: public/index.html includes #scrDetailOpenChartBtn and openScreenerInChartWorkstation handler', () => {
  const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.match(indexHtml, /scrDetailOpenChartBtn/, 'Must contain button id #scrDetailOpenChartBtn');
  assert.match(indexHtml, /Buka di Chart Workstation/, 'Button label must indicate Chart Workstation');
  assert.match(indexHtml, /openScreenerInChartWorkstation/, 'Must define openScreenerInChartWorkstation');
});

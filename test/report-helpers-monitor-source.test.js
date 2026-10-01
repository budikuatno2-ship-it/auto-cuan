'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getMonitorSource } = require('../lib/report-helpers');

test('Finding #11: getMonitorSource resolves from row.monitor_source (physical DB column)', () => {
  assert.equal(getMonitorSource({ monitor_source: 'daytrade' }), 'daytrade');
  assert.equal(getMonitorSource({ monitor_source: 'daytrade_signal' }), 'daytrade');
  assert.equal(getMonitorSource({ monitor_source: 'day_trade' }), 'daytrade');
  assert.equal(getMonitorSource({ monitor_source: 'swing_konglo' }), 'swing_konglo');
  assert.equal(getMonitorSource({ monitor_source: 'swing_nk' }), 'swing_nk');
  assert.equal(getMonitorSource({ monitor_source: 'swing_non_konglo' }), 'swing_nk');
  assert.equal(getMonitorSource({ monitor_source: 'top5' }), 'top5');
  assert.equal(getMonitorSource({ monitor_source: 'daily_top5' }), 'top5');
  assert.equal(getMonitorSource({ monitor_source: 'watchlist' }), 'watchlist');
});

test('Finding #11: getMonitorSource falls back to raw_payload.monitor_source when row.monitor_source is absent', () => {
  assert.equal(getMonitorSource({ raw_payload: { monitor_source: 'daytrade_signal' } }), 'daytrade');
  assert.equal(getMonitorSource({ raw_payload: { monitor_source: 'swing_konglo' } }), 'swing_konglo');
  assert.equal(getMonitorSource({ raw_payload: { monitor_source: 'swing_nk' } }), 'swing_nk');
  assert.equal(getMonitorSource({ raw_payload: { monitor_source: 'daily_top5' } }), 'top5');
});

test('Finding #11: getMonitorSource falls back to category when both monitor_source fields are absent', () => {
  assert.equal(getMonitorSource({ category: 'Day Trade' }), 'daytrade');
  assert.equal(getMonitorSource({ category: 'Swing Konglo' }), 'swing_konglo');
  assert.equal(getMonitorSource({ category: 'Swing Non-Konglo' }), 'swing_nk');
  assert.equal(getMonitorSource({ category: 'Top 5 Daily' }), 'top5');
});

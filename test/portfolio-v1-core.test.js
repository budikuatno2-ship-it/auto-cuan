'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coreSource = fs.readdirSync(path.join(__dirname, '../public/core-parts')).sort((a,b) => Number(a.match(/part(\d+)/)[1]) - Number(b.match(/part(\d+)/)[1])).map((name) => fs.readFileSync(path.join(__dirname, '../public/core-parts', name), 'utf8')).join('');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(coreSource, sandbox);
const portfolio = sandbox.module.exports;

test('IDX lot conversion is exactly 100 shares', () => {
  assert.equal(portfolio.LOT_SIZE, 100);
  const result = portfolio.calculatePositionSize({ ticker: 'bbca', budget: 5_000_000, buyPrice: 9_000, stop: 8_730, target: 9_540, profile: 'sedang' });
  assert.equal(result.ok, true);
  assert.equal(result.shares, result.suggestedLots * 100);
});

test('affordable and risk-limited lots use the stricter limit', () => {
  const result = portfolio.calculatePositionSize({ ticker: 'BBCA', budget: 5_000_000, buyPrice: 9_000, stop: 8_730, target: 9_540, profile: 'sedang' });
  assert.equal(result.affordableLots, 5);
  assert.equal(result.riskLimitedLots, 1);
  assert.equal(result.suggestedLots, 1);
  assert.equal(result.purchaseValue, 900_000);
  assert.equal(result.maxLoss, 27_000);
});

test('invalid stop and target are rejected', () => {
  assert.equal(portfolio.calculatePositionSize({ ticker: 'BBCA', budget: 1_000_000, buyPrice: 1000, stop: 1000, profile: 'sedang' }).ok, false);
  assert.equal(portfolio.calculatePositionSize({ ticker: 'BBCA', budget: 1_000_000, buyPrice: 1000, stop: 900, target: 1000, profile: 'sedang' }).ok, false);
});

test('weighted average is correct', () => {
  assert.equal(portfolio.weightedAverage(1000, 2, 800, 1), (1000 * 2 + 800) / 3);
});

test('partial sale preserves remaining average and closes final lot', () => {
  const position = { ticker: 'BBCA', lots: 3, averageBuy: 1000, stop: 900, target: 1200, riskProfile: 'sedang' };
  const partial = portfolio.calculatePartialSale(position, 1, 1100);
  assert.equal(partial.ok, true);
  assert.equal(partial.realizedPL, 10_000);
  assert.equal(partial.remainingLots, 2);
  assert.equal(partial.remainingAverage, 1000);
  assert.equal(partial.closesPosition, false);
  const full = portfolio.calculatePartialSale(position, 3, 900);
  assert.equal(full.closesPosition, true);
  assert.equal(full.realizedPL, -30_000);
});

test('storage key isolates users and strips unsafe characters', () => {
  assert.notEqual(portfolio.storageKey('user-a'), portfolio.storageKey('user-b'));
  assert.equal(portfolio.storageKey(' A/B <script> '), 'autocuan_portfolio_v1_a_b__script_');
  assert.equal(portfolio.storageKey(''), null);
});

test('malformed storage safely returns empty state and invalid records are discarded', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(portfolio.parseStoredState('{bad'))), { version: 1, positions: [], history: [] });
  const state = portfolio.parseStoredState(JSON.stringify({ positions: [
    { ticker: '<img>', lots: 1, averageBuy: 1000, stop: 900, riskProfile: 'sedang' },
    { ticker: 'BBCA', lots: 1, averageBuy: 1000, stop: 900, riskProfile: 'sedang' }
  ] }));
  assert.equal(state.positions.length, 1);
  assert.equal(state.positions[0].ticker, 'BBCA');
});

test('ticker normalization and HTML escaping are safe', () => {
  assert.equal(portfolio.normalizeTicker(' bbca.jk '), 'BBCA');
  assert.equal(portfolio.normalizeTicker('<img>'), null);
  assert.equal(portfolio.escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

test('average-down simulation does not mutate input and blocks apply after invalidation', () => {
  const position = { ticker: 'BBCA', lots: 2, averageBuy: 1000, stop: 900, target: 1200, riskProfile: 'sedang', riskBudget: 2_000_000, lastPrice: 890 };
  const before = JSON.stringify(position);
  const sim = portfolio.simulateAverageDown(position, { price: 800, lots: 1 });
  assert.equal(sim.ok, true);
  assert.equal(sim.invalidated, true);
  assert.equal(sim.canApply, false);
  assert.equal(JSON.stringify(position), before);
  assert.equal(sim.newAverage, (1000 * 2 + 800) / 3);
});

test('quote acceptance preserves stale/T-1 metadata', () => {
  const q = portfolio.acceptQuote({ success: true, last: 950, price_stale: true, price_source: 'Yahoo close', price_date: '2026-07-24' });
  assert.deepEqual(JSON.parse(JSON.stringify(q)), { price: 950, stale: true, source: 'Yahoo close', date: '2026-07-24' });
  assert.equal(portfolio.acceptQuote({ success: false, last: 950 }), null);
});

test('portfolio summary excludes unavailable quote values instead of treating them as zero', () => {
  const positions = [
    { ticker: 'BBCA', lots: 1, averageBuy: 1000, stop: 900, target: 1200, riskProfile: 'sedang', lastPrice: 1100, priceStale: false, realizedPL: 0 },
    { ticker: 'TLKM', lots: 1, averageBuy: 3000, stop: 2800, target: 3400, riskProfile: 'rendah', lastPrice: null, priceStale: false, realizedPL: 0 }
  ];
  const summary = portfolio.portfolioSummary(positions);
  assert.equal(summary.invested, 400_000);
  assert.equal(summary.currentValue, 110_000);
  assert.equal(summary.pricedCost, 100_000);
  assert.equal(summary.unrealizedPL, 10_000);
  assert.equal(summary.unavailable, 1);
  assert.equal(summary.incomplete, true);
});

test('app shell injects only Portfolio V1 script and does not contain screener logic', () => {
  const shell = fs.readFileSync(path.join(__dirname, '../public/app-shell.html'), 'utf8');
  assert.match(shell, /portfolio-v1-loader\.js\?v=1/);
  assert.doesNotMatch(shell, /swing|konglo|daytrade_score|sector-hot/i);
});

test('Portfolio V1 source does not add API endpoints or subscription startup behavior', () => {
  const core = coreSource;
  const runtime = fs.readdirSync(path.join(__dirname, '../public/runtime-parts')).sort().map((name) => fs.readFileSync(path.join(__dirname, '../public/runtime-parts', name), 'utf8')).join('');
  assert.match(runtime, /\/api\/quote\?ticker=/);
  assert.doesNotMatch(core + runtime, /subscription|premium-access|voucher|midtrans/i);
  assert.doesNotMatch(core + runtime, /\/api\/[a-z-]+\.js/);
});

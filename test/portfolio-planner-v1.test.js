'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../public/portfolio-planner-v1.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'portfolio-planner.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

function valid(overrides) {
  return Object.assign({
    capitalIdr: 5000000,
    riskProfile: 'MEDIUM',
    riskBps: 100,
    reserveBps: 0,
    maxPositions: 4,
    entryPriceIdr: 250,
    stopLossIdr: 240,
    tp1Idr: 270,
    tp2Idr: 290
  }, overrides || {});
}

test('exports version and IDX lot size', () => {
  assert.equal(planner.VERSION, 'portfolio-planner-v1');
  assert.equal(planner.LOT_SIZE, 100);
});

test('calculates deterministic Rp5m MEDIUM sizing and rounds down to lots', () => {
  const out = planner.calculate(valid());
  assert.equal(out.ok, true);
  assert.equal(out.result.riskBudgetIdr.value, 50000);
  assert.equal(out.result.riskPerShareIdr.value, 10);
  assert.equal(out.result.sharesByRisk.value, 5000);
  assert.equal(out.result.sharesByCapital.value, 5000);
  assert.equal(out.result.recommendedShares.value, 5000);
  assert.equal(out.result.recommendedLots.value, 50);
  assert.equal(out.result.positionValueIdr.value, 1250000);
  assert.equal(out.result.estimatedStopLossIdr.value, 50000);
});

test('supports LOW, MEDIUM and HIGH presets', () => {
  for (const profile of ['LOW', 'MEDIUM', 'HIGH']) {
    const preset = planner.RISK_PRESETS[profile];
    const out = planner.calculate(valid({
      riskProfile: profile,
      riskBps: preset.defaultRiskBps,
      maxPositions: preset.defaultMaxPositions
    }));
    assert.equal(out.ok, true, profile);
  }
});

test('rejects stop equal to or above entry', () => {
  assert.equal(planner.calculate(valid({ stopLossIdr: 250 })).errors[0].code, 'STOP_NOT_BELOW_ENTRY');
  assert.equal(planner.calculate(valid({ stopLossIdr: 260 })).errors[0].code, 'STOP_NOT_BELOW_ENTRY');
});

test('rejects zero and negative money inputs', () => {
  assert.equal(planner.calculate(valid({ capitalIdr: 0 })).errors[0].code, 'INVALID_CAPITAL');
  assert.equal(planner.calculate(valid({ entryPriceIdr: -1 })).errors[0].code, 'INVALID_ENTRY');
  assert.equal(planner.calculate(valid({ stopLossIdr: 0 })).errors[0].code, 'INVALID_STOP');
});

test('enforces risk ceiling for each profile', () => {
  assert.equal(planner.calculate(valid({ riskProfile: 'LOW', riskBps: 101 })).errors[0].code, 'RISK_LIMIT_EXCEEDED');
  assert.equal(planner.calculate(valid({ riskProfile: 'MEDIUM', riskBps: 151 })).errors[0].code, 'RISK_LIMIT_EXCEEDED');
  assert.equal(planner.calculate(valid({ riskProfile: 'HIGH', riskBps: 201 })).errors[0].code, 'RISK_LIMIT_EXCEEDED');
});

test('applies cash reserve before sizing', () => {
  const out = planner.calculate(valid({ reserveBps: 2000 }));
  assert.equal(out.ok, true);
  assert.equal(out.result.usableCapitalIdr.value, 4000000);
  assert.equal(out.result.riskBudgetIdr.value, 40000);
  assert.equal(out.result.maxPositionCapitalIdr.value, 1000000);
});

test('uses the stricter of risk and capital limits', () => {
  const riskLimited = planner.calculate(valid({ maxPositions: 1, riskBps: 50 }));
  assert.equal(riskLimited.ok, true);
  assert.equal(riskLimited.result.recommendedShares.value, 2500);

  const capitalLimited = planner.calculate(valid({ maxPositions: 5, riskBps: 150 }));
  assert.equal(capitalLimited.ok, true);
  assert.equal(capitalLimited.result.recommendedShares.value, 4000);
});

test('returns no-lot error when capital or risk is insufficient', () => {
  const out = planner.calculate(valid({
    capitalIdr: 10000,
    entryPriceIdr: 1000,
    stopLossIdr: 999,
    tp1Idr: '',
    tp2Idr: ''
  }));
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, 'INSUFFICIENT_FOR_ONE_LOT');
});

test('calculates TP reward/risk without floating-point money math', () => {
  const out = planner.calculate(valid());
  assert.equal(out.result.rewardRiskTp1.bps, 20000);
  assert.equal(out.result.rewardRiskTp2.bps, 40000);
});

test('rejects invalid target ordering', () => {
  assert.equal(planner.calculate(valid({ tp1Idr: 250 })).errors[0].code, 'TP1_NOT_ABOVE_ENTRY');
  assert.equal(planner.calculate(valid({ tp1Idr: 280, tp2Idr: 270 })).errors[0].code, 'TP2_NOT_ABOVE_TP1');
});

test('supports large integer values with BigInt calculations', () => {
  const out = planner.calculate(valid({
    capitalIdr: '900719925474000',
    entryPriceIdr: '1000000',
    stopLossIdr: '990000',
    maxPositions: 20,
    riskProfile: 'HIGH',
    riskBps: 200,
    tp1Idr: '',
    tp2Idr: ''
  }));
  assert.equal(out.ok, true);
  assert.match(out.result.positionValueIdr.exact, /^\d+$/);
  assert.match(out.result.estimatedStopLossIdr.exact, /^\d+$/);
});

test('planner access is decided by the signed approval endpoint', () => {
  assert.match(html, /fetchWithTimeout\('\/api\/admin-users'/);
  assert.match(html, /action:'portfolio_access'/);
  assert.match(html, /credentials:'same-origin'/);
  // The bounded gate always resolves into content or a retry state.
  assert.match(html, /var ACCESS_TIMEOUT_MS=9000/);
  assert.match(html, /Portfolio belum berhasil dibuka/);
});

test('planner never trusts browser-supplied identity for authorization', () => {
  // The local-data namespace comes from the server response (state.uid), and
  // localStorage writes are UI persistence only — the API session decides.
  assert.match(html, /state\.uid=String\(data\.user_id\)/);
  assert.match(html, /'autocuan_portfolio_plans_'\+state\.uid/);
  assert.doesNotMatch(html, /localStorage\.getItem\('autocuan_user_id'\)[^\n]{0,80}portfolio_access/);
});

test('browser receives no service-role secret and creates no broker order', () => {
  assert.doesNotMatch(html, /SUPABASE_SERVICE_ROLE_KEY|service[_-]?role|MIDTRANS|brokerage|placeOrder|buyOrder|sellOrder/i);
  assert.match(html, /tidak membuat order ke broker/i);
});

test('confirmed plan uses the existing per-user manual portfolio key', () => {
  assert.match(html, /autocuan_portfolio_/);
  assert.match(html, /autocuan_user_id/);
  assert.match(html, /window\.AutoCuanPortfolioPlannerV1\.calculate/);
});

test('vercel route exposes only the isolated preview page', () => {
  // Portfolio Planner v2 rollout: the clean URL now serves the v2 command-center
  // file; portfolio-planner.html remains on disk (still cache-header-configured
  // in vercel.json) but is no longer the routed destination.
  const route = vercel.rewrites.find((item) => item.source === '/portfolio-planner');
  assert.deepEqual(route, { source: '/portfolio-planner', destination: '/portfolio-command-center-v2.html' });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function model() {
  const file = path.join(ROOT, 'public', 'portfolio-command-center-model.js');
  delete require.cache[require.resolve(file)];
  return require(file);
}

test('command center v2 assets parse and route from portfolio-planner', () => {
  const html = read('public/portfolio-command-center-v2.html');
  const legacyHtml = read('public/portfolio-command-center.html');
  const ui = read('public/portfolio-command-center.js');
  const pure = read('public/portfolio-command-center-model.js');
  const scenarios = read('public/portfolio-position-scenarios.js');
  const stability = read('public/ui-stability-fix.js');
  const runtimeFix = read('public/portfolio-runtime-fix.js');
  const css = read('public/portfolio-command-center.css');
  const vercel = JSON.parse(read('vercel.json'));
  new vm.Script(ui, { filename: 'portfolio-command-center.js' });
  new vm.Script(pure, { filename: 'portfolio-command-center-model.js' });
  new vm.Script(scenarios, { filename: 'portfolio-position-scenarios.js' });
  new vm.Script(stability, { filename: 'ui-stability-fix.js' });
  new vm.Script(runtimeFix, { filename: 'portfolio-runtime-fix.js' });
  const route = (vercel.rewrites || []).find((row) => row.source === '/portfolio-planner');
  assert.ok(route);
  assert.equal(route.destination, '/portfolio-command-center-v2.html');
  assert.match(html, /Portfolio Command Center/);
  assert.match(html, /fetch\('\/portfolio-command-center\.html\?v=/);
  assert.match(html, /\/ui-stability-fix\.js\?v=/);
  assert.match(html, /\/portfolio-runtime-fix\.js\?v=20260728-portfolio-runtime-fix-v1/);
  assert.match(legacyHtml, /Budget-to-Stock Planner/);
  assert.match(legacyHtml, /Skenario Posisi/);
  assert.match(legacyHtml, /Trading Journal/);
  assert.match(stability, /PORTFOLIO COPILOT/);
  for (const key of ['today:', 'planner:', 'watch:', 'risk:', 'scenarios:', 'journal:', 'ai:']) assert.match(stability, new RegExp(key));
  assert.match(stability, /pruneStandaloneArtifacts/);
  assert.match(stability, /\.tab-strip\{top:10px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(html + legacyHtml + ui + scenarios + stability + runtimeFix, /document\.write\(|\beval\(|new Function\(/);
});

test('access stays server-verified and uses existing APIs only', () => {
  const ui = read('public/portfolio-command-center.js');
  const scenarios = read('public/portfolio-position-scenarios.js');
  const runtimeFix = read('public/portfolio-runtime-fix.js');
  assert.match(ui, /ACCESS_TIMEOUT_MS = 9000/);
  assert.match(ui, /action: 'portfolio_access'/);
  assert.match(ui, /credentials: 'same-origin'/);
  assert.match(scenarios, /action=screener/);
  assert.match(scenarios, /action=nk-screener-results/);
  assert.match(scenarios, /action=daytrade-screener/);
  assert.match(scenarios, /\/api\/quote\?ticker=/);
  assert.doesNotMatch(ui + scenarios + runtimeFix, /broker-order|telegram|supabase\.from|createOrder/i);
});

test('legacy Portfolio plans receive stable IDs and delete is intercepted before the broken handler', () => {
  const runtimeFix = read('public/portfolio-runtime-fix.js');
  assert.match(runtimeFix, /function stableLegacyId/);
  assert.match(runtimeFix, /if \(plan\.id != null && String\(plan\.id\)\.trim\(\)\) return plan/);
  assert.match(runtimeFix, /id:stableLegacyId\(plan, index, used\)/);
  assert.match(runtimeFix, /doc\.addEventListener\('click',[\s\S]*true\)/);
  assert.match(runtimeFix, /event\.stopImmediatePropagation\(\)/);
  assert.match(runtimeFix, /legacyFallback = !planId && requestedTicker && planTicker === requestedTicker/);
  assert.match(runtimeFix, /berhasil dihapus/);
  assert.match(runtimeFix, /\^0\\s\+perubahan\\s\+dicatat/);
});

test('rupiah input parser accepts formatted Indonesian currency', () => {
  const m = model();
  assert.equal(m.finite('Rp 5.000.000'), 5_000_000);
  const capacity = m.budgetCapacity({ capitalIdr: 'Rp 5.000.000', reservePct: 10, maxPositions: 4 });
  assert.equal(capacity.ok, true);
  assert.equal(capacity.usableCapitalIdr, 4_500_000);
  assert.equal(capacity.positionBudgetIdr, 1_125_000);
  assert.equal(capacity.maxPriceOneLotIdr, 11_250);
  assert.equal(capacity.maxPriceTwoLotsIdr, 5_625);
  assert.equal(capacity.maxPriceFourLotsIdr, 2_812);
});

test('affordability produces deterministic lot capacity', () => {
  const m = model();
  const capacity = m.budgetCapacity({ capitalIdr: 5_000_000, reservePct: 10, maxPositions: 4 });
  const fit = m.affordability(1_000, capacity);
  assert.equal(fit.lots, 11);
  assert.equal(fit.positionValueIdr, 1_100_000);
  assert.equal(fit.label, 'Leluasa');
});

test('average down guard returns cut loss when stop is touched', () => {
  const m = model();
  const decision = m.averageDownDecision({
    plan: { ticker:'BBRI', entryPriceIdr:5000, stopLossIdr:4800, lots:3 },
    currentPriceIdr: 4790,
    addLots: 1,
    availableFundsIdr: 1_000_000,
    riskLimitIdr: 200_000,
    setupValid: true
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'CUT_LOSS');
  assert.match(decision.action, /CUT LOSS/);
});

test('average down guard blocks invalid setup, insufficient funds, and excess risk', () => {
  const m = model();
  const plan = { ticker:'BBRI', entryPriceIdr:5000, stopLossIdr:4500, lots:2 };
  assert.equal(m.averageDownDecision({ plan, currentPriceIdr:4700, addLots:1, availableFundsIdr:1_000_000, riskLimitIdr:300_000, setupValid:false }).code, 'SETUP_INVALID');
  assert.equal(m.averageDownDecision({ plan, currentPriceIdr:4700, addLots:3, availableFundsIdr:100_000, riskLimitIdr:300_000, setupValid:true }).code, 'INSUFFICIENT_FUNDS');
  assert.equal(m.averageDownDecision({ plan, currentPriceIdr:4700, addLots:3, availableFundsIdr:2_000_000, riskLimitIdr:100_000, setupValid:true }).code, 'RISK_LIMIT');
});

test('average down guard allows manual review only when every guard passes', () => {
  const m = model();
  const decision = m.averageDownDecision({
    plan: { ticker:'BBRI', entryPriceIdr:5000, stopLossIdr:4500, lots:2 },
    currentPriceIdr: 4700,
    addLots: 1,
    availableFundsIdr: 1_000_000,
    riskLimitIdr: 200_000,
    setupValid: true
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, 'AVG_DOWN_REVIEW');
  assert.equal(decision.totalLots, 3);
  assert.equal(Math.round(decision.newAveragePriceIdr), 4900);
});

test('scenario module formats money, keeps Quick calculations local, and overrides the old generic guard', () => {
  const source = read('public/portfolio-position-scenarios.js');
  assert.match(source, /formatMoneyInput/);
  assert.match(source, /Rp ' \+ Number\(raw\)\.toLocaleString\('id-ID'\)/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /Model\.averageDownDecision/);
  assert.match(source, /AVG DOWN BOLEH DIREVIEW/);
  assert.match(source, /\(plan\.stop - plan\.entry\) \* shares/);
  assert.match(source, /tp1Result \/ riskAbs/);
  assert.doesNotMatch(source, /sendTelegram|createOrder|broker/i);
});

test('status and snapshot logic remain deterministic', () => {
  const m = model();
  const plan = { ticker:'BBRI', entryPriceIdr:5000, stopLossIdr:4800, tp1Idr:5300, tp2Idr:5600, lots:2 };
  assert.equal(m.planStatus(plan, null).code, 'NO_PRICE');
  assert.equal(m.planStatus(plan, 4790).code, 'STOP_TOUCHED');
  assert.equal(m.planStatus(plan, 5300).code, 'TP1_TOUCHED');
  const previous = { rows:{ BBRI:{ price:5000, status:'ACTIVE', risk:40000 } } };
  const current = { rows:{ BBRI:{ price:5100, status:'NEAR_TP1', risk:40000 }, TLKM:{ price:3000, status:'ACTIVE', risk:20000 } } };
  const events = m.compareSnapshots(previous, current);
  assert.ok(events.some((row) => row.type === 'STATUS_CHANGED' && row.ticker === 'BBRI'));
  assert.ok(events.some((row) => row.type === 'PLAN_ADDED' && row.ticker === 'TLKM'));
});

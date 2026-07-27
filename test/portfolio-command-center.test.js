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

test('command center assets parse and expose one secure production route', () => {
  const html = read('public/portfolio-command-center.html');
  const ui = read('public/portfolio-command-center.js');
  const pure = read('public/portfolio-command-center-model.js');
  const scenarios = read('public/portfolio-position-scenarios.js');
  const css = read('public/portfolio-command-center.css');
  const vercel = JSON.parse(read('vercel.json'));
  new vm.Script(ui, { filename: 'portfolio-command-center.js' });
  new vm.Script(pure, { filename: 'portfolio-command-center-model.js' });
  new vm.Script(scenarios, { filename: 'portfolio-position-scenarios.js' });
  const route = (vercel.rewrites || []).find((row) => row.source === '/portfolio-planner');
  assert.ok(route);
  assert.equal(route.destination, '/portfolio-command-center.html');
  assert.match(html, /href="\/dashboard"/);
  assert.match(html, /portfolio-command-center\.js\?v=/);
  assert.match(html, /portfolio-command-center-model\.js\?v=/);
  assert.match(html, /portfolio-position-scenarios\.js\?v=/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(html + ui + scenarios, /document\.write\(|\beval\(|new Function\(/);
});

test('command center keeps approval access and existing APIs only', () => {
  const ui = read('public/portfolio-command-center.js');
  const scenarios = read('public/portfolio-position-scenarios.js');
  assert.match(ui, /var ACCESS_TIMEOUT_MS = 9000/);
  assert.match(ui, /body: JSON\.stringify\(\{ action: 'portfolio_access' \}\)/);
  assert.match(ui, /retryAccess/);
  assert.match(ui, /credentials: 'same-origin'/);
  const endpoints = [...ui.matchAll(/fetch(?:WithTimeout)?\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(endpoints)].sort(), ['/api/admin-users', '/api/quote?ticker=', '/api/sector-hot']);
  assert.match(ui, /fetch\('\/api\/quote\?ticker='/);
  assert.doesNotMatch(ui + scenarios, /supabase|voucher|subscription|broker-order/i);
  assert.doesNotMatch(scenarios, /fetch\(|telegram|push notification/i);
});

test('command center contains one coherent decision workflow', () => {
  const html = read('public/portfolio-command-center.html');
  ['today','planner','watch','risk','scenarios','journal','ai'].forEach((name) => {
    assert.match(html, new RegExp('data-tab="' + name + '"'));
    assert.match(html, new RegExp('id="page-' + name + '"'));
  });
  assert.match(html, /Budget-to-Stock Planner/);
  assert.match(html, /Apa yang Berubah\?/);
  assert.match(html, /Ticker Intelligence/);
  assert.match(html, /Trading Journal/);
  assert.match(html, /Skenario Posisi/);
  assert.doesNotMatch(html, />Pengingat Harga</);
  assert.doesNotMatch(html, />Export JSON</);
  assert.match(html, /id="exportJournal" class="hidden"/);
  ['aiMessages','aiInput','aiSend','aiClear','aiStatus','aiPlanCount','aiWithPrice','aiMissingPrice','aiTotalRisk','aiTotalValue','aiDataQuality'].forEach((id) => assert.match(html, new RegExp('id="' + id + '"')));
});

test('position scenarios calculate stop, TP, RR, and staged exits locally', () => {
  const source = read('public/portfolio-position-scenarios.js');
  assert.match(source, /\(plan\.stop - plan\.entry\) \* shares/);
  assert.match(source, /\(plan\.tp1 - plan\.entry\) \* shares/);
  assert.match(source, /\(plan\.tp2 - plan\.entry\) \* shares/);
  assert.match(source, /tp1Result \/ riskAbs/);
  assert.match(source, /tp2Result \/ riskAbs/);
  assert.match(source, /tp1Lots = Math\.floor\(plan\.lots \* tp1Pct \/ 100\)/);
  assert.match(source, /Simulasi, bukan order otomatis/);
});

test('budget capacity and affordability are deterministic', () => {
  const m = model();
  const capacity = m.budgetCapacity({ capitalIdr: 5_000_000, reservePct: 10, maxPositions: 4 });
  assert.equal(capacity.ok, true);
  assert.equal(capacity.usableCapitalIdr, 4_500_000);
  assert.equal(capacity.positionBudgetIdr, 1_125_000);
  assert.equal(capacity.maxPriceOneLotIdr, 11_250);
  assert.equal(capacity.maxPriceTwoLotsIdr, 5_625);
  assert.equal(capacity.maxPriceFourLotsIdr, 2_812);
  const fit = m.affordability(1_000, capacity);
  assert.equal(fit.lots, 11);
  assert.equal(fit.positionValueIdr, 1_100_000);
  assert.equal(fit.label, 'Leluasa');
});

test('portfolio status prioritizes stop, targets, and missing data safely', () => {
  const m = model();
  const plan = { ticker:'BBRI', entryPriceIdr:5000, stopLossIdr:4800, tp1Idr:5300, tp2Idr:5600, lots:2 };
  assert.equal(m.planStatus(plan, null).code, 'NO_PRICE');
  assert.equal(m.planStatus(plan, 4790).code, 'STOP_TOUCHED');
  assert.equal(m.planStatus(plan, 5300).code, 'TP1_TOUCHED');
  assert.equal(m.planStatus(plan, 5600).code, 'TP2_TOUCHED');
  assert.equal(m.planStatus(plan, 4970).code, 'BELOW_ENTRY');
});

test('snapshot comparison records material changes without inventing signals', () => {
  const m = model();
  const previous = { rows:{ BBRI:{ price:5000, status:'ACTIVE', risk:40000 } } };
  const current = { rows:{ BBRI:{ price:5100, status:'NEAR_TP1', risk:40000 }, TLKM:{ price:3000, status:'ACTIVE', risk:20000 } } };
  const events = m.compareSnapshots(previous, current);
  assert.ok(events.some((row) => row.type === 'STATUS_CHANGED' && row.ticker === 'BBRI'));
  assert.ok(events.some((row) => row.type === 'PRICE_CHANGED' && row.ticker === 'BBRI'));
  assert.ok(events.some((row) => row.type === 'PLAN_ADDED' && row.ticker === 'TLKM'));
});

test('journal summary measures recorded discipline only', () => {
  const m = model();
  const summary = m.journalSummary([
    { action:'ENTRY', followedPlan:true }, { action:'TP1', followedPlan:true },
    { action:'STOP', followedPlan:false }, { action:'REVIEW', followedPlan:null }
  ]);
  assert.equal(summary.entries, 1);
  assert.equal(summary.positive, 1);
  assert.equal(summary.stopped, 1);
  assert.equal(summary.assessed, 3);
  assert.equal(Math.round(summary.disciplinePct), 67);
});
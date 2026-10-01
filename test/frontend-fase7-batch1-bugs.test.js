'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PositionSizing = require('../public/position-sizing-calculator.js');
const CommandModel = require('../public/portfolio-command-center-model.js');
const PlannerV1 = require('../public/portfolio-planner-v1.js');

const scenariosSource = fs.readFileSync(path.join(__dirname, '../public/portfolio-position-scenarios.js'), 'utf8');

const tests = [
  {
    name: 'BUG-F7-001: sanitizeNumber strips decimal point when input has 3 decimals (e.g. 0.500% risk becomes 500%)',
    fn: () => {
      const calc = PositionSizing.calculate({
        capital: 10000000,
        riskPct: '0.500',
        entry: 1000,
        sl: 950
      });
      assert.strictEqual(calc.riskPct, 0.5, `Expected riskPct 0.5, got ${calc.riskPct}`);
    }
  },
  {
    name: 'BUG-F7-002: PositionSizing accepts non-IDX tick prices without normalization/validation',
    fn: () => {
      const calc = PositionSizing.calculate({
        capital: 10000000,
        riskPct: 1.0,
        entry: 205,
        sl: 200
      });
      assert.strictEqual(calc.isValid, false, 'Expected entry 205 to be rejected or flagged due to invalid IDX tick size');
    }
  },
  {
    name: 'BUG-F7-003: CommandModel.normalizePlan accepts entry == stopLoss and inverted setups',
    fn: () => {
      const normalized = CommandModel.normalizePlan({
        ticker: 'BBCA',
        entryPriceIdr: 1000,
        stopLossIdr: 1000,
        lots: 10
      });
      assert.strictEqual(normalized, null, 'Expected normalizePlan to reject plan where entry <= stopLoss');
    }
  },
  {
    name: 'BUG-F7-004: CommandModel.summarize reports totalRiskIdr = 0 when estimatedMaxLossIdr is not preset',
    fn: () => {
      const summary = CommandModel.summarize([
        { ticker: 'BBCA', entryPriceIdr: 1000, stopLossIdr: 900, lots: 10 }
      ], { BBCA: 1000 });
      assert.strictEqual(summary.totalRiskIdr, 100000, `Expected totalRiskIdr 100000 IDR, got ${summary.totalRiskIdr}`);
    }
  },
  {
    name: 'BUG-F7-005: portfolio-position-scenarios simulates stop loss as profit when stop > entry',
    fn: () => {
      const dom = {
        scenarioList: { className: '', innerHTML: '' },
        scenarioStopTotal: { textContent: '' },
        scenarioTp1Pct: { value: '50' }
      };
      const mockWindow = {
        AutoCuanPortfolioCommandModel: CommandModel,
        localStorage: {
          getItem: (k) => {
            if (k === 'autocuan_user_id') return 'u1';
            if (k === 'autocuan_portfolio_plans_u1') return JSON.stringify([{ ticker: 'BBCA', entryPriceIdr: 1000, stopLossIdr: 1100, lots: 1 }]);
            if (k === 'autocuan_portfolio_prices_u1') return JSON.stringify({ BBCA: 1050 });
            return null;
          },
          setItem: () => {}
        }
      };
      const mockDoc = {
        getElementById: (id) => dom[id] || null,
        addEventListener: () => {},
        querySelectorAll: () => []
      };
      const runner = new Function('window', 'document', 'localStorage', scenariosSource);
      runner(mockWindow, mockDoc, mockWindow.localStorage);

      assert.ok(
        dom.scenarioStopTotal.textContent.includes('−') || dom.scenarioStopTotal.textContent === '—',
        `Expected stop total to be negative/invalid, but got: ${dom.scenarioStopTotal.textContent}`
      );
    }
  },
  {
    name: 'BUG-F7-006: PortfolioPlannerV1 calculate accepts non-tick prices on regular board',
    fn: () => {
      const res = PlannerV1.calculate({
        riskProfile: 'MEDIUM',
        capitalIdr: '10000000',
        entryPriceIdr: '205',
        stopLossIdr: '200'
      });
      assert.strictEqual(res.ok, false, 'Expected calculate to reject entryPriceIdr: 205 due to IDX tick violation');
    }
  }
];

let failed = 0;
console.log('--- RUNNING PHASE 7 BATCH 1 REPRODUCTION TESTS ---');
for (const t of tests) {
  try {
    t.fn();
    console.log(`[PASS] ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`[FAIL] ${t.name}`);
    console.log(`       Error: ${err.message}`);
  }
}
console.log(`\nResult: ${failed}/${tests.length} tests failed (expected failing reproductions).`);
if (failed > 0) {
  process.exit(1);
}

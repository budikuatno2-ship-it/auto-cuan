'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TrackRecord = require('../lib/track-record-service.js');
const Watchlist = require('../lib/user-watchlist-service.js');
const StateHandler = require('../lib/portfolio-state-handler.js');

const aiRuntimeSource = fs.readFileSync(path.join(__dirname, '../public/portfolio-ai-runtime-v2.js'), 'utf8');

const tests = [
  {
    name: 'BUG-F7-012: buildTrackRecordData corrupts summary metrics when an anomaly signal (>500% gain) is skipped',
    fn: () => {
      const rows = [
        {
          ticker: 'CORRUPT',
          entry1: 100,
          tp1: 1000,
          outcome: 'TP1_HIT',
          source: 'daytrade'
        }
      ];
      const result = TrackRecord.buildTrackRecordData(rows);
      assert.strictEqual(
        result.summary.total_signals,
        result.signals.length,
        `Expected total_signals (${result.summary.total_signals}) to match signals array length (${result.signals.length})`
      );
    }
  },
  {
    name: 'BUG-F7-013: buildTrackRecordData attributes best_gain to NEVER_ENTERED or EXPIRED signal',
    fn: () => {
      const rows = [
        {
          ticker: 'UNTOUCHED',
          entry1: 1000,
          high: 1500,
          outcome: 'NEVER_ENTERED',
          source: 'daytrade'
        }
      ];
      const result = TrackRecord.buildTrackRecordData(rows);
      assert.strictEqual(
        result.summary.best_gain,
        null,
        `Expected best_gain to be null for NEVER_ENTERED signal, but got ${JSON.stringify(result.summary.best_gain)}`
      );
    }
  },
  {
    name: 'BUG-F7-014: createAlert permits ENTRY_ZONE/TP_HIT/SL_HIT with null target_price, resulting in dead alerts',
    fn: async () => {
      const mockDb = {
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
          insert: (rec) => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'alert-test', ...rec } }) }) })
        })
      };
      const res = await Watchlist.createAlert(mockDb, 'user-123', {
        ticker: 'BBCA',
        condition_type: 'TP_HIT'
      });
      assert.strictEqual(
        res.success,
        false,
        'Expected createAlert to reject TP_HIT when target_price is missing or null'
      );
    }
  },
  {
    name: 'BUG-F7-015: hasPortfolioData throws unhandled 413 error instead of returning boolean on oversized state',
    fn: () => {
      const hasPortfolioData = StateHandler.__test.hasPortfolioData;
      const oversizedState = {
        plans: Array.from({ length: 150 }, () => ({
          ticker: 'BBCA',
          data: 'X'.repeat(3000)
        }))
      };
      let result;
      try {
        result = hasPortfolioData(oversizedState);
      } catch (err) {
        assert.fail(`hasPortfolioData threw uncaught exception: ${err.message}`);
      }
      assert.strictEqual(typeof result, 'boolean', 'Expected hasPortfolioData to return a boolean');
    }
  },
  {
    name: 'BUG-F7-016: portfolio-ai-runtime-v2 syncPortfolioPrices uses context.plans capped at 30, starving positions > 30',
    fn: async () => {
      const fetchedTickers = [];
      const mockStorage = {
        autocuan_user_id: 'u1',
        autocuan_user: 'testuser',
        autocuan_portfolio_plans_u1: JSON.stringify(
          Array.from({ length: 35 }, (_, i) => ({
            ticker: `TK${String(i + 1).padStart(2, '0')}`,
            entryPriceIdr: 1000,
            stopLossIdr: 900,
            lots: 1
          }))
        ),
        autocuan_portfolio_prices_u1: JSON.stringify({}),
        autocuan_portfolio_price_sync_v2_u1: '0'
      };

      const mockWindow = {
        __AUTOCUAN_PORTFOLIO_ACCESS__: { userId: 'u1', username: 'testuser' },
        localStorage: {
          getItem: (k) => mockStorage[k] || null,
          setItem: (k, v) => { mockStorage[k] = String(v); }
        },
        document: {
          getElementById: () => null,
          querySelector: () => null,
          querySelectorAll: () => [],
          readyState: 'complete',
          addEventListener: () => {}
        },
        fetch: async (url) => {
          const match = url.match(/ticker=([^&]+)/);
          if (match) fetchedTickers.push(decodeURIComponent(match[1]));
          return {
            ok: true,
            json: async () => ({ success: true, last: 1000 })
          };
        }
      };

      const runner = new Function('window', 'document', 'localStorage', 'fetch', aiRuntimeSource);
      runner(mockWindow, mockWindow.document, mockWindow.localStorage, mockWindow.fetch);

      await new Promise((r) => setTimeout(r, 80));

      assert.strictEqual(
        fetchedTickers.length,
        35,
        `Expected all 35 distinct portfolio tickers to be fetched, but only ${fetchedTickers.length} were synced`
      );
    }
  }
];

async function runAll() {
  let failed = 0;
  console.log('=== RUNNING FRONTEND FASE 7 BATCH 3 BUG REPRODUCTION TESTS ===\n');
  for (const t of tests) {
    try {
      await t.fn();
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
}

runAll();

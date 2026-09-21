const assert = require('assert');
const historyStore = require('../lib/stock-daily-history-store');

async function run() {
  console.log('Running stock-daily-history-store bug reproduction tests...');

  // BUG-SDHS-01: getLatestSessionsForTickers orders globally by trade_date DESC across multi-ticker batch,
  // causing older or less-active tickers to lose rows or be completely starved by active tickers.
  {
    let capturedQuery = {};
    const mockSupabase = {
      from: (table) => ({
        select: (cols) => ({
          in: (col, val) => ({
            order: (ordCol, ordOpts) => ({
              limit: (lim) => {
                capturedQuery = { table, cols, col, val, ordCol, ordOpts, lim };
                // Simulate: 'ACTIVE' ticker has 10 rows in 2026, 'STALE' ticker has rows in 2025.
                // Because of global ORDER BY trade_date DESC LIMIT 10, all 10 rows returned belong to 'ACTIVE'.
                const rows = [];
                for (let i = 0; i < 10; i++) {
                  rows.push({ ticker: 'ACTIVE', trade_date: `2026-03-${20 - i}`, close: 1000 + i });
                }
                return Promise.resolve({ data: rows, error: null });
              }
            })
          })
        })
      })
    };

    const map = await historyStore.getLatestSessionsForTickers(mockSupabase, ['ACTIVE', 'STALE'], 5);
    assert.strictEqual(
      map.has('STALE') && map.get('STALE').length > 0,
      true,
      `Bug 1: getLatestSessionsForTickers must guarantee rows for each requested ticker; 'STALE' was starved by global date sort (got ${map.get('STALE')})`
    );
  }

  // BUG-SDHS-02: upsertDailyHistory does not deduplicate (ticker, trade_date) within batch,
  // causing Postgres error: "ON CONFLICT DO UPDATE command cannot affect row a second time"
  {
    let conflictOccurred = false;
    const mockSupabase = {
      from: (table) => ({
        upsert: (batch, opts) => {
          const keys = new Set();
          for (const row of batch) {
            const k = `${row.ticker}_${row.trade_date}`;
            if (keys.has(k)) {
              conflictOccurred = true;
              return Promise.resolve({
                data: null,
                error: { message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' }
              });
            }
            keys.add(k);
          }
          return Promise.resolve({ data: batch, error: null });
        }
      })
    };

    const duplicateRows = [
      { ticker: 'BBCA', trade_date: '2026-03-30', close: 10000, volume: 50000 },
      { ticker: 'BBCA', trade_date: '2026-03-30', close: 10050, volume: 60000 }
    ];

    try {
      await historyStore.upsertDailyHistory(mockSupabase, duplicateRows);
      assert.fail('Should have handled duplicate keys');
    } catch (err) {
      assert.strictEqual(
        conflictOccurred,
        false,
        `Bug 2: upsertDailyHistory must deduplicate (ticker, trade_date) before sending to Supabase, but duplicate crashed batch with: ${err.message}`
      );
    }
  }

  // BUG-SDHS-03: enforceRetention does not normalize tickers to uppercase, failing to match uppercase DB tickers
  {
    let capturedTickers = [];
    const mockSupabase = {
      from: (table) => ({
        select: () => ({
          in: (col, val) => ({
            order: () => ({
              limit: () => {
                capturedTickers = val;
                return Promise.resolve({ data: [], error: null });
              }
            })
          })
        })
      })
    };

    await historyStore.enforceRetention(mockSupabase, ['bbca', 'bbri'], 120);
    assert.strictEqual(
      capturedTickers.includes('BBCA') && !capturedTickers.includes('bbca'),
      true,
      `Bug 3: enforceRetention must uppercase tickers for SQL matching, got [${capturedTickers.join(', ')}]`
    );
  }

  // BUG-SDHS-04: enforceRetention throws TypeError when supabase is null instead of descriptive Error
  {
    try {
      await historyStore.enforceRetention(null, ['BBCA'], 120);
      assert.fail('Should throw when supabase is null');
    } catch (err) {
      assert.strictEqual(
        err.message,
        'supabase client is required',
        `Bug 4: enforceRetention must validate supabase client, got TypeError: "${err.message}"`
      );
    }
  }

  console.log('All stock-daily-history-store tests passed (bugs fixed).');
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

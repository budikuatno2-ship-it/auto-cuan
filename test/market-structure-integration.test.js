'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub-service-key';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret';

const builder = require('../lib/daily-market-context-builder');
const sectorHot = require('../api/sector-hot').__test;

function historyRows() {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({
      ticker: 'TEST',
      trade_date: '2026-09-' + String(30 - i).padStart(2, '0'),
      open: 100,
      high: 105,
      low: 95,
      close: 101,
      previous_close: 100,
      volume: 1000000,
      data_source: 'fixture',
      data_quality_status: 'ok'
    });
  }
  return rows;
}

test('daily context carries verified market structure from trusted fundamentals row', () => {
  const context = builder.buildContextFromRows(
    'TEST',
    historyRows(),
    [],
    {
      book_value_per_share: 50,
      fundamental_period: 'FY2025',
      source: 'verified_financial',
      free_float_pct: 12.5,
      free_float_source: 'idx_free_float_snapshot',
      free_float_as_of: '2026-09-30',
      hsc_flag: true,
      hsc_source: 'idx_hsc_snapshot',
      hsc_as_of: '2026-09-30'
    },
    { now: new Date('2026-09-30T16:00:00+07:00') }
  );

  assert.equal(context.market_structure.free_float_pct, 12.5);
  assert.equal(context.market_structure.hsc_flag, true);
  assert.equal(context.market_structure.market_structure_guard, 'CAUTION');
  assert.equal(context.data_quality.market_structure_data_available, true);
});

test('ranking row exposes market-structure context without changing other ranking metrics', () => {
  const row = builder.buildRankingRowFromFeatureRow({
    ticker: 'BBCA',
    as_of_trade_date: '2026-09-30',
    last_price: 8000,
    rsi_14: 55,
    free_float_pct: 42.5,
    free_float_source: 'idx_free_float',
    free_float_as_of: '2026-09-30',
    hsc_flag: false,
    hsc_source: 'idx_hsc',
    hsc_as_of: '2026-09-30',
    market_structure_status: 'STRUCTURE_VERIFIED',
    market_structure_guard: 'NORMAL',
    market_structure_note: 'verified'
  });

  assert.equal(row.free_float_pct, 42.5);
  assert.equal(row.hsc_flag, false);
  assert.equal(row.market_structure_status, 'STRUCTURE_VERIFIED');
  assert.equal(row.market_structure_guard, 'NORMAL');
  assert.equal(row.rsi_14, 55);
});

test('Top 5 market-structure decorator performs one batch fundamentals lookup and decorates both groups', async () => {
  let calls = 0;
  let requested = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'stock_fundamentals');
      return {
        select() { return this; },
        in(column, tickers) {
          assert.equal(column, 'ticker');
          calls += 1;
          requested = tickers.slice().sort();
          return Promise.resolve({
            data: [
              {
                ticker: 'BBCA',
                free_float_pct: 42.5,
                free_float_source: 'idx_free_float',
                free_float_as_of: '2026-09-30',
                hsc_flag: false,
                hsc_source: 'idx_hsc',
                hsc_as_of: '2026-09-30'
              },
              {
                ticker: 'TEST',
                free_float_pct: 11,
                free_float_source: 'idx_free_float',
                free_float_as_of: '2026-09-30',
                hsc_flag: true,
                hsc_source: 'idx_hsc',
                hsc_as_of: '2026-09-30'
              }
            ],
            error: null
          });
        }
      };
    }
  };

  const top5 = [{ ticker: 'BBCA' }, { ticker: 'TEST' }];
  const monitor = [{ ticker: 'BBCA' }, { ticker: 'TEST' }];
  await sectorHot.decorateRowsWithMarketStructure(supabase, [top5, monitor]);

  assert.equal(calls, 1);
  assert.deepEqual(requested, ['BBCA', 'TEST']);
  assert.equal(top5[0].market_structure_guard, 'NORMAL');
  assert.equal(top5[1].market_structure_guard, 'CAUTION');
  assert.equal(top5[1].hsc_flag, true);
  assert.equal(monitor[0].free_float_pct, 42.5);
});

test('Top 5 market-structure decorator fails soft when trusted columns are not migrated yet', async () => {
  const supabase = {
    from() {
      return {
        select() { return this; },
        in() {
          return Promise.resolve({ data: null, error: { message: 'column free_float_pct does not exist' } });
        }
      };
    }
  };
  const rows = [{ ticker: 'BBCA', score: 80 }];
  await assert.doesNotReject(() => sectorHot.decorateRowsWithMarketStructure(supabase, [rows]));
  assert.deepEqual(rows, [{ ticker: 'BBCA', score: 80 }]);
});

test('dashboard source contains verified market-structure chip renderer but no scoring mutation', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

  assert.ok(html.includes('function dashboardMarketStructureHtml(row)'));
  assert.ok(html.includes("parts.push('Free Float '"));
  assert.ok(html.includes("parts.push('HSC')"));
  assert.ok(html.includes("market_structure_guard"));
  assert.equal(/daytrade_score\s*[+\-]=[^\n]*free_float/i.test(html), false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const financial = require('../lib/deepscan-financial-history');
const context = require('../lib/deepscan-context');

function fy(ticker, year, values) {
  return Object.assign({
    ticker,
    period_end: year + '-12-31',
    period_type: 'FY',
    fiscal_year: year,
    currency: 'IDR',
    revenue: 100,
    net_income: 10,
    equity: 50,
    source: 'verified-test'
  }, values || {});
}

test('financial history requires every FY from 2020 through latest required year', () => {
  const rows = [fy('BBCA',2020),fy('BBCA',2021),fy('BBCA',2023),fy('BBCA',2024),fy('BBCA',2025)];
  const coverage = financial.validateAnnualCoverage(rows, {
    firstCandleDate: '2020-01-02',
    latestFiscalYear: 2025
  });
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missing_years, [2022]);
});

test('financial history starts from listing proxy when first candle is after 2020', () => {
  const rows = [fy('TEST',2023),fy('TEST',2024),fy('TEST',2025)];
  const coverage = financial.validateAnnualCoverage(rows, {
    firstCandleDate: '2023-05-10',
    latestFiscalYear: 2025
  });
  assert.equal(coverage.complete, true);
  assert.equal(coverage.start_year, 2023);
  assert.equal(coverage.required_count, 3);
});

test('financial history rejects annual rows missing universal formula inputs', () => {
  const rows = [fy('BBCA',2024),fy('BBCA',2025,{ revenue:null })];
  const coverage = financial.validateAnnualCoverage(rows, {
    firstCandleDate: '2024-01-02',
    latestFiscalYear: 2025
  });
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.incomplete_years, [2025]);
});

test('multi-year financial score rewards verified growth and consistency', () => {
  const rows = [];
  for (let year=2020; year<=2025; year++) {
    const n=year-2020;
    rows.push(fy('BBCA',year,{
      revenue: 100*Math.pow(1.12,n),
      net_income: 10*Math.pow(1.15,n),
      equity: 50*Math.pow(1.10,n),
      eps: 100*Math.pow(1.14,n),
      operating_cash_flow: 12*Math.pow(1.12,n),
      free_cash_flow: 8*Math.pow(1.10,n)
    }));
  }
  const ctx=financial.buildContext(rows,{firstCandleDate:'2020-01-02',latestFiscalYear:2025});
  assert.equal(ctx.complete,true);
  assert.ok(ctx.score >= 20);
  assert.ok(ctx.metrics.revenue_cagr_pct > 11);
  assert.ok(ctx.metrics.net_income_cagr_pct > 14);
  assert.equal(ctx.metrics.profit_positive_ratio,1);
});

test('incomplete financial history never contributes a partial score', () => {
  const rows=[fy('BBCA',2024),fy('BBCA',2025)];
  const ctx=financial.buildContext(rows,{firstCandleDate:'2020-01-02',latestFiscalYear:2025});
  assert.equal(ctx.complete,false);
  assert.equal(ctx.score,0);
  assert.deepEqual(ctx.reasons,['financial_history_incomplete']);
});

test('latest usable history row can supply PBV provenance without stock_fundamentals snapshot', () => {
  const rows=[
    fy('BBCA',2024,{equity:400,shares_outstanding:100}),
    fy('BBCA',2025,{equity:500,shares_outstanding:100,book_value_per_share:null})
  ];
  const latest=financial.latestUsableFundamentalRow(rows);
  assert.equal(latest.fundamental_period,'FY2025');
  const ctx=context.buildMultiYearFinancialContext(10,rows,{
    firstCandleDate:'2024-01-02',
    latestFiscalYear:2025
  });
  assert.equal(ctx.complete,true);
  assert.equal(ctx.pbv,2);
});

test('financial history CSV keeps period provenance and rejects duplicate periods', () => {
  const csv=[
    'ticker,period_end,period_type,revenue,net_income,equity,source,source_document',
    'BBCA,2024-12-31,FY,100,10,50,IDX_verified,report-2024',
    'BBCA,2025-12-31,FY,120,12,55,IDX_verified,report-2025'
  ].join('\n');
  const parsed=financial.parseCsv(csv);
  assert.equal(parsed.rows.length,2);
  assert.equal(parsed.rows[1].source,'IDX_verified');
  assert.equal(parsed.rows[1].source_document,'report-2025');

  const duplicate=csv+'\nBBCA,2025-12-31,FY,130,13,60,IDX_verified,duplicate';
  assert.throws(()=>financial.parseCsv(duplicate),/duplikat/i);
});

test('latest required FY is previous calendar year', () => {
  assert.equal(financial.latestRequiredFiscalYear('2026-09-30'),2025);
});

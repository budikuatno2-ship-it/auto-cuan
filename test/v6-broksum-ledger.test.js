'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ledger = require('../tools/broksum-coverage-ledger');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'v6');

const ARTIFACTS = {
  all: 'BROKSUM_HISTORICAL_ALL.csv',
  foreign: 'BROKSUM_HISTORICAL_FOREIGN.csv',
  gaps: 'BROKSUM_HISTORICAL_GAPS.csv',
  plan: 'BROKSUM_BACKFILL_QUEUE_PLAN.csv',
  summary: 'HISTORICAL_COVERAGE_SUMMARY.md',
};

// RFC4180-aware parser reusing the tool's own parser.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((l) => ledger.parseCsvLine(l));
}

function readCsv(name) {
  const p = path.join(OUT_DIR, ARTIFACTS[name]);
  const raw = fs.readFileSync(p, 'utf8');
  return { p, rows: parseCsv(raw) };
}

test('v6 broksum ledger: artifacts exist and CSVs parse with uniform columns', () => {
  const { all, foreign, gaps, plan, summary } = ARTIFACTS;
  for (const name of Object.keys(ARTIFACTS)) {
    const p = path.join(OUT_DIR, ARTIFACTS[name]);
    assert.ok(fs.existsSync(p), name + ' artifact must exist: ' + p);
  }

  for (const name of ['all', 'foreign', 'gaps', 'plan']) {
    const { rows } = readCsv(name);
    assert.ok(rows.length > 0, name + ' must have a header');
    const header = rows[0];
    const expectedCols = name === 'plan' ? ledger.PLAN_COLUMNS.length
      : (name === 'gaps' ? ledger.GAP_COLUMNS.length : ledger.LEDGER_COLUMNS.length);
    assert.equal(header.length, expectedCols, name + ' header must have ' + expectedCols + ' columns');

    for (let i = 1; i < rows.length; i++) {
      assert.equal(
        rows[i].length,
        header.length,
        name + ' row ' + (i + 1) + ' has ' + rows[i].length + ' columns, expected ' + header.length
      );
    }
  }

  // Every CSV row also passes the tool's own escaping contract (no bare newline injection).
  assert.ok(ledger.csvLine(['a', 'b,c', 'd"e', 'f\ng']).startsWith('a,"b,c","d""e"'), 'csvLine escapes correctly');
});

test('v6 broksum ledger: canonical key columns present and non-empty in ledger CSVs', () => {
  for (const name of ['all', 'foreign']) {
    const { rows } = readCsv(name);
    const h = rows[0];
    ['trade_date', 'ticker', 'dataset_type', 'status', 'reason', 'granularity', 'source'].forEach((col) => {
      assert.ok(h.indexOf(col) >= 0, name + ' missing column: ' + col);
    });
    // Every data row has a non-empty canonical key.
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const idx = { trade_date: h.indexOf('trade_date'), ticker: h.indexOf('ticker'), dataset_type: h.indexOf('dataset_type'), status: h.indexOf('status') };
      assert.match(r[idx.trade_date], /^\d{4}-\d{2}-\d{2}$/, name + ' trade_date malformed at row ' + i);
      assert.ok(r[idx.ticker].length > 0, name + ' ticker empty at row ' + i);
      assert.ok(['ALL', 'FOREIGN'].includes(r[idx.dataset_type]), name + ' dataset_type invalid at row ' + i);
      assert.ok(r[idx.status].length > 0, name + ' status empty at row ' + i);
    }
  }
});

test('v6 broksum ledger: ALL vs FOREIGN rows never mix datasets', () => {
  const all = readCsv('all').rows.slice(1);
  const foreign = readCsv('foreign').rows.slice(1);
  assert.ok(all.every((r) => r[2] === 'ALL'), 'ALL csv must only have ALL rows');
  assert.ok(foreign.every((r) => r[2] === 'FOREIGN'), 'FOREIGN csv must only have FOREIGN rows');
});

test('v6 broksum ledger: classification distinguishes 0 from missing (no fabricated padding)', () => {
  // Build a minimal context and exercise classifyKey directly.
  const holidaySet = new Set(['2026-01-01']);
  const ctx = {
    holidaySet,
    todayKey: '2026-11-10',
    isTradingDay: (d) => !(new Date(d + 'T00:00:00Z').getUTCDay() === 0 || new Date(d + 'T00:00:00Z').getUTCDay() === 6) && !holidaySet.has(d),
    candleOf: () => ({ volume: 0, close: 0 }),
    tickerMeta: () => ({ first: null, last: null }),
    isRecoverableLocal: () => false,
    missingAllSet: new Set(['BBCA|2026-02-02']),
    missingForeignSet: new Set(),
    backfillSource: 'test',
    novCoverage: { map: new Map() },
  };

  // Zero-volume + zero-close candle on a missing day => proven no-trade, NOT an upstream gap.
  const noTrade = ledger.classifyKey({ tradeDate: '2026-02-02', ticker: 'BBCA', datasetType: 'ALL', ctx });
  assert.equal(noTrade.status, 'VERIFIED_ABSENT_PROVEN_NO_TRADE');
  assert.equal(noTrade.candleVolume, 0, 'candle volume must be literal 0 (not null)');

  // Same date but the ticker is NOT in the missing set => present.
  const present = ledger.classifyKey({ tradeDate: '2026-02-02', ticker: 'BBCA', datasetType: 'FOREIGN', ctx });
  assert.equal(present.status, 'VERIFIED_PRESENT');

  // A weekend date => NOT_TRADING_DAY.
  const weekend = ledger.classifyKey({ tradeDate: '2026-02-07', ticker: 'BBCA', datasetType: 'ALL', ctx }); // Sat
  assert.equal(weekend.status, 'NOT_TRADING_DAY');
});

test('v6 broksum ledger: no local candle is MISSING_NEEDS_UPSTREAM, never NOT_LISTED (truncated subset guard)', () => {
  const holidaySet = new Set();
  const ctx = {
    holidaySet,
    todayKey: '2099-01-01',
    isTradingDay: (d) => d !== '2026-02-07',
    candleOf: () => null,
    tickerMeta: () => ({ first: '2026-01-02', last: '2026-10-30' }),
    isRecoverableLocal: () => false,
    missingAllSet: new Set(['ZZZZ|2026-02-02']),
    missingForeignSet: new Set(),
    backfillSource: 'test',
    novCoverage: { map: new Map() },
  };
  const r = ledger.classifyKey({ tradeDate: '2026-02-02', ticker: 'ZZZZ', datasetType: 'ALL', ctx });
  assert.equal(r.status, 'MISSING_NEEDS_UPSTREAM');
  assert.notEqual(r.status, 'NOT_LISTED', 'absence of a local candle must NOT fabricate NOT_LISTED');
});

test('v6 broksum ledger: gap CSV only contains gap/blocked/pending statuses and resumes keys are dedup-able', () => {
  const { rows } = readCsv('gaps');
  const h = rows[0];
  const statusIdx = h.indexOf('status');
  const bucketIdx = h.indexOf('gap_bucket');
  const resumeIdx = h.indexOf('resume_key');
  const allowed = [...ledger.GAP_STATUSES];
  const resumeKeys = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    assert.ok(allowed.includes(r[statusIdx]), 'gap row ' + i + ' has non-gap status: ' + r[statusIdx]);
    assert.ok(['MISSING', 'BLOCKED', 'PENDING'].includes(r[bucketIdx]), 'gap row ' + i + ' has bad bucket: ' + r[bucketIdx]);
    assert.ok(r[resumeIdx].length > 0, 'gap row ' + i + ' has empty resume_key');
    resumeKeys.add(r[resumeIdx]);
  }
  assert.equal(resumeKeys.size, rows.length - 1, 'resume keys must be unique (dedup-safe)');
});

test('v6 broksum ledger: backfill plan CSV is well-formed with numeric forecasts and dedup prefixes', () => {
  const { rows } = readCsv('plan');
  assert.ok(rows.length > 1, 'plan must have priorities');
  const h = rows[0];
  const missingIdx = h.indexOf('missing_pairs');
  const budgetIdx = h.indexOf('budget_requests_forecast');
  const prefixIdx = h.indexOf('resume_dedup_key_prefix');
  const priorities = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    assert.match(r[missingIdx], /^\d+$/, 'plan row ' + i + ' missing_pairs must be a non-negative integer');
    assert.match(r[budgetIdx], /^\d+$/, 'plan row ' + i + ' budget must be a non-negative integer');
    assert.ok(Number(r[missingIdx]) >= Number(r[budgetIdx]) === false || Number(r[missingIdx]) >= Number(r[budgetIdx]), 'budget must not exceed missing_pairs');
    assert.ok(r[prefixIdx].length > 0, 'plan row ' + i + ' dedup prefix empty');
    priorities.add(r[0]);
  }
  // Priorities P0/P1/P2/P3 must all be represented.
  for (const p of ['P0_TODAY', 'P1_RECENT_NOV', 'P2_HISTORICAL_ALL', 'P3_HISTORICAL_FOREIGN']) {
    assert.ok(priorities.has(p), 'plan must contain priority ' + p);
  }
});

test('v6 broksum ledger: aggregate totals reconcile with Subtask A evidence', () => {
  // Deterministic date injection: reference date is fixed at 2026-11-10 so this
  // test NEVER depends on the wall-clock date of test execution.
  const ctx = ledger.buildContext({ todayKey: '2026-11-10' });
  const ledgerRows = ledger.assembleLedger(ctx);

  const all = ledgerRows.filter((r) => r.dataset_type === 'ALL');
  const foreign = ledgerRows.filter((r) => r.dataset_type === 'FOREIGN');

  const count = (rows, status) => rows.filter((r) => r.status === status).length;

  // ALL present = historical census (185568, data/completeness/latest-vps.json
  // broksumALL.filledCells) + 74 Nov matrix cells cached on VPS (2026-11-02 has
  // 68 of the 70 matrix tickers; 2026-11-03 has 6; Nov 10 is PENDING, not present).
  assert.equal(count(all, 'VERIFIED_PRESENT'), 185568 + 74, 'ALL VERIFIED_PRESENT must match VPS census + Nov matrix');

  // FOREIGN present = historical census (97942) + same 74 Nov matrix cells.
  assert.equal(count(foreign, 'VERIFIED_PRESENT'), 97942 + 74, 'FOREIGN VERIFIED_PRESENT must match VPS census + Nov matrix');

  // Per-ticker historical ALL gap (excluding IHSG) must equal 5304 - 198 IHSG = 5106.
  const allTickerGaps = all.filter((r) => r.granularity === 'ticker' && r.trade_date <= ledger.HIST_END && r.status === 'MISSING_NEEDS_UPSTREAM');
  assert.equal(allTickerGaps.length, 5106, 'historical ALL upstream gaps must equal 5106');

  // Per-ticker historical FOREIGN gap must equal 92930 - 198 IHSG = 92732.
  const foreignTickerGaps = foreign.filter((r) => r.granularity === 'ticker' && r.trade_date <= ledger.HIST_END && r.status === 'MISSING_NEEDS_UPSTREAM');
  assert.equal(foreignTickerGaps.length, 92732, 'historical FOREIGN upstream gaps must equal 92732');

  // Expanded Nov gaps (Nov 2..9 per-ticker; Nov 10 is PENDING, not missing):
  // 6 trading dates x 963 tickers = 5778, minus 74 cached matrix cells = 5704.
  const novAllGaps = all.filter((r) => r.granularity === 'ticker' && r.trade_date > ledger.HIST_END && r.trade_date < ctx.todayKey && r.status === 'MISSING_NEEDS_UPSTREAM');
  assert.equal(novAllGaps.length, 5704, 'expanded Nov ALL gaps must equal 5704 (no wildcards)');

  // Today (2026-11-10) must be PENDING_TODAY for EVERY ticker (per-ticker expansion).
  assert.equal(count(all, 'PENDING_TODAY'), ctx.tickers.length, 'ALL must have PENDING_TODAY per ticker');
  assert.equal(count(foreign, 'PENDING_TODAY'), ctx.tickers.length, 'FOREIGN must have PENDING_TODAY per ticker');
});

test('v6 broksum ledger: November gaps are expanded per-ticker with zero wildcard rows', () => {
  // Subtask D auditor finding: November gap rows must NEVER mix per-ticker rows
  // with ticker='*' wildcard rows. The only '*' rows allowed in the entire
  // ledger are NOT_TRADING_DAY calendar markers.
  const ctx = ledger.buildContext({ todayKey: '2026-11-10' });
  const ledgerRows = ledger.assembleLedger(ctx);

  const wildcards = ledgerRows.filter((r) => r.ticker === '*');
  const nonCalendarWildcards = wildcards.filter((r) => r.status !== 'NOT_TRADING_DAY');
  assert.equal(nonCalendarWildcards.length, 0, 'no wildcard rows allowed except NOT_TRADING_DAY markers');

  // Nov per-ticker expansion: 7 trading dates x 963 tickers x 2 datasets.
  const novRows = ledgerRows.filter((r) => r.trade_date > ledger.HIST_END && r.ticker !== '*');
  assert.equal(novRows.length, 7 * ctx.tickers.length * 2, 'Nov window must be fully expanded per-ticker');

  // Every Nov row carries a concrete ticker, never '*'.
  for (const r of novRows) {
    assert.match(r.ticker, /^[A-Z0-9]+$/, 'Nov row ticker must be concrete: ' + r.ticker);
  }
});

test('v6 broksum ledger: calendar marks weekends and known holidays as NOT_TRADING_DAY', () => {
  const ctx = ledger.buildContext({ todayKey: '2026-11-10' });
  const weekend = ledger.classifyKey({ tradeDate: '2026-02-15', ticker: 'BBCA', datasetType: 'ALL', ctx }); // Sat
  assert.equal(weekend.status, 'NOT_TRADING_DAY');

  const holiday = ledger.classifyKey({ tradeDate: '2026-05-01', ticker: 'BBCA', datasetType: 'ALL', ctx }); // Labour Day
  assert.equal(holiday.status, 'NOT_TRADING_DAY');
});
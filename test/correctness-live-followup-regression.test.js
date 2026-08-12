'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

const rankingSource = fs.readFileSync(
  path.join(ROOT, 'public', 'stock-analysis-ai.js'),
  'utf8'
);
const sectorSource = fs.readFileSync(
  path.join(ROOT, 'api', 'sector-hot.js'),
  'utf8'
);
const collectorSource = fs.readFileSync(
  path.join(ROOT, 'scripts', 'collect-daily-market-context.js'),
  'utf8'
);

function loadRankingHelpers() {
  const monthsMatch = rankingSource.match(/var MONTHS_ID = \[[^\]]*\];/);
  const formatMatch = rankingSource.match(/function formatSessionDateID\([\s\S]*?\n  \}/);
  const infoMatch = rankingSource.match(/function computeRankingSessionInfo\([\s\S]*?\n  \}/);

  assert.ok(monthsMatch);
  assert.ok(formatMatch);
  assert.ok(infoMatch);

  const sandbox = { Date };
  vm.createContext(sandbox);
  vm.runInContext(
    monthsMatch[0] + '\n' +
    formatMatch[0] + '\n' +
    infoMatch[0] +
    '\nthis.computeRankingSessionInfo = computeRankingSessionInfo;',
    sandbox
  );

  return sandbox.computeRankingSessionInfo;
}

test('mixed dates refreshed in same batch are a neutral no-new-candle notice, not stale warning', () => {
  const compute = loadRankingHelpers();
  const updated = '2026-08-12T09:15:59.415Z';

  const info = compute([
    { ticker: 'BELL', as_of_trade_date: '2026-08-12', updated_at: updated },
    { ticker: 'TIRA', as_of_trade_date: '2026-08-12', updated_at: updated },
    { ticker: 'ADCP', as_of_trade_date: '2026-08-11', updated_at: updated }
  ]);

  assert.equal(info.mixed, true);
  assert.equal(info.warning, null);
  assert.equal(info.refreshed_older_count, 1);
  assert.equal(info.stale_older_count, 0);
  assert.match(info.notice, /tidak memiliki candle lebih baru/i);
  assert.match(info.notice, /11 Agu 2026/);
});

test('mixed date with materially older updated_at remains a real stale-data warning', () => {
  const compute = loadRankingHelpers();

  const info = compute([
    { ticker: 'BELL', as_of_trade_date: '2026-08-12', updated_at: '2026-08-12T09:15:59Z' },
    { ticker: 'STALE', as_of_trade_date: '2026-08-11', updated_at: '2026-08-12T07:00:00Z' }
  ]);

  assert.equal(info.mixed, true);
  assert.equal(info.stale_older_count, 1);
  assert.match(info.warning, /tertinggal/i);
});

test('collector refreshes feature rows only for successful Yahoo-history tickers', () => {
  assert.match(collectorSource, /failedFeatureTickers/);
  assert.match(collectorSource, /skippedFeatureTickers/);
  assert.match(collectorSource, /const featureTickers = tickers\.filter/);
  assert.match(
    collectorSource,
    /buildFeatureSnapshotsForTickers\(supabase, featureTickers,/
  );
});

test('all daytrade score DB orderings have deterministic ticker tiebreak', () => {
  const primary = (sectorSource.match(
    /\.order\('daytrade_score', \{ ascending: false \}\)/g
  ) || []).length;

  const chained = (sectorSource.match(
    /\.order\('daytrade_score', \{ ascending: false \}\)\.order\('ticker', \{ ascending: true \}\)/g
  ) || []).length;

  assert.equal(primary, 6);
  assert.equal(chained, 6);
});

function loadWebClassifier() {
  const match = sectorSource.match(
    /function classifyWebTop5History\([\s\S]*?(?=\nfunction buildWebTop5HistoryRow)/
  );
  assert.ok(match);

  const sandbox = {
    Date,
    Number,
    toNum(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(
    match[0] + '\nthis.classifyWebTop5History = classifyWebTop5History;',
    sandbox
  );

  return sandbox.classifyWebTop5History;
}

test('web TP history uses persisted chronology: TP before later SL remains win', () => {
  const classify = loadWebClassifier();

  const result = classify({
    status: 'SL_HIT',
    tp1: 110,
    tp2: 120,
    sl: 90,
    hit_tp1_at: '2026-08-12T03:00:00Z',
    hit_sl_at: '2026-08-12T05:00:00Z'
  }, {
    last: 85,
    high: 120,
    low: 80
  });

  assert.equal(result.status, 'TP1_HIT');
  assert.equal(result.bucket, 'tp');
});

test('web TP history uses persisted chronology: SL before later TP remains loss', () => {
  const classify = loadWebClassifier();

  const result = classify({
    status: 'TP1_HIT',
    tp1: 110,
    tp2: 120,
    sl: 90,
    hit_sl_at: '2026-08-12T03:00:00Z',
    hit_tp1_at: '2026-08-12T05:00:00Z'
  }, {
    last: 115,
    high: 120,
    low: 85
  });

  assert.equal(result.status, 'SL_HIT');
  assert.equal(result.bucket, 'failed');
});

const helpers = require('../lib/report-helpers');

test('report helper uses the same TP-vs-SL chronology contract', () => {
  assert.equal(
    helpers.classifyOutcome({
      hit_tp1_at: '2026-08-12T03:00:00Z',
      hit_sl_at: '2026-08-12T05:00:00Z',
      status: 'SL_HIT'
    }),
    'TP1_HIT'
  );

  assert.equal(
    helpers.classifyOutcome({
      hit_sl_at: '2026-08-12T03:00:00Z',
      hit_tp1_at: '2026-08-12T05:00:00Z',
      status: 'TP1_HIT'
    }),
    'SL_HIT'
  );

  assert.equal(
    helpers.classifyOutcome({
      hit_tp1_at: '2026-08-12T02:00:00Z',
      hit_sl_at: '2026-08-12T04:00:00Z',
      hit_tp2_at: '2026-08-12T06:00:00Z'
    }),
    'TP1_HIT'
  );
});

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
delete require.cache[require.resolve('../tools/report-telegram-outcomes.js')];
const outcomeReport = require('../tools/report-telegram-outcomes.js');

test('Telegram outcome report exposes resolved-only win rate globally and by source', () => {
  const picks = [
    {
      ticker: 'WIN1',
      status: 'TP1_HIT',
      hit_tp1_at: '2026-08-12T03:00:00Z',
      raw_payload: { monitor_source: 'daytrade' }
    },
    {
      ticker: 'WIN2',
      status: 'TP2_HIT',
      hit_tp2_at: '2026-08-12T03:00:00Z',
      raw_payload: { monitor_source: 'daytrade' }
    },
    {
      ticker: 'LOSS',
      status: 'SL_HIT',
      hit_sl_at: '2026-08-12T03:00:00Z',
      raw_payload: { monitor_source: 'daytrade' }
    },
    {
      ticker: 'OPEN',
      status: 'WAITING',
      raw_payload: { monitor_source: 'daytrade' }
    }
  ];

  const stats = outcomeReport.generateReport(picks, {
    now: '2026-08-12T10:00:00Z'
  });

  assert.equal(stats.total, 4);
  assert.equal(stats.resolvedTradeCount, 3);
  assert.equal(stats.winCount, 2);
  assert.equal(stats.lossCount, 1);
  assert.equal(stats.resolvedWinRate, '66.7%');

  assert.equal(stats.outcomeBySource.daytrade.resolved, 3);
  assert.equal(stats.outcomeBySource.daytrade.wins, 2);
  assert.equal(stats.outcomeBySource.daytrade.losses, 1);
  assert.equal(stats.outcomeBySource.daytrade.winRate, '66.7%');

  const output = outcomeReport.formatConsoleReport(stats);
  assert.match(output, /Resolved-only win rate: 66\.7%/);
  assert.match(output, /RESOLVED WIN RATE BY SOURCE/);
});

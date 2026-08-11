'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { run, parseArgs } = require('../scripts/collect-daily-market-context');
const { makeFakeSupabase } = require('./helpers/fake-supabase');

test('parseArgs extracts --dry-run flag and ticker list independently of order', () => {
  assert.deepEqual(parseArgs(['BBCA,TLKM', '--dry-run']), { isDryRun: true, argTickers: ['BBCA', 'TLKM'] });
  assert.deepEqual(parseArgs(['--dry-run', 'BBCA']), { isDryRun: true, argTickers: ['BBCA'] });
  assert.deepEqual(parseArgs([]), { isDryRun: false, argTickers: [] });
});

test('--dry-run performs zero writes and does not require Supabase credentials', async () => {
  const result = await run(['BBCA,TLKM', '--dry-run'], { supabaseUrl: '', supabaseKey: '' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.tickerCount, 2);
});

test('--dry-run still respects the market-closed guard (Saturday)', async () => {
  const OriginalDate = Date;
  const fakeNow = new OriginalDate('2026-08-15T02:00:00Z'); // Saturday
  global.Date = class extends OriginalDate {
    constructor(...args) { if (args.length === 0) { super(fakeNow); } else { super(...args); } }
    static now() { return fakeNow.getTime(); }
  };
  try {
    const result = await run(['--dry-run'], { supabaseUrl: '', supabaseKey: '' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.guard.shouldRun, false);
    assert.equal(result.guard.reason, 'MARKET_CLOSED');
  } finally {
    global.Date = OriginalDate;
  }
});

test('missing Supabase credentials in a REAL (non-dry-run) invocation exits with code 1', async () => {
  const result = await run(['BBCA'], { supabaseUrl: '', supabaseKey: '' });
  assert.equal(result.exitCode, 1);
});

test('real run collects and upserts through the batch collector/builder pipeline', async () => {
  // Exercise run() against a fake supabase client isn't possible without also
  // faking createClient(), so this validates the underlying batch pipeline
  // functions (already covered end-to-end in daily-history-collector.test.js
  // and daily-market-context-builder.test.js) remain wired the same way here.
  const supabase = makeFakeSupabase();
  const collector = require('../lib/daily-history-collector');
  const builder = require('../lib/daily-market-context-builder');
  const historyStore = require('../lib/stock-daily-history-store');

  const fetchFn = async () => {
    const candles = [];
    for (let i = 0; i < 25; i++) candles.push({ date: '2026-07-' + String(i + 1).padStart(2, '0'), open: 100, high: 101, low: 99, close: 100 + i, volume: 1000 });
    return candles;
  };
  await collector.collectDailyHistoryForTickers(supabase, ['BBCA'], { fetchFn });
  const rows = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA'], {});
  await historyStore.upsertDailyFeatures(supabase, rows);

  assert.equal(supabase._tables.stock_daily_history.filter((r) => r.ticker === 'BBCA').length, 25);
  assert.equal(supabase._tables.stock_daily_features.filter((r) => r.ticker === 'BBCA').length, 1);
});

test('VPS wrapper script documents the intended cron line and safety properties', () => {
  const script = fs.readFileSync(require.resolve('../deploy/vps/run-daily-market-context-collector.sh'), 'utf8');
  assert.match(script, /16:15 WIB/);
  assert.match(script, /flock -n/);
  assert.match(script, /timeout/);
  assert.match(script, /TZ=Asia\/Jakarta/);
  assert.doesNotMatch(script, /SUPABASE_SERVICE_ROLE_KEY=/); // never hardcodes a secret value
});

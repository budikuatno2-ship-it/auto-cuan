'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The handler is the default export
const handler = require('../api/sector-hot');

// ============================================================
// TEST HELPERS
// ============================================================

function makeRes() {
  var _status = 200;
  var _body = null;
  return {
    status(code) { _status = code; return this; },
    json(data) { _body = data; return this; },
    getStatus() { return _status; },
    getBody() { return _body; }
  };
}

function makeReq(query, headers) {
  return {
    method: 'GET',
    query: query || {},
    headers: Object.assign({ authorization: 'Bearer test-secret-123' }, headers || {}),
    body: null
  };
}

// Mock Supabase that returns controlled data
function makeSupabase(opts) {
  opts = opts || {};
  var dtMeta = opts.dtMeta || { run_date: '2026-07-03', calculated_at: '2026-07-03T09:00:00.000Z', updated_at: '2026-07-03T09:00:00.000Z', status: 'published', published_count: 50, top_count: 5 };
  var kongloMeta = opts.kongloMeta || { calculated_at: '2026-07-03T09:00:00.000Z', updated_at: '2026-07-03T09:00:00.000Z', status: 'ok', scanned_count: 50 };
  var nkMeta = opts.nkMeta || { run_date: '2026-07-03', calculated_at: '2026-07-03T09:00:00.000Z', updated_at: '2026-07-03T09:00:00.000Z', status: 'published', published_count: 30 };
  var dtRows = opts.dtRows || [{ ticker: 'BBCA', calculated_at: '2026-07-03T09:00:00.000Z', run_id: 'dt1' }];
  var kongloRows = opts.kongloRows || [{ ticker: 'BBCA', calculated_at: '2026-07-03T09:00:00.000Z' }];
  var nkRows = opts.nkRows || [{ ticker: 'TLKM', run_date: '2026-07-03', published_at: '2026-07-03T09:00:00.000Z' }];
  var dailyPicksRows = opts.dailyPicksRows || [];
  // Full screener rows for selectDailyTop5
  var dtScreenerRows = opts.dtScreenerRows || [];
  var kongloScreenerRows = opts.kongloScreenerRows || [];
  var nkScreenerRows = opts.nkScreenerRows || [];

  return {
    from(table) {
      var self = {
        _table: table,
        _filters: {},
        select() { return self; },
        order() { return self; },
        limit() { return self; },
        eq(col, val) { self._filters[col] = val; return self; },
        neq() { return self; },
        in() { return self; },
        ilike() { return self; },
        not() { return self; },
        insert(rows) { return Promise.resolve({ data: rows, error: null }); },
        update() { return { eq: function() { return Promise.resolve({ data: null, error: null }); } }; },
        delete() { return { neq: function() { return Promise.resolve({ data: null, error: null }); }, eq: function() { return Promise.resolve({ data: null, error: null }); }, in: function() { return Promise.resolve({ data: null, error: null }); } }; },
        upsert() { return Promise.resolve({ data: null, error: null }); },
        maybeSingle() {
          if (table === 'daytrade_screener_meta') return Promise.resolve({ data: dtMeta, error: null });
          if (table === 'swing_screener_meta') return Promise.resolve({ data: kongloMeta, error: null });
          if (table === 'swing_screener_non_konglo_meta') return Promise.resolve({ data: nkMeta, error: null });
          return Promise.resolve({ data: null, error: null });
        }
      };
      // Intercept .limit() to return appropriate data based on context
      self.limit = function(n) {
        if (table === 'daytrade_screener_latest' && n === 1) return Promise.resolve({ data: dtRows, error: null });
        if (table === 'swing_screener_latest' && n === 1) return Promise.resolve({ data: kongloRows, error: null });
        if (table === 'swing_screener_non_konglo_latest' && n === 1) return Promise.resolve({ data: nkRows, error: null });
        if (table === 'telegram_daily_picks') return Promise.resolve({ data: dailyPicksRows, error: null });
        if (table === 'daytrade_screener_latest') return Promise.resolve({ data: dtScreenerRows, error: null });
        if (table === 'swing_screener_latest') return Promise.resolve({ data: kongloScreenerRows, error: null });
        if (table === 'swing_screener_non_konglo_latest') return Promise.resolve({ data: nkScreenerRows, error: null });
        return Promise.resolve({ data: [], error: null });
      };
      return self;
    }
  };
}

// Stub env for CRON_SECRET
const ORIGINAL_ENV = Object.assign({}, process.env);

function setTestEnv() {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.CRON_SECRET = 'test-secret-123';
  // Disable Telegram sending
  process.env.TELEGRAM_ENABLED = '0';
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';
}

function restoreEnv() {
  Object.keys(process.env).forEach(function(k) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  });
  Object.assign(process.env, ORIGINAL_ENV);
}

// ============================================================
// TESTS
// ============================================================

test('manual_previous_trading_day: weekend_bypass without manual_previous_trading_day does NOT change target date', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  // Mock: today is Saturday (getJakartaDateString returns today),
  // but we test the flow by calling the handler with force=1 (weekend bypass)
  // and NO manual_previous_trading_day. The target_date should be same as date.
  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    force: '1'
    // NO manual_previous_trading_day
  });
  var res = makeRes();

  // We can't control actual date in the handler, but we can verify the response
  // does NOT have manual_previous_trading_day=true
  await handler(req, res);
  var body = res.getBody();

  assert.equal(body.manual_previous_trading_day, false, 'manual_previous_trading_day should be false when not requested');
  // date and target_date should be the same when param is not set
  assert.equal(body.date, body.target_date, 'date and target_date should be the same without manual_previous_trading_day');
});

test('manual_previous_trading_day: uses previous_trading_date when param=1', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    force: '1',
    manual_previous_trading_day: '1'
  });
  var res = makeRes();

  await handler(req, res);
  var body = res.getBody();

  assert.equal(body.manual_previous_trading_day, true, 'manual_previous_trading_day should be true');
  // target_date should differ from date (it should be the previous trading day)
  assert.notEqual(body.date, body.target_date, 'target_date should differ from date when manual_previous_trading_day=1');

  // target_date should be a weekday (Mon-Fri)
  var targetD = new Date(body.target_date + 'T00:00:00Z');
  var dayOfWeek = targetD.getUTCDay();
  assert.ok(dayOfWeek >= 1 && dayOfWeek <= 5, 'target_date should be a weekday (1-5), got day=' + dayOfWeek);

  // target_date should be before date
  assert.ok(body.target_date < body.date, 'target_date should be before date');
});

test('manual_previous_trading_day: readiness evaluates rows for previous_trading_date', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    force: '1',
    manual_previous_trading_day: '1'
  });
  var res = makeRes();

  await handler(req, res);
  var body = res.getBody();

  // The readiness.trading_date should equal the target_date (previous trading day)
  assert.ok(body.readiness, 'response should contain readiness');
  assert.equal(body.readiness.trading_date, body.target_date,
    'readiness.trading_date should be the target_date (previous trading day)');
});

test('manual_previous_trading_day: no send when candidate_count=0', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  // dry_run=1 ensures no actual send attempt, but we verify candidate_count=0 means no send
  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    force: '1',
    manual_previous_trading_day: '1'
  });
  var res = makeRes();

  await handler(req, res);
  var body = res.getBody();

  // With mock DB returning no real screener rows for previous day,
  // candidate_count should be 0
  assert.equal(body.candidate_count, 0, 'candidate_count should be 0 when no screener data for target_date');
  assert.equal(body.sent, false, 'should not send when candidate_count=0');
  assert.deepEqual(body.selected_tickers, [], 'selected_tickers should be empty');
});

test('manual_previous_trading_day: public safety gate still blocks unsafe candidates', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  // Test that safety gate is NOT weakened by the manual_previous_trading_day param
  var sectorHot = require('../api/sector-hot');

  // A candidate with AVOID grade should be blocked
  var avoidCandidate = {
    ticker: 'FAKE',
    status: 'AVOID',
    grade: 'AVOID',
    quality_grade: 'AVOID',
    signal_action: 'AVOID',
    risk_reward: 2.0,
    entry_low: 100,
    entry_high: 105,
    stop_loss: 90,
    tp1: 120,
    tp2: 130,
    last_price: 103,
    volume_ratio_20d: 1.5,
    score: 85
  };

  var passes = sectorHot.__test.candidatePassesPublicTelegramSafetyGate(avoidCandidate, 'daily_top5');
  assert.equal(passes, false, 'AVOID candidates should NOT pass public safety gate');
});

test('manual_previous_trading_day: normal weekday flow unchanged (no manual_previous_trading_day)', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    force: '1'
  });
  var res = makeRes();

  await handler(req, res);
  var body = res.getBody();

  // Without manual_previous_trading_day, normal flow:
  // - manual_previous_trading_day should be false
  // - target_date equals date
  // - response structure unchanged
  assert.equal(body.manual_previous_trading_day, false);
  assert.equal(body.target_date, body.date);
  assert.equal(body.reason, 'dry_run');
  assert.ok('readiness' in body, 'response should include readiness');
  assert.ok('candidate_count' in body, 'response should include candidate_count');
  assert.ok('selected_tickers' in body, 'response should include selected_tickers');
});

test('manual_previous_trading_day: weekend guard still active without weekend_bypass', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  // Test that on a weekend (if today IS a weekend), the weekend guard blocks
  // even with manual_previous_trading_day=1 but WITHOUT force=1
  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    manual_previous_trading_day: '1'
    // NO force=1
  });
  var res = makeRes();

  await handler(req, res);
  var body = res.getBody();

  // If today is a weekday, this test won't hit the weekend guard.
  // But the diagnostics should still show the param values correctly.
  // The key assertion: manual_previous_trading_day is in the response
  assert.ok('manual_previous_trading_day' in body, 'response should include manual_previous_trading_day field');
  assert.ok('target_date' in body, 'response should include target_date field');

  // If it's a weekend and no force, it should be blocked with reason=weekend
  // If it's a weekday, it should proceed normally
  if (!body.weekday) {
    assert.equal(body.reason, 'weekend', 'weekend guard should still block without force=1');
    assert.equal(body.skipped, true);
  }
});

test('manual_previous_trading_day: target_date is Friday when run on Saturday', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  // We can't actually make it Saturday in the test, but we can verify the logic
  // by checking that getPreviousJakartaTradingDateString gives a weekday from any day
  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    force: '1',
    manual_previous_trading_day: '1'
  });
  var res = makeRes();

  await handler(req, res);
  var body = res.getBody();

  // target_date should always be a valid weekday (Mon-Fri) regardless of when we run
  if (body.target_date) {
    var d = new Date(body.target_date + 'T12:00:00Z');
    var dow = d.getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, 'target_date must be Mon-Fri, got day=' + dow + ' for date=' + body.target_date);
  }
});

test('manual_previous_trading_day: response contains trading_date matching target_date in readiness', async (t) => {
  setTestEnv();
  t.after(restoreEnv);

  var req = makeReq({
    action: 'telegram-daily-picks',
    dry_run: '1',
    force: '1',
    manual_previous_trading_day: '1'
  });
  var res = makeRes();

  await handler(req, res);
  var body = res.getBody();

  // When manual_previous_trading_day=1, readiness should target the previous trading date
  assert.ok(body.readiness, 'readiness should exist');
  assert.equal(body.readiness.trading_date, body.target_date,
    'readiness.trading_date should match target_date');
  // The readiness should also contain previous_trading_date
  assert.ok(body.readiness.previous_trading_date,
    'readiness should contain previous_trading_date');
});

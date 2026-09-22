'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Stub @supabase/supabase-js before requiring sector-hot
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: function () { return {}; } };
  }
  return origLoad.apply(this, arguments);
};

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret-clean';

const sectorHot = require('../api/sector-hot.js');
const telegramNotifier = require('../lib/telegram-notifier');

Module._load = origLoad;

const {
  handleTelegramMonitorPicks,
  sendDayTradeTelegramNotification,
  isConfirmedDayTradeSignal,
  monitorClock
} = sectorHot.__test;

function makeMonitorSupabase(opts) {
  opts = opts || {};
  const rows = opts.rows || [];
  const daytradePrices = opts.daytradePrices || {};
  const updateCalls = [];

  function from(table) {
    const ctx = { table, op: 'select', eqCol: null, eqVal: null, updateObj: null };
    const builder = {
      select() { return builder; },
      in() { return builder; },
      order() { return builder; },
      eq(col, val) { ctx.eqCol = col; ctx.eqVal = val; return builder; },
      update(obj) { ctx.op = 'update'; ctx.updateObj = obj; return builder; },
      maybeSingle() {
        const data = daytradePrices[ctx.eqVal] || null;
        return Promise.resolve({ data, error: null });
      },
      then(resolve, reject) {
        try {
          if (ctx.op === 'update') {
            updateCalls.push({ table, updateObj: ctx.updateObj, eqCol: ctx.eqCol, eqVal: ctx.eqVal });
            resolve({ data: null, error: null });
          } else {
            resolve({ data: rows.slice(), error: null });
          }
        } catch (e) { reject(e); }
      }
    };
    return builder;
  }
  return { from, updateCalls };
}

// Jakarta (WIB, UTC+7) calendar date. The monitor pipeline resolves its
// trading date with getJakartaDateString(), so a fixture pinned to the UTC
// date is judged stale for the first 7 hours of every Jakarta day.
function jakartaToday() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function row(overrides) {
  const nowIso = new Date().toISOString();
  // Derive the trading date from the wall clock instead of a hardcoded literal:
  // a frozen date made every fixture look stale once the clock rolled past it.
  const today = jakartaToday();
  return Object.assign({
    ticker: 'TEST',
    status: 'A_PLUS_SETUP',
    final_status: 'A_PLUS_SETUP',
    action_label: 'BUY',
    quality_grade: 'A',
    score: 88,
    daytrade_score: 88,
    risk_reward: 1.8,
    entry1: 100,
    entry_low: 100,
    entry2: 100,
    entry_high: 100,
    stop_loss: 95,
    sl: 95,
    tp1: 115,
    tp1n: 115,
    tp2: 125,
    last_price: 100,
    volume_ratio_20d: 1.5,
    value_today: 5000000000,
    risk_label: 'Low Risk',
    plan_quality_status: 'VALID',
    trading_plan_valid: true,
    breakout_confirmation_status: 'CONFIRMED',
    breakout_confirmation_label: 'Breakout Confirmed',
    entry_timing: 'ENTRY_NOW',
    resistance: 99,
    breakout_trigger: 99,
    entry_status: 'IN_ENTRY_ZONE',
    entry_status_label: 'Area Entry',
    respect_quality_label: 'Strong Respect',
    trend_label: 'Bullish Trend',
    volume_label: 'Strong Volume',
    volume_confirmation_label: 'Strong Volume',
    foreign_label: 'Foreign Accumulation',
    rr_quality_label: 'Healthy RR',
    tp_quality_label: 'TP realistic',
    sl_quality_label: 'Safe SL',
    pattern_label: 'Breakout Consolidation',
    notes: 'Siap Entry',
    status_reason: 'Siap Entry',
    telegram_verdict: 'Siap entry.',
    is_top5: true,
    is_verified: true,
    verified: true,
    final_quality_pass: true,
    final_quality_status: 'PASS',
    final_gate_pass: true,
    final_gate_status: 'PASS',
    final_quality_reason: 'Siap entry terkonfirmasi',
    entry_range_display: '100 - 100',
    setup_origin_at: nowIso,
    freshness_timestamp: nowIso,
    calculated_at: nowIso,
    price_date: today,
    price_freshness_status: 'FRESH'
  }, overrides || {});
}

test('IN_ENTRY_ZONE is never sent as an immediate individual notification, but appears in hourly batch', async () => {
  const sentCalls = [];
  const origSend = telegramNotifier.sendTelegramMessage;
  telegramNotifier.sendTelegramMessage = async (text, options) => {
    sentCalls.push({ text, options });
    return { sent: true, skipped: false };
  };

  try {
    const NOW_ISO = new Date().toISOString();
    const scenario = {
      rows: [
        {
          id: 101,
          ticker: 'TEST',
          date: jakartaToday(),
          status: 'WAITING',
          is_final: false,
          entry1: 100,
          entry2: 98,
          tp1: 110,
          tp2: 120,
          sl: 95,
          first_sent_at: NOW_ISO,
          hit_entry_at: null,
          category: 'Swing Konglo',
          raw_payload: { monitor_source: 'swing_konglo' }
        }
      ],
      daytradePrices: {
        TEST: { last_price: 99, open_price: 99, high_price: 99, low_price: 99, calculated_at: NOW_ISO }
      }
    };

    // Half-hour run (minute 30): hourly batch is suppressed.
    // Since IN_ENTRY_ZONE is NOT an immediate individual hit, 0 messages sent!
    monitorClock.getJakartaMinute = () => 30;
    const sup30 = makeMonitorSupabase(scenario);
    const req30 = {
      method: 'GET',
      headers: { authorization: 'Bearer ' + process.env.CRON_SECRET },
      query: { force: '1' }
    };
    const res30 = { status() { return this; }, json(d) { this.body = d; return this; } };
    await handleTelegramMonitorPicks(req30, res30, sup30);

    assert.equal(sentCalls.length, 0, 'No individual message must be sent for IN_ENTRY_ZONE on half-hour run');
    assert.equal(res30.body.individual_sent_count, 0);

    // Top-of-hour run (minute 0): routine hourly batch summary IS sent.
    sentCalls.length = 0;
    monitorClock.getJakartaMinute = () => 0;
    const sup00 = makeMonitorSupabase(scenario);
    const req00 = {
      method: 'GET',
      headers: { authorization: 'Bearer ' + process.env.CRON_SECRET },
      query: { force: '1' }
    };
    const res00 = { status() { return this; }, json(d) { this.body = d; return this; } };
    await handleTelegramMonitorPicks(req00, res00, sup00);

    assert.equal(sentCalls.length, 1, 'Only the batch summary should be sent at top-of-hour');
    assert.match(sentCalls[0].text, /TEST · Swing Konglo — IN ENTRY ZONE/);
    assert.equal(res00.body.individual_sent_count, 0);
  } finally {
    telegramNotifier.sendTelegramMessage = origSend;
  }
});

test('In-run deduplication suppresses multiple hits for the same ticker in the same monitor run', async () => {
  const sentCalls = [];
  const origSend = telegramNotifier.sendTelegramMessage;
  telegramNotifier.sendTelegramMessage = async (text, options) => {
    sentCalls.push({ text, options });
    return { sent: true, skipped: false };
  };

  try {
    const NOW_ISO = new Date().toISOString();
    // Two active recommendations for same ticker TAPG (different plans/sources)
    const scenario = {
      rows: [
        {
          id: 1,
          ticker: 'TAPG',
          date: '2026-09-22',
          status: 'RUNNING',
          is_final: false,
          entry1: 100,
          entry2: 98,
          tp1: 105,
          sl: 95,
          hit_entry_at: NOW_ISO,
          hit_tp1_at: null,
          category: 'Day Trade',
          raw_payload: { monitor_source: 'daytrade_signal' }
        },
        {
          id: 2,
          ticker: 'TAPG',
          date: '2026-09-22',
          status: 'RUNNING',
          entry1: 100,
          entry2: 98,
          tp1: 105,
          sl: 95,
          hit_entry_at: NOW_ISO,
          hit_tp1_at: null,
          category: 'Swing Konglo',
          raw_payload: { monitor_source: 'swing_konglo' }
        }
      ],
      daytradePrices: {
        // High 106 >= TP1 105, low 104 > BEP/SL -> clean TP1_HIT
        TAPG: { last_price: 106, open_price: 104, high_price: 106, low_price: 104, calculated_at: NOW_ISO }
      }
    };

    // Both TAPG rows evaluate to TP1_HIT at minute 30.
    // In-run deduplication must allow ONLY 1 individual message for TAPG!
    monitorClock.getJakartaMinute = () => 30;
    const sup = makeMonitorSupabase(scenario);
    const req = {
      method: 'GET',
      headers: { authorization: 'Bearer ' + process.env.CRON_SECRET },
      query: { force: '1' }
    };
    const res = { status() { return this; }, json(d) { this.body = d; return this; } };
    await handleTelegramMonitorPicks(req, res, sup);

    assert.equal(sentCalls.length, 1, 'In-run deduplication must prevent duplicate TP1_HIT alert for same ticker TAPG');
    assert.equal(sentCalls[0].options.ticker, 'TAPG', 'Must pass ticker parameter');
    assert.equal(sentCalls[0].options.status, 'TP1_HIT', 'Must pass status parameter');
  } finally {
    telegramNotifier.sendTelegramMessage = origSend;
  }
});

test('isConfirmedDayTradeSignal strictly validates setup status and quality grade', () => {
  assert.equal(typeof isConfirmedDayTradeSignal, 'function', 'isConfirmedDayTradeSignal must be exported');

  // Valid screener setups
  assert.equal(isConfirmedDayTradeSignal({ status: 'A_PLUS_SETUP', quality_grade: 'A', daytrade_score: 90 }), true);
  assert.equal(isConfirmedDayTradeSignal({ status: 'TRADE_CANDIDATE', quality_grade: 'B', daytrade_score: 82 }), true);
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_BREAKOUT', quality_grade: 'A', daytrade_score: 85 }), true);
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_BREAKOUT', daytrade_score: 78 }), true, 'Missing grade falls back to score >= 75');

  // Unconfirmed or speculative statuses must be rejected
  assert.equal(isConfirmedDayTradeSignal({ status: 'PRE_SPIKE_WATCH', quality_grade: 'A', daytrade_score: 85 }), false, 'PRE_SPIKE_WATCH is not confirmed');
  assert.equal(isConfirmedDayTradeSignal({ status: 'EARLY_RADAR', quality_grade: 'A', daytrade_score: 85 }), false, 'EARLY_RADAR is not confirmed');
  assert.equal(isConfirmedDayTradeSignal({ status: 'MOMENTUM_CONTINUATION', quality_grade: 'A', daytrade_score: 85 }), false, 'MOMENTUM_CONTINUATION is not confirmed');
  assert.equal(isConfirmedDayTradeSignal({ status: 'RECLAIM_CANDIDATE', quality_grade: 'A', daytrade_score: 85 }), false, 'RECLAIM_CANDIDATE is not confirmed');
  assert.equal(isConfirmedDayTradeSignal({ status: 'WAIT_PULLBACK', quality_grade: 'A', daytrade_score: 85 }), false, 'WAIT_PULLBACK is not confirmed');

  // Low or invalid quality grade must be rejected
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_BREAKOUT', quality_grade: 'C', daytrade_score: 85 }), false, 'Grade C is not valid');
  assert.equal(isConfirmedDayTradeSignal({ status: 'A_PLUS_SETUP', quality_grade: 'Avoid', daytrade_score: 85 }), false, 'Grade Avoid is not valid');
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_BREAKOUT', quality_grade: 'High Risk', daytrade_score: 85 }), false, 'Grade High Risk is not valid');
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_BREAKOUT', daytrade_score: 65 }), false, 'Score below 75 with no grade is not valid');

  // Fast Watcher confirmed setups pass
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_CONFIRMED', ready_streak: 2 }), true);
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_BREAKOUT', run_mode: 'FAST_WATCHER_LIVE' }), true);
  assert.equal(isConfirmedDayTradeSignal({ status: 'READY_BREAKOUT', notes: 'FAST_WATCHER_CONFIRMED | flow=85' }), true);
});

test('sendDayTradeTelegramNotification passes ticker and status to sendTelegramMessage and deduplicates in-run', async () => {
  const sentCalls = [];
  const origSend = telegramNotifier.sendTelegramMessage;
  telegramNotifier.sendTelegramMessage = async (text, options) => {
    sentCalls.push({ text, options });
    return { sent: true, skipped: false };
  };

  try {
    const candidates = [
      row({ ticker: 'BBCA', status: 'A_PLUS_SETUP', quality_grade: 'A', score: 90, daytrade_score: 90 }),
      // Duplicate BBCA in batch should be deduplicated
      row({ ticker: 'BBCA', status: 'A_PLUS_SETUP', quality_grade: 'A', score: 92, daytrade_score: 92 }),
      // Unconfirmed setup should be filtered out
      row({ ticker: 'UNCONF', status: 'PRE_SPIKE_WATCH', quality_grade: 'B', score: 80, daytrade_score: 80 })
    ];

    const nowIso = new Date().toISOString();
    const today = jakartaToday();
    const mockSupabase = {
      from(table) {
        if (table === 'telegram_daily_picks') {
          const api = {
            select() { return api; },
            eq() { return api; },
            in() { return api; },
            gte() { return api; },
            lt() { return api; },
            order() { return api; },
            limit() { return api; },
            insert() { return Promise.resolve({ data: [], error: null }); },
            then(resolve, reject) {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            }
          };
          return api;
        }
        if (table === 'daytrade_screener_latest') {
          return {
            select() { return this; },
            order() { return this; },
            limit() { return Promise.resolve({ data: candidates, error: null }); },
            eq() { return this; },
            maybeSingle() { return Promise.resolve({ data: { calculated_at: nowIso, run_date: today, run_id: 'r1', status: 'published' }, error: null }); }
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          maybeSingle() { return Promise.resolve({ data: { calculated_at: nowIso, run_date: today, status: 'published' }, error: null }); },
          insert() { return Promise.resolve({ data: [], error: null }); }
        };
      }
    };

    const res = await sendDayTradeTelegramNotification(
      mockSupabase,
      'run-test-dedup',
      today,
      1,
      false,
      false,
      { bypass_time_guard: true }
    );

    assert.equal(res.sent, true, 'Result should be sent: ' + JSON.stringify(res));
    assert.equal(res.selected_count, 1, 'Duplicate BBCA and unconfirmed UNCONF must be filtered out');
    assert.equal(sentCalls.length, 1);
    assert.equal(sentCalls[0].options.ticker, 'BBCA', 'Options must include ticker parameter');
    assert.equal(sentCalls[0].options.status, 'A_PLUS_SETUP', 'Options must include status parameter');
  } finally {
    telegramNotifier.sendTelegramMessage = origSend;
  }
});

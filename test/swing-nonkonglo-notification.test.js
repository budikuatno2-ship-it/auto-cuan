'use strict';

// Regression test for PR-1: sendSwingNkTelegramNotification previously referenced
// undefined `radarCandidates` / `diagnostics` on the send path. In production the
// Telegram message was sent, then a ReferenceError was thrown and swallowed by the
// outer catch, so the function returned { sent: false, reason: 'exception' } and the
// monitoring-registration path (registerCandidatesForMonitoring) was never reached.
//
// This was masked in existing tests because their fixtures omit `price_date`, so the
// candidate was dropped by candidatePassesPriceFreshness before reaching the send path.
// Here we supply price_date=today so the candidate reaches the send path and exercises
// the previously-broken code.

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');

// Jakarta is a fixed UTC+7 offset (no DST).
const JAKARTA_TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function makeSupabase(tableRows, inserts) {
  return {
    from(table) {
      const rows = tableRows[table] || [];
      const builder = {
        select() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: rows, error: null }); },
        // .eq() is awaited directly in registerCandidatesForMonitoring, so make it thenable.
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: { calculated_at: new Date().toISOString(), run_id: 'r1', run_date: JAKARTA_TODAY, status: 'published' },
            error: null
          });
        },
        insert(payload) {
          if (inserts) inserts.push({ table, payload });
          return Promise.resolve({ data: payload, error: null });
        },
        then(resolve) { return resolve({ data: [], error: null }); }
      };
      return builder;
    }
  };
}

function strongNkRow(overrides) {
  return Object.assign({
    ticker: 'NKGOOD', rank: 1, price_date: JAKARTA_TODAY,
    status: 'TRADE_CANDIDATE', final_status: 'TRADE_CANDIDATE', quality_grade: 'A', grade: 'A',
    score: 90, daily_score: 90, daytrade_score: 90, risk_reward: 2.0,
    entry1: 100, entry_low: 100, entry2: 101, entry_high: 101, stop_loss: 95, sl: 95,
    tp1: 115, tp1n: 115, tp2: 130, tp2n: 130, last_price: 100, volume_ratio_20d: 1.5,
    value_today: 8000000000, traded_value: 8000000000, risk_label: 'Medium Risk',
    plan_quality_status: 'VALID', trading_plan_valid: true, final_quality_pass: true,
    final_quality_status: 'passed', telegram_verdict: 'Final quality gate passed.'
  }, overrides || {});
}

async function withSendSpy(fn) {
  const original = notifier.sendTelegramMessage;
  const calls = [];
  notifier.sendTelegramMessage = async (text) => { calls.push(text); return { sent: true, message: text }; };
  try { return await fn(calls); } finally { notifier.sendTelegramMessage = original; }
}

test('Swing Non-Konglo notifier handles public-safety-filtered candidate without ReferenceError', async () => {
  await withSendSpy(async (calls) => {
    const inserts = [];
    const supabase = makeSupabase({ swing_screener_non_konglo_latest: [strongNkRow()] }, inserts);

    const result = await sectorHot.__test.sendSwingNkTelegramNotification(supabase, 1);

    // No exception: the old bug returned reason 'exception' with the ReferenceError message.
    assert.notEqual(result.reason, 'exception');
    assert.equal(result.error_message, undefined);

    // Message was sent successfully as a safe heartbeat after the public safety filter.
    assert.equal(result.sent, true);
    assert.notEqual(result.skipped, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /empty heartbeat/i);
    assert.doesNotMatch(calls[0], /Hindari|AVOID|SELL|LOW_TP|Very High Risk/i);

    // A candidate was filtered before the public signal was built.
    assert.equal(result.selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);

    // No signal candidates are registered when selected_count is zero.
    const monitorInsert = inserts.find((i) => i.table === 'telegram_daily_picks');
    assert.equal(monitorInsert, undefined);
  });
});

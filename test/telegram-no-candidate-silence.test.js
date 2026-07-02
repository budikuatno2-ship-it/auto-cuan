'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');

function makeSupabase(tableRows) {
  return {
    from(table) {
      const rows = tableRows[table] || [];
      const builder = {
        select() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: rows, error: null }); },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: { calculated_at: new Date().toISOString(), run_id: 'r1', status: 'published' }, error: null }); }
      };
      return builder;
    }
  };
}

function row(overrides) {
  return Object.assign({
    ticker: 'TEST', status: 'WAIT_PULLBACK', score: 82, daytrade_score: 82, risk_reward: 1.6,
    entry1: 100, entry_low: 100, entry2: 101, entry_high: 101, stop_loss: 95, sl: 95,
    tp1: 115, tp1n: 115, tp2: 125, last_price: 100, volume_ratio_20d: 1.2,
    value_today: 5000000000, risk_label: 'Medium Risk', plan_quality_status: 'VALID', trading_plan_valid: true,
    telegram_verdict: 'Pantau dulu.'
  }, overrides || {});
}

async function withSendSpy(fn) {
  const original = notifier.sendTelegramMessage;
  const calls = [];
  notifier.sendTelegramMessage = async (text) => { calls.push(text); return { sent: true, message: text }; };
  try { return await fn(calls); } finally { notifier.sendTelegramMessage = original; }
}

test('public Telegram no-candidate message is not sent for Swing Konglo', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingKongloTelegramNotification(makeSupabase({ swing_screener_latest: [row({ status: 'WATCHLIST', score: 65 })] }), 1);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_final_quality_gate_candidates_silent');
    assert.equal(calls.length, 0);
  });
});

test('public Telegram no-candidate message is not sent for Swing Non-Konglo', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingNkTelegramNotification(makeSupabase({ swing_screener_non_konglo_latest: [row({ status: 'WATCHLIST', rank: 1 })] }), 1);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_final_quality_gate_candidates_silent');
    assert.equal(calls.length, 0);
  });
});

test('public Telegram no-candidate message is not sent for Day Trade without radar fallback', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendDayTradeTelegramNotification(makeSupabase({ daytrade_screener_latest: [row({ status: 'WAIT_PULLBACK', entry_timing: 'needs close confirmation' })] }), 'run-silent', '2026-07-02', 1, true, false, {});
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_final_quality_gate_candidates');
    assert.equal(calls.length, 0);
  });
});


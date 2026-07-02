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
    ticker: 'RADR', status: 'WAIT_PULLBACK', final_status: 'WAIT_PULLBACK', score: 82, daily_score: 82, daytrade_score: 82, risk_reward: 1.6,
    entry1: 100, entry_low: 100, entry2: 101, entry_high: 101, stop_loss: 95, sl: 95,
    tp1: 115, tp1n: 115, tp2: 125, tp2n: 125, last_price: 100, volume_ratio_20d: 1.2,
    value_today: 5000000000, traded_value: 5000000000, risk_label: 'Medium Risk', plan_quality_status: 'VALID', trading_plan_valid: true,
    breakout_confirmation_status: 'WAIT_PULLBACK', entry_timing: 'WAIT_PULLBACK', final_quality_pass: false,
    final_quality_status: 'needs close confirmation', telegram_verdict: 'Pantau dulu, needs close confirmation.'
  }, overrides || {});
}

async function withSendSpy(fn) {
  const original = notifier.sendTelegramMessage;
  const calls = [];
  notifier.sendTelegramMessage = async (text) => { calls.push(text); return { sent: true, message: text }; };
  try { return await fn(calls); } finally { notifier.sendTelegramMessage = original; }
}

function assertRadarDigestPublicSafe(text) {
  assert.match(text, /\[RADAR — BUKAN SINYAL ENTRY\]/);
  assert.match(text, /Pantauan, bukan sinyal entry\./);
  assert.match(text, /Konfirmasi manual wajib\./);
  assert.match(text, /Jangan entry jika harga sudah chase \/ tidak masuk area\./);
  assert.doesNotMatch(text, /\bSignal\b(?!.*bukan sinyal)/i);
  assert.doesNotMatch(text, /raw_payload|sample_rejected|stageByTicker|debug|internal notes|\[object Object\]/i);
}

test('Swing Konglo empty final Signal sends eligible Radar digest', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingKongloTelegramNotification(makeSupabase({ swing_screener_latest: [row()] }), 1);
    assert.equal(result.sent, true);
    assert.equal(result.radar_sent, true);
    assert.equal(result.reason, 'radar_digest_sent');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Swing Konglo Radar/);
    assertRadarDigestPublicSafe(calls[0]);
  });
});

test('Swing Konglo only Hard Reject stays silent', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingKongloTelegramNotification(makeSupabase({ swing_screener_latest: [row({ ticker: 'HARD', action_label: 'Hindari', risk_label: 'Very High Risk' })] }), 1);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_final_quality_gate_candidates_silent');
    assert.equal(calls.length, 0);
  });
});

test('Swing Non-Konglo empty final Signal sends eligible Radar digest', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingNkTelegramNotification(makeSupabase({ swing_screener_non_konglo_latest: [row({ ticker: 'NKRAD', rank: 1 })] }), 1);
    assert.equal(result.sent, true);
    assert.equal(result.radar_sent, true);
    assert.match(calls[0], /Swing Non-Konglo Radar/);
    assertRadarDigestPublicSafe(calls[0]);
  });
});

test('Swing Non-Konglo only Hard Reject stays silent', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingNkTelegramNotification(makeSupabase({ swing_screener_non_konglo_latest: [row({ ticker: 'NKHARD', rank: 1, action_label: 'Hindari', risk_label: 'Very High Risk' })] }), 1);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_final_quality_gate_candidates_silent');
    assert.equal(calls.length, 0);
  });
});

test('Top 5 empty final candidates sends Top 5 Radar digest', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendDailyTop5Telegram(makeSupabase({}), [row({ ticker: 'TOPR', category: 'Swing Konglo' })], '2026-07-02', {});
    assert.equal(result.header.sent, true);
    assert.equal(result.header.radar_sent, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Top 5 Radar/);
    assertRadarDigestPublicSafe(calls[0]);
  });
});

test('Top 5 only Hard Reject stays silent', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendDailyTop5Telegram(makeSupabase({}), [row({ ticker: 'TOPH', category: 'Swing Konglo', action_label: 'Hindari', risk_label: 'Very High Risk' })], '2026-07-02', {});
    assert.equal(result.header.skipped, true);
    assert.equal(result.header.reason, 'no_final_quality_gate_candidates_silent');
    assert.equal(calls.length, 0);
  });
});

test('normal Top 5 Signal remains preferred over Radar', async () => {
  await withSendSpy(async (calls) => {
    const signal = row({ ticker: 'SIG', category: 'Swing Konglo', status: 'TRADE_CANDIDATE', final_status: 'TRADE_CANDIDATE', quality_grade: 'A', score: 90, final_quality_pass: true, final_quality_status: 'passed', telegram_verdict: 'Final quality gate passed.' });
    const result = await sectorHot.__test.sendDailyTop5Telegram(makeSupabase({}), [signal, row({ ticker: 'RAD2', category: 'Swing Konglo' })], '2026-07-02', {});
    assert.equal(result.header.sent, true);
    assert.notEqual(result.header.radar_sent, true);
    assert.match(calls[0], /AUTO-CUAN SAHAM PILIHAN/);
  });
});

test('Avoid/Hindari/Very High Risk/weak liquidity/invalid plan/below SL/invalid candle cannot enter Radar digest', () => {
  const cases = [
    row({ ticker: 'AVD', action_label: 'Avoid' }),
    row({ ticker: 'HIN', action_label: 'Hindari' }),
    row({ ticker: 'VHR', risk_label: 'Very High Risk' }),
    row({ ticker: 'WLI', liquidity_label: 'Weak Liquidity' }),
    row({ ticker: 'IPL', plan_quality_status: 'INVALID' }),
    row({ ticker: 'BSL', last_price: 90, sl: 95 }),
    row({ ticker: 'ICA', data_quality_status: 'INVALID_CANDLE' })
  ];
  const selected = sectorHot.__test.selectRadarDigestCandidates(cases, 'swing_radar_digest', 5);
  assert.deepEqual(selected, []);
});

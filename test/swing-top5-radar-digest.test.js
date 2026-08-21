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

// Jakarta is a fixed UTC+7 offset (no DST). Candidates need a fresh price_date to
// pass candidatePassesPriceFreshness before reaching the digest/send path.
const JAKARTA_TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function row(overrides) {
  return Object.assign({
    ticker: 'RADR', price_date: JAKARTA_TODAY, status: 'WAIT_PULLBACK', final_status: 'WAIT_PULLBACK', score: 82, daily_score: 82, daytrade_score: 82, risk_reward: 1.6,
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

// Product decision (see PR #416 discussion): a benign final_quality_pass:false
// candidate (e.g. "needs close confirmation", watchlist-only, entry not
// touched, MTF mixed, wait/tunggu confirmation) is never promoted to a public
// "Signal" — it may only surface through the safe RADAR/MONITOR fallback path,
// clearly labeled as monitoring rather than an actionable entry.
test('Swing Konglo benign final_quality_pass:false candidate is Radar/Monitor only, never a Signal', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingKongloTelegramNotification(makeSupabase({ swing_screener_latest: [row()] }), 1);
    assert.equal(result.sent, true);
    assert.equal(result.selected_count, 0, 'a final_quality_pass:false candidate must never be a selected public Signal');
    assert.equal(result.monitor_fallback_sent, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /Swing Konglo Signal/i, 'must not be labeled/sent as an actionable Signal');
    assert.match(calls[0], /RADAR\/MONITOR/, 'must be clearly labeled as monitoring, not an entry signal');
    assert.match(calls[0], /bukan (BUY|sinyal entry)/i, 'must explicitly say this is not a buy/entry signal');
    assert.match(calls[0], /RADR/, 'the benign candidate itself may still be shown for monitoring purposes');
  });
});

// Hard-reject conditions (Hindari/Avoid, Very High Risk, invalid plan, invalid
// candle, below SL, fatal data-quality) must never be promoted into a Signal
// or a Radar/Monitor listing. Production stays on its existing safety
// contract: no unsafe candidate ticker/detail reaches any public Telegram
// message, whatever internal ops diagnostics (e.g. an empty-heartbeat notice)
// the screener may still emit.
test('Swing Konglo Hindari + Very High Risk candidate is excluded from Signal and Radar/Monitor', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingKongloTelegramNotification(makeSupabase({ swing_screener_latest: [row({ ticker: 'HARD', action_label: 'Hindari', risk_label: 'Very High Risk' })] }), 1);
    assert.equal(result.selected_count, 0, 'a Hindari/Very High Risk candidate must never be a selected public Signal');
    assert.equal(result.monitor_fallback_sent, false, 'must not be promoted into the Radar/Monitor fallback either');
    calls.forEach((text) => {
      assert.doesNotMatch(text, /HARD/, 'the rejected candidate ticker must never reach a public Telegram message');
      assert.doesNotMatch(text, /Swing Konglo Signal/i, 'must not be sent as a Signal');
      assert.doesNotMatch(text, /RADAR\/MONITOR/, 'must not be sent as a Radar/Monitor listing either');
    });
  });
});

test('Swing Non-Konglo benign final_quality_pass:false candidate is Radar/Monitor only, never a Signal', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingNkTelegramNotification(makeSupabase({ swing_screener_non_konglo_latest: [row({ ticker: 'NKRAD', rank: 1 })] }), 1);
    assert.equal(result.sent, true);
    assert.equal(result.selected_count, 0, 'a final_quality_pass:false candidate must never be a selected public Signal');
    assert.equal(result.monitor_fallback_sent, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /Swing Non-Konglo Signal/i, 'must not be labeled/sent as an actionable Signal');
    assert.match(calls[0], /RADAR\/MONITOR/, 'must be clearly labeled as monitoring, not an entry signal');
    assert.match(calls[0], /NKRAD/, 'the benign candidate itself may still be shown for monitoring purposes');
  });
});

test('Swing Non-Konglo Hindari + Very High Risk candidate is excluded from Signal and Radar/Monitor', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingNkTelegramNotification(makeSupabase({ swing_screener_non_konglo_latest: [row({ ticker: 'NKHARD', rank: 1, action_label: 'Hindari', risk_label: 'Very High Risk' })] }), 1);
    assert.equal(result.selected_count, 0, 'a Hindari/Very High Risk candidate must never be a selected public Signal');
    assert.equal(result.monitor_fallback_sent, false, 'must not be promoted into the Radar/Monitor fallback either');
    calls.forEach((text) => {
      assert.doesNotMatch(text, /NKHARD/, 'the rejected candidate ticker must never reach a public Telegram message');
      assert.doesNotMatch(text, /Swing Non-Konglo Signal/i, 'must not be sent as a Signal');
      assert.doesNotMatch(text, /RADAR\/MONITOR/, 'must not be sent as a Radar/Monitor listing either');
    });
  });
});

test('Top 5 empty final candidates sends Top 5 Radar digest', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendDailyTop5Telegram(makeSupabase({}), [], '2026-07-02', { radar_candidates: [row({ ticker: 'TOPR', category: 'Swing Konglo' })] });
    assert.equal(result.header.sent, true);
    assert.equal(result.header.radar_sent, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Top 5 Radar/);
    assertRadarDigestPublicSafe(calls[0]);
  });
});

test('Top 5 radar_candidates with only Hard Reject stays silent', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendDailyTop5Telegram(makeSupabase({}), [], '2026-07-02', { radar_candidates: [row({ ticker: 'TOPH', category: 'Swing Konglo', action_label: 'Hindari', risk_label: 'Very High Risk' })] });
    assert.equal(result.header.skipped, true);
    assert.equal(result.header.reason, 'no_final_quality_gate_candidates_silent');
    assert.equal(calls.length, 0);
  });
});

test('normal Top 5 Signal remains preferred over Radar', async () => {
  await withSendSpy(async (calls) => {
    const signal = row({ ticker: 'SIG', category: 'Swing Konglo', status: 'TRADE_CANDIDATE', final_status: 'TRADE_CANDIDATE', quality_grade: 'A', score: 90, final_quality_pass: true, final_quality_status: 'passed', telegram_verdict: 'Final quality gate passed.' });
    const result = await sectorHot.__test.sendDailyTop5Telegram(makeSupabase({}), [signal], '2026-07-02', { radar_candidates: [row({ ticker: 'RAD2', category: 'Swing Konglo' })] });
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

test('Radar digest selection sorts with numeric normalized scores and excludes high-score Hard Reject', () => {
  const selected = sectorHot.__test.selectRadarDigestCandidates([
    row({ ticker: 'LOWR', score: 80, display_score: 80 }),
    row({ ticker: 'HARD100', score: 100, display_score: 100, action_label: 'Hindari', risk_label: 'Very High Risk' }),
    row({ ticker: 'TOP100', score: 70, display_score: 100 }),
    row({ ticker: 'MID90', score: 90, display_score: 90 })
  ], 'swing_radar_digest', 5);
  assert.deepEqual(selected.map((candidate) => candidate.ticker), ['TOP100', 'MID90', 'LOWR']);
  assert.equal(selected.some((candidate) => candidate.ticker === 'HARD100'), false);
  const scoreA = sectorHot.__test.getRadarDigestSortScore(selected[0]);
  const scoreB = sectorHot.__test.getRadarDigestSortScore(selected[1]);
  assert.equal(Number.isNaN(scoreA), false);
  assert.equal(Number.isNaN(scoreB), false);
  assert.equal(scoreA > scoreB, true);
});

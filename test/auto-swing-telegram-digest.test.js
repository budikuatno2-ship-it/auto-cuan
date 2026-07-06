'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');

const {
  sendSwingKongloTelegramNotification,
  sendSwingNkTelegramNotification
} = sectorHot.__test;

function makeSupabase(kongloRows, nkRows) {
  return {
    from: function(table) {
      var data;
      if (table === 'swing_screener_latest') data = kongloRows || [];
      else if (table === 'swing_screener_non_konglo_latest') data = nkRows || [];
      else data = [];
      return {
        select: function() { return this; },
        order: function() { return this; },
        limit: function() { return Promise.resolve({ data: data, error: null }); },
        eq: function() { return this; },
        neq: function() { return this; },
        in: function() { return this; },
        maybeSingle: function() { return Promise.resolve({ data: { calculated_at: new Date().toISOString(), status: 'published' }, error: null }); }
      };
    }
  };
}

function validRow(overrides) {
  return Object.assign({
    ticker: 'BBRI', status: 'Watchlist', score: 72, rank: 1,
    last_price: 5025, entry_low: 5000, entry_high: 5050,
    stop_loss: 4800, tp1: 5500, tp2: 5800, risk_reward: 2.0,
    volume_ratio_avg20: 1.1, tx_value_1d: 5000000000, avg_tx_value_7d: 5000000000,
    trading_plan_valid: true, plan_quality_status: 'OK',
    risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk',
    tf_1d_context: 'Green candle', tf_5d_context: 'Bullish'
  }, overrides || {});
}

function withSendSpy(fn) {
  var original = notifier.sendTelegramMessage;
  var calls = [];
  notifier.sendTelegramMessage = async function(text) { calls.push(text); return { sent: true, message: text }; };
  return fn(calls).finally(function() { notifier.sendTelegramMessage = original; });
}

test('Swing Konglo auto sends rich candidate when strict gate fails but digest gate passes', async function() {
  await withSendSpy(async function(calls) {
    // Very High Risk candidate fails strict gate but passes digest gate
    var supabase = makeSupabase([validRow({ ticker: 'VHRC', risk_label: 'Very High Risk' })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.sent, true, 'Should send Telegram message');
    assert.ok(result.selected_count > 0, 'Should have selected candidates');
    assert.ok(calls.length >= 1, 'Should have sent at least 1 message');
    assert.match(calls[0], /Swing Konglo Signal/);
    assert.match(calls[0], /VHRC/);
    // Rich format fields
    assert.match(calls[0], /Status:/);
    assert.match(calls[0], /RR:/);
    assert.match(calls[0], /Verdict:/);
  });
});

test('Swing Non-Konglo auto sends rich candidate when strict gate fails but digest gate passes', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [validRow({ ticker: 'NKVH', rank: 1, risk_label: 'Very High Risk' })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.sent, true, 'Should send Telegram message');
    assert.ok(result.selected_count > 0, 'Should have selected candidates');
    assert.ok(calls.length >= 1);
    assert.match(calls[0], /Swing Non-Konglo Signal/);
    assert.match(calls[0], /NKVH/);
    assert.match(calls[0], /Status:/);
    assert.match(calls[0], /Verdict:/);
  });
});

test('Swing Konglo auto stays silent when all candidates are fatal (missing SL)', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([validRow({ ticker: 'FATAL', stop_loss: null })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0, 'Should not send any message');
  });
});

test('Swing Non-Konglo auto stays silent when all candidates are fatal (missing SL)', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [validRow({ ticker: 'FATAL', rank: 1, stop_loss: null })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0, 'Should not send any message');
  });
});

test('Swing Konglo telemetry includes digest_candidate_count', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([validRow({ ticker: 'TELE' })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.ok(result.digest_candidate_count != null, 'Should have digest_candidate_count');
    assert.ok(result.digest_candidate_count > 0, 'digest_candidate_count should be > 0');
  });
});

test('Endpoint count remains 12', function() {
  var apiDir = path.join(__dirname, '..', 'api');
  var files = fs.readdirSync(apiDir).filter(function(f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12);
});

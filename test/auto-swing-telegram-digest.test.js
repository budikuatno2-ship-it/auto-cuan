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

const JAKARTA_TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const JAKARTA_TOMORROW = new Date(Date.now() + 31 * 3600 * 1000).toISOString().slice(0, 10);

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
        maybeSingle: function() { return Promise.resolve({ data: { calculated_at: new Date().toISOString(), status: 'published', run_date: JAKARTA_TODAY }, error: null }); }
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
    tf_1d_context: 'Green candle', tf_5d_context: 'Bullish', price_date: JAKARTA_TODAY, calculated_at: new Date().toISOString(), setup_freshness_status: 'FRESH'
  }, overrides || {});
}

function withSendSpy(fn) {
  var original = notifier.sendTelegramMessage;
  var calls = [];
  notifier.sendTelegramMessage = async function(text) { calls.push(text); return { sent: true, message: text }; };
  return fn(calls).finally(function() { notifier.sendTelegramMessage = original; });
}

test('Swing Konglo public safety filter blocks Very High Risk digest candidate', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([validRow({ ticker: 'VHRC', risk_label: 'Very High Risk' })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.sent, true, 'Should send Telegram message');
    assert.equal(result.selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.equal(result.final_selected_after_public_safety_count, 0);
    assert.doesNotMatch(calls[0], /SWING KONGLO SIGNAL/i);
    assert.doesNotMatch(calls[0], /VHRC/);
    assert.doesNotMatch(calls[0], /Very High Risk/i);
  });
});

test('Swing Non-Konglo public safety filter blocks Very High Risk digest candidate', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [validRow({ ticker: 'NKVH', rank: 1, risk_label: 'Very High Risk' })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.ok(result && typeof result === 'object', 'Should return handled result');
    assert.equal(result.sent, true);
    assert.equal(result.selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.equal(result.final_selected_after_public_safety_count, 0);
    assert.doesNotMatch(calls[0], /SWING NON-KONGLO SIGNAL/i);
    assert.doesNotMatch(calls[0], /NKVH/);
    assert.doesNotMatch(calls[0], /Very High Risk/i);
  });
});

test('Swing Konglo auto sends heartbeat when all candidates are fatal (missing SL)', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([validRow({ ticker: 'FATAL', stop_loss: null })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.equal(calls.length, 1, 'Should send heartbeat');
  });
});

test('Swing Non-Konglo auto sends heartbeat when all candidates are fatal (missing SL)', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [validRow({ ticker: 'FATAL', rank: 1, stop_loss: null })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.equal(calls.length, 1, 'Should send heartbeat');
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

test('Swing Non-Konglo finalize no-min-TP branch sends TP heartbeat with diagnostics', async function() {
  await withSendSpy(async function(calls) {
    const stagingRows = [
      validRow({ ticker: 'LOW1', entry_low: 100, entry_high: 100, tp1: 103, status: 'Watchlist' }),
      validRow({ ticker: 'MISS', entry_low: 100, entry_high: 100, tp1: null, status: 'Watchlist' })
    ];
    let stagingLimitCalls = 0;
    const supabase = {
      from: function(table) {
        const chain = {
          select: function(_cols, opts) {
            if (opts && opts.count === 'exact') this._count = true;
            return this;
          },
          eq: function() {
            if (this._count) return Promise.resolve({ count: stagingRows.length, error: null });
            return this;
          },
          in: function() { return Promise.resolve({ data: [], error: null }); },
          order: function() { return this; },
          limit: function() {
            if (table === 'swing_screener_non_konglo_staging') {
              stagingLimitCalls += 1;
              return Promise.resolve({ data: stagingLimitCalls === 1 ? [] : stagingRows, error: null });
            }
            return Promise.resolve({ data: [], error: null });
          },
          maybeSingle: function() { return Promise.resolve({ data: { scanned_count: 2 }, error: null }); },
          upsert: function() { return Promise.resolve({ data: [], error: null }); }
        };
        return chain;
      }
    };
    let body;
    const res = { status: function() { return { json: function(payload) { body = payload; return payload; } }; } };
    await sectorHot.__test.handleNkScreenerFinalize({ headers: {}, query: {} }, res, supabase);
    assert.equal(body.step, 'finalize');
    assert.equal(body.status, 'COMPLETED_NO_CANDIDATES');
    assert.equal(body.telegram.sent, true);
    assert.equal(body.telegram.skipped, false);
    assert.equal(body.telegram.reason, 'swing_nonkonglo_empty_tp_heartbeat_sent');
    assert.ok(body.min_tp1_upside_diagnostics);
    assert.ok(body.entry_range_normalization_diagnostics);
    assert.equal(body.min_tp1_upside_diagnostics.total_pre_tp_candidates, 2);
    assert.match(body.telegram.message, /Threshold:/);
    assert.match(body.telegram.message, /Total pre-TP candidates: 2/);
    assert.match(body.telegram.message, /LOW1|MISS/);
    assert.equal(calls.length, 1);
  });
});

test('Swing Konglo selected_count=0 heartbeat includes normalization diagnostics when source candidates exist', async function() {
  await withSendSpy(async function() {
    var supabase = makeSupabase([validRow({ ticker: 'LOWK', entry_low: 100, entry_high: 100, tp1: 102, stop_loss: null })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.ok(result.entry_range_normalization_diagnostics);
    assert.ok(result.min_tp1_upside_diagnostics);
    assert.equal(result.min_tp1_upside_diagnostics.total_pre_tp_candidates, 1);
  });
});

test('Swing Non-Konglo finalize uses persisted meta run_date and exposes staging diagnostics', async function() {
  await withSendSpy(async function() {
    const runDate = '2026-07-08';
    const stagingRows = [validRow({ ticker: 'PASS1', run_date: runDate, entry_low: 100, entry_high: 100, tp1: 115, score: 88, risk_label: 'Medium Risk' })];
    const inserted = [];
    const jobs = [{ id: 'batch-7', batch_index: 7, status: 'done', result_count: 1, run_date: runDate }];
    const supabase = {
      from: function(table) {
        const chain = {
          _table: table,
          _count: false,
          select: function(_cols, opts) { if (opts && opts.count === 'exact') this._count = true; return this; },
          eq: function(_col, value) {
            if (this._count && table === 'swing_screener_non_konglo_staging') return Promise.resolve({ count: stagingRows.filter(r => r.run_date === value).length, error: null });
            return this;
          },
          in: function() { return Promise.resolve({ data: [], error: null }); },
          order: function() { return this; },
          limit: function() {
            if (table === 'swing_screener_non_konglo_staging') return Promise.resolve({ data: stagingRows, error: null });
            if (table === 'swing_screener_non_konglo_jobs') return Promise.resolve({ data: jobs, error: null });
            if (table === 'swing_screener_non_konglo_latest') return Promise.resolve({ data: inserted, error: null });
            return Promise.resolve({ data: [], error: null });
          },
          maybeSingle: function() {
            return Promise.resolve({ data: { run_date: runDate, status: 'scanning', scanned_count: 8 }, error: null });
          },
          upsert: function() { return Promise.resolve({ data: [], error: null }); },
          update: function() { return { eq: function() { return Promise.resolve({ data: [], error: null }); } }; },
          delete: function() { return { neq: function() { return Promise.resolve({ data: [], error: null }); } }; },
          insert: function(rows) { inserted.push.apply(inserted, rows); return Promise.resolve({ data: rows, error: null }); }
        };
        return chain;
      }
    };
    let body;
    const res = { status: function() { return { json: function(payload) { body = payload; return payload; } }; } };
    await sectorHot.__test.handleNkScreenerFinalize({ headers: {}, query: {} }, res, supabase);
    assert.equal(body.status, 'PUBLISHED');
    assert.equal(body.run_date, runDate);
    assert.equal(body.staging_table, 'swing_screener_non_konglo_staging');
    assert.deepEqual(body.staging_query_keys.run_date, runDate);
    assert.equal(body.staging_rows_found, 1);
    assert.equal(body.batch_passed_seen_count, 1);
    assert.equal(body.last_batch_id_seen, 'batch-7');
    assert.equal(inserted.length, 1);
  });
});

test('Swing Non-Konglo finalize mismatch diagnostics report exact empty query keys and no_staging_rows', async function() {
  await withSendSpy(async function() {
    const runDate = '2026-07-08';
    const jobs = [{ id: 'batch-2', batch_index: 2, status: 'done', result_count: 2, run_date: runDate }];
    const supabase = {
      from: function(table) {
        const chain = {
          _count: false,
          select: function(_cols, opts) { if (opts && opts.count === 'exact') this._count = true; return this; },
          eq: function(_col, _value) {
            if (this._count && table === 'swing_screener_non_konglo_staging') return Promise.resolve({ count: 0, error: null });
            return this;
          },
          in: function() { return Promise.resolve({ data: [], error: null }); },
          order: function() { return this; },
          limit: function() {
            if (table === 'swing_screener_non_konglo_jobs') return Promise.resolve({ data: jobs, error: null });
            return Promise.resolve({ data: [], error: null });
          },
          maybeSingle: function() { return Promise.resolve({ data: { run_date: runDate, status: 'scanning', scanned_count: 8 }, error: null }); },
          upsert: function() { return Promise.resolve({ data: [], error: null }); },
          update: function() { return { eq: function() { return Promise.resolve({ data: [], error: null }); } }; }
        };
        return chain;
      }
    };
    let body;
    const res = { status: function() { return { json: function(payload) { body = payload; return payload; } }; } };
    await sectorHot.__test.handleNkScreenerFinalize({ headers: {}, query: {} }, res, supabase);
    assert.equal(body.status, 'COMPLETED_NO_CANDIDATES');
    assert.equal(body.staging_query_keys.run_date, runDate);
    assert.equal(body.staging_rows_found, 0);
    assert.equal(body.batch_passed_seen_count, 2);
    assert.deepEqual(body.top_rejection_reasons, [{ reason: 'no_staging_rows', count: 1 }]);
    assert.match(body.message, /Staging query keys/);
  });
});

test('Swing Non-Konglo staging sanitizer drops latest-only timeframe fields before durable upsert', function() {
  const row = {
    ticker: 'NKTF',
    run_date: JAKARTA_TODAY,
    tf_1d_context: 'bullish',
    tf_2d_context: 'latest-only',
    tf_3d_context: 'latest-only',
    tf_5d_context: 'neutral',
    tf_10d_context: 'latest-only',
    tf_20d_context: 'bullish',
    multi_timeframe_bias: 'bullish',
    multi_timeframe_notes: 'latest-only notes',
    score: 88
  };
  const sanitized = sectorHot.__test.sanitizeNkStagingRow(row);
  assert.equal(sanitized.ticker, 'NKTF');
  assert.equal(sanitized.run_date, JAKARTA_TODAY);
  assert.equal(sanitized.tf_1d_context, 'bullish');
  assert.equal(sanitized.tf_5d_context, 'neutral');
  assert.equal(sanitized.tf_20d_context, 'bullish');
  assert.equal(sanitized.multi_timeframe_bias, 'bullish');
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'tf_2d_context'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'tf_3d_context'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'tf_10d_context'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'multi_timeframe_notes'), false);
});

test('Swing Non-Konglo heartbeat separates latest published rows from Telegram selected count', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [validRow({ ticker: 'PUB1', rank: 1, stop_loss: null })]);
    var result = await sendSwingNkTelegramNotification(supabase, 19);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.equal(result.latest_published_count, 19);
    assert.equal(result.published_count, 19);
    assert.equal(result.selected_count, 0);
    assert.doesNotMatch(calls[0], /selected\/published\s*=\s*0/i);
    assert.doesNotMatch(calls[0], /published\s*=\s*0/i);
    assert.match(calls[0], /Telegram selected = 0/);
    assert.match(calls[0], /Latest published rows: 19/);
    assert.doesNotMatch(calls[0], /AVOID|Hindari|SELL|LOW_TP|Very High Risk/i);
  });
});

test('Swing Konglo heartbeat separates saved generated rows from Telegram selected count', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([validRow({ ticker: 'KONG', stop_loss: null })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 7);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.equal(result.latest_published_count, 7);
    assert.equal(result.saved_count, 7);
    assert.equal(result.strict_selected_count, 0);
    assert.equal(result.selected_count, 0);
    assert.doesNotMatch(calls[0], /selected\/published\s*=\s*0/i);
    assert.match(calls[0], /Telegram selected = 0/);
    assert.match(calls[0], /Latest published rows: 7/);
    assert.match(calls[0], /Saved: 7/);
  });
});

function monitorRow(overrides) {
  return Object.assign(validRow({
    ticker: 'MONI', status: 'MONITOR', final_status: 'MONITOR', score: 45, rank: 1, price_date: JAKARTA_TODAY, last_price: 100,
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk', quality_grade: 'C', grade: 'C',
    entry_low: 100, entry_high: 102, entry1: 100, entry2: 102,
    stop_loss: 94, sl: 94, tp1: 110, target1: 110, risk_reward: 0,
    setup_freshness_status: 'FRESH', execution_reality_status: 'ARA_HIT', telegram_verdict: 'Tunggu breakout valid.',
    trading_plan_valid: true, plan_quality_status: 'VALID'
  }), overrides || {});
}


function digestMonitorRow(overrides) {
  return monitorRow(Object.assign({ risk_reward: 1.4, execution_reality_status: null }, overrides || {}));
}

test('Swing Non-Konglo digest path does not bypass generated Hindari action safety', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [digestMonitorRow({ ticker: 'NDIG' })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_monitor_fallback_sent');
    assert.equal(result.selected_count, 0);
    assert.equal(result.strict_selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.doesNotMatch(calls[0], /SWING NON-KONGLO SIGNAL/i);
  });
});

test('Swing Non-Konglo public safety filter excludes Hindari/Very High row from normal signal', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [
      digestMonitorRow({ ticker: 'RAJA', rank: 1, score: 80, action_label: 'Hindari / Tunggu konfirmasi', risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' })
    ]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.equal(result.final_selected_after_public_safety_count, 0);
    assert.doesNotMatch(calls[0], /SWING NON-KONGLO SIGNAL/i);
    assert.doesNotMatch(calls[0], /RAJA/);
    assert.doesNotMatch(calls[0], /Hindari|Very High Risk/i);
  });
});

test('Swing Non-Konglo all-public-unsafe finalList sends monitor fallback when safe monitor exists', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [
      digestMonitorRow({ ticker: 'RAJA', rank: 1, score: 80, action_label: 'Hindari / Tunggu konfirmasi', risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' }),
      monitorRow({ ticker: 'NMON', rank: 2 })
    ]);
    var result = await sendSwingNkTelegramNotification(supabase, 2);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_monitor_fallback_sent');
    assert.equal(result.selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.equal(result.final_selected_after_public_safety_count, 0);
    assert.match(calls[0], /RADAR\/MONITOR/);
    assert.match(calls[0], /NMON/);
    assert.doesNotMatch(calls[0], /RAJA|Hindari|Very High Risk/i);
  });
});

test('Swing Non-Konglo all-public-unsafe finalList sends empty heartbeat when no safe monitor exists', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [
      digestMonitorRow({ ticker: 'RAJA', rank: 1, score: 80, action_label: 'Hindari / Tunggu konfirmasi', risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' })
    ]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.equal(result.selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.equal(result.final_selected_after_public_safety_count, 0);
    assert.doesNotMatch(calls[0], /SWING NON-KONGLO SIGNAL/i);
    assert.doesNotMatch(calls[0], /RAJA|Hindari|Very High Risk/i);
  });
});

test('Swing Konglo digest path does not bypass generated Hindari action safety', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([digestMonitorRow({ ticker: 'KDIG' })], null);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_monitor_fallback_sent');
    assert.equal(result.selected_count, 0);
    assert.equal(result.strict_selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.doesNotMatch(calls[0], /SWING KONGLO SIGNAL/i);
  });
});

test('Swing Konglo public safety filter excludes Hindari/Very High row from normal signal', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([
      digestMonitorRow({ ticker: 'KRAJ', score: 80, action_label: 'Hindari / Tunggu konfirmasi', risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' })
    ], null);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.selected_count, 0);
    assert.equal(result.public_safety_filtered_count, 1);
    assert.equal(result.final_selected_after_public_safety_count, 0);
    assert.doesNotMatch(calls[0], /SWING KONGLO SIGNAL/i);
    assert.doesNotMatch(calls[0], /KRAJ|Hindari|Very High Risk/i);
  });
});

test('Swing Non-Konglo strict selected 0 plus safe monitor candidates sends monitor fallback', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [monitorRow({ ticker: 'NMON' })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_monitor_fallback_sent');
    assert.equal(result.selected_count, 0);
    assert.equal(result.strict_selected_count, 0);
    assert.equal(result.monitor_fallback_sent, true);
    assert.equal(result.monitor_candidate_count, 1);
    assert.match(calls[0], /NMON/);
  });
});

test('Swing Non-Konglo monitor fallback message says bukan BUY and tunggu trigger', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [monitorRow({ ticker: 'TRIG' })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.reason, 'swing_monitor_fallback_sent');
    assert.match(calls[0], /RADAR\/MONITOR — bukan BUY, tunggu trigger\./);
  });
});

[
  ['AVOID/Hindari candidate excluded', { ticker: 'AVOD', status: 'MONITOR', action_label: 'Hindari', notes: 'avoid dulu' }],
  ['Very High Risk excluded', { ticker: 'VHR', risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' }],
  ['LOW_TP excluded', { ticker: 'LOWT', reason: 'LOW_TP' }],
  ['missing SL excluded', { ticker: 'MSL', stop_loss: null, sl: null }],
  ['TP1 upside below 5 excluded', { ticker: 'LOWU', entry_low: 100, entry_high: 100, entry1: 100, entry2: 100, tp1: 104, target1: 104 }]
].forEach(function(item) {
  test('Swing Non-Konglo monitor fallback safety: ' + item[0], async function() {
    var candidates = sectorHot.__test.selectSafeSwingMonitorCandidates(
      [monitorRow(item[1])],
      { calculated_at: new Date().toISOString(), status: 'published', run_date: JAKARTA_TODAY },
      'Swing Non-Konglo',
      5
    );
    assert.equal(candidates.length, 0);
  });
});

test('Swing Non-Konglo empty heartbeat still sent if no safe monitor candidates exist', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [monitorRow({ ticker: 'NONE', status: 'TRADE_CANDIDATE', stop_loss: null, sl: null })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.equal(result.selected_count, 0);
    assert.equal(result.monitor_fallback_sent, false);
    assert.match(calls[0], /empty heartbeat/);
  });
});


test('Swing monitor diagnostics: safe candidate passes diagnostics', function() {
  var diag = sectorHot.__test.diagnoseSwingMonitorCandidate(monitorRow({ ticker: 'SAFE' }));
  assert.equal(diag.passed, true);
  assert.equal(diag.reason, 'passed');
});

test('Swing monitor diagnostics reports rejection reasons', function() {
  var cases = [
    [{ status: 'TRADE_CANDIDATE' }, 'unsupported_status'],
    [{ stop_loss: null, sl: null }, 'missing_stop_loss'],
    [{ entry_high: 100, entry2: 100, tp1: 104, target1: 104 }, 'below_min_tp1_upside'],
    [{ setup_freshness_status: 'EXPIRED' }, 'stale_or_expired'],
    [{ action_label: 'Hindari', notes: 'AVOID dulu' }, 'blocked_text'],
    [{ risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' }, 'very_high_risk'],
    [{ trading_plan_valid: false, plan_quality_status: 'INVALID' }, 'invalid_plan']
  ];
  cases.forEach(function(item) {
    var diag = sectorHot.__test.diagnoseSwingMonitorCandidate(monitorRow(item[0]));
    assert.equal(diag.passed, false);
    assert.equal(diag.reason, item[1]);
  });
});

test('Swing monitor diagnostics reports price freshness rejection before safe helper', function() {
  var diagnostics = sectorHot.__test.buildSwingMonitorFallbackDiagnostics(
    [monitorRow({ ticker: 'OLDP', price_date: '2026-07-08' })],
    { calculated_at: new Date().toISOString(), status: 'published', run_date: JAKARTA_TODAY },
    'Swing Non-Konglo'
  );
  assert.equal(diagnostics.monitor_candidate_count, 0);
  assert.equal(diagnostics.price_freshness_rejected_count, 1);
  assert.equal(diagnostics.top_rejection_reasons[0].reason, 'price_freshness_rejected');
  assert.equal(diagnostics.sample_rejections[0].ticker, 'OLDP');
  assert.equal(diagnostics.sample_rejections[0].price_date, '2026-07-08');
});

test('Swing monitor fallback uses trusted current meta run_date when price date is missing', function() {
  var diagnostics = sectorHot.__test.buildSwingMonitorFallbackDiagnostics(
    [monitorRow({ ticker: 'META', price_date: null, price_asof: null })],
    { calculated_at: new Date().toISOString(), status: 'published', run_date: JAKARTA_TODAY },
    'Swing Non-Konglo'
  );
  assert.equal(diagnostics.monitor_candidate_count, 1);
  assert.equal(diagnostics.price_date_fallback_count, 1);
  assert.equal(diagnostics.safe_monitor_sample[0].price_date, JAKARTA_TODAY);
  assert.equal(diagnostics.safe_monitor_sample[0].price_freshness_source, 'swing_meta_run_date_fallback');
  assert.equal(diagnostics.safe_monitor_sample[0].price_date_fallback_used, true);
});

test('Swing monitor fallback does not bypass freshness without meta run_date', function() {
  var candidates = sectorHot.__test.selectSafeSwingMonitorCandidates(
    [monitorRow({ ticker: 'MISSRUN', price_date: null, price_asof: null })],
    { calculated_at: new Date().toISOString(), status: 'published' },
    'Swing Non-Konglo',
    5
  );
  assert.equal(candidates.length, 0);
});

test('Swing monitor fallback does not allow stale meta run_date', function() {
  var candidates = sectorHot.__test.selectSafeSwingMonitorCandidates(
    [monitorRow({ ticker: 'OLDRUN', price_date: null, price_asof: null })],
    { calculated_at: new Date().toISOString(), status: 'published', run_date: '2026-07-08' },
    'Swing Non-Konglo',
    5
  );
  assert.equal(candidates.length, 0);
});

test('Swing monitor fallback does not allow future meta run_date', function() {
  var candidates = sectorHot.__test.selectSafeSwingMonitorCandidates(
    [monitorRow({ ticker: 'FUTRUN', price_date: null, price_asof: null })],
    { calculated_at: new Date().toISOString(), status: 'published', run_date: JAKARTA_TOMORROW },
    'Swing Non-Konglo',
    5
  );
  assert.equal(candidates.length, 0);
});

test('Swing monitor fallback preserves explicit price_date', function() {
  var candidate = sectorHot.__test.applyTrustedSwingLatestPriceDateFallback(
    monitorRow({ ticker: 'EXPL', price_date: JAKARTA_TODAY }),
    { calculated_at: new Date().toISOString(), status: 'published', run_date: '2099-01-01' },
    'Swing Non-Konglo'
  );
  assert.equal(candidate.price_date, JAKARTA_TODAY);
  assert.equal(candidate.price_date_fallback_used, undefined);
});

test('Swing latest price date fallback applies to Non-Konglo and Konglo monitor selection only through Swing helpers', function() {
  var meta = { calculated_at: new Date().toISOString(), status: 'published', run_date: JAKARTA_TODAY };
  var nkCandidates = sectorHot.__test.selectSafeSwingMonitorCandidates(
    [monitorRow({ ticker: 'NKMETA', price_date: null, price_asof: null })],
    meta,
    'Swing Non-Konglo',
    5
  );
  var kongloCandidates = sectorHot.__test.selectSafeSwingMonitorCandidates(
    [monitorRow({ ticker: 'KMETA', price_date: null, price_asof: null })],
    meta,
    'Swing Konglo',
    5
  );
  assert.equal(nkCandidates.length, 1);
  assert.equal(kongloCandidates.length, 1);
  assert.equal(nkCandidates[0].price_date_fallback_used, true);
  assert.equal(kongloCandidates[0].price_date_fallback_used, true);
});

test('Swing Non-Konglo empty heartbeat includes monitor fallback diagnostics', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase(null, [monitorRow({ ticker: 'NOSL', stop_loss: null, sl: null })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.reason, 'swing_empty_heartbeat_sent');
    assert.equal(result.monitor_fallback_diagnostics.missing_stop_loss_count, 1);
    assert.equal(result.monitor_rejection_top_reason, 'missing_stop_loss');
    assert.match(calls[0], /Top monitor reject: missing_stop_loss \(1\)/);
  });
});

test('Swing monitor fallback sent response includes monitor fallback diagnostics', async function() {
  await withSendSpy(async function() {
    var supabase = makeSupabase(null, [monitorRow({ ticker: 'GOOD' })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.reason, 'swing_monitor_fallback_sent');
    assert.equal(result.monitor_fallback_diagnostics.monitor_candidate_count, 1);
    assert.equal(result.monitor_fallback_diagnostics.safe_monitor_sample[0].ticker, 'GOOD');
  });
});
test('Swing Konglo strict selected 0 plus safe monitor candidates sends same monitor fallback', async function() {
  await withSendSpy(async function(calls) {
    var supabase = makeSupabase([monitorRow({ ticker: 'KMON' })], null);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.reason, 'swing_monitor_fallback_sent');
    assert.equal(result.selected_count, 0);
    assert.equal(result.monitor_fallback_sent, true);
    assert.match(calls[0], /RADAR\/MONITOR — bukan BUY, tunggu trigger\./);
    assert.match(calls[0], /KMON/);
  });
});

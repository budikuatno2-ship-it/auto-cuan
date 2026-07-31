'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function write(relativePath, content) {
  const file = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Patch target not found: ${label}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Patch target is ambiguous: ${label}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function replaceRegexOnce(source, regex, replacement, label) {
  const matches = source.match(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`));
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one regex target for ${label}, found ${matches ? matches.length : 0}`);
  }
  return source.replace(regex, replacement);
}

function patchFinalizer() {
  const file = 'api/sector-hot.js';
  let source = read(file);

  source = replaceOnce(
    source,
    ".select('ticker, daytrade_score, status, action_label')",
    ".select('ticker, daytrade_score, status')",
    'remove non-persisted action_label from finalizer select'
  );

  source = replaceOnce(
    source,
    "  var rawBatchPassedCount = counters ? (counters.passed_count || 0) : 0;\n  var prePublishCandidateCount = allRows ? allRows.length : 0;",
    "  var rawBatchPassedCount = counters ? (counters.passed_count || 0) : 0;\n  if (readErr) {\n    var failedScannedCount = counters ? (counters.scanned_count || universeCount) : universeCount;\n    var failedTickerCount = counters ? (counters.failed_count || 0) : 0;\n    console.error('[daytrade-screener-finalize] candidate read failed:', readErr.message || readErr);\n    await updateDtMeta(supabase, {\n      status: 'failed',\n      run_date: runDate,\n      run_mode: runMode,\n      run_id: runId,\n      universe_count: universeCount,\n      scanned_count: failedScannedCount,\n      failed_count: failedTickerCount,\n      passed_count: rawBatchPassedCount,\n      published_count: 0,\n      top_count: 0,\n      message: 'Day Trade finalization failed while reading saved candidates.'\n    });\n    return res.status(500).json({\n      success: false,\n      status: 'failed',\n      error_code: 'daytrade_finalize_read_failed',\n      error: 'Day Trade candidates were scanned but could not be finalized.',\n      run_id: runId,\n      run_mode: runMode,\n      run_date: runDate,\n      universe_count: universeCount,\n      scanned_count: failedScannedCount,\n      failed_count: failedTickerCount,\n      passed_count: rawBatchPassedCount,\n      raw_batch_passed_count: rawBatchPassedCount,\n      published_count: 0\n    });\n  }\n  allRows = allRows || [];\n  var prePublishCandidateCount = allRows.length;",
    'surface finalizer read errors instead of false zero'
  );

  source = replaceOnce(
    source,
    "      await supabase.from('daytrade_screener_latest').delete().in('ticker', tickersToRemove);",
    "      var { error: trimErr } = await supabase.from('daytrade_screener_latest').delete().in('ticker', tickersToRemove);\n      if (trimErr) {\n        console.error('[daytrade-screener-finalize] top-50 trim failed:', trimErr.message || trimErr);\n        await updateDtMeta(supabase, {\n          status: 'failed',\n          run_date: runDate,\n          run_mode: runMode,\n          run_id: runId,\n          universe_count: universeCount,\n          scanned_count: counters ? (counters.scanned_count || universeCount) : universeCount,\n          failed_count: counters ? (counters.failed_count || 0) : 0,\n          passed_count: rawBatchPassedCount,\n          published_count: 0,\n          top_count: 0,\n          message: 'Day Trade finalization failed while trimming candidates.'\n        });\n        return res.status(500).json({\n          success: false,\n          status: 'failed',\n          error_code: 'daytrade_finalize_trim_failed',\n          error: 'Day Trade candidates were saved but the Top 50 trim failed.',\n          run_id: runId,\n          run_date: runDate,\n          raw_batch_passed_count: rawBatchPassedCount,\n          pre_publish_candidate_count: prePublishCandidateCount,\n          published_count: 0\n        });\n      }",
    'surface top-50 trim failures'
  );

  source = replaceOnce(
    source,
    "  var actionLabelDistribution = buildDtValueDistribution(publishedRows, 'action_label');",
    "  // action_label is a runtime/display label and is not persisted in this table.\n  var actionLabelDistribution = {};",
    'do not derive distribution from non-persisted field'
  );

  write(file, source);
}

function patchRunMode() {
  const file = 'lib/daytrade-screener-engine.js';
  let source = read(file);

  source = replaceOnce(
    source,
    'function getRunMode(overrideMode) {',
    'function getRunMode(overrideMode, nowValue) {',
    'injectable getRunMode clock'
  );

  source = replaceOnce(
    source,
    "  var now = new Date();\n  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);",
    "  var now = nowValue == null ? new Date() : new Date(nowValue);\n  if (Number.isNaN(now.getTime())) return 'OUTSIDE_MARKET';\n  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);",
    'use injected clock safely'
  );

  source = replaceOnce(
    source,
    "  // 13:30–15:00 WIB = 810–900\n  if (totalMin > 810 && totalMin <= 900) return 'AFTERNOON_EXIT';",
    "  // 13:30–16:00 WIB = 810–960. Keep the conservative late-session\n  // classification active for every Fast Watcher/Day Trade run through close.\n  if (totalMin > 810 && totalMin <= 960) return 'AFTERNOON_EXIT';",
    'extend afternoon mode through 16:00 WIB'
  );

  write(file, source);
}

function patchPool() {
  const file = 'lib/intraday-fast-watcher-pool.js';
  let source = read(file);

  source = replaceOnce(
    source,
    "const RULE_VERSION = 'FAST_WATCHER_ADAPTIVE_MOMENTUM_V2';",
    "const RULE_VERSION = 'FAST_WATCHER_ADAPTIVE_MOMENTUM_V3';",
    'bump pool rule version'
  );

  source = replaceOnce(
    source,
    "const REQUIRED_CONFIRMATIONS = 2;\nconst MAX_PUBLISH_COUNT = 3;\nconst MIN_EXTENSION_SCORE = 42;",
    "const REQUIRED_CONFIRMATIONS = 2;\nconst CONFIRMATION_WINDOW_SIZE = 3;\nconst MIN_FRESH_SHORTLIST_SLOTS = 6;\nconst MAX_PUBLISH_COUNT = 3;\nconst MIN_EXTENSION_SCORE = 42;",
    'add confirmation and freshness constants'
  );

  source = replaceOnce(
    source,
    "    source_score: row.score, source_status: row.source_status || null, status: 'WATCHING', ready_streak: 0,",
    "    source_score: row.score, source_status: row.source_status || null, source_origin: row.source_origin || null,\n    status: 'WATCHING', ready_streak: 0, confirmation_window: [],",
    'store source provenance and confirmation window'
  );

  source = replaceOnce(
    source,
    "      source_status: item.source_status || 'CARRIED_WATCH_POOL', watch_score: item.last_watch_score,\n      publish_score: item.last_publish_score, ready_streak: item.ready_streak || 0, carried: true",
    "      source_status: item.source_status || 'CARRIED_WATCH_POOL', source_origin: 'carried_pool',\n      watch_score: item.last_watch_score, publish_score: item.last_publish_score,\n      ready_streak: item.ready_streak || 0, carried: true",
    'mark carried source provenance'
  );

  const mergeReplacement = `function supplementalStatusBonus(status) {
  if (['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT'].includes(status)) return 40;
  if (['PRE_SPIKE_WATCH', 'EARLY_RADAR', 'RECLAIM_CANDIDATE'].includes(status)) return 24;
  if (['MOMENTUM_CONTINUATION', 'WAIT_PULLBACK', 'WATCHING'].includes(status)) return 10;
  return 0;
}
function mergePayload(payload, priorState, scheduledTime, supplemental, maxShortlist) {
  const current = watcher.buildShortlist(payload, watcher.MAX_SHORTLIST_LIMIT);
  const byTicker = new Map();
  (current.ok ? current.rows : []).forEach((row, index) => {
    byTicker.set(row.ticker, Object.assign({}, row, {
      carried: false,
      source_origin: 'current_radar',
      pool_priority: 300 + Math.max(0, 50 - index) + (Number(row.score) || 0) * 0.2
    }));
  });
  for (const item of supplemental || []) {
    const ticker = watcher.normalizeTicker(item && (item.ticker || item.symbol || item.code));
    if (!ticker || byTicker.has(ticker)) continue;
    const status = String(item.status || item.source_status || '').toUpperCase();
    if (status && !SUPPLEMENTAL_STATUSES.has(status)) continue;
    const score = Number.isFinite(Number(item.daytrade_score ?? item.score)) ? Number(item.daytrade_score ?? item.score) : 0;
    byTicker.set(ticker, {
      ticker,
      board: item.board || null,
      source_rank: byTicker.size + 1,
      score,
      source_status: status || null,
      source_origin: 'supplemental',
      carried: false,
      pool_priority: 160 + score + supplementalStatusBonus(status)
    });
  }
  for (const item of activeRows(priorState, scheduledTime)) {
    const priority = 170 + (Number(item.watch_score) || 0) + (Number(item.ready_streak) || 0) * 15;
    const existing = byTicker.get(item.ticker);
    if (existing) {
      existing.pool_priority = Math.max(existing.pool_priority || 0, priority);
      existing.carried_support = true;
    } else {
      byTicker.set(item.ticker, Object.assign({}, item, { pool_priority: priority }));
    }
  }
  const limit = Number.isInteger(maxShortlist) ? maxShortlist : 20;
  const sorted = [...byTicker.values()].sort((a, b) =>
    (b.pool_priority || 0) - (a.pool_priority || 0) ||
    (a.source_rank || 999) - (b.source_rank || 999) ||
    a.ticker.localeCompare(b.ticker)
  );
  const fresh = sorted.filter(row => row.source_origin !== 'carried_pool');
  const requiredFresh = Math.min(MIN_FRESH_SHORTLIST_SLOTS, fresh.length, limit);
  let selected = sorted.slice(0, limit);
  const selectedFreshCount = selected.filter(row => row.source_origin !== 'carried_pool').length;
  if (selectedFreshCount < requiredFresh) {
    const required = fresh.slice(0, requiredFresh);
    const requiredTickers = new Set(required.map(row => row.ticker));
    selected = required.concat(sorted.filter(row => !requiredTickers.has(row.ticker))).slice(0, limit);
    selected.sort((a, b) =>
      (b.pool_priority || 0) - (a.pool_priority || 0) ||
      (a.source_rank || 999) - (b.source_rank || 999) ||
      a.ticker.localeCompare(b.ticker)
    );
  }
  const rows = selected.map((row, index) => Object.assign({}, row, { source_rank: index + 1 }));
  const sourceCounts = rows.reduce((counts, row) => {
    const key = row.source_origin || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  return {
    status: 'published',
    results: rows,
    diagnostics: {
      candidate_count_before_limit: sorted.length,
      required_fresh_slots: requiredFresh,
      selected_source_counts: sourceCounts
    }
  };
}
function observationKey`;

  source = replaceRegexOnce(
    source,
    /function mergePayload\(payload, priorState, scheduledTime, supplemental, maxShortlist\) \{[\s\S]*?\n\}\nfunction observationKey/,
    mergeReplacement,
    'replace merge policy with freshness-aware policy'
  );

  source = replaceOnce(
    source,
    "    item.board = row.board || item.board || null; item.source_score = row.score != null ? row.score : item.source_score; item.source_status = row.source_status || item.source_status || null;",
    "    item.board = row.board || item.board || null; item.source_score = row.score != null ? row.score : item.source_score;\n    item.source_status = row.source_status || item.source_status || null;\n    item.source_origin = row.source_origin || item.source_origin || (row.carried === true ? 'carried_pool' : null);",
    'persist source provenance into state'
  );

  source = replaceOnce(
    source,
    "    if (result.passes) {\n      item.ready_streak = (item.ready_streak || 0) + 1; item.stagnant_count = 0;\n      to = item.ready_streak >= REQUIRED_CONFIRMATIONS ? 'READY_CONFIRMED' : 'READY_PENDING';\n    } else {\n      item.ready_streak = 0;\n      item.stagnant_count = item.last_watch_score != null && result.metrics.watch_score <= item.last_watch_score + 1 ? (item.stagnant_count || 0) + 1 : 0;\n    }",
    "    const terminalFailure = ['INVALIDATED', 'STALE', 'INVALID_DATA', 'BLOCKED_CHASE'].includes(result.status);\n    const confirmationWindow = [...(Array.isArray(item.confirmation_window) ? item.confirmation_window : []), result.passes === true]\n      .slice(-CONFIRMATION_WINDOW_SIZE);\n    item.confirmation_window = terminalFailure ? [] : confirmationWindow;\n    const confirmationCount = item.confirmation_window.filter(Boolean).length;\n    item.ready_streak = confirmationCount;\n    if (result.passes) {\n      item.stagnant_count = 0;\n      to = confirmationCount >= REQUIRED_CONFIRMATIONS ? 'READY_CONFIRMED' : 'READY_PENDING';\n      if (to === 'READY_CONFIRMED' && item.confirmation_window.includes(false)) {\n        result.reasons = [...new Set([...(result.reasons || []), 'two_of_three_confirmation'])].sort();\n      }\n    } else {\n      item.stagnant_count = item.last_watch_score != null && result.metrics.watch_score <= item.last_watch_score + 1 ? (item.stagnant_count || 0) + 1 : 0;\n      if (terminalFailure) {\n        item.ready_streak = 0;\n        to = result.status;\n      } else if (confirmationCount > 0) {\n        to = 'READY_PENDING';\n        result.reasons = [...new Set([...(result.reasons || []), 'confirmation_grace'])].sort();\n      }\n    }",
    'replace strict consecutive confirmation with safe two-of-three confirmation'
  );

  source = replaceOnce(
    source,
    "      const from = item.status || 'WATCHING'; item.active = false; item.status = 'DROPPED_FROM_WATCH_POOL'; item.ready_streak = 0;",
    "      const from = item.status || 'WATCHING'; item.active = false; item.status = 'DROPPED_FROM_WATCH_POOL';\n      item.ready_streak = 0; item.confirmation_window = [];",
    'clear confirmation memory when dropped'
  );

  source = replaceOnce(
    source,
    "  const confirmed = Object.entries(state.tickers).filter(([, item]) => item.active && item.status === 'READY_CONFIRMED').map(([ticker, item]) => ({ ticker, time: item.last_time, ready_streak: item.ready_streak, watch_score: item.last_watch_score, publish_score: item.last_publish_score, setup_id: setupId(date, ticker, item.last_metrics || {}), observation: Object.assign({}, item.last_observation || {}, { metrics: item.last_metrics || {} }), shortlist_rank: item.shortlist_rank }));",
    "  const confirmed = Object.entries(state.tickers).filter(([, item]) => item.active && item.status === 'READY_CONFIRMED').map(([ticker, item]) => ({ ticker, time: item.last_time, ready_streak: item.ready_streak, confirmation_window: item.confirmation_window || [], source_origin: item.source_origin || null, watch_score: item.last_watch_score, publish_score: item.last_publish_score, setup_id: setupId(date, ticker, item.last_metrics || {}), observation: Object.assign({}, item.last_observation || {}, { metrics: item.last_metrics || {} }), shortlist_rank: item.shortlist_rank }));",
    'include confirmation and source telemetry in confirmed rows'
  );

  source = replaceOnce(
    source,
    "module.exports = { RULE_VERSION, INITIAL_WATCH_MINUTES, WATCH_EXTENSION_MINUTES, MAX_WATCH_MINUTES, REQUIRED_CONFIRMATIONS, MAX_PUBLISH_COUNT, SUPPLEMENTAL_STATUSES, resetTrackerForReentry, activeRows, mergePayload, process, rankPublishable, setupId };",
    "module.exports = { RULE_VERSION, INITIAL_WATCH_MINUTES, WATCH_EXTENSION_MINUTES, MAX_WATCH_MINUTES, REQUIRED_CONFIRMATIONS, CONFIRMATION_WINDOW_SIZE, MIN_FRESH_SHORTLIST_SLOTS, MAX_PUBLISH_COUNT, SUPPLEMENTAL_STATUSES, resetTrackerForReentry, activeRows, mergePayload, process, rankPublishable, setupId };",
    'export new policy constants'
  );

  write(file, source);
}

function patchTelemetry() {
  const liveFile = 'lib/intraday-fast-watcher-live.js';
  let live = read(liveFile);

  live = replaceOnce(
    live,
    "const rankByTicker = new Map(shortlist.rows.map((row, index) => [row.ticker, index + 1]));\nresults.sort((a, b) => (rankByTicker.get(a.ticker) || 999) - (rankByTicker.get(b.ticker) || 999));",
    "const rankByTicker = new Map(shortlist.rows.map((row, index) => [row.ticker, index + 1]));\nconst shortlistMetaByTicker = new Map(shortlist.rows.map(row => [row.ticker, row]));\nresults.sort((a, b) => (rankByTicker.get(a.ticker) || 999) - (rankByTicker.get(b.ticker) || 999));",
    'index shortlist provenance by ticker'
  );

  live = replaceOnce(
    live,
    "return collector.deriveDistances(record);",
    "const source = shortlistMetaByTicker.get(result.ticker) || {};\nrecord.source_rank = source.source_rank != null ? source.source_rank : null;\nrecord.source_score = source.score != null ? source.score : null;\nrecord.source_status = source.source_status || null;\nrecord.source_origin = source.source_origin || null;\nrecord.pool_priority = source.pool_priority != null ? source.pool_priority : null;\nrecord.carried = source.carried === true;\nreturn collector.deriveDistances(record);",
    'persist shortlist provenance in candidate observations'
  );

  live = replaceOnce(
    live,
    "shortlist_count: shortlist.rows.length,\ncompleted_count: observations.length,",
    "shortlist_count: shortlist.rows.length,\nshortlist_source_distribution: shortlist.rows.reduce((counts, row) => {\n  const key = row.source_origin || 'unknown';\n  counts[key] = (counts[key] || 0) + 1;\n  return counts;\n}, {}),\ncompleted_count: observations.length,",
    'persist source distribution in run telemetry'
  );

  write(liveFile, live);

  const guardedFile = 'lib/intraday-fast-watcher-guarded-live.js';
  let guarded = read(guardedFile);
  guarded = replaceOnce(
    guarded,
    "      supplemental_count: Array.isArray(supplemental) ? supplemental.length : 0,",
    "      supplemental_count: Array.isArray(supplemental) ? supplemental.length : 0,\n      merge_diagnostics: mergedPayload.diagnostics || null,",
    'return merge diagnostics'
  );
  write(guardedFile, guarded);
}

function writeTests() {
  write('test/daytrade-finalizer-schema-contract.test.js', `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../api/sector-hot'), 'utf8');
const start = source.indexOf('async function finalizeDtScreener');
const end = source.indexOf('function getDtRunningStartedAt', start);
const finalizer = source.slice(start, end);

test('Day Trade finalizer reads only persisted columns and surfaces database errors', () => {
  assert.match(finalizer, /select\\('ticker, daytrade_score, status'\\)/);
  assert.doesNotMatch(finalizer, /select\\([^\\n]*action_label/);
  assert.match(finalizer, /if \\(readErr\\)/);
  assert.match(finalizer, /daytrade_finalize_read_failed/);
  assert.match(finalizer, /daytrade_finalize_trim_failed/);
  assert.match(finalizer, /var actionLabelDistribution = \\{\\};/);
});
`);

  write('test/daytrade-run-mode-window.test.js', `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/daytrade-screener-engine');

test('Day Trade keeps conservative afternoon mode through 16:00 WIB', () => {
  assert.equal(engine.getRunMode(null, '2026-07-31T08:05:00.000Z'), 'AFTERNOON_EXIT');
  assert.equal(engine.getRunMode(null, '2026-07-31T09:00:00.000Z'), 'AFTERNOON_EXIT');
  assert.equal(engine.getRunMode(null, '2026-07-31T09:01:00.000Z'), 'OUTSIDE_MARKET');
  assert.equal(engine.getRunMode(null, 'not-a-date'), 'OUTSIDE_MARKET');
});
`);

  write('test/intraday-fast-watcher-recall.test.js', `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../lib/intraday-fast-watcher-pool');

function readyObservation(time, status, price, volume, relativeVolume) {
  return {
    ticker: 'TEST', scheduled_time: time, current_status: status,
    current_price: price, entry_low: 100, entry_high: 103, tp1: 112, stop_loss: 97,
    open: 100, high: 104, low: 99, volume, average_volume: 1000,
    relative_volume: relativeVolume, score: 82, momentum_component: 20,
    liquidity_component: 20, risk_reward: 2
  };
}

function run(priorState, time, observation) {
  return pool.process({
    sampleDate: '2026-07-31', scheduledTime: time,
    shortlistRows: [{ ticker: 'TEST', source_rank: 1, score: 82, source_status: 'READY_BREAKOUT', source_origin: 'current_radar' }],
    observations: [observation], priorState,
    now: `2026-07-31T${String(Number(time.slice(0, 2)) - 7).padStart(2, '0')}:${time.slice(3)}:00.000Z`
  });
}

test('two passes in three observations confirm while one noisy miss gets grace', () => {
  const first = run(null, '09:10', readyObservation('09:10', 'READY_BREAKOUT', 101, 1400, 1.4));
  assert.equal(first.state.tickers.TEST.status, 'READY_PENDING');
  assert.deepEqual(first.state.tickers.TEST.confirmation_window, [true]);

  const noisy = run(first.state, '09:13', readyObservation('09:13', 'WAIT_PULLBACK', 101, 1400, 0.8));
  assert.equal(noisy.state.tickers.TEST.status, 'READY_PENDING');
  assert.deepEqual(noisy.state.tickers.TEST.confirmation_window, [true, false]);
  assert.ok(noisy.state.tickers.TEST.last_reasons.includes('confirmation_grace'));

  const third = run(noisy.state, '09:16', readyObservation('09:16', 'READY_BREAKOUT', 102, 1900, 1.6));
  assert.equal(third.state.tickers.TEST.status, 'READY_CONFIRMED');
  assert.deepEqual(third.state.tickers.TEST.confirmation_window, [true, false, true]);
  assert.ok(third.state.tickers.TEST.last_reasons.includes('two_of_three_confirmation'));
});

test('hard reject remains immediate and clears confirmation memory', () => {
  const first = run(null, '09:10', readyObservation('09:10', 'READY_BREAKOUT', 101, 1400, 1.4));
  const rejected = run(first.state, '09:13', readyObservation('09:13', 'AVOID', 101, 1500, 1.5));
  assert.equal(rejected.state.tickers.TEST.status, 'DROPPED_FROM_WATCH_POOL');
  assert.deepEqual(rejected.state.tickers.TEST.confirmation_window, []);
});

test('merge reserves fresh slots so weak carried rows cannot starve new candidates', () => {
  const priorState = { date: '2026-07-31', tickers: {} };
  for (let index = 0; index < 20; index += 1) {
    priorState.tickers[`OLD${index}`] = {
      active: true, status: 'WATCHING', shortlist_rank: index + 1,
      source_score: 55, source_status: 'WAIT_PULLBACK', last_watch_score: 20,
      ready_streak: 0, max_expires_at_minute: 700
    };
  }
  const supplemental = Array.from({ length: 10 }, (_, index) => ({
    ticker: `NEW${index}`, status: 'EARLY_RADAR', daytrade_score: 80 - index
  }));
  const merged = pool.mergePayload({ results: [] }, priorState, '09:20', supplemental, 20);
  const freshRows = merged.results.filter(row => row.source_origin === 'supplemental');
  assert.ok(freshRows.length >= pool.MIN_FRESH_SHORTLIST_SLOTS);
  assert.equal(merged.diagnostics.required_fresh_slots, pool.MIN_FRESH_SHORTLIST_SLOTS);
});
`);
}

patchFinalizer();
patchRunMode();
patchPool();
patchTelemetry();
writeTests();

console.log('DAYTRADE_RECALL_PATCH_APPLIED');

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const watcher = require('../lib/intraday-fast-watcher');
const live = require('../lib/intraday-fast-watcher-live');

function fakeCollector() {
return {
checkProductionWorkerActive: async () => ({ active: false }),
fetchWithFreshnessFallback: async () => ({
candles: Array.from({ length: 20 }, () => ({ open: 1, high: 2, low: 1, close: 2, volume: 1 })),
freshness: { is_stale: false }
}),
buildCandidateRecord: (result, time, rank, freshness) => ({
ticker: result.ticker,
scheduled_time: time,
rank,
current_price: result.last_price,
entry_low: result.entry_low,
entry_high: result.entry_high,
tp1: result.tp1,
tp2: result.tp2,
sl: result.stop_loss,
current_status: result.status,
freshness
}),
deriveDistances: row => row,
sanitizeRecord: row => row
};
}

function fakeEngine() {
return {
runDayTradeBatch: async (batch, mode, options) => {
const results = [];
for (const item of batch) {
await options.fetchCandles(item.ticker);
results.push({
ticker: item.ticker,
board: item.board,
last_price: 100,
entry_low: 98,
entry_high: 103,
tp1: 112,
tp2: 120,
stop_loss: 95,
status: 'READY_BREAKOUT',
daytrade_score: 80,
volume_today: 1000,
avg_volume_20d: 500,
volume_ratio_20d: 2
});
}
return { results, failed: [] };
}
};
}

test('published radar_candidates string array becomes the bounded production shortlist', () => {
const normalized = live.normalizeProductionShortlistPayload({
status: 'published',
radar_count: 3,
radar_candidates: ['MMIX', 'MSTI', 'AMRT']
});
assert.equal(normalized.status, 'ready');
assert.equal(normalized.source_status, 'published');
const shortlist = watcher.buildShortlist(normalized.payload, 20);
assert.equal(shortlist.ok, true);
assert.deepEqual(shortlist.rows.map(row => row.ticker), ['MMIX', 'MSTI', 'AMRT']);
});

test('running full-screener payload is skipped and excluded diagnostics are never used', async () => {
let engineCalled = false;
const result = await live.collectLiveSnapshot({
sampleDate: '2026-07-28',
scheduledTime: '14:41',
shortlistFile: 'ignored',
readPayload: async () => ({
status: 'running',
passed_count: 45,
universe_diagnostics: {
sample_excluded: [{ ticker: 'WIKA' }, { ticker: 'WSKT' }]
},
failed_tickers: [{ ticker: 'PRDL' }]
}),
checkProductionWorkerActive: async () => ({ active: false }),
engine: {
runDayTradeBatch: async () => {
engineCalled = true;
return { results: [], failed: [] };
}
},
collector: fakeCollector(),
dryRun: true
});
assert.equal(result.status, 'skipped_screener_running');
assert.equal(result.error_code, 'source_screener_running');
assert.equal(result.shortlist_count, 0);
assert.equal(engineCalled, false);
assert.equal(result.telegram_attempted, false);
assert.equal(result.source_screener_mutated, false);
assert.equal(result.production_state_mutated, false);
});

test('live dry-run exposes scheduled time and explicit non-mutation flags', async () => {
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-watcher-production-payload-'));
const result = await live.runLiveFastWatcher({
sampleDate: '2026-07-28',
scheduledTime: '14:41',
shortlistFile: 'ignored',
maxShortlist: 20,
concurrency: 4,
dryRun: true,
stateDir: path.join(root, 'state'),
eventDir: path.join(root, 'events'),
observationRoot: path.join(root, 'observations'),
readPayload: async () => ({
status: 'published',
radar_candidates: ['MMIX', 'MSTI', 'AMRT']
}),
checkProductionWorkerActive: async () => ({ active: false }),
engine: fakeEngine(),
collector: fakeCollector()
});
assert.equal(result.status, 'live_shadow_dry_run');
assert.equal(result.scheduled_time, '14:41');
assert.equal(result.through_time, '14:41');
assert.equal(result.shortlist_count, 3);
assert.equal(result.collection.completed_count, 3);
assert.equal(result.collection.source_status, 'published');
assert.equal(result.telegram_attempted, false);
assert.equal(result.telegram_sent, false);
assert.equal(result.source_screener_mutated, false);
assert.equal(result.production_state_mutated, false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const watcher = require('../lib/intraday-fast-watcher');
const cli = require('../tools/run-intraday-fast-watcher');
function obs(ticker, time, overrides) {
return {
ticker,
scheduled_time: time,
current_price: 100,
entry_low: 98,
entry_high: 103,
tp1: 112,
stop_loss: 95,
production_eligible: true,
freshness: { is_stale: false },
...overrides
};
}
test('shortlist preserves full-screener ranking, deduplicates, and caps without fallback', () => {
const payload = { results: [
{ ticker: 'BBRI', score: 90 }, { ticker: 'BBRI.JK', score: 88 },
{ symbol: 'TLKM', score: 80 }, { code: 'ASII', score: 70 }
] };
const result = watcher.buildShortlist(payload, 2);
assert.equal(result.ok, true);
assert.deepEqual(result.rows.map(row => row.ticker), ['BBRI', 'TLKM']);
assert.equal(result.truncated, true);
assert.equal(watcher.buildShortlist({ results: [] }, 20).rows.length, 0);
});
test('score alone never creates READY; an engine-owned readiness flag is mandatory', () => {
const tracker = { first_price: 100 };
const result = watcher.evaluateObservation(obs('BBRI', '09:05', {
production_eligible: undefined,
score: 99,
status: undefined
}), tracker);
assert.equal(result.passes, false);
assert.equal(result.status, 'UNKNOWN');
assert.deepEqual(result.reasons, ['missing_engine_ready_flag']);
});
test('two distinct consecutive READY observations confirm a ticker', () => {
const result = watcher.processObservations({
sampleDate: '2026-07-28',
shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
observations: [obs('BBRI', '09:05'), obs('BBRI', '09:08', { current_price: 101 })],
now: '2026-07-28T02:08:00Z'
});
assert.deepEqual(result.events.map(event => event.to_status), ['READY_PENDING', 'READY_CONFIRMED']);
assert.equal(result.confirmed[0].ticker, 'BBRI');
assert.equal(result.state.tickers.BBRI.ready_streak, 2);
});
test('rerunning the same observations is idempotent and records no duplicate events', () => {
const first = watcher.processObservations({
sampleDate: '2026-07-28',
shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
observations: [obs('BBRI', '09:05'), obs('BBRI', '09:08')]
});
const second = watcher.processObservations({
sampleDate: '2026-07-28',
shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
observations: [obs('BBRI', '09:05'), obs('BBRI', '09:08')],
priorState: first.state
});
assert.equal(second.events.length, 0);
assert.equal(second.state.tickers.BBRI.ready_streak, 2);
});
test('anti-chase blocks price above entry zone, TP1 reached, and advance above six percent', () => {
const aboveZone = watcher.processObservations({
sampleDate: '2026-07-28', shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
observations: [obs('BBRI', '09:05', { current_price: 104 })]
});
assert.equal(aboveZone.state.tickers.BBRI.status, 'BLOCKED_CHASE');
assert.ok(aboveZone.state.tickers.BBRI.last_reasons.includes('above_entry_zone'));
const tpReached = watcher.processObservations({
sampleDate: '2026-07-28', shortlistRows: [{ ticker: 'TLKM', source_rank: 1 }],
observations: [obs('TLKM', '09:05', { current_price: 112, entry_high: 115, tp1: 112 })]
});
assert.equal(tpReached.state.tickers.TLKM.status, 'BLOCKED_CHASE');
assert.ok(tpReached.state.tickers.TLKM.last_reasons.includes('tp1_already_reached'));
const advance = watcher.processObservations({
sampleDate: '2026-07-28', shortlistRows: [{ ticker: 'ASII', source_rank: 1 }],
observations: [
obs('ASII', '09:05', { current_price: 100, entry_high: 120, tp1: 130, production_eligible: false }),
obs('ASII', '09:08', { current_price: 107, entry_high: 120, tp1: 130 })
]
});
assert.equal(advance.state.tickers.ASII.status, 'BLOCKED_CHASE');
assert.ok(advance.state.tickers.ASII.last_reasons.includes('advance_above_6_pct'));
});
test('stale data and a touched stop fail closed', () => {
const stale = watcher.processObservations({
sampleDate: '2026-07-28', shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
observations: [obs('BBRI', '09:05', { freshness: { is_stale: true } })]
});
assert.equal(stale.state.tickers.BBRI.status, 'STALE');
const stopped = watcher.processObservations({
sampleDate: '2026-07-28', shortlistRows: [{ ticker: 'TLKM', source_rank: 1 }],
observations: [obs('TLKM', '09:05', { current_price: 94, entry_low: 90, stop_loss: 95 })]
});
assert.equal(stopped.state.tickers.TLKM.status, 'INVALIDATED');
});
test('a ticker removed by the next full screener emits one drop transition', () => {
const first = watcher.processObservations({
sampleDate: '2026-07-28', shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
observations: [obs('BBRI', '09:05')]
});
const dropped = watcher.processObservations({
sampleDate: '2026-07-28', shortlistRows: [{ ticker: 'TLKM', source_rank: 1 }],
observations: [], priorState: first.state, throughTime: '09:11'
});
const event = dropped.events.find(row => row.ticker === 'BBRI');
assert.equal(event.to_status, 'DROPPED_FROM_SHORTLIST');
assert.deepEqual(event.reasons, ['not_in_latest_shortlist']);
});
test('shadow run writes state/events, remains idempotent, and never calls Telegram', async () => {
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-watcher-'));
const shortlistFile = path.join(root, 'shortlist.json');
const observationsFile = path.join(root, 'observations.jsonl');
const stateDir = path.join(root, 'state');
const eventDir = path.join(root, 'events');
await fsp.writeFile(shortlistFile, JSON.stringify({ results: [{ ticker: 'BBRI' }] }));
await fsp.writeFile(observationsFile, [obs('BBRI', '09:05'), obs('BBRI', '09:08')].map(JSON.stringify).join('\n') + '\n');
const first = await watcher.runFastWatcher({
sampleDate: '2026-07-28', shortlistFile, observationsFile, stateDir, eventDir, now: '2026-07-28T02:08:00Z'
});
assert.equal(first.status, 'shadow_recorded');
assert.equal(first.telegram_attempted, false);
assert.equal(first.telegram_sent, false);
assert.equal(first.event_count, 2);
const eventText = await fsp.readFile(path.join(eventDir, '2026-07-28.jsonl'), 'utf8');
assert.equal(eventText.trim().split('\n').length, 2);
const second = await watcher.runFastWatcher({ sampleDate: '2026-07-28', shortlistFile, observationsFile, stateDir, eventDir });
assert.equal(second.event_count, 0);
const sameEventText = await fsp.readFile(path.join(eventDir, '2026-07-28.jsonl'), 'utf8');
assert.equal(sameEventText, eventText);
});
test('dry-run writes nothing', async () => {
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-watcher-dry-'));
const shortlistFile = path.join(root, 'shortlist.json');
const observationsFile = path.join(root, 'observations.json');
await fsp.writeFile(shortlistFile, JSON.stringify([{ ticker: 'BBRI' }]));
await fsp.writeFile(observationsFile, JSON.stringify([obs('BBRI', '09:05')]));
const result = await watcher.runFastWatcher({
sampleDate: '2026-07-28', shortlistFile, observationsFile,
stateDir: path.join(root, 'state'), eventDir: path.join(root, 'events'), dryRun: true
});
assert.equal(result.status, 'shadow_dry_run');
await assert.rejects(fsp.stat(path.join(root, 'state', '2026-07-28.json')), { code: 'ENOENT' });
});
test('CLI rejects send mode and validates shortlist bound', () => {
const send = cli.parseArgs(['node', 'tool', '--sample-date', '2026-07-28', '--shortlist-file', 'a', '--observations-file', 'b', '--send']);
assert.equal(send.invalid, '--send');
const invalidMax = cli.parseArgs(['node', 'tool', '--max-shortlist', '51']);
assert.equal(invalidMax.maxShortlist, 51);
assert.match(cli.USAGE, /no --send mode exists/);
});
test('source contains no Telegram import, send adapter, screener run, or scoring threshold', async () => {
const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'intraday-fast-watcher.js'), 'utf8');
assert.doesNotMatch(source, /telegram-notifier|sendTelegram|TELEGRAM_/);
assert.doesNotMatch(source, /daytrade-screener-run|refresh-screener|nk-screener-run/);
assert.doesNotMatch(source, /score\s*[<>]=?\s*\d+/);
});
const live = require('../lib/intraday-fast-watcher-live');
test('actual Day Trade engine statuses are consumed without recreating score thresholds', () => {
const tracker = { first_price: 100 };
for (const current_status of ['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT']) {
const result = watcher.evaluateObservation(obs('BBRI', '09:05', {
production_eligible: undefined,
current_status,
status: undefined
}), tracker);
assert.equal(result.passes, true, current_status);
assert.equal(result.ready_source, 'current_status');
}
for (const current_status of ['EARLY_RADAR', 'PRE_SPIKE_WATCH', 'WAIT_PULLBACK', 'SPECULATIVE', 'AVOID']) {
const result = watcher.evaluateObservation(obs('BBRI', '09:05', {
production_eligible: undefined,
current_status,
status: undefined
}), tracker);
assert.equal(result.passes, false, current_status);
assert.equal(result.status, 'WATCHING');
}
});
test('live collector runs existing engine only for bounded shortlist with concurrency four', async () => {
const calledBatches = [];
const fakeEngine = {
runDayTradeBatch: async (batch, mode, options) => {
calledBatches.push({ batch, mode, env: options.env });
const results = [];
for (const item of batch) {
const candles = await options.fetchCandles(item.ticker);
assert.equal(candles.length, 20);
results.push({
ticker: item.ticker, board: item.board, last_price: 100,
entry_low: 98, entry_high: 103, tp1: 112, tp2: 120,
stop_loss: 95, status: 'READY_BREAKOUT', daytrade_score: 80,
volume_today: 1000, avg_volume_20d: 500, volume_ratio_20d: 2
});
}
return { results, failed: [] };
}
};
const fakeCollector = {
checkProductionWorkerActive: async () => ({ active: false }),
fetchWithFreshnessFallback: async () => ({ candles: Array.from({ length: 20 }, () => ({ open: 1, high: 2, low: 1, close: 2, volume: 1 })), freshness: { is_stale: false } }),
buildCandidateRecord: (result, time, rank, freshness) => ({
ticker: result.ticker, scheduled_time: time, rank,
current_price: result.last_price, entry_low: result.entry_low, entry_high: result.entry_high,
tp1: result.tp1, tp2: result.tp2, sl: result.stop_loss,
current_status: result.status, freshness
}),
deriveDistances: row => row,
sanitizeRecord: row => row
};
const payload = { results: ['BBRI', 'TLKM', 'ASII', 'BBCA', 'BMRI'].map((ticker, index) => ({ ticker, board: 'UTAMA', score: 100 - index })) };
const result = await live.collectLiveSnapshot({
sampleDate: '2026-07-28', scheduledTime: '09:09', shortlistFile: 'ignored',
maxShortlist: 5, concurrency: 4, dryRun: true,
readPayload: async () => payload, engine: fakeEngine, collector: fakeCollector,
checkProductionWorkerActive: async () => ({ active: false })
});
assert.equal(result.status, 'live_shadow_dry_run');
assert.equal(result.completed_count, 5);
assert.equal(calledBatches.length, 4);
assert.ok(calledBatches.every(call => call.mode === 'MORNING_SCOUT'));
assert.ok(calledBatches.every(call => call.env.DAYTRADE_INTRADAY_SCORE_ENABLED === '0'));
assert.deepEqual(result.observations.map(row => row.ticker), ['BBRI', 'TLKM', 'ASII', 'BBCA', 'BMRI']);
});
test('live collector skips cleanly while production worker lock is active', async () => {
const result = await live.collectLiveSnapshot({
sampleDate: '2026-07-28', scheduledTime: '09:09', shortlistFile: 'ignored',
checkProductionWorkerActive: async () => ({ active: true, pid: 123 })
});
assert.equal(result.status, 'skipped_due_to_production_lock');
assert.equal(result.observations.length, 0);
});
test('live mode only supports engine market windows and at most four workers', () => {
assert.equal(live.runModeForTime('09:00'), 'MORNING_SCOUT');
assert.equal(live.runModeForTime('11:00'), 'MIDDAY_CHECK');
assert.equal(live.runModeForTime('13:33'), 'AFTERNOON_EXIT');
assert.equal(live.runModeForTime('15:03'), null);
assert.deepEqual(live.chunkRoundRobin([1,2,3,4,5], 4), [[1,5],[2],[3],[4]]);
});
test('live source cannot publish, send Telegram, build a universe, or enable intraday score adjustment', async () => {
const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'intraday-fast-watcher-live.js'), 'utf8');
assert.doesNotMatch(source, /sendTelegram|telegram-notifier|TELEGRAM_/);
assert.doesNotMatch(source, /buildDayTradeUniverse|buildFastDayTradeUniverse/);
assert.doesNotMatch(source, /Supabase|createClient|publishResults|register.*candidate/i);
assert.match(source, /DAYTRADE_INTRADAY_SCORE_ENABLED: '0'/);
});

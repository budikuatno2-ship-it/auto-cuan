'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const watcher = require('./intraday-fast-watcher');
const volumePace = require('./intraday-volume-pace');
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_DIR = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache');
const DEFAULT_OBSERVATION_ROOT = path.join(process.cwd(), 'data', 'intraday-fast-watcher-observations');
const DEFAULT_PRODUCTION_LOCK_FILE = path.join(process.cwd(), 'tmp', 'daytrade-vps-worker-observe.lock');
const IN_PROGRESS_SOURCE_STATUSES = new Set([
'running', 'processing', 'queued', 'started', 'in_progress'
]);
// sampleDate is OPTIONAL and backward-compatible: called with just `time`,
// this keeps its original flat Mon-Thu-shaped time bands (existing callers/
// tests rely on that). When `sampleDate` IS supplied (the live production
// call below), it additionally consults intraday-volume-pace.js's
// tradingSchedule/sessionProgress — the same day-of-week-aware IDX session
// calendar already used elsewhere in this codebase for lunch break (Mon-Thu
// 12:00-13:30) and Friday's shifted hours (open 09:00-11:30, break
// 11:30-14:00, close 14:00-16:00) — to reject a scheduled tick that falls
// inside a break/non-trading window, which the flat time bands alone cannot
// distinguish (e.g. 13:31 Friday used to classify as valid 'AFTERNOON_EXIT'
// even though the market doesn't reopen until 14:00 that day). Confirmed
// bug: without this check, a break-time tick would process a frozen/stale
// quote as if it were a fresh confirmation observation.
function runModeForTime(time, sampleDate) {
if (!watcher.validTime(time)) return null;
const [hour, minute] = time.split(':').map(Number);
const total = hour * 60 + minute;
let mode = null;
if (total >= 9 * 60 && total <= 10 * 60 + 30) mode = 'MORNING_SCOUT';
else if (total > 10 * 60 + 30 && total <= 13 * 60 + 30) mode = 'MIDDAY_CHECK';
else if (total > 13 * 60 + 30 && total <= 16 * 60) mode = 'AFTERNOON_EXIT';
if (!mode) return null;
if (sampleDate != null) {
const progress = volumePace.sessionProgress(sampleDate, time);
if (progress.market_state !== 'ACTIVE_SESSION') return null;
}
return mode;
}
function chunkRoundRobin(rows, count) {
const chunks = Array.from({ length: count }, () => []);
rows.forEach((row, index) => chunks[index % count].push(row));
return chunks.filter(chunk => chunk.length);
}
function appendJsonlMany(file, rows) {
if (!rows.length) return Promise.resolve();
return fsp.mkdir(path.dirname(file), { recursive: true })
.then(() => fsp.appendFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 }));
}
function normalizeProductionShortlistPayload(payload) {
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
return { status: 'ready', source_status: null, payload };
}
const sourceStatus = String(payload.status || '').trim().toLowerCase();
if (IN_PROGRESS_SOURCE_STATUSES.has(sourceStatus)) {
return { status: 'screener_running', source_status: sourceStatus, payload: null };
}
if (!Array.isArray(payload.radar_candidates)) {
return { status: 'ready', source_status: sourceStatus || null, payload };
}
const rows = payload.radar_candidates.map((item, index) => {
if (typeof item === 'string') {
return { ticker: item, source_rank: index + 1, source_status: 'RADAR' };
}
if (item && typeof item === 'object' && !Array.isArray(item)) return item;
return null;
}).filter(Boolean);
return {
status: 'ready',
source_status: sourceStatus || null,
payload: Object.assign({}, payload, { results: rows })
};
}
async function collectLiveSnapshot(options) {
const opts = options || {};
let engine = opts.engine || null;
let collector = opts.collector || null;
const scheduledTime = opts.scheduledTime;
const runMode = runModeForTime(scheduledTime, opts.sampleDate);
const concurrency = opts.concurrency == null ? DEFAULT_CONCURRENCY : Number(opts.concurrency);
if (!watcher.validDate(opts.sampleDate) || !runMode) {
return { status: 'invalid_input', error_code: !runMode ? 'outside_supported_market_window' : 'invalid_date', observations: [] };
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
return { status: 'invalid_input', error_code: 'invalid_concurrency', observations: [] };
}
const productionCheck = opts.checkProductionWorkerActive || (collector || require('../tools/intraday-sample-collector')).checkProductionWorkerActive;
const production = await productionCheck(opts.productionLockFile || DEFAULT_PRODUCTION_LOCK_FILE);
if (production && production.active) {
return { status: 'skipped_due_to_production_lock', production, observations: [] };
}
if (!engine) engine = require('./daytrade-screener-engine');
if (!collector) collector = require('../tools/intraday-sample-collector');
let payload;
try { payload = await (opts.readPayload || watcher.parseFile)(opts.shortlistFile); }
catch (error) {
return { status: error.code === 'ENOENT' ? 'shortlist_missing' : 'shortlist_invalid', error_code: error.code || 'shortlist_invalid', observations: [] };
}
const normalized = normalizeProductionShortlistPayload(payload);
if (normalized.status === 'screener_running') {
return {
status: 'skipped_screener_running',
error_code: 'source_screener_running',
source_status: normalized.source_status,
observations: [],
shortlist_count: 0,
telegram_attempted: false,
telegram_sent: false,
source_screener_mutated: false,
production_state_mutated: false
};
}
payload = normalized.payload;
const shortlist = watcher.buildShortlist(payload, opts.maxShortlist);
if (!shortlist.ok) return { status: 'invalid_input', error_code: 'invalid_max_shortlist', observations: [] };
if (!shortlist.rows.length) return { status: 'empty_shortlist', observations: [], shortlist_count: 0 };
const freshnessByTicker = {};
const candlesByTicker = {};
const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
const fetchCandles = opts.fetchCandles || (async function fetchForTicker(ticker) {
const result = await collector.fetchWithFreshnessFallback(ticker, cacheDir, { timeoutMs });
freshnessByTicker[ticker] = result.freshness || null;
candlesByTicker[ticker] = Array.isArray(result.candles) ? result.candles : null;
return result.candles;
});
const wrappedFetchCandles = async function wrappedFetch(ticker) {
  const candles = await fetchCandles(ticker);
  if (!Object.prototype.hasOwnProperty.call(candlesByTicker, ticker)) candlesByTicker[ticker] = Array.isArray(candles) ? candles : null;
  return candles;
};
const safeEnv = Object.assign({}, opts.env || process.env, { DAYTRADE_INTRADAY_SCORE_ENABLED: '0' });
const batches = chunkRoundRobin(shortlist.rows.map(row => ({
ticker: row.ticker,
board: row.board,
source_rank: row.source_rank,
universe_source: 'fast_watcher_latest_full_screener'
})), concurrency);
const batchResults = await Promise.all(batches.map(batch => engine.runDayTradeBatch(batch, runMode, {
fastMode: true,
noDelay: false,
fetchCandles: wrappedFetchCandles,
env: safeEnv
})));
const results = [];
const failures = [];
batchResults.forEach(batch => {
(batch.results || []).forEach(row => results.push(row));
(batch.failed || []).forEach(row => failures.push(row));
});
const rankByTicker = new Map(shortlist.rows.map((row, index) => [row.ticker, index + 1]));
const shortlistMetaByTicker = new Map(shortlist.rows.map(row => [row.ticker, row]));
results.sort((a, b) => (rankByTicker.get(a.ticker) || 999) - (rankByTicker.get(b.ticker) || 999));
const observations = results.map(result => {
const record = collector.buildCandidateRecord(
result,
scheduledTime,
rankByTicker.get(result.ticker) || null,
freshnessByTicker[result.ticker] || null,
opts.sampleDate,
safeEnv
);
const pacedRecord = volumePace.enrichObservation(record, {
  sampleDate: opts.sampleDate,
  scheduledTime,
  candles: candlesByTicker[result.ticker] || null
});
const source = shortlistMetaByTicker.get(result.ticker) || {};
pacedRecord.source_rank = source.source_rank != null ? source.source_rank : null;
pacedRecord.source_score = source.score != null ? source.score : null;
pacedRecord.source_status = source.source_status || null;
pacedRecord.source_origin = source.source_origin || null;
pacedRecord.pool_priority = source.pool_priority != null ? source.pool_priority : null;
pacedRecord.carried = source.carried === true;
return collector.deriveDistances(pacedRecord);
});
const root = opts.observationRoot || DEFAULT_OBSERVATION_ROOT;
const dayDir = path.join(root, opts.sampleDate);
const candidatesFile = path.join(dayDir, 'candidates.jsonl');
const runsFile = path.join(dayDir, 'runs.jsonl');
const runRecord = {
schema_version: 1,
rule_version: watcher.RULE_VERSION,
volume_pace_version: volumePace.VERSION,
sample_date: opts.sampleDate,
scheduled_time: scheduledTime,
run_mode: runMode,
shortlist_count: shortlist.rows.length,
shortlist_source_distribution: shortlist.rows.reduce((counts, row) => {
  const key = row.source_origin || 'unknown';
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}, {}),
completed_count: observations.length,
failed_count: failures.length,
failures: failures.slice(0, 20),
production_overlap: production || null,
telegram_attempted: false,
telegram_sent: false,
source_screener_mutated: false,
production_state_mutated: false,
created_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString()
};
if (!opts.dryRun) {
await (opts.appendRows || appendJsonlMany)(candidatesFile, observations.map(row => collector.sanitizeRecord(row)));
await (opts.appendRows || appendJsonlMany)(runsFile, [collector.sanitizeRecord(runRecord)]);
}
return {
status: opts.dryRun ? 'live_shadow_dry_run' : 'live_shadow_collected',
sample_date: opts.sampleDate,
scheduled_time: scheduledTime,
run_mode: runMode,
shortlist_count: shortlist.rows.length,
shortlist_payload: payload,
source_status: normalized.source_status,
observations,
completed_count: observations.length,
failed_count: failures.length,
failures,
candidates_file: candidatesFile,
runs_file: runsFile,
telegram_attempted: false,
telegram_sent: false,
source_screener_mutated: false,
production_state_mutated: false
};
}
async function runLiveFastWatcher(options) {
const opts = options || {};
const stateDir = opts.stateDir || watcher.DEFAULT_STATE_DIR;
const liveLock = path.join(stateDir, `${opts.sampleDate || 'invalid'}.live.lock`);
const release = await (opts.acquireLock || watcher.acquireLock)(liveLock, {
nowMs: opts.lockNowMs,
staleMs: opts.lockStaleMs
});
if (!release) return { status: 'lock_busy', error_code: 'live_lock_busy', shadow_only: true };
try {
const collected = await collectLiveSnapshot(opts);
if (!['live_shadow_collected', 'live_shadow_dry_run'].includes(collected.status)) return collected;
const processOptions = {
sampleDate: opts.sampleDate,
shortlistFile: opts.shortlistFile,
observationsFile: collected.candidates_file,
throughTime: opts.scheduledTime,
stateDir,
eventDir: opts.eventDir,
maxShortlist: opts.maxShortlist,
dryRun: opts.dryRun,
mode: 'shadow',
now: opts.now,
shortlistPayload: collected.shortlist_payload
};
if (opts.dryRun) processOptions.observationPayload = collected.observations;
const processWatcher = opts.processWatcher || watcher.runFastWatcher;
const processed = await processWatcher(processOptions);
const expectedStatus = opts.dryRun ? 'shadow_dry_run' : 'shadow_recorded';
const collection = {
status: collected.status,
source_status: collected.source_status,
run_mode: collected.run_mode,
shortlist_count: collected.shortlist_count,
completed_count: collected.completed_count,
failed_count: collected.failed_count,
candidates_file: collected.candidates_file,
runs_file: collected.runs_file
};
const safety = {
scheduled_time: opts.scheduledTime,
through_time: opts.scheduledTime,
telegram_attempted: false,
telegram_sent: false,
source_screener_mutated: false,
production_state_mutated: false,
collection
};
if (!processed || processed.status !== expectedStatus) {
return Object.assign({
status: 'processing_failed',
error_code: 'missing_processor_result',
shadow_only: true
}, processed || {}, safety);
}
return Object.assign({}, processed, safety, {
status: opts.dryRun ? 'live_shadow_dry_run' : 'live_shadow_recorded'
});
} finally {
await release();
}
}
module.exports = {
DEFAULT_CONCURRENCY,
MAX_CONCURRENCY,
DEFAULT_TIMEOUT_MS,
DEFAULT_CACHE_DIR,
DEFAULT_OBSERVATION_ROOT,
DEFAULT_PRODUCTION_LOCK_FILE,
IN_PROGRESS_SOURCE_STATUSES,
runModeForTime,
chunkRoundRobin,
appendJsonlMany,
normalizeProductionShortlistPayload,
collectLiveSnapshot,
runLiveFastWatcher
};

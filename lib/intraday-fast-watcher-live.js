'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const watcher = require('./intraday-fast-watcher');
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_DIR = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache');
const DEFAULT_OBSERVATION_ROOT = path.join(process.cwd(), 'data', 'intraday-fast-watcher-observations');
const DEFAULT_PRODUCTION_LOCK_FILE = path.join(process.cwd(), 'tmp', 'daytrade-vps-worker-observe.lock');
function runModeForTime(time) {
if (!watcher.validTime(time)) return null;
const [hour, minute] = time.split(':').map(Number);
const total = hour * 60 + minute;
if (total >= 9 * 60 && total <= 10 * 60 + 30) return 'MORNING_SCOUT';
if (total > 10 * 60 + 30 && total <= 13 * 60 + 30) return 'MIDDAY_CHECK';
if (total > 13 * 60 + 30 && total <= 15 * 60) return 'AFTERNOON_EXIT';
return null;
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
async function collectLiveSnapshot(options) {
const opts = options || {};
let engine = opts.engine || null;
let collector = opts.collector || null;
const scheduledTime = opts.scheduledTime;
const runMode = runModeForTime(scheduledTime);
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
const shortlist = watcher.buildShortlist(payload, opts.maxShortlist);
if (!shortlist.ok) return { status: 'invalid_input', error_code: 'invalid_max_shortlist', observations: [] };
if (!shortlist.rows.length) return { status: 'empty_shortlist', observations: [], shortlist_count: 0 };
const freshnessByTicker = {};
const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
const fetchCandles = opts.fetchCandles || (async function fetchForTicker(ticker) {
const result = await collector.fetchWithFreshnessFallback(ticker, cacheDir, { timeoutMs });
freshnessByTicker[ticker] = result.freshness || null;
return result.candles;
});
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
fetchCandles,
env: safeEnv
})));
const results = [];
const failures = [];
batchResults.forEach(batch => {
(batch.results || []).forEach(row => results.push(row));
(batch.failed || []).forEach(row => failures.push(row));
});
const rankByTicker = new Map(shortlist.rows.map((row, index) => [row.ticker, index + 1]));
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
return collector.deriveDistances(record);
});
const root = opts.observationRoot || DEFAULT_OBSERVATION_ROOT;
const dayDir = path.join(root, opts.sampleDate);
const candidatesFile = path.join(dayDir, 'candidates.jsonl');
const runsFile = path.join(dayDir, 'runs.jsonl');
const runRecord = {
schema_version: 1,
rule_version: watcher.RULE_VERSION,
sample_date: opts.sampleDate,
scheduled_time: scheduledTime,
run_mode: runMode,
shortlist_count: shortlist.rows.length,
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
now: opts.now
};
if (opts.dryRun) {
processOptions.shortlistPayload = collected.shortlist_payload;
processOptions.observationPayload = collected.observations;
}
const processed = await watcher.runFastWatcher(processOptions);
return Object.assign({}, processed, {
status: opts.dryRun ? 'live_shadow_dry_run' : 'live_shadow_recorded',
collection: {
status: collected.status,
run_mode: collected.run_mode,
completed_count: collected.completed_count,
failed_count: collected.failed_count,
candidates_file: collected.candidates_file,
runs_file: collected.runs_file
}
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
runModeForTime,
chunkRoundRobin,
appendJsonlMany,
collectLiveSnapshot,
runLiveFastWatcher
};

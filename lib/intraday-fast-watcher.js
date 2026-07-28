'use strict';
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const RULE_VERSION = 'FAST_WATCHER_SHADOW_CONFIRM_2_ANTI_CHASE_V1';
const TIMEZONE = 'Asia/Jakarta';
const DEFAULT_MAX_SHORTLIST = 20;
const MAX_SHORTLIST_LIMIT = 50;
const REQUIRED_CONFIRMATIONS = 2;
const MAX_ADVANCE_PCT = 6;
const DEFAULT_STATE_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-state');
const DEFAULT_EVENT_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-events');
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const READY_VALUES = new Set([
'READY', 'ENTRY_READY', 'QUALIFIED', 'SENDABLE', 'CONFIRMED',
'A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT'
]);
const NOT_READY_VALUES = new Set([
'NOT_READY', 'WAIT', 'WATCHING', 'BLOCKED', 'REJECTED', 'NO_ACTION', 'INVALID',
'EARLY_RADAR', 'PRE_SPIKE_WATCH', 'WAIT_PULLBACK', 'MOMENTUM_CONTINUATION',
'RECLAIM_CANDIDATE', 'SPECULATIVE', 'AVOID'
]);
const ARRAY_KEYS = ['results', 'rows', 'data', 'picks', 'top5', 'candidates', 'items', 'shortlist'];
function finite(value) {
return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function validDate(value) {
if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
const [year, month, day] = value.split('-').map(Number);
const date = new Date(Date.UTC(year, month - 1, day));
return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validTime(value) {
return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}
function toMinutes(value) {
if (!validTime(value)) return null;
const [hour, minute] = value.split(':').map(Number);
return hour * 60 + minute;
}
function normalizeTicker(value) {
const ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
return /^[A-Z]{3,5}$/.test(ticker) ? ticker : null;
}
function tickerFromRow(row) {
if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
return normalizeTicker(row.ticker || row.symbol || row.code || row.stock_code);
}
function observationTime(row) {
if (!row || typeof row !== 'object') return null;
const direct = row.scheduled_time || row.observation_time || row.wib_time || row.time;
if (validTime(direct)) return direct;
const timestamp = row.observed_at || row.timestamp || row.calculated_at || row.updated_at;
if (!timestamp) return null;
const date = new Date(timestamp);
if (!Number.isFinite(date.getTime())) return null;
const parts = new Intl.DateTimeFormat('en-GB', {
timeZone: TIMEZONE,
hour: '2-digit',
minute: '2-digit',
hourCycle: 'h23'
}).formatToParts(date);
const hour = parts.find(part => part.type === 'hour');
const minute = parts.find(part => part.type === 'minute');
return hour && minute ? `${hour.value}:${minute.value}` : null;
}
function extractRows(payload, depth) {
const level = depth || 0;
if (level > 4 || payload == null) return [];
if (Array.isArray(payload)) return payload;
if (typeof payload !== 'object') return [];
if (tickerFromRow(payload)) return [payload];
for (const key of ARRAY_KEYS) {
if (Array.isArray(payload[key])) return payload[key];
}
for (const key of ['payload', 'result', 'latest', 'response']) {
if (payload[key] && typeof payload[key] === 'object') {
const rows = extractRows(payload[key], level + 1);
if (rows.length) return rows;
}
}
return [];
}
function buildShortlist(payloads, maxShortlist) {
const limit = Number.isInteger(maxShortlist) ? maxShortlist : DEFAULT_MAX_SHORTLIST;
if (limit < 1 || limit > MAX_SHORTLIST_LIMIT) {
return { ok: false, error: `maxShortlist must be between 1 and ${MAX_SHORTLIST_LIMIT}.`, rows: [] };
}
const sources = Array.isArray(payloads) ? payloads : [payloads];
const seen = new Set();
const rows = [];
for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
const sourceRows = extractRows(sources[sourceIndex]);
for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
const row = sourceRows[rowIndex];
const ticker = tickerFromRow(row);
if (!ticker || seen.has(ticker)) continue;
seen.add(ticker);
rows.push({
ticker,
source_index: sourceIndex,
source_rank: rowIndex + 1,
score: finite(row.score) ?? finite(row.final_score) ?? finite(row.total_score),
source_status: String(row.status || row.current_status || row.signal_status || row.production_status || '').trim() || null,
board: String(row.board || '').trim().toUpperCase() || null
});
if (rows.length >= limit) break;
}
if (rows.length >= limit) break;
}
return { ok: true, rows, total_unique_seen: seen.size, truncated: rows.length >= limit };
}
function explicitReady(obs) {
if (!obs || typeof obs !== 'object') return { value: null, source: null };
if (obs.production_eligible === true) return { value: true, source: 'production_eligible' };
if (obs.production_eligible === false) return { value: false, source: 'production_eligible' };
if (obs.ready === true) return { value: true, source: 'ready' };
if (obs.ready === false) return { value: false, source: 'ready' };
for (const field of ['production_status', 'eligibility_status', 'signal_status', 'decision', 'current_status', 'status']) {
const value = String(obs[field] || '').trim().toUpperCase();
if (READY_VALUES.has(value)) return { value: true, source: field };
if (NOT_READY_VALUES.has(value)) return { value: false, source: field };
}
return { value: null, source: null };
}
function observationMetrics(obs) {
return {
current_price: finite(obs.current_price) ?? finite(obs.last_price) ?? finite(obs.price),
entry_low: finite(obs.entry_low) ?? finite(obs.buy_low),
entry_high: finite(obs.entry_high) ?? finite(obs.buy_high),
tp1: finite(obs.tp1) ?? finite(obs.target_1),
stop_loss: finite(obs.stop_loss) ?? finite(obs.sl),
stale: Boolean(obs.freshness && obs.freshness.is_stale === true) || obs.is_stale === true
};
}
function evaluateObservation(obs, tracker) {
const ready = explicitReady(obs);
const metrics = observationMetrics(obs);
const reasons = [];
let status = 'WATCHING';
let passes = false;
if (ready.value === null) {
reasons.push('missing_engine_ready_flag');
status = 'UNKNOWN';
} else if (metrics.current_price == null || metrics.current_price <= 0) {
reasons.push('invalid_current_price');
status = 'INVALID_DATA';
} else if (metrics.stale) {
reasons.push('stale');
status = 'STALE';
} else if (metrics.stop_loss != null && metrics.current_price <= metrics.stop_loss) {
reasons.push('stop_touched');
status = 'INVALIDATED';
} else if (ready.value === false) {
reasons.push('engine_not_ready');
status = 'WATCHING';
} else {
if (metrics.entry_low == null || metrics.entry_high == null || metrics.entry_low > metrics.entry_high) {
reasons.push('invalid_entry_zone');
status = 'INVALID_DATA';
} else if (metrics.current_price < metrics.entry_low) {
reasons.push('below_entry_zone');
status = 'WATCHING';
} else if (metrics.current_price > metrics.entry_high) {
reasons.push('above_entry_zone');
status = 'BLOCKED_CHASE';
} else if (metrics.tp1 == null || metrics.tp1 <= metrics.current_price) {
reasons.push(metrics.tp1 == null ? 'invalid_tp1' : 'tp1_already_reached');
status = 'BLOCKED_CHASE';
} else {
const firstPrice = finite(tracker.first_price);
const advancePct = firstPrice && firstPrice > 0
? ((metrics.current_price - firstPrice) / firstPrice) * 100
: null;
if (advancePct == null) {
reasons.push('missing_first_price');
status = 'INVALID_DATA';
} else if (advancePct > MAX_ADVANCE_PCT) {
reasons.push('advance_above_6_pct');
status = 'BLOCKED_CHASE';
} else {
passes = true;
status = 'READY_PASS';
}
metrics.advance_pct = advancePct;
}
}
return {
passes,
status,
reasons: [...new Set(reasons)].sort(),
ready_source: ready.source,
metrics
};
}
function observationKey(ticker, time, obs) {
const digest = crypto.createHash('sha256').update(JSON.stringify(obs)).digest('hex').slice(0, 12);
return `${ticker}|${time}|${digest}`;
}
function eventId(date, ticker, time, from, to) {
return crypto.createHash('sha256')
.update([date, ticker, time, from || '-', to, RULE_VERSION].join('|'))
.digest('hex');
}
function processObservations(options) {
const date = options.sampleDate;
const throughMinutes = options.throughTime ? toMinutes(options.throughTime) : null;
const shortlistRows = options.shortlistRows || [];
const shortlist = new Set(shortlistRows.map(row => row.ticker));
const priorState = options.priorState && options.priorState.date === date
? options.priorState
: null;
const state = priorState ? JSON.parse(JSON.stringify(priorState)) : {
schema_version: 1,
date,
rule_version: RULE_VERSION,
shortlist_hash: null,
updated_at: null,
tickers: {}
};
state.rule_version = RULE_VERSION;
state.date = date;
state.shortlist_hash = crypto.createHash('sha256').update([...shortlist].join('|')).digest('hex');
state.shortlist = [...shortlist];
const events = [];
const prepared = [];
const malformed = [];
for (const obs of options.observations || []) {
const ticker = tickerFromRow(obs);
const time = observationTime(obs);
if (!ticker || !time) {
malformed.push({ ticker: ticker || null, reason: !ticker ? 'invalid_ticker' : 'invalid_time' });
continue;
}
if (!shortlist.has(ticker)) continue;
if (throughMinutes != null && toMinutes(time) > throughMinutes) continue;
prepared.push({ obs, ticker, time, minute: toMinutes(time) });
}
prepared.sort((a, b) => a.minute - b.minute || a.ticker.localeCompare(b.ticker) || JSON.stringify(a.obs).localeCompare(JSON.stringify(b.obs)));
for (const row of shortlistRows) {
const ticker = row.ticker;
if (!state.tickers[ticker]) {
state.tickers[ticker] = {
active: true,
shortlist_rank: row.source_rank,
status: 'WATCHING',
ready_streak: 0,
first_price: null,
first_time: null,
last_time: null,
processed_keys: [],
last_reasons: []
};
} else {
state.tickers[ticker].active = true;
state.tickers[ticker].shortlist_rank = row.source_rank;
}
}
for (const [ticker, tracker] of Object.entries(state.tickers)) {
if (tracker.active && !shortlist.has(ticker)) {
const from = tracker.status || 'WATCHING';
tracker.active = false;
tracker.status = 'DROPPED_FROM_SHORTLIST';
tracker.ready_streak = 0;
const time = options.throughTime || tracker.last_time || '00:00';
events.push({
event_id: eventId(date, ticker, time, from, tracker.status),
date,
time,
ticker,
from_status: from,
to_status: tracker.status,
reasons: ['not_in_latest_shortlist'],
rule_version: RULE_VERSION,
shadow_only: true
});
}
}
for (const row of prepared) {
const tracker = state.tickers[row.ticker];
if (!tracker || tracker.active !== true) continue;
const key = observationKey(row.ticker, row.time, row.obs);
const processed = new Set(Array.isArray(tracker.processed_keys) ? tracker.processed_keys : []);
if (processed.has(key)) continue;
processed.add(key);
tracker.processed_keys = [...processed].slice(-200);
const metrics = observationMetrics(row.obs);
if (tracker.first_price == null && metrics.current_price != null && metrics.current_price > 0) {
tracker.first_price = metrics.current_price;
tracker.first_time = row.time;
}
const result = evaluateObservation(row.obs, tracker);
const from = tracker.status || 'WATCHING';
let to = result.status;
if (result.passes) {
tracker.ready_streak = (tracker.ready_streak || 0) + 1;
to = tracker.ready_streak >= REQUIRED_CONFIRMATIONS ? 'READY_CONFIRMED' : 'READY_PENDING';
} else {
tracker.ready_streak = 0;
}
tracker.status = to;
tracker.last_time = row.time;
tracker.last_reasons = result.reasons;
tracker.last_metrics = result.metrics;
tracker.ready_source = result.ready_source;
if (to !== from) {
events.push({
event_id: eventId(date, row.ticker, row.time, from, to),
date,
time: row.time,
ticker: row.ticker,
from_status: from,
to_status: to,
ready_streak: tracker.ready_streak,
reasons: result.reasons,
ready_source: result.ready_source,
metrics: result.metrics,
rule_version: RULE_VERSION,
shadow_only: true
});
}
}
state.updated_at = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
const confirmed = Object.entries(state.tickers)
.filter(([, tracker]) => tracker.active && tracker.status === 'READY_CONFIRMED')
.map(([ticker, tracker]) => ({ ticker, time: tracker.last_time, ready_streak: tracker.ready_streak }));
return {
state,
events,
confirmed,
malformed_count: malformed.length,
processed_observation_count: prepared.length,
shortlist_count: shortlist.size
};
}
async function parseFile(file) {
const raw = await fsp.readFile(file, 'utf8');
const trimmed = raw.trim();
if (!trimmed) return [];
if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
try { return JSON.parse(trimmed); } catch (_) {}
}
const rows = [];
const errors = [];
raw.split(/\r?\n/).forEach((line, index) => {
if (!line.trim()) return;
try { rows.push(JSON.parse(line)); }
catch (_) { errors.push({ line: index + 1, reason: 'invalid_json' }); }
});
if (errors.length) {
const error = new Error('Invalid JSONL input.');
error.code = 'INVALID_JSONL';
error.details = errors;
throw error;
}
return rows;
}
async function readState(file) {
try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJsonAtomic(file, value) {
await fsp.mkdir(path.dirname(file), { recursive: true });
const temp = `${file}.${process.pid}.tmp`;
await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
await fsp.rename(temp, file);
}
async function appendEvents(file, events) {
if (!events.length) return;
await fsp.mkdir(path.dirname(file), { recursive: true });
const text = events.map(event => JSON.stringify(event)).join('\n') + '\n';
await fsp.appendFile(file, text, { mode: 0o600 });
}
function isPidAlive(pid) {
if (!Number.isInteger(pid) || pid <= 0) return false;
try { process.kill(pid, 0); return true; }
catch (error) { return Boolean(error && error.code === 'EPERM'); }
}
async function acquireLock(file, options) {
const nowMs = options && options.nowMs != null ? options.nowMs : Date.now();
const staleMs = options && options.staleMs != null ? options.staleMs : DEFAULT_LOCK_STALE_MS;
await fsp.mkdir(path.dirname(file), { recursive: true });
for (let attempt = 0; attempt < 2; attempt += 1) {
try {
const handle = await fsp.open(file, 'wx');
await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date(nowMs).toISOString() }) + '\n');
return async function release() {
await handle.close().catch(() => {});
await fsp.unlink(file).catch(() => {});
};
} catch (error) {
if (error.code !== 'EEXIST') throw error;
let current = null;
try { current = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) {}
const created = current ? Date.parse(current.created_at) : NaN;
const stale = Number.isFinite(created) && nowMs - created >= staleMs;
if (!stale || isPidAlive(current && current.pid)) return null;
await fsp.unlink(file).catch(() => {});
}
}
return null;
}
async function runFastWatcher(options) {
const opts = options || {};
if (!validDate(opts.sampleDate)) {
return { status: 'invalid_input', error_code: 'invalid_date', rule_version: RULE_VERSION, shadow_only: true };
}
if (opts.throughTime && !validTime(opts.throughTime)) {
return { status: 'invalid_input', error_code: 'invalid_time', rule_version: RULE_VERSION, shadow_only: true };
}
if (opts.mode && opts.mode !== 'shadow') {
return { status: 'blocked_non_shadow_mode', error_code: 'shadow_only', rule_version: RULE_VERSION, shadow_only: true };
}
let shortlistPayload;
let observationPayload;
if (Object.prototype.hasOwnProperty.call(opts, 'shortlistPayload')) shortlistPayload = opts.shortlistPayload;
else {
try { shortlistPayload = await (opts.readPayload || parseFile)(opts.shortlistFile); }
catch (error) {
return { status: error.code === 'ENOENT' ? 'shortlist_missing' : 'shortlist_invalid', error_code: error.code || 'shortlist_invalid', rule_version: RULE_VERSION, shadow_only: true };
}
}
if (Object.prototype.hasOwnProperty.call(opts, 'observationPayload')) observationPayload = opts.observationPayload;
else {
try { observationPayload = await (opts.readPayload || parseFile)(opts.observationsFile); }
catch (error) {
return { status: error.code === 'ENOENT' ? 'observations_missing' : 'observations_invalid', error_code: error.code || 'observations_invalid', rule_version: RULE_VERSION, shadow_only: true };
}
}
const shortlistResult = buildShortlist(shortlistPayload, opts.maxShortlist);
if (!shortlistResult.ok) {
return { status: 'invalid_input', error_code: 'invalid_max_shortlist', error: shortlistResult.error, rule_version: RULE_VERSION, shadow_only: true };
}
if (!shortlistResult.rows.length) {
return { status: 'empty_shortlist', rule_version: RULE_VERSION, shadow_only: true, shortlist_count: 0, event_count: 0, confirmed: [] };
}
const observations = extractRows(observationPayload).length
? extractRows(observationPayload)
: (Array.isArray(observationPayload) ? observationPayload : []);
const stateDir = opts.stateDir || DEFAULT_STATE_DIR;
const eventDir = opts.eventDir || DEFAULT_EVENT_DIR;
const stateFile = path.join(stateDir, `${opts.sampleDate}.json`);
const eventFile = path.join(eventDir, `${opts.sampleDate}.jsonl`);
const lockFile = path.join(stateDir, `${opts.sampleDate}.lock`);
const release = await (opts.acquireLock || acquireLock)(lockFile, { nowMs: opts.lockNowMs, staleMs: opts.lockStaleMs });
if (!release) return { status: 'lock_busy', error_code: 'lock_busy', rule_version: RULE_VERSION, shadow_only: true };
try {
const priorState = await (opts.readState || readState)(stateFile);
const processed = processObservations({
sampleDate: opts.sampleDate,
throughTime: opts.throughTime,
shortlistRows: shortlistResult.rows,
observations,
priorState,
now: opts.now
});
if (!opts.dryRun) {
await (opts.writeState || writeJsonAtomic)(stateFile, processed.state);
await (opts.writeEvents || appendEvents)(eventFile, processed.events);
}
return {
status: opts.dryRun ? 'shadow_dry_run' : 'shadow_recorded',
rule_version: RULE_VERSION,
shadow_only: true,
sample_date: opts.sampleDate,
through_time: opts.throughTime || null,
shortlist_count: processed.shortlist_count,
shortlist_truncated: shortlistResult.truncated,
processed_observation_count: processed.processed_observation_count,
malformed_count: processed.malformed_count,
event_count: processed.events.length,
events: processed.events,
confirmed: processed.confirmed,
state_file: stateFile,
event_file: eventFile,
telegram_attempted: false,
telegram_sent: false,
source_files_mutated: false
};
} finally {
await release();
}
}
module.exports = {
RULE_VERSION,
TIMEZONE,
DEFAULT_MAX_SHORTLIST,
MAX_SHORTLIST_LIMIT,
REQUIRED_CONFIRMATIONS,
MAX_ADVANCE_PCT,
DEFAULT_STATE_DIR,
DEFAULT_EVENT_DIR,
validDate,
validTime,
normalizeTicker,
observationTime,
extractRows,
buildShortlist,
explicitReady,
observationMetrics,
evaluateObservation,
processObservations,
parseFile,
readState,
writeJsonAtomic,
appendEvents,
acquireLock,
runFastWatcher
};

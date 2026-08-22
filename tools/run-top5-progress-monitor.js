#!/usr/bin/env node
'use strict';

// VPS-only runner: it is not imported by any Vercel endpoint and defaults to dry run.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const monitor = require('../lib/top5-progress-monitor');
const prices = require('../lib/latest-price-resolver');
const telegram = require('../lib/telegram-notifier');

const ENV_FILES = ['.env.local', '.env.intraday-runtime', '.env'];
const PROGRESS_PAGE_SIZE = 1000;

function loadEnvFiles(options) {
  const cwd = (options && options.cwd) || process.cwd();
  const env = (options && options.env) || process.env;
  for (const name of ENV_FILES) {
    let content;
    try { content = fsSync.readFileSync(path.join(cwd, name), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || Object.prototype.hasOwnProperty.call(env, match[1])) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      env[match[1]] = value;
    }
  }
}

loadEnvFiles();

const AS_OF_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?([+-])(\d{2}):(\d{2})$/;

function validateAsOfDatetime(value, currentTime) {
  const input = String(value || '');
  const match = input.match(AS_OF_DATETIME_PATTERN);
  if (!match) throw new Error('--as-of-datetime must be a full ISO-8601 datetime with an explicit numeric timezone offset (for example, 2026-07-17T14:00:00+07:00).');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const offsetHour = Number(match[9]), offsetMinute = Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    throw new Error('--as-of-datetime is not a valid ISO-8601 calendar datetime.');
  }
  const evaluationTime = new Date(input);
  if (Number.isNaN(evaluationTime.getTime())) throw new Error('--as-of-datetime is not a valid ISO-8601 calendar datetime.');
  const actualNow = currentTime instanceof Date ? currentTime : new Date(currentTime || Date.now());
  if (evaluationTime.getTime() > actualNow.getTime()) throw new Error('--as-of-datetime must not be in the future.');
  return evaluationTime;
}

function validateHistoricalOptions(options, currentTime) {
  if (!options || !options.asOfDatetime) return null;
  if (options.send || options.sendRequested) throw new Error('--as-of-datetime cannot be combined with --send.');
  if (!options.dryRun || options.dryRunExplicit !== true) throw new Error('--as-of-datetime requires an explicitly supplied --dry-run.');
  return validateAsOfDatetime(options.asOfDatetime, currentTime);
}

function parseArgs(argv) {
  const o = { dryRun: true, dryRunExplicit: false, send: false, sendRequested: false, asOfDatetime: null, json: false, limit: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') { o.send = true; o.sendRequested = true; o.dryRun = false; }
    else if (a === '--dry-run') { o.dryRun = true; o.dryRunExplicit = true; o.send = false; }
    else if (a === '--as-of-datetime') {
      if (o.asOfDatetime != null) throw new Error('--as-of-datetime may only be supplied once.');
      const value = argv[++i];
      if (!value || String(value).startsWith('--')) throw new Error('--as-of-datetime requires a value.');
      o.asOfDatetime = value;
    } else if (a === '--json') o.json = true;
    else if (a === '--limit') o.limit = Math.max(1, Number(argv[++i]) || 1);
  }
  validateHistoricalOptions(o);
  return o;
}
function statePath() { return process.env.TOP5_PROGRESS_STATE_FILE || '/home/ubuntu/auto-cuan-runner/state/top5-progress-events.json'; }
async function readState(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { events: {}, tracking: {} }; throw e; } }
async function writeState(file, state) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
function rowsByTicker(rows) { const out = {}; (rows || []).forEach((r) => { if (r && r.ticker) out[String(r.ticker).toUpperCase()] = r; }); return out; }
function supabaseRestUrl(url, table, params) { const base = String(url || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, ''); const target = new URL(base + '/rest/v1/' + table); Object.entries(params || {}).forEach(([key, value]) => target.searchParams.set(key, value)); return target.toString(); }
async function fetchSupabaseRows(fetchImpl, supabaseUrl, key, table, params) {
  const response = await fetchImpl(supabaseRestUrl(supabaseUrl, table, params), { method: 'GET', headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!response.ok) throw new Error('Supabase read failed for ' + table + ': HTTP ' + response.status + ' ' + await response.text());
  return response.json();
}
async function fetchAllProgressRows(fetchImpl, supabaseUrl, key, limit) {
  const requestedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : null;
  const rows = [];
  let offset = 0;
  while (requestedLimit == null || rows.length < requestedLimit) {
    const remaining = requestedLimit == null ? PROGRESS_PAGE_SIZE : Math.min(PROGRESS_PAGE_SIZE, requestedLimit - rows.length);
    if (remaining <= 0) break;
    const page = await fetchSupabaseRows(fetchImpl, supabaseUrl, key, 'telegram_daily_picks', {
      select: '*',
      order: 'date.desc,id.desc',
      limit: String(remaining),
      offset: String(offset)
    });
    rows.push(...(page || []));
    if (!Array.isArray(page) || page.length < remaining) break;
    offset += page.length;
  }
  return rows;
}
async function readLatestRows(fetchImpl, supabaseUrl, key, tickers, options) {
  const uniqueTickers = [...new Set((tickers || []).filter(Boolean).map((ticker) => String(ticker).toUpperCase()))];
  const output = {}; prices.SOURCES.forEach((source) => { output[source.table] = {}; });
  if (!uniqueTickers.length) return output;
  const tickerFilter = 'in.(' + uniqueTickers.join(',') + ')';
  const results = await Promise.all(prices.SOURCES.map((source) => fetchSupabaseRows(fetchImpl, supabaseUrl, key, source.table, { select: '*', ticker: tickerFilter })));
  const requiredPriceDate = options && options.requiredPriceDate;
  results.forEach((rows, index) => {
    const eligibleRows = requiredPriceDate
      ? (rows || []).filter((row) => dateOnlyInJakarta(prices.rowDate(row)) === requiredPriceDate)
      : rows;
    output[prices.SOURCES[index].table] = rowsByTicker(eligibleRows);
  });
  return output;
}
function progressMessage(row, progress, event, source) {
  return ['📊 ' + (row.ticker || '-') + ' — ' + event.type, 'Harga: ' + progress.latest_price + ' | Entry: ' + progress.entry_used, 'TP1/TP2/SL: ' + (progress.tp1 || '-') + '/' + (progress.tp2 || '-') + '/' + (progress.sl || '-'), 'Gain: ' + (progress.gain_pct == null ? '-' : progress.gain_pct + '%') + ' | Sumber: ' + (source.price_date || '-'), 'Pantauan, bukan rekomendasi beli/jual.'].join('\n');
}
function jakartaDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return part('year') + '-' + part('month') + '-' + part('day');
}
function dateOnlyInJakarta(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return jakartaDate(value);
}
function pickDate(row) { return dateOnlyInJakarta(row && (row.locked_date || row.date || row.trade_date)); }
function sendGuard(row, source, currentWibDate) {
  const rowPickDate = pickDate(row);
  const rowDates = ['locked_date', 'date', 'trade_date'].map((field) => dateOnlyInJakarta(row && row[field])).filter(Boolean);
  if (!rowDates.length || rowDates.some((date) => date !== currentWibDate)) return { reason: 'STALE_PICK_DATE', pick_date: rowPickDate };
  const priceDate = dateOnlyInJakarta(source && source.price_date);
  if (priceDate !== currentWibDate) return { reason: 'PRICE_DATE_NOT_TODAY', pick_date: rowPickDate };
  return { reason: null, pick_date: rowPickDate };
}
function shouldSendEvent(options, event, state, source, guard) {
  return !!(options && options.send && monitor.isTelegramSendableEvent(event) && !(state && state.events && state.events[event.event_key]) && !(source && source.stale) && !(guard && guard.reason) && telegram.isTelegramEnabled());
}
function isAfterJakartaMarketClose(now) { const d = now || new Date(); return d.getUTCHours() > 9 || (d.getUTCHours() === 9 && d.getUTCMinutes() >= 15); }
function isActiveProgressRow(row) {
  if (!row || !row.ticker) return false;
  const raw = row.raw_payload || {};
  if (raw.history_archived_at || row.history_archived_at || row.archived_at) return false;
  const status = String(row.status || row.final_status || '').toUpperCase();
  return ['TP2_HIT', 'SL_HIT', 'COMPLETE', 'COMPLETED', 'EXPIRED', 'MAX_AGE_EXPIRED', 'STOP_TRACKING'].indexOf(status) < 0;
}
async function run(options, deps) {
  options = options || parseArgs(process.argv); deps = deps || {};
  const historicalEvaluationTime = validateHistoricalOptions(options);
  const historicalDryRun = !!historicalEvaluationTime;
  const env = deps.env || process.env, fetchImpl = deps.fetch || global.fetch;
  const supabaseUrl = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY are required.');
  if (typeof fetchImpl !== 'function') throw new Error('Native fetch is required (Node.js 20 or newer).');
  const file = historicalDryRun ? null : (deps.stateFile || statePath());
  const state = historicalDryRun ? { events: {}, tracking: {} } : await readState(file);
  const now = historicalDryRun ? historicalEvaluationTime : (deps.now ? new Date(deps.now) : new Date());
  const currentWibDate = jakartaDate(now);
  const query = await fetchAllProgressRows(fetchImpl, supabaseUrl, key, options.limit);
  const rows = (query || []).filter(isActiveProgressRow);
  const latest = await readLatestRows(fetchImpl, supabaseUrl, key, rows.map((row) => row.ticker), historicalDryRun ? { requiredPriceDate: currentWibDate } : null);
  const report = [];
  for (const row of rows) {
    const ticker = String(row.ticker).toUpperCase(), sourceRows = {}; prices.SOURCES.forEach((s) => { sourceRows[s.table] = latest[s.table][ticker]; });
    const source = prices.resolveLatestPrice(sourceRows, { now: now.toISOString() });
    const detected = monitor.detectTop5ProgressEvents(row, source.price, { now: now.toISOString(), priceTimestamp: source.price_date });
    const trackingKey = ticker + ':' + (row.locked_date || row.date || row.trade_date || 'unknown-date');
    const tracking = monitor.deriveTrackingStatus(row, detected, state.tracking[trackingKey], { now: now.toISOString(), afterMarketClose: isAfterJakartaMarketClose(now) });
    state.tracking[trackingKey] = Object.assign({}, state.tracking[trackingKey], { status: tracking.status, updated_at: now.toISOString() });
    let events = detected.events.slice();
    if (state.tracking[trackingKey].tp1_notified) events = events.filter((event) => event.type !== 'TP1_HIT');
    if (!tracking.should_track) {
      if (tracking.reason === 'SL_HIT') events = [{ type: 'SL_HIT', event_key: monitor.eventKey(row, 'SL_HIT'), actionable: true, notification_enabled: options.send }];
      else if (tracking.reason === 'TP2_HIT') events = events.filter((event) => event.type === 'TP2_HIT');
      else events = [];
    }
    for (const event of events) {
      const duplicate = !!state.events[event.event_key];
      const guard = sendGuard(row, source, currentWibDate);
      const sendable = monitor.isTelegramSendableEvent(event) && !duplicate && !source.stale && !guard.reason;
      const canSend = historicalDryRun ? false : shouldSendEvent(options, event, state, source, guard);
      let sent = false;
      let sendResult = null;
      if (canSend) {
        sendResult = await telegram.sendTelegramMessage(progressMessage(row, detected.progress, event, source));
        if (sendResult && sendResult.sent) {
          sent = true;
          state.events[event.event_key] = { sent_at: now.toISOString(), ticker, type: event.type };
          if (event.type === 'TP1_HIT') state.tracking[trackingKey].tp1_notified = true;
        }
      }
      const sendSkipReason = !sendable
        ? null
        : historicalDryRun
          ? 'HISTORICAL_DRY_RUN'
          : !options.send
            ? 'DRY_RUN'
            : !telegram.isTelegramEnabled()
              ? 'TELEGRAM_DISABLED'
              : sendResult && !sendResult.sent
                ? (sendResult.reason || 'TELEGRAM_SEND_FAILED')
                : null;
      report.push({ ticker, event: event.type, event_key: event.event_key, pick_date: guard.pick_date, source: source.price_source, price_date: source.price_date, sendable, send_block_reason: guard.reason || (duplicate ? 'DUPLICATE' : (source.stale ? 'STALE_PRICE' : null)), send_attempted: canSend, send_skip_reason: sendSkipReason, sent, duplicate, tracking: tracking.status, dry_run: !options.send });
    }
  }
  if (!historicalDryRun) await writeState(file, state);
  const result = { dry_run: !options.send, state_file: file, checked: rows.length, total_events: report.length, sendable_count: report.filter((event) => event.sendable).length, blocked_old_pick_count: report.filter((event) => event.send_block_reason === 'STALE_PICK_DATE').length, blocked_price_date_count: report.filter((event) => event.send_block_reason === 'PRICE_DATE_NOT_TODAY').length, attempted_count: report.filter((event) => event.send_attempted).length, failed_count: report.filter((event) => event.send_attempted && !event.sent).length, sent_count: report.filter((event) => event.sent).length, duplicate_count: report.filter((event) => event.duplicate).length, events: report };
  if (historicalDryRun) {
    Object.assign(result, {
      historical_dry_run: true,
      simulation: true,
      evaluation_datetime: options.asOfDatetime,
      evaluation_date_wib: currentWibDate,
      state_mode: 'ISOLATED_IN_MEMORY',
      state_persisted: false,
      simulation_notice: 'Historical dry-run simulation using current database snapshots and isolated empty idempotency/tracking state; this is not an exact replay of the original production idempotency and tracking state.'
    });
  }
  return result;
}
if (require.main === module) { const options = parseArgs(process.argv); run(options).then((result) => { if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log('top5 progress: checked=' + result.checked + ' events=' + result.events.length + ' dry_run=' + result.dry_run + ' state=' + result.state_file); }).catch((error) => { console.error(error.message || error); process.exitCode = 1; }); }
module.exports = { ENV_FILES, PROGRESS_PAGE_SIZE, loadEnvFiles, validateAsOfDatetime, validateHistoricalOptions, parseArgs, readState, writeState, supabaseRestUrl, fetchSupabaseRows, fetchAllProgressRows, readLatestRows, jakartaDate, dateOnlyInJakarta, pickDate, sendGuard, shouldSendEvent, isAfterJakartaMarketClose, isActiveProgressRow, run, statePath };

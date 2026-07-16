#!/usr/bin/env node
'use strict';

// VPS-only runner: it is not imported by any Vercel endpoint and defaults to dry run.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const monitor = require('../lib/top5-progress-monitor');
const prices = require('../lib/latest-price-resolver');
const telegram = require('../lib/telegram-notifier');

function parseArgs(argv) { const o = { dryRun: true, send: false, json: false, limit: 50 }; for (let i = 2; i < argv.length; i++) { const a = argv[i]; if (a === '--send') { o.send = true; o.dryRun = false; } else if (a === '--dry-run') { o.dryRun = true; o.send = false; } else if (a === '--json') o.json = true; else if (a === '--limit') o.limit = Math.max(1, Number(argv[++i]) || 50); } return o; }
function statePath() { return process.env.TOP5_PROGRESS_STATE_FILE || '/home/ubuntu/auto-cuan-runner/state/top5-progress-events.json'; }
async function readState(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { events: {}, tracking: {} }; throw e; } }
async function writeState(file, state) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
function rowsByTicker(rows) { const out = {}; (rows || []).forEach((r) => { if (r && r.ticker) out[String(r.ticker).toUpperCase()] = r; }); return out; }
async function readLatestRows(supabase, tickers) {
  const results = await Promise.all(prices.SOURCES.map((source) => supabase.from(source.table).select('*').in('ticker', tickers)));
  const output = {}; results.forEach((result, index) => { output[prices.SOURCES[index].table] = rowsByTicker(result.data); }); return output;
}
function progressMessage(row, progress, event, source) {
  return ['📊 ' + (row.ticker || '-') + ' — ' + event.type, 'Harga: ' + progress.latest_price + ' | Entry: ' + progress.entry_used, 'TP1/TP2/SL: ' + (progress.tp1 || '-') + '/' + (progress.tp2 || '-') + '/' + (progress.sl || '-'), 'Gain: ' + (progress.gain_pct == null ? '-' : progress.gain_pct + '%') + ' | Sumber: ' + (source.price_date || '-'), 'Pantauan, bukan rekomendasi beli/jual.'].join('\n');
}
function shouldSendEvent(options, event, state, source) {
  return !!(options && options.send && event && event.actionable && !(state && state.events && state.events[event.event_key]) && !(source && source.stale) && telegram.isTelegramEnabled());
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
  const supabase = deps.supabase || createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '', { auth: { persistSession: false, autoRefreshToken: false } });
  if (!deps.supabase && (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY))) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY are required.');
  const file = deps.stateFile || statePath(), state = await readState(file);
  const query = await supabase.from('telegram_daily_picks').select('*').order('date', { ascending: false }).limit(options.limit);
  if (query.error) throw new Error(query.error.message);
  // `is_final` marks locked/final publication in telegram_daily_picks; it is
  // not a terminal monitor state and must remain eligible for progress checks.
  const rows = (query.data || []).filter(isActiveProgressRow);
  const latest = await readLatestRows(supabase, rows.map((row) => row.ticker));
  const report = [];
  for (const row of rows) {
    const ticker = String(row.ticker).toUpperCase(), sourceRows = {}; prices.SOURCES.forEach((s) => { sourceRows[s.table] = latest[s.table][ticker]; });
    const source = prices.resolveLatestPrice(sourceRows, { now: new Date().toISOString() });
    const detected = monitor.detectTop5ProgressEvents(row, source.price, { now: new Date().toISOString(), priceTimestamp: source.price_date });
    const trackingKey = ticker + ':' + (row.locked_date || row.date || row.trade_date || 'unknown-date');
    const tracking = monitor.deriveTrackingStatus(row, detected, state.tracking[trackingKey], { now: new Date().toISOString(), afterMarketClose: isAfterJakartaMarketClose() });
    state.tracking[trackingKey] = Object.assign({}, state.tracking[trackingKey], { status: tracking.status, updated_at: new Date().toISOString() });
    let events = detected.events.slice();
    if (state.tracking[trackingKey].tp1_notified) events = events.filter((event) => event.type !== 'TP1_HIT');
    if (!tracking.should_track && tracking.reason === 'terminal_state') events = [];
    if (tracking.reason === 'SL_HIT') events = [{ type: 'SL_HIT', event_key: monitor.eventKey(row, 'SL_HIT'), actionable: true, notification_enabled: options.send }];
    if (tracking.reason === 'TP2_HIT') events = events.filter((event) => event.type === 'TP2_HIT');
    for (const event of events) {
      const duplicate = !!state.events[event.event_key];
      const canSend = shouldSendEvent(options, event, state, source);
      if (canSend) { const sent = await telegram.sendTelegramMessage(progressMessage(row, detected.progress, event, source)); if (sent && sent.sent) { state.events[event.event_key] = { sent_at: new Date().toISOString(), ticker, type: event.type }; if (event.type === 'TP1_HIT') state.tracking[trackingKey].tp1_notified = true; } }
      report.push({ ticker, event: event.type, event_key: event.event_key, source: source.price_source, price_date: source.price_date, sent: canSend, duplicate, tracking: tracking.status, dry_run: !options.send });
    }
  }
  await writeState(file, state);
  return { dry_run: !options.send, state_file: file, checked: rows.length, events: report };
}
if (require.main === module) { const options = parseArgs(process.argv); run(options).then((result) => { if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log('top5 progress: checked=' + result.checked + ' events=' + result.events.length + ' dry_run=' + result.dry_run + ' state=' + result.state_file); }).catch((error) => { console.error(error.message || error); process.exitCode = 1; }); }
module.exports = { parseArgs, readState, writeState, shouldSendEvent, isAfterJakartaMarketClose, isActiveProgressRow, run, statePath };

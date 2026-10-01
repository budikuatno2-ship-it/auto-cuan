'use strict';

// Read-only Top 5 progress calculations. This module deliberately has no data
// fetching or Telegram side effects: callers must provide a fresh price and a
// durable idempotency store before considering a notification.
const PRICE_FIELDS = ['latest_price', 'current_price', 'last_price', 'price', 'close_price', 'close'];
const PRICE_TIME_FIELDS = ['latest_price_at', 'price_updated_at', 'last_price_at', 'updated_at', 'as_of', 'price_date'];
const SAFETY_TERMS = /\b(avoid|hindari|low_tp|very high risk|stale_level|needs_revalidation|history_insufficient|new_listing)\b/i;
const STRUCTURED_ACTION_STATUS_FIELDS = ['action', 'action_label', 'signal_action', 'signal_action_label', 'telegram_action_label', 'status', 'final_status', 'display_status', 'public_status', 'signal_status'];
const DEFAULT_MAX_PRICE_AGE_HOURS = 48;
const TELEGRAM_SENDABLE_EVENT_TYPES = new Set(['TP1_HIT', 'TP2_HIT', 'SL_HIT', 'GAIN_3_PCT', 'GAIN_5_PCT', 'GAIN_10_PCT']);

function positive(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
function round(value, digits) { const p = Math.pow(10, digits == null ? 2 : digits); return Math.round(value * p) / p; }
function firstPositive(row, fields) { for (const field of fields) { const value = positive(row && row[field]); if (value) return value; } return null; }
function text(row) { return Object.keys(row || {}).map((key) => String(row[key] == null ? '' : row[key])).join(' '); }

function resolveLatestPrice(row, latestPrice) {
  return positive(latestPrice) || firstPositive(row, PRICE_FIELDS);
}

function resolveEntry(row) {
  // entry_high is the conservative end of a range and must win over aliases.
  return firstPositive(row, ['entry_high', 'entry_price', 'entry', 'entry1']);
}

// When the source candidate carries a LOCKED canonical trade plan (produced by
// the shared selector — website / Telegram / intraday all lock the identical
// numbers), progress monitoring MUST read that locked plan rather than the raw
// row fields, so it can never diverge from what was shown/observed and never
// silently switch between legacy and V2. Returns null when no locked plan is
// present, in which case the legacy raw-field behaviour is preserved verbatim.
function resolveSelectedPlan(row) {
  const p = row && row.selected_trade_plan;
  if (!p || typeof p !== 'object') return null;
  return {
    entry: firstPositive(p, ['entry_zone_high', 'entry_zone_low']),
    tp1: positive(p.tp1),
    tp2: positive(p.tp2),
    sl: firstPositive(p, ['stop_loss']),
    source: p.trade_plan_source || null,
    plan_lock_id: (row && row.plan_lock_id) || p.plan_lock_id || null
  };
}

function priceAgeHours(row, options) {
  const timestamp = options && options.priceTimestamp || (row && PRICE_TIME_FIELDS.map((field) => row[field]).find(Boolean));
  if (!timestamp) return null;
  const at = new Date(timestamp).getTime();
  const now = options && options.now ? new Date(options.now).getTime() : Date.now();
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return Math.max(0, (now - at) / 3600000);
}

function safetyBlockReason(row, latestPrice, options) {
  const combined = text(row);
  const age = priceAgeHours(row, options);
  const maxAge = positive(options && options.maxPriceAgeHours) || DEFAULT_MAX_PRICE_AGE_HOURS;
  if (!latestPrice) return 'latest_price_missing';
  if (row && row.trading_plan_valid === false) return 'invalid_trading_plan';
  if (row && String(row.corporate_action_guard || '').toUpperCase() === 'BLOCKED') return 'corporate_action_guard_blocked';
  if (STRUCTURED_ACTION_STATUS_FIELDS.some((field) => /\bSELL\b/i.test(String(row && row[field] || '')))) return 'structured_sell_blocked';
  if (SAFETY_TERMS.test(combined)) return 'safety_gate_blocked';
  if (age != null && age > maxAge) return 'stale_price';
  return null;
}

function computeTop5Progress(row, latestPrice, options) {
  row = row || {};
  const latest = resolveLatestPrice(row, latestPrice);
  // Prefer the LOCKED selected plan when the row carries one; otherwise read the
  // raw row fields exactly as before (byte-identical legacy behaviour).
  const selected = resolveSelectedPlan(row);
  const entry = selected && selected.entry ? selected.entry : resolveEntry(row);
  const tp1 = selected ? selected.tp1 : positive(row.tp1);
  const tp2 = selected ? selected.tp2 : positive(row.tp2);
  const sl = selected ? selected.sl : firstPositive(row, ['sl', 'stop_loss', 'stoploss']);
  const age = priceAgeHours(row, options);
  const blockReason = safetyBlockReason(row, latest, options);
  const gain = latest && entry ? round(((latest - entry) / entry) * 100, 2) : null;
  const stale = blockReason === 'stale_price';
  return {
    ticker: row.ticker || row.symbol || null,
    latest_price: latest,
    entry_used: entry,
    tp1: tp1,
    tp2: tp2,
    sl: sl,
    // Diagnostic: which plan the monitor read and its lock id (null when the row
    // carried no locked plan and the legacy raw fields were used).
    trade_plan_source: selected ? selected.source : null,
    plan_lock_id: selected ? selected.plan_lock_id : null,
    gain_pct: gain,
    tp1_hit: !!(latest && tp1 && latest >= tp1),
    tp2_hit: !!(latest && tp2 && latest >= tp2),
    price_age_hours: age == null ? null : round(age, 2),
    stale: stale,
    stale_reason: stale ? 'price_age_exceeds_max' : null,
    actionable: !blockReason && !!entry,
    block_reason: blockReason || (!entry ? 'entry_missing' : null),
    status: blockReason ? 'BLOCKED' : (!entry ? 'INVALID_PLAN' : 'OK')
  };
}

function eventKey(row, eventType) {
  const ticker = String((row || {}).ticker || (row || {}).symbol || 'UNKNOWN').toUpperCase();
  const lockedDate = (row || {}).locked_date || (row || {}).trade_date || (row || {}).date || 'unknown-date';
  const suffix = eventType === 'TP1_HIT' ? 'tp1' : eventType === 'TP2_HIT' ? 'tp2' : eventType.replace('GAIN_', '').replace('_PCT', '').toLowerCase();
  return 'top5_progress:' + ticker + ':' + lockedDate + ':' + eventType + ':' + suffix;
}

function isTelegramSendableEvent(event) {
  return !!(event && event.actionable && TELEGRAM_SENDABLE_EVENT_TYPES.has(event.type));
}

function isTerminalTrackingStatus(status) {
  return ['STOP_TRACKING', 'COMPLETE', 'COMPLETED', 'MAX_AGE_EXPIRED', 'EXPIRED', 'SL_HIT', 'TP2_HIT', 'TERMINAL'].includes(String(status || '').toUpperCase());
}

function detectTop5ProgressEvents(row, latestPrice, options) {
  const progress = computeTop5Progress(row, latestPrice, options);
  const events = [];
  const add = (type, actionable) => events.push({ type, event_key: eventKey(row, type), actionable: !!actionable });
  if (progress.block_reason === 'stale_price') add('STALE_PRICE', false);
  else if (progress.block_reason || !progress.entry_used) add('INVALID_PLAN', false);
  else {
    if (progress.tp1_hit) add('TP1_HIT', true);
    if (progress.tp2_hit) add('TP2_HIT', true);
    [3, 5, 10].forEach((milestone) => { if (progress.gain_pct >= milestone) add('GAIN_' + milestone + '_PCT', true); });
    // These describe a condition for the dry-run report; they are never alerts.
    if (progress.sl && progress.latest_price <= progress.sl * 1.02) add('SL_NEAR', false);
    if (progress.gain_pct < 0) add('BELOW_ENTRY', false);
  }
  // A caller can render events, but cannot treat them as sendable absent durable storage.
  const durable = !!(options && options.hasDurableIdempotency);
  events.forEach((event) => { event.notification_enabled = isTelegramSendableEvent(event) && durable; });
  return { progress, events, notification_mode: durable ? 'idempotent_ready' : 'dry_run_only' };
}

function deriveTrackingStatus(row, detected, state, options) {
  const progress = detected && detected.progress ? detected.progress : computeTop5Progress(row, null, options);
  const events = detected && detected.events ? detected.events : [];
  const now = options && options.now ? new Date(options.now) : new Date();
  const locked = new Date((row && (row.locked_date || row.date || row.trade_date || row.first_sent_at)) || now);
  const ageDays = Number.isFinite(locked.getTime()) ? (now - locked) / 86400000 : null;
  const prior = state || {};
  if (isTerminalTrackingStatus(prior.status)) return { status: prior.status, should_track: false, reason: 'terminal_state' };
  if (ageDays != null && ageDays > 7) return { status: 'MAX_AGE_EXPIRED', should_track: false, reason: 'tracking_window_exceeded' };
  if (progress.sl && progress.latest_price && progress.latest_price <= progress.sl) return { status: 'STOP_TRACKING', should_track: false, reason: 'SL_HIT' };
  if (progress.tp2_hit) return { status: 'COMPLETE', should_track: false, reason: 'TP2_HIT' };
  if (progress.tp1_hit && !prior.tp1_notified) return { status: 'TRACKING_TP1', should_track: true, reason: 'TP1_HIT' };
  if (prior.tp1_notified) return { status: 'TRACKING_AFTER_TP1', should_track: true, reason: 'tp1_already_notified', routine_update_due: false };
  const isSwing = /swing/i.test(String((row || {}).category || (row || {}).mode || ''));
  const routineAt = prior.last_routine_update_at ? new Date(prior.last_routine_update_at) : null;
  const today = now.toISOString().slice(0, 10);
  const routineDue = isSwing && !!(options && options.afterMarketClose) && (!routineAt || routineAt.toISOString().slice(0, 10) !== today);
  return { status: 'TRACKING', should_track: true, reason: events.length ? 'event_detected' : 'routine_check', routine_update_due: routineDue };
}

function buildTop5ProgressDiagnostics(rows, context) {
  const results = (Array.isArray(rows) ? rows : []).map((row) => detectTop5ProgressEvents(row, null, context));
  const counts = results.reduce((out, result) => { result.events.forEach((event) => { out[event.type] = (out[event.type] || 0) + 1; }); return out; }, {});
  return {
    rows_checked: results.length,
    event_counts: counts,
    notification_mode: context && context.hasDurableIdempotency ? 'idempotent_ready' : 'dry_run_only',
    notification_reason: context && context.hasDurableIdempotency ? null : 'real Telegram disabled because no durable idempotency store exists without SQL migration.',
    results
  };
}

module.exports = { computeTop5Progress, detectTop5ProgressEvents, buildTop5ProgressDiagnostics, deriveTrackingStatus, eventKey, isTelegramSendableEvent, isTerminalTrackingStatus, resolveLatestPrice, resolveEntry, DEFAULT_MAX_PRICE_AGE_HOURS };

'use strict';

/** Isolated evaluator for the experimental, admin-only Second Chance pilot. */
const fsp = require('node:fs/promises');
const path = require('node:path');

const RULE_VERSION = 'BALANCED_CONFIRM_2_ANTI_CHASE_V1';
const TIMEZONE = 'Asia/Jakarta';
const QUALITY = 'CORPORATE_ACTION_RISK';
const DEFAULT_MODE = 'shadow';
const DEFAULT_STATE_DIR = path.join(process.cwd(), 'data', 'second-chance-admin-pilot-state');
const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

function enabled(value) { return ['1', 'true'].includes(String(value == null ? '' : value).trim().toLowerCase()); }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validTime(value) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')); }
function minutes(value) { const p = String(value).split(':').map(Number); return p[0] * 60 + p[1]; }
function jakartaDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now || new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function ticker(value) { return String(value || '').trim().toUpperCase().replace(/\.JK$/, ''); }
function stop(obs) { return number(obs.stop_loss !== undefined ? obs.stop_loss : obs.sl); }

function qualifyObservation(obs, first, previous) {
  const reasons = [];
  const fields = ['score', 'relative_volume', 'volume', 'current_price', 'entry_low', 'entry_high', 'tp1', 'tp2'];
  const n = Object.fromEntries(fields.map(k => [k, number(obs[k])]));
  const firstScore = number(first && first.score);
  const sl = stop(obs);
  if (obs.data_quality_status !== QUALITY) reasons.push('data_quality_status');
  for (const field of fields) if (n[field] === null) reasons.push(`invalid_${field}`);
  if (firstScore === null) reasons.push('invalid_first_score');
  if (!previous) reasons.push('missing_previous_observation');
  const previousVolume = number(previous && previous.volume);
  const previousPrice = number(previous && previous.current_price);
  if (previous && previousVolume === null) reasons.push('invalid_previous_volume');
  if (previous && previousPrice === null) reasons.push('invalid_previous_price');
  if (!validTime(obs.scheduled_time) || (validTime(obs.scheduled_time) && minutes(obs.scheduled_time) > minutes('13:45'))) reasons.push('after_cutoff');
  if (n.score !== null && n.score < 23) reasons.push('score_below_23');
  if (n.score !== null && firstScore !== null && n.score - firstScore < 10) reasons.push('score_improvement_below_10');
  if (n.relative_volume !== null && n.relative_volume < 1.5) reasons.push('relative_volume_below_1_50');
  if (n.volume !== null && previousVolume !== null && n.volume <= previousVolume) reasons.push('volume_not_growing');
  if (n.current_price !== null && previousPrice !== null && n.current_price < previousPrice) reasons.push('price_falling');
  if (n.current_price !== null && n.entry_low !== null && n.current_price < n.entry_low) reasons.push('below_entry_zone');
  if (n.current_price !== null && n.entry_high !== null && n.current_price > n.entry_high) reasons.push('above_entry_zone');
  if (obs.freshness && obs.freshness.is_stale === true) reasons.push('stale');
  if (sl === null) reasons.push('invalid_stop_loss');
  if (sl !== null && n.current_price !== null && sl >= n.current_price) reasons.push('stop_not_below_price');
  if (n.tp1 !== null && n.current_price !== null && n.tp1 <= n.current_price) reasons.push('tp1_not_above_price');
  if (n.tp2 !== null && n.tp1 !== null && n.tp2 <= n.tp1) reasons.push('tp2_not_above_tp1');
  const risk = n.current_price !== null && sl !== null ? n.current_price - sl : null;
  const reward = n.tp1 !== null && n.current_price !== null ? n.tp1 - n.current_price : null;
  const rr = risk !== null && risk > 0 && reward !== null ? reward / risk : null;
  if (risk === null || risk <= 0 || rr === null || rr < 1) reasons.push('rr_to_tp1_below_1');
  return { qualifies: reasons.length === 0, reasons: [...new Set(reasons)].sort(), metrics: { score_improvement: n.score !== null && firstScore !== null ? n.score - firstScore : null, risk, reward, rr_to_tp1: rr } };
}

function antiChase(observations, index) {
  const firstPrice = number(observations[0] && observations[0].current_price);
  const firstTp1 = number(observations[0] && observations[0].tp1);
  const currentPrice = number(observations[index] && observations[index].current_price);
  const reasons = [];
  let advance = null;
  if (firstPrice === null || firstPrice <= 0) reasons.push('invalid_first_observation_price');
  else if (currentPrice === null) reasons.push('invalid_current_price');
  else { advance = ((currentPrice - firstPrice) / firstPrice) * 100; if (advance > 6) reasons.push('advance_above_6_pct'); }
  if (firstTp1 === null) reasons.push('invalid_first_observation_tp1');
  else if (observations.slice(0, index + 1).some(o => { const p = number(o.current_price); return p !== null && p >= firstTp1; })) reasons.push('first_plan_tp1_already_reached');
  return { passes: reasons.length === 0, reasons, advance_pct: advance };
}

function evaluateObservations(records, throughTime) {
  const rejected = {};
  const add = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  const malformed = [];
  const prepared = [];
  for (const rec of records || []) {
    if (!rec || typeof rec !== 'object' || !ticker(rec.ticker) || !validTime(rec.scheduled_time)) { malformed.push(rec); add('malformed_observation'); continue; }
    if (throughTime && minutes(rec.scheduled_time) > minutes(throughTime)) continue;
    prepared.push({ ...rec, ticker: ticker(rec.ticker) });
  }
  prepared.sort((a, b) => a.ticker.localeCompare(b.ticker) || minutes(a.scheduled_time) - minutes(b.scheduled_time) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const unique = [], seen = new Set();
  for (const rec of prepared) { const key = `${rec.ticker}|${rec.scheduled_time}`; if (seen.has(key)) { add('duplicate_observation'); continue; } seen.add(key); unique.push(rec); }
  const groups = new Map();
  for (const rec of unique) { if (!groups.has(rec.ticker)) groups.set(rec.ticker, []); groups.get(rec.ticker).push(rec); }
  const opportunities = [], tickerDetails = {};
  for (const [symbol, observations] of groups) {
    const checks = observations.map((obs, i) => qualifyObservation(obs, observations[0], observations[i - 1]));
    let opportunity = null;
    for (let i = 1; i < observations.length; i++) {
      if (!(checks[i - 1].qualifies && checks[i].qualifies)) continue;
      const anti = antiChase(observations, i);
      if (!anti.passes) { anti.reasons.forEach(add); continue; }
      const obs = observations[i];
      opportunity = { ticker: symbol, scheduled_time: obs.scheduled_time, current_price: number(obs.current_price), score: number(obs.score), relative_volume: number(obs.relative_volume), volume: number(obs.volume), entry_low: number(obs.entry_low), entry_high: number(obs.entry_high), tp1: number(obs.tp1), tp2: number(obs.tp2), stop_loss: stop(obs), score_improvement: checks[i].metrics.score_improvement, rr_to_tp1: checks[i].metrics.rr_to_tp1, advance_pct: anti.advance_pct, reason: 'first_two_consecutive_complete_confirmations_passed_anti_chase' }; break;
    }
    checks.forEach(c => c.reasons.forEach(add));
    const qualifyingCount = checks.filter(c => c.qualifies).length;
    tickerDetails[symbol] = { observation_count: observations.length, independently_qualifying_count: qualifyingCount, reason: opportunity ? 'confirmed' : (qualifyingCount === 1 ? 'only_one_consecutive_qualifying_snapshot' : 'no_two_consecutive_qualifying_snapshots'), opportunity };
    if (opportunity) opportunities.push(opportunity);
  }
  opportunities.sort((a, b) => minutes(a.scheduled_time) - minutes(b.scheduled_time) || b.score - a.score || b.relative_volume - a.relative_volume || a.ticker.localeCompare(b.ticker));
  const selected = opportunities[0] || null;
  return { selected, opportunities, observation_count: unique.length, ticker_count: groups.size, rejection_summary: Object.fromEntries(Object.entries(rejected).sort()), ticker_details: tickerDetails, malformed_count: malformed.length };
}

async function readCandidates(file) {
  const raw = await fsp.readFile(file, 'utf8');
  const records = [], errors = [];
  raw.split(/\r?\n/).forEach((line, index) => { if (!line.trim()) return; try { records.push(JSON.parse(line)); } catch (_) { errors.push({ line: index + 1, reason: 'invalid_json' }); } });
  return { raw, records, errors };
}
function identity(date, selected) { return selected ? `${date}|${selected.ticker}|${selected.scheduled_time}|${RULE_VERSION}` : null; }
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
async function inspectLock(file, nowMs, staleMs) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    const createdMs = Date.parse(parsed.created_at);
    return { stale: Number.isFinite(createdMs) && nowMs - createdMs >= staleMs, alive: isPidAlive(parsed.pid), parsed };
  } catch (_) { return { stale: false, alive: true, parsed: null }; }
}
async function acquireLock(file, options) {
  options = options || {};
  const nowMs = options.nowMs == null ? Date.now() : options.nowMs;
  const staleMs = options.staleMs == null ? DEFAULT_LOCK_STALE_MS : options.staleMs;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await fsp.open(file, 'wx');
      await h.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date(nowMs).toISOString() }) + '\n');
      return async function release() { await h.close().catch(() => {}); await fsp.unlink(file).catch(() => {}); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const lock = await inspectLock(file, nowMs, staleMs);
      if (!lock.stale || lock.alive) return null;
      const quarantine = `${file}.stale.${process.pid}.${Math.random().toString(16).slice(2)}`;
      try { await fsp.rename(file, quarantine); await fsp.unlink(quarantine).catch(() => {}); }
      catch (renameError) { if (renameError.code !== 'ENOENT') return null; }
    }
  }
  return null;
}
async function readState(file) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function writeState(file, state) { await fsp.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await fsp.rename(tmp, file); }
function approvedAdmin(env) {
  const id = String((env || {}).TELEGRAM_VERIFY_ADMIN_CHAT_ID || '').trim();
  if (!/^-?\d{5,20}$/.test(id)) return null;
  if (id === String((env || {}).TELEGRAM_CHAT_ID || '').trim() || id === String((env || {}).TELEGRAM_VERIFY_CHANNEL_ID || '').trim()) return null;
  return id;
}
function telegramConfigured(env) { return (env || {}).TELEGRAM_ENABLED === '1' && Boolean(String((env || {}).TELEGRAM_BOT_TOKEN || '').trim()); }
const DEFINITE_NO_SEND_REASONS = new Set(['telegram_disabled', 'missing_token', 'missing_chat_id', 'empty_message']);
function classifyTelegramResult(result) {
  if (result && result.sent === true) return 'sent';
  if (!result || result.sent !== false) return 'uncertain';
  if (typeof result.chunks_sent === 'number' && Number.isFinite(result.chunks_sent) && result.chunks_sent > 0) return 'uncertain';
  if (DEFINITE_NO_SEND_REASONS.has(result.reason)) return 'retryable';
  if (result.reason === 'api_error' && result.chunks_sent === 0) return 'retryable';
  return 'uncertain';
}
function message(date, s) { return [
  'EKSPERIMENTAL ADMIN ONLY — SECOND CHANCE', '', `Ticker: ${s.ticker}`, `Qualification: ${date} ${s.scheduled_time} WIB`, `Current price: ${s.current_price}`, `Entry zone: ${s.entry_low}–${s.entry_high}`, `TP1: ${s.tp1}`, `TP2: ${s.tp2}`, `Stop loss: ${s.stop_loss}`, `Score: ${s.score}`, `Score improvement: ${s.score_improvement}`, `Relative volume: ${s.relative_volume}`, `Risk-reward to TP1: ${s.rr_to_tp1}`, `Rule: ${RULE_VERSION}`, `Reason: ${s.reason}`, '', 'The ticker initially failed the normal production data-quality gate, but later passed two consecutive intraday confirmations while remaining inside the entry zone and passing the anti-chase checks.', '', 'Manual validation required. Not a public signal. Not an automatic order. Experimental admin-only pilot.'
].join('\n'); }

function baseResult(opts, evaluation, source) { const env = opts.env || process.env; const mode = opts.mode || env.SECOND_CHANCE_ADMIN_PILOT_MODE || DEFAULT_MODE; const today = jakartaDate(opts.now); return { status: evaluation.selected ? 'selected_dry_run' : 'no_qualifying_alert', rule_version: RULE_VERSION, sample_date: opts.sampleDate, timezone: TIMEZONE, evaluated_through_time: opts.throughTime || null, operating_mode: mode, feature_enabled: enabled(env.SECOND_CHANCE_ADMIN_PILOT_ENABLED), historical_date: opts.sampleDate !== today, source_file: source, source_file_mutated: false, observation_count: evaluation.observation_count, ticker_count: evaluation.ticker_count, qualifying_opportunity_count: evaluation.opportunities.length, selected: Boolean(evaluation.selected), selected_ticker: evaluation.selected && evaluation.selected.ticker, selected_scheduled_time: evaluation.selected && evaluation.selected.scheduled_time, selection_details: evaluation.selected, rejection_summary: evaluation.rejection_summary, ticker_details: evaluation.ticker_details, already_recorded: false, telegram_attempted: false, telegram_sent: false, telegram_block_reason: null, state_identity: identity(opts.sampleDate, evaluation.selected), error_code: null }; }

async function runPilot(opts) {
  opts = opts || {}; const env = opts.env || process.env; const source = opts.sourceFile;
  if (!validDate(opts.sampleDate) || (opts.throughTime && !validTime(opts.throughTime))) return { status: 'invalid_input', rule_version: RULE_VERSION, error_code: 'invalid_input', telegram_attempted: false, telegram_sent: false, source_file_mutated: false };
  let input; try { input = await readCandidates(source); } catch (e) { return { status: e.code === 'ENOENT' ? 'source_missing' : 'source_invalid', rule_version: RULE_VERSION, sample_date: opts.sampleDate, source_file: source, source_file_mutated: false, error_code: e.code === 'ENOENT' ? 'source_missing' : 'source_invalid', telegram_attempted: false, telegram_sent: false }; }
  const evaluation = evaluateObservations(input.records, opts.throughTime); if (input.errors.length) evaluation.rejection_summary.malformed_json_line = input.errors.length;
  const result = baseResult(opts, evaluation, source); const mode = result.operating_mode;
  if (!['shadow', 'send'].includes(mode)) { result.status = 'blocked_invalid_mode'; result.error_code = 'invalid_mode'; result.telegram_block_reason = 'invalid_mode'; return result; }
  if (opts.dryRun) return result;
  if (mode === 'send') {
    if (!result.feature_enabled) { result.status = 'blocked_feature_disabled'; result.telegram_block_reason = 'feature_disabled'; return result; }
    if (result.historical_date) { result.status = 'blocked_historical_send'; result.telegram_block_reason = 'historical_date'; return result; }
    if (!approvedAdmin(env)) { result.status = 'blocked_missing_admin'; result.telegram_block_reason = 'missing_or_ambiguous_admin'; return result; }
    if (!telegramConfigured(env)) { result.status = 'failed'; result.error_code = 'telegram_not_configured'; result.telegram_block_reason = 'telegram_not_configured'; return result; }
  }
  const dir = opts.stateDir || DEFAULT_STATE_DIR, stateFile = path.join(dir, `${opts.sampleDate}.json`), lockFile = path.join(dir, `${opts.sampleDate}.lock`);
  const release = await acquireLock(lockFile, { nowMs: opts.lockNowMs, staleMs: opts.lockStaleMs }); if (!release) { result.status = 'lock_busy'; result.error_code = 'lock_busy'; return result; }
  try {
    const existing = await readState(stateFile);
    let selectedForDelivery = evaluation.selected;
    if (existing) {
      result.already_recorded = true; result.state_identity = existing.identity;
      if (existing.status === 'send_failed_retryable') {
        if (mode !== 'send') {
          result.status = 'blocked_retry_requires_send'; result.telegram_block_reason = 'retryable_send_state_requires_send_mode'; return result;
        }
        if (existing.identity !== identity(opts.sampleDate, evaluation.selected)) {
          result.status = 'blocked_retry_identity_mismatch'; result.telegram_block_reason = 'retry_identity_mismatch'; return result;
        }
        if (!existing.selected || identity(opts.sampleDate, existing.selected) !== existing.identity) {
          result.status = 'blocked_delivery_uncertain'; result.telegram_block_reason = 'retry_state_invalid'; return result;
        }
        // Retry the exact durably persisted alert, never mutable re-evaluated fields.
        selectedForDelivery = existing.selected;
        result.selection_details = selectedForDelivery;
      } else {
        result.status = existing.status === 'sent' ? 'already_sent' : (['send_in_progress', 'delivery_uncertain'].includes(existing.status) ? 'blocked_delivery_uncertain' : 'already_recorded');
        result.telegram_block_reason = existing.identity !== identity(opts.sampleDate, evaluation.selected) ? 'date_already_selected_different_alert' : (['send_in_progress', 'delivery_uncertain'].includes(existing.status) ? 'previous_delivery_uncertain' : null);
        return result;
      }
    }
    if (!evaluation.selected) return result;
    const persist = opts.writeState || writeState;
    if (mode === 'shadow') { await persist(stateFile, { schema_version: 1, date: opts.sampleDate, identity: identity(opts.sampleDate, selectedForDelivery), rule_version: RULE_VERSION, status: 'shadow_recorded', selected: selectedForDelivery }); result.status = 'selected_shadow_recorded'; return result; }
    const attempt = { schema_version: 1, date: opts.sampleDate, identity: identity(opts.sampleDate, selectedForDelivery), rule_version: RULE_VERSION, status: 'send_in_progress', selected: selectedForDelivery };
    await persist(stateFile, attempt);
    result.telegram_attempted = true;
    const adapter = opts.sendTelegram || (async (text, options) => require('./telegram-notifier').sendTelegramMessage(text, options));
    let sent;
    try { sent = await adapter(message(opts.sampleDate, selectedForDelivery), { chat_id: approvedAdmin(env), disable_web_page_preview: true }); }
    catch (_) {
      await writeState(stateFile, { ...attempt, status: 'delivery_uncertain' }).catch(() => {});
      result.status = 'blocked_delivery_uncertain'; result.error_code = 'telegram_result_uncertain'; result.telegram_block_reason = 'telegram_result_uncertain'; return result;
    }
    const deliveryClass = classifyTelegramResult(sent);
    if (deliveryClass === 'retryable') {
      await persist(stateFile, { ...attempt, status: 'send_failed_retryable' });
      result.status = 'failed'; result.error_code = 'telegram_send_failed_retryable'; result.telegram_block_reason = 'telegram_send_failed_retryable'; return result;
    }
    if (deliveryClass === 'uncertain') {
      await writeState(stateFile, { ...attempt, status: 'delivery_uncertain' }).catch(() => {});
      result.status = 'blocked_delivery_uncertain'; result.error_code = 'telegram_result_uncertain'; result.telegram_block_reason = 'telegram_result_uncertain'; return result;
    }
    try { await persist(stateFile, { ...attempt, status: 'sent' }); }
    catch (_) { result.status = 'blocked_delivery_uncertain'; result.error_code = 'sent_state_persistence_failed'; result.telegram_block_reason = 'sent_state_persistence_failed'; return result; }
    result.status = 'sent'; result.telegram_sent = true; return result;
  } finally { await release(); }
}

module.exports = { RULE_VERSION, TIMEZONE, DEFAULT_MODE, DEFAULT_STATE_DIR, DEFAULT_LOCK_STALE_MS, enabled, number, validDate, jakartaDate, qualifyObservation, antiChase, evaluateObservations, readCandidates, approvedAdmin, classifyTelegramResult, message, acquireLock, readState, writeState, runPilot };

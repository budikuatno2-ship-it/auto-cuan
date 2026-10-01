'use strict';

/**
 * Day Trade EXPERIMENTAL admin-only alert gate (research / evaluation ONLY)
 * =========================================================================
 *
 * Purpose
 *   Based on the COMPLETED intraday shadow evaluation (lib/intraday-shadow-
 *   scoring-live.js), send a strict, ADMIN-ONLY experimental Day Trade alert for
 *   the single strongest confirmed candidate of the day. This is a shadow
 *   diagnostic. It is NOT a buy instruction and makes NO profitability claim.
 *
 *   This module deliberately does NOT:
 *     - modify the base Day Trade scoring formula (it only READS shadow output);
 *     - touch Swing Konglo / Swing Non-Konglo / nightly Top5 / Top5 progress
 *       monitor / portfolios / Supabase schema;
 *     - deliver anything to public users or verification-channel users.
 *
 * Hard invariants (assertExperimentalSafety):
 *   - DAYTRADE_INTRADAY_SCORE_ENABLED must stay OFF (production scoring OFF).
 *   - DAYTRADE_WORKER_ALLOW_MUTATION must NOT be true (no production mutation).
 *
 * Explicit opt-in (isExperimentalAdminAlertEnabled):
 *   - DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED must be explicitly '1'/'true'.
 *     No alert may ever be sent unless this flag is explicitly true.
 *
 * Delivery:
 *   - Reuses the EXISTING safe Telegram sender (lib/telegram-notifier.js) and
 *     the EXISTING admin destination (TELEGRAM_VERIFY_ADMIN_CHAT_ID) via an
 *     explicit chat_id override. It NEVER falls back to the public chat
 *     (TELEGRAM_CHAT_ID) and NEVER uses the verification-channel id. No new bot
 *     token is introduced.
 *
 * Idempotency:
 *   - A durable append-only JSONL state file keyed by (date, ticker) guarantees
 *     that reruns can never send the same ticker/date alert twice.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const FEATURE_FLAG = 'DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED';

// Minimum shadow score required for an experimental alert.
const SCORE_THRESHOLD = 16;

// Only these confirmation reasons are accepted (provisional / single-snapshot
// candidates are rejected).
const ALLOWED_CONFIRMATION_REASONS = Object.freeze([
  'TWO_CONSECUTIVE_SNAPSHOTS',
  'TWO_OF_LAST_THREE_SNAPSHOTS',
  'STICKY_PREVIOUSLY_CONFIRMED'
]);
const ALLOWED_CONFIRMATION_REASON_SET = new Set(ALLOWED_CONFIRMATION_REASONS);

const CONFIRMED_STATE = 'CONFIRMED';
const REQUIRED_CONFIRMED_RANK = 1;

// Message label — clearly experimental and admin-only.
const ALERT_LABEL = 'EXPERIMENTAL DAY TRADE \u2014 ADMIN ONLY';

// Explicit, non-buy-instruction / non-profitability disclaimer.
const SHADOW_NOTE =
  'Note: This is a SHADOW EVALUATION only, not a buy instruction. ' +
  'No profitability is claimed or implied.';

// Gate reason codes.
const GATE = Object.freeze({
  PASS: 'PASS',
  REJECT_NOT_CONFIRMED: 'REJECT_NOT_CONFIRMED',
  REJECT_RANK_NOT_1: 'REJECT_RANK_NOT_1',
  REJECT_SCORE_BELOW_THRESHOLD: 'REJECT_SCORE_BELOW_THRESHOLD',
  REJECT_INVALID_CONFIRMATION_REASON: 'REJECT_INVALID_CONFIRMATION_REASON',
  REJECT_STALE_OR_PREVIOUS_DAY: 'REJECT_STALE_OR_PREVIOUS_DAY',
  REJECT_MISSING_NEXT_SNAPSHOT_PRICE: 'REJECT_MISSING_NEXT_SNAPSHOT_PRICE',
  REJECT_DUPLICATE_SAME_DAY: 'REJECT_DUPLICATE_SAME_DAY'
});

const DEFAULT_STATE_FILE = path.join(
  process.cwd(), 'data', 'experimental-daytrade-alerts', 'alerts.jsonl'
);

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
function boolEnv(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v === '1' || v === 'true';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/, '').replace(/[^A-Z0-9_-]/g, '');
}

/**
 * Mask a chat id for safe logging (never emit the full destination).
 */
function maskChatId(chatId) {
  const s = String(chatId == null ? '' : chatId);
  if (!s) return null;
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '****' + s.slice(-2);
}

// -----------------------------------------------------------------------------
// Feature flag + safety
// -----------------------------------------------------------------------------
/**
 * The experimental admin alert is OFF unless the dedicated flag is explicitly
 * '1' or 'true'. Everything else (unset, '', '0', 'false', 'yes', ...) is OFF.
 */
function isExperimentalAdminAlertEnabled(env) {
  env = env || process.env;
  return boolEnv(env[FEATURE_FLAG]);
}

/**
 * Hard safety invariants that must hold even when the experimental flag is on:
 * production intraday scoring and worker mutation must both remain disabled.
 * Returns { safe, errors } (never throws).
 */
function assertExperimentalSafety(env) {
  env = env || process.env;
  const errors = [];
  if (String(env.DAYTRADE_INTRADAY_SCORE_ENABLED || '').trim().toLowerCase() === '1' ||
      String(env.DAYTRADE_INTRADAY_SCORE_ENABLED || '').trim().toLowerCase() === 'true') {
    errors.push('DAYTRADE_INTRADAY_SCORE_ENABLED must stay off (production scoring must remain disabled)');
  }
  if (String(env.DAYTRADE_WORKER_ALLOW_MUTATION || '').trim().toLowerCase() === 'true') {
    errors.push('DAYTRADE_WORKER_ALLOW_MUTATION must not be true (no production mutation)');
  }
  return { safe: errors.length === 0, errors };
}

// -----------------------------------------------------------------------------
// Admin destination resolution (ADMIN ONLY — never the public chat)
// -----------------------------------------------------------------------------
/**
 * Resolve the configured admin chat id. Reuses the EXISTING admin destination
 * env var (TELEGRAM_VERIFY_ADMIN_CHAT_ID). It intentionally never reads
 * TELEGRAM_CHAT_ID (the public delivery chat) or TELEGRAM_VERIFY_CHANNEL_ID
 * (the verification channel), so a public/channel destination is impossible.
 * An explicit opts.adminChatId (tests / callers) takes precedence.
 */
function resolveAdminChatId(env, opts) {
  opts = opts || {};
  if (opts.adminChatId != null && String(opts.adminChatId).trim() !== '') {
    return String(opts.adminChatId).trim();
  }
  env = env || process.env;
  const v = env.TELEGRAM_VERIFY_ADMIN_CHAT_ID;
  return (typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
}

// -----------------------------------------------------------------------------
// The gate (pure)
// -----------------------------------------------------------------------------
/**
 * Decide whether a single candidate is eligible for an experimental admin alert.
 *
 * A candidate is eligible ONLY when ALL are true:
 *   - confirmation_state === 'CONFIRMED';
 *   - confirmed_rank === 1;
 *   - shadow_score >= SCORE_THRESHOLD (16);
 *   - confirmation_reason is one of ALLOWED_CONFIRMATION_REASONS;
 *   - candidate data is current-day (candidate.date === ctx.tradingDay) AND
 *     fresh (candidate.stale !== true);
 *   - an executable entry_reference_price exists at the next valid snapshot
 *     (entry_snapshot_time present AND entry_reference_price is finite);
 *   - the (date, ticker) has NOT already generated an experimental alert
 *     (not in ctx.alertedKeys).
 *
 * @param {object} candidate
 * @param {object} ctx  { tradingDay, alertedKeys?:Set }
 * @returns {{ eligible:boolean, reason:string }}
 */
function evaluateCandidateGate(candidate, ctx) {
  ctx = ctx || {};
  const c = candidate || {};

  // 1. Must be CONFIRMED (rejects provisional / one-snapshot candidates).
  if (c.confirmation_state !== CONFIRMED_STATE || c.confirmed !== true) {
    return { eligible: false, reason: GATE.REJECT_NOT_CONFIRMED };
  }

  // 2. Must be confirmed rank 1 (rejects rank 2-5).
  if (Number(c.confirmed_rank) !== REQUIRED_CONFIRMED_RANK) {
    return { eligible: false, reason: GATE.REJECT_RANK_NOT_1 };
  }

  // 3. Must meet the score threshold (rejects score below 16).
  const score = finiteNumber(c.shadow_score);
  if (score === null || score < SCORE_THRESHOLD) {
    return { eligible: false, reason: GATE.REJECT_SCORE_BELOW_THRESHOLD };
  }

  // 4. Confirmation reason must be an accepted, genuine confirmation.
  if (!ALLOWED_CONFIRMATION_REASON_SET.has(c.confirmation_reason)) {
    return { eligible: false, reason: GATE.REJECT_INVALID_CONFIRMATION_REASON };
  }

  // 5. Current-day + fresh (rejects stale or previous-day data).
  const currentDay = c.date != null && ctx.tradingDay != null && String(c.date) === String(ctx.tradingDay);
  if (!currentDay || c.stale === true) {
    return { eligible: false, reason: GATE.REJECT_STALE_OR_PREVIOUS_DAY };
  }

  // 6. Executable price must exist in the next valid snapshot.
  const entryPrice = finiteNumber(c.entry_reference_price);
  const hasEntrySnapshot = c.entry_snapshot_time != null && String(c.entry_snapshot_time).trim() !== '';
  if (!hasEntrySnapshot || entryPrice === null || entryPrice <= 0) {
    return { eligible: false, reason: GATE.REJECT_MISSING_NEXT_SNAPSHOT_PRICE };
  }

  // 7. No duplicate alert for the same ticker on the same day.
  const alertedKeys = ctx.alertedKeys instanceof Set ? ctx.alertedKeys : new Set();
  if (alertedKeys.has(dedupKey(c.date, c.ticker))) {
    return { eligible: false, reason: GATE.REJECT_DUPLICATE_SAME_DAY };
  }

  return { eligible: true, reason: GATE.PASS };
}

// -----------------------------------------------------------------------------
// Candidate extraction from a completed live shadow evaluation
// -----------------------------------------------------------------------------
/**
 * Build the set of alert candidates from a live shadow evaluation object (the
 * shape returned by lib/intraday-shadow-scoring-live.evaluateLiveThroughTime /
 * runLiveShadowSnapshot(...).evaluation).
 *
 * For each ticker, the SIGNAL is the FIRST snapshot at which it is the confirmed
 * rank-1 candidate. The entry reference is the executable price at the NEXT
 * valid snapshot (models "you can only act on the next snapshot, not the signal
 * snapshot"). Only one candidate per ticker is produced, matching the once-per-
 * day dedup rule.
 *
 * @param {object} evaluation
 * @param {object} [opts] { tradingDay }
 * @returns {Array<object>} candidate objects for evaluateCandidateGate
 */
function buildAlertCandidatesFromEvaluation(evaluation, opts) {
  opts = opts || {};
  if (!evaluation || typeof evaluation !== 'object') return [];

  const date = evaluation.date;
  const snapshots = (evaluation.summary && Array.isArray(evaluation.summary.evaluated_snapshot_times))
    ? evaluation.summary.evaluated_snapshot_times.slice()
    : [];
  const snapshotIndex = new Map();
  snapshots.forEach((t, i) => snapshotIndex.set(t, i));

  // Price + data-quality lookup: ticker -> snapshot -> { price, dataQuality }.
  const byTicker = new Map();
  for (const s of (Array.isArray(evaluation.scores) ? evaluation.scores : [])) {
    const ticker = safeTicker(s.ticker);
    if (!ticker) continue;
    if (!byTicker.has(ticker)) byTicker.set(ticker, new Map());
    byTicker.get(ticker).set(s.snapshot, {
      price: finiteNumber(s.current_price),
      dataQuality: s.data_quality_status || null
    });
  }

  // Confirmed rank-1 per snapshot from confirmed_top5.
  const seen = new Set();
  const candidates = [];
  for (const snap of (Array.isArray(evaluation.confirmed_top5) ? evaluation.confirmed_top5 : [])) {
    const rankOne = (snap.confirmed_top5 || []).find((t) => Number(t.confirmed_rank) === REQUIRED_CONFIRMED_RANK);
    if (!rankOne) continue;
    const ticker = safeTicker(rankOne.ticker);
    if (!ticker || seen.has(ticker)) continue; // first confirmed rank-1 appearance only
    seen.add(ticker);

    const signalSnapshot = snap.snapshot;
    const idx = snapshotIndex.get(signalSnapshot);
    const nextSnapshot = (idx != null && idx + 1 < snapshots.length) ? snapshots[idx + 1] : null;

    let entryPrice = null;
    if (nextSnapshot != null) {
      const tickerPrices = byTicker.get(ticker);
      const entry = tickerPrices ? tickerPrices.get(nextSnapshot) : null;
      entryPrice = entry ? entry.price : null;
    }

    // Data-quality / freshness at the signal snapshot.
    const tickerPrices = byTicker.get(ticker);
    const atSignal = tickerPrices ? tickerPrices.get(signalSnapshot) : null;
    const dataQuality = atSignal ? atSignal.dataQuality : null;
    const stale = typeof dataQuality === 'string' && dataQuality.toUpperCase().indexOf('STALE') !== -1;

    candidates.push({
      ticker,
      date,
      snapshot: signalSnapshot,
      confirmation_state: CONFIRMED_STATE,
      confirmed: true,
      confirmed_rank: Number(rankOne.confirmed_rank),
      confirmation_reason: rankOne.confirmation_reason,
      shadow_score: finiteNumber(rankOne.shadow_score),
      entry_snapshot_time: nextSnapshot,
      entry_reference_price: entryPrice,
      data_quality_status: dataQuality,
      stale
    });
  }

  return candidates;
}

// -----------------------------------------------------------------------------
// Message formatting
// -----------------------------------------------------------------------------
/**
 * Build the clearly-labeled, admin-only experimental alert message. Includes the
 * ticker, signal time, confirmation reason, score, entry snapshot time, entry
 * reference price, and the explicit shadow-evaluation / no-profitability note.
 */
function formatAdminAlertMessage(candidate) {
  const c = candidate || {};
  const signalTime = c.date ? (c.date + ' ' + (c.snapshot || '')) : (c.snapshot || '');
  const lines = [
    ALERT_LABEL,
    '',
    'Ticker: ' + safeTicker(c.ticker),
    'Signal time: ' + String(signalTime).trim(),
    'Confirmation: ' + String(c.confirmation_reason || ''),
    'Shadow score: ' + String(c.shadow_score),
    'Entry snapshot: ' + String(c.entry_snapshot_time || ''),
    'Entry reference price: ' + String(c.entry_reference_price),
    '',
    SHADOW_NOTE
  ];
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Idempotency state (durable, append-only JSONL keyed by date + ticker)
// -----------------------------------------------------------------------------
function dedupKey(date, ticker) {
  return String(date || '') + '|' + safeTicker(ticker);
}

/**
 * Read the set of already-alerted (date|ticker) keys from the state file.
 * A missing file yields an empty set; malformed lines are skipped safely.
 */
async function readAlertedKeys(stateFile) {
  const keys = new Set();
  let content;
  try {
    content = await fsp.readFile(stateFile, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return keys;
    throw e;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.date && rec.ticker) keys.add(dedupKey(rec.date, rec.ticker));
    } catch (e) { /* skip malformed line */ }
  }
  return keys;
}

/**
 * Append one alert record to the durable state file (creating dirs as needed).
 */
async function recordAlert(stateFile, entry) {
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  await fsp.appendFile(stateFile, JSON.stringify(entry) + '\n');
}

// -----------------------------------------------------------------------------
// Default safe sender (reuses the EXISTING notifier + admin destination only)
// -----------------------------------------------------------------------------
/**
 * Send a message to the ADMIN chat via the existing safe Telegram sender. The
 * chat_id is ALWAYS the explicit admin destination — this never uses the public
 * default chat. Never throws (the underlying sender never throws).
 */
async function defaultAdminSender(text, adminChatId /*, env */) {
  const notifier = require('./telegram-notifier');
  return notifier.sendTelegramMessage(text, { chat_id: adminChatId });
}

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------
/**
 * Evaluate candidates and (only when everything is satisfied) deliver an
 * ADMIN-ONLY experimental alert per eligible candidate.
 *
 * @param {object} opts
 *   env           optional — env object (defaults to process.env)
 *   tradingDay    required — the current trading day (YYYY-MM-DD)
 *   evaluation    optional — a live shadow evaluation (candidates derived from it)
 *   candidates    optional — explicit candidate array (overrides evaluation)
 *   stateFile     optional — idempotency state file path
 *   adminChatId   optional — explicit admin destination override (tests)
 *   sender        optional — async (text, adminChatId, env) => sendResult
 *   dryRun        optional — evaluate + report only; never send, never record
 *   now           optional — () => Date, for deterministic timestamps in tests
 * @returns result object (never throws)
 */
async function runExperimentalAdminAlert(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  const dryRun = opts.dryRun === true;

  // Resolve candidate source up front (needed for a meaningful dry-run preview).
  const tradingDay = opts.tradingDay;
  let candidates = Array.isArray(opts.candidates)
    ? opts.candidates.slice()
    : (opts.evaluation ? buildAlertCandidatesFromEvaluation(opts.evaluation, { tradingDay }) : []);

  // Hard safety: production scoring / mutation must remain off (even in dry-run).
  const safety = assertExperimentalSafety(env);
  if (!safety.safe) {
    return { status: 'safety_violation', enabled: isExperimentalAdminAlertEnabled(env), errors: safety.errors, sent: 0, evaluated: candidates.length, alerts: [] };
  }

  // Feature flag: no alert may be sent unless explicitly enabled. A dry-run may
  // still preview gate decisions without sending.
  const enabled = isExperimentalAdminAlertEnabled(env);
  if (!enabled && !dryRun) {
    return { status: 'disabled', enabled: false, flag: FEATURE_FLAG, sent: 0, evaluated: candidates.length, alerts: [] };
  }

  if (tradingDay == null || String(tradingDay).trim() === '') {
    return { status: 'error', enabled, errors: ['missing tradingDay'], sent: 0, evaluated: candidates.length, alerts: [] };
  }

  // Admin destination is required. Without it we NEVER fall back to a public or
  // channel destination — we simply send nothing.
  const adminChatId = resolveAdminChatId(env, opts);
  if (!adminChatId && !dryRun) {
    return { status: 'missing_admin_chat_id', enabled, sent: 0, evaluated: candidates.length, alerts: [] };
  }

  const stateFile = opts.stateFile || DEFAULT_STATE_FILE;
  const alertedKeys = await readAlertedKeys(stateFile);
  const sender = typeof opts.sender === 'function' ? opts.sender : defaultAdminSender;

  const alerts = [];
  let sent = 0;

  for (const candidate of candidates) {
    const gate = evaluateCandidateGate(candidate, { tradingDay, alertedKeys });
    if (!gate.eligible) {
      alerts.push({ ticker: safeTicker(candidate.ticker), eligible: false, reason: gate.reason, sent: false });
      continue;
    }

    if (dryRun) {
      alerts.push({ ticker: safeTicker(candidate.ticker), eligible: true, reason: gate.reason, sent: false, dry_run: true });
      continue;
    }

    const message = formatAdminAlertMessage(candidate);
    let sendResult;
    try {
      sendResult = await sender(message, adminChatId, env);
    } catch (e) {
      sendResult = { sent: false, reason: 'sender_threw', error_message: (e && e.message) ? String(e.message).slice(0, 120) : 'unknown' };
    }

    if (sendResult && sendResult.sent) {
      const key = dedupKey(candidate.date, candidate.ticker);
      alertedKeys.add(key); // in-run dedup
      let recorded = true;
      try {
        await recordAlert(stateFile, {
          date: candidate.date,
          ticker: safeTicker(candidate.ticker),
          snapshot: candidate.snapshot,
          confirmation_reason: candidate.confirmation_reason,
          shadow_score: candidate.shadow_score,
          entry_snapshot_time: candidate.entry_snapshot_time,
          entry_reference_price: candidate.entry_reference_price,
          admin_chat_id_masked: maskChatId(adminChatId),
          recorded_at: now().toISOString()
        });
      } catch (e) {
        recorded = false;
      }
      sent++;
      alerts.push({ ticker: safeTicker(candidate.ticker), eligible: true, sent: true, recorded, admin_chat_id_masked: maskChatId(adminChatId) });
    } else {
      alerts.push({ ticker: safeTicker(candidate.ticker), eligible: true, sent: false, reason: (sendResult && sendResult.reason) || 'send_failed' });
    }
  }

  return {
    status: dryRun ? 'dry_run' : 'ok',
    enabled,
    dry_run: dryRun,
    trading_day: tradingDay,
    admin_chat_id_masked: adminChatId ? maskChatId(adminChatId) : null,
    evaluated: candidates.length,
    sent,
    alerts,
    safety: {
      DAYTRADE_INTRADAY_SCORE_ENABLED: String(env.DAYTRADE_INTRADAY_SCORE_ENABLED || ''),
      DAYTRADE_WORKER_ALLOW_MUTATION: String(env.DAYTRADE_WORKER_ALLOW_MUTATION || ''),
      feature_flag: FEATURE_FLAG,
      feature_flag_enabled: enabled,
      admin_only: true,
      public_delivery_possible: false
    }
  };
}

module.exports = {
  // constants
  FEATURE_FLAG,
  SCORE_THRESHOLD,
  ALLOWED_CONFIRMATION_REASONS,
  CONFIRMED_STATE,
  REQUIRED_CONFIRMED_RANK,
  ALERT_LABEL,
  SHADOW_NOTE,
  GATE,
  DEFAULT_STATE_FILE,
  // flag + safety
  isExperimentalAdminAlertEnabled,
  assertExperimentalSafety,
  resolveAdminChatId,
  // gate + candidate building
  evaluateCandidateGate,
  buildAlertCandidatesFromEvaluation,
  // message
  formatAdminAlertMessage,
  // idempotency
  dedupKey,
  readAlertedKeys,
  recordAlert,
  maskChatId,
  // sender + orchestration
  defaultAdminSender,
  runExperimentalAdminAlert
};

'use strict';

/**
 * Fast Watcher Early Watch — Telegram publisher.
 *
 * Owns everything lib/intraday-fast-watcher-early-watch.js (the CORE
 * persistence/tracking module) deliberately does not know about: message
 * text, the canonical Telegram sender, and the existing Fast Watcher
 * Telegram kill switches. Mirrors the exact pattern already used by
 * lib/intraday-fast-watcher-publisher.js (confirmed signal) and
 * lib/intraday-fast-watcher-radar-publisher.js (radar) — a sibling
 * "*-publisher.js" file owning I/O side effects, called from the
 * guarded-live orchestrator only.
 *
 * Two, and only two, notification types, each ATTEMPTED AT MOST ONCE per
 * ticker/trading_date/early_watch_version — see sendPendingNotifications
 * below for the crash-safe "persist the attempt reservation BEFORE the
 * network call" contract (dedup is the persisted
 * early_watch_notification_attempted / anti_chase_notification_attempted
 * flags on the Early Watch tracker state, not the `_sent` flags — see
 * intraday-fast-watcher-early-watch.js):
 *
 *   1. EARLY WATCH — attempted once a ticker's Early Watch tracker has a
 *      known reference_price AND the CURRENT pool.js snapshot says it is
 *      still a live, PRE-confirmation candidate: active, status is
 *      WATCHING or READY_PENDING (never READY_CONFIRMED or a terminal
 *      status — see isCurrentlyEarlyWatchEligible), not already blocked by
 *      the existing canonical production-eligibility decision (reused
 *      verbatim from pool.js's own `item.last_reasons` — see
 *      isProductionEligibilityBlocked), and not already chase-blocked
 *      (isChaseBlocked) — a ticker that is already chase-blocked on the
 *      very run it was first captured gets NO Early Watch alert at all,
 *      rather than one immediately followed by an anti-chase alert. The
 *      message itself displays the CURRENT poolItem.status/ready_streak,
 *      never the frozen FIRST_WATCH snapshot, so a delayed send (e.g. once
 *      reference_price finally becomes known) never shows stale progress.
 *   2. ANTI-CHASE — attempted only for a ticker whose Early Watch alert
 *      was already successfully SENT on a PRIOR run (never the same run),
 *      once the existing, canonical, frozen Fast Watcher chase
 *      classification (a reason in
 *      intraday-fast-watcher-radar-publisher.js's CHASE_REASONS Set — the
 *      same Set radar-publisher.js already uses) fires. This file never
 *      invents a new advance-percent cutoff.
 *
 * 15m/30m/60m follow-up checkpoints and MFE/MAE remain internal research
 * evidence ONLY — this file never sends a Telegram message for them.
 *
 * Never writes Supabase. Never registers a production recommendation. Only
 * ever calls the canonical lib/telegram-notifier.js sender (or an injected
 * test double) — never a raw fetch/bot-API call of its own.
 */

const telegramNotifier = require('./telegram-notifier');
const radarPublisher = require('./intraday-fast-watcher-radar-publisher');

// Reused verbatim from pool.js's OWN inline terminal-failure/eviction status
// list (lib/intraday-fast-watcher-pool.js: the `activeRows()` filter and the
// process() terminal-safety-status cleanup both use this exact set). pool.js
// does not export it as a constant, so it is duplicated here character-for-
// character rather than re-derived — this file must never invent a new
// terminal-status rule.
const NON_EARLY_WATCH_STATUSES = new Set(['DROPPED_FROM_WATCH_POOL', 'INVALIDATED', 'STALE', 'INVALID_DATA', 'BLOCKED_CHASE']);

// Early Watch is, by definition, a PRE-confirmation alert ("belum
// terkonfirmasi"). pool.js's own two live pre-confirmation statuses are
// WATCHING and READY_PENDING (see lib/intraday-fast-watcher-pool.js
// process(): `to = confirmationCount >= REQUIRED_CONFIRMATIONS ?
// 'READY_CONFIRMED' : 'READY_PENDING'`). Any other current status —
// including READY_CONFIRMED itself — must never receive a fresh/delayed
// Early Watch send; the existing confirmed publisher already owns that
// ticker's notification once it reaches READY_CONFIRMED.
const PRE_CONFIRMATION_STATUSES = new Set(['WATCHING', 'READY_PENDING']);

function numberOrNull(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || typeof value === 'boolean' ? null : (Number.isFinite(n) ? n : null);
}

function safeText(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength || 180);
}

function formatPrice(value) {
  const n = numberOrNull(value);
  return n == null ? '-' : `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(n)}`;
}

function formatSignedPct(value) {
  const n = numberOrNull(value);
  return n == null ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function confirmationCountText(n) {
  return Number.isInteger(n) && n >= 0 && n <= 2 ? `${n}/2` : 'Belum 2/2';
}

/**
 * True only when the FROZEN production eligibility decision already made by
 * pool.js (via lib/intraday-production-eligibility.js inside
 * lib/intraday-fast-watcher-pool.js's own process() loop) blocked this
 * ticker's latest observation. Reused verbatim from `poolItem.last_reasons`
 * — this file never re-runs or re-implements the eligibility check.
 */
function isProductionEligibilityBlocked(poolItem) {
  return Boolean(poolItem && Array.isArray(poolItem.last_reasons) && poolItem.last_reasons.includes('production_eligibility_blocked'));
}

/**
 * True only when the FROZEN, existing anti-chase engine classification in
 * lib/intraday-fast-watcher-momentum.js fired with one of the exact chase
 * reason codes already defined in
 * lib/intraday-fast-watcher-radar-publisher.js's CHASE_REASONS Set (the
 * same Set radar-publisher.js itself uses). This file never derives its
 * own advance-percent cutoff.
 *
 * Deliberately reason-code-only, NOT status-gated: pool.js's own
 * process() terminal-safety-status cleanup rewrites a BLOCKED_CHASE
 * status to DROPPED_FROM_WATCH_POOL within the SAME process() call
 * whenever a scheduled_time is available (i.e. on every real guarded-live
 * run), so `poolItem.status` will essentially never still read
 * 'BLOCKED_CHASE' by the time this file sees it — only `last_reasons`
 * (never overwritten by that cleanup step) reliably preserves the chase
 * signal.
 */
function isChaseBlocked(poolItem) {
  return Boolean(
    poolItem
    && Array.isArray(poolItem.last_reasons)
    && poolItem.last_reasons.some(reason => radarPublisher.CHASE_REASONS.has(reason))
  );
}

/**
 * Gate for the Early Watch (not anti-chase) alert. Requires a CURRENT,
 * relevant pool.js snapshot for the ticker — never sends against a stale
 * capture from a run where the ticker has since left the active pool,
 * already reached confirmation, or flipped to a canonical
 * terminal/ineligible status. Reuses existing canonical semantics only:
 *   - poolItem must exist and be active (pool.js's own `item.active`)
 *   - poolItem.status must be a live PRE-confirmation status (WATCHING or
 *     READY_PENDING) — this alone also rules out READY_CONFIRMED and every
 *     one of pool.js's own terminal statuses, since none of them are in
 *     PRE_CONFIRMATION_STATUSES
 *   - poolItem.status must not be one of pool.js's own terminal statuses
 *     (kept as an explicit, defense-in-depth check even though the
 *     allowlist above already excludes them)
 *   - not production-eligibility-blocked (isProductionEligibilityBlocked)
 *   - not already chase-blocked (isChaseBlocked) — if a ticker is
 *     ALREADY chase-blocked on the very run it was first captured, the
 *     Early Watch alert is skipped entirely rather than immediately
 *     followed by an anti-chase alert in the same run.
 */
function isCurrentlyEarlyWatchEligible(poolItem) {
  if (!poolItem || poolItem.active !== true) return false;
  if (!PRE_CONFIRMATION_STATUSES.has(poolItem.status)) return false;
  if (NON_EARLY_WATCH_STATUSES.has(poolItem.status)) return false;
  if (isProductionEligibilityBlocked(poolItem)) return false;
  if (isChaseBlocked(poolItem)) return false;
  return true;
}

/**
 * `poolItem` is the CURRENT pool.js snapshot for this ticker, at send time
 * — by the time this is reached from sendPendingNotifications,
 * isCurrentlyEarlyWatchEligible() has already guaranteed
 * `poolItem.status` is WATCHING or READY_PENDING, so the displayed status
 * and confirmation count reflect what's true RIGHT NOW, never the frozen
 * FIRST_WATCH snapshot (which could be stale by the time a delayed send
 * finally goes out, e.g. once reference_price becomes known days apart —
 * see the "eligibility becoming clear on a later run" case). `poolItem` is
 * optional so this function stays usable for direct content-only tests
 * that don't construct a full pool snapshot; it then falls back to the
 * tracker's own frozen values.
 */
function buildEarlyWatchMessage(tracker, ticker, poolItem) {
  const currentStatus = poolItem && PRE_CONFIRMATION_STATUSES.has(poolItem.status) ? poolItem.status : 'WATCHING';
  const currentConfirmationCount = poolItem && Number.isInteger(poolItem.ready_streak) ? poolItem.ready_streak : tracker.confirmation_count;
  const lines = [
    '👀 EARLY WATCH — BELUM TERKONFIRMASI',
    '',
    safeText(ticker, 5).toUpperCase(),
    '',
    `Harga referensi : ${formatPrice(tracker.reference_price)}`,
    `Status           : ${currentStatus}`,
    `Konfirmasi       : ${confirmationCountText(currentConfirmationCount)}`,
    `Score            : ${numberOrNull(tracker.score) == null ? '-' : Math.round(numberOrNull(tracker.score))}`,
    `Setup            : ${tracker.candidate_type ? safeText(tracker.candidate_type, 60) : '-'}`,
    '',
    '⚠️ Belum merupakan sinyal BUY.',
    'Pantau pergerakan harga dan tunggu konfirmasi Fast Watcher.'
  ];
  return lines.join('\n');
}

function buildAntiChaseMessage(tracker, ticker, poolItem) {
  const currentPrice = numberOrNull(poolItem && poolItem.last_price);
  const referencePrice = numberOrNull(tracker.reference_price);
  const movePct = referencePrice != null && currentPrice != null && referencePrice > 0
    ? ((currentPrice - referencePrice) / referencePrice) * 100
    : null;
  const lines = [
    '🚫 HARGA SUDAH NAIK TERLALU JAUH — JANGAN DIKEJAR',
    '',
    safeText(ticker, 5).toUpperCase(),
    '',
    `Harga saat Early Watch : ${formatPrice(referencePrice)}`,
    `Harga referensi kini   : ${formatPrice(currentPrice)}`,
    `Kenaikan                : ${formatSignedPct(movePct)}`,
    '',
    'Momentum sudah bergerak terlalu jauh dari area awal.',
    '',
    '⚠️ Jangan mengejar harga.',
    'Tunggu pullback atau setup baru.'
  ];
  return lines.join('\n');
}

/**
 * Reuses the exact same layered kill-switch pattern as
 * intraday-fast-watcher-publisher.js / intraday-fast-watcher-radar-publisher.js
 * (FAST_WATCHER_LIVE_ENABLED, FAST_WATCHER_TELEGRAM_ENABLED), PLUS the
 * GLOBAL TELEGRAM_ENABLED switch checked HERE, not left to
 * lib/telegram-notifier.js alone. This matters specifically because of the
 * at-most-once ATTEMPT contract below: the `_attempted` reservation is
 * durably persisted BEFORE the outbound call, so if this gate did not also
 * cover the global switch, a run with TELEGRAM_ENABLED=0 would still mark
 * the alert "attempted" (via telegram-notifier's own internal
 * `telegram_disabled` response) and permanently consume it — the alert
 * would never fire even after Telegram is turned back on. Requiring all
 * three switches here means a globally-disabled Telegram run is a clean
 * DISABLED/SKIPPED no-op: no reservation, no attempt, nothing consumed.
 * lib/telegram-notifier.js still independently re-checks TELEGRAM_ENABLED
 * itself too — this file does not bypass or replace that check, it adds an
 * earlier one with different (reservation-safety) consequences.
 */
function telegramGateOpen(env) {
  return String(env.FAST_WATCHER_LIVE_ENABLED || '') === '1'
    && String(env.FAST_WATCHER_TELEGRAM_ENABLED || '') === '1'
    && String(env.TELEGRAM_ENABLED || '') === '1';
}

/**
 * Sends any pending Early Watch / anti-chase Telegram notifications for the
 * given (already-updated-this-run) Early Watch state, using the CURRENT
 * pool.js snapshot to check eligibility/chase status. Returns a NEW state
 * object (immutable-style) with sent/attempted flags flipped for whatever
 * was attempted; never throws — a send failure is reported in `failures`.
 *
 * AT-MOST-ONCE ATTEMPT contract (crash-safe): for each notification type,
 * this function marks `_attempted`/`_attempted_at` on the in-memory state
 * and calls `context.persist(state)` — a durable, atomic write against the
 * SAME on-disk state file — BEFORE making the outbound Telegram call. If
 * the process crashes or the VPS dies between that persist and the
 * Telegram response, the reservation already survived: on restart,
 * `_attempted === true` prevents any resend attempt, by construction. This
 * intentionally trades "may miss one informational alert on a rare crash"
 * for "never duplicate/spam" — it does NOT claim exactly-once delivery,
 * only at-most-once ATTEMPT. `context.persist` defaults to a no-op so this
 * function stays safely callable standalone (e.g. in tests); real
 * durability requires the caller (lib/intraday-fast-watcher-early-watch.js
 * runEarlyWatch) to supply the real one, which it always does.
 */
async function sendPendingNotifications(state, processedPoolState, context) {
  const opts = context || {};
  const env = opts.env || process.env;
  const persist = opts.persist || (async () => {});
  const nextState = JSON.parse(JSON.stringify(state));
  const result = { state: nextState, early_watch_sent: 0, anti_chase_sent: 0, failures: [], telegram_gate_open: telegramGateOpen(env) };
  if (!result.telegram_gate_open) return result;

  const send = opts.notifyFn || telegramNotifier.sendTelegramMessage;
  const chatId = env.FAST_WATCHER_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  const nowIso = new Date(opts.now || Date.now()).toISOString();

  for (const ticker of Object.keys(nextState.tickers)) {
    const tracker = nextState.tickers[ticker];
    const poolItem = processedPoolState && processedPoolState.tickers && processedPoolState.tickers[ticker];
    // Snapshot BEFORE this run's own Early Watch attempt below, so a
    // ticker that gets its Early Watch alert sent for the first time in
    // THIS run can never also fire an anti-chase alert in the same run —
    // anti-chase only ever follows an Early Watch alert from a PRIOR run.
    const earlyWatchAlreadySentBeforeThisRun = tracker.early_watch_notification_sent === true;

    if (!tracker.early_watch_notification_attempted && tracker.reference_price != null && isCurrentlyEarlyWatchEligible(poolItem)) {
      tracker.early_watch_notification_attempted = true;
      tracker.early_watch_notification_attempted_at = nowIso;
      await persist(nextState);
      try {
        const sendResult = await send(buildEarlyWatchMessage(tracker, ticker, poolItem), { chat_id: chatId, disable_web_page_preview: true, timeout_ms: 5000 });
        if (sendResult && sendResult.sent) {
          tracker.early_watch_notification_sent = true;
          tracker.early_watch_notification_sent_at = nowIso;
          result.early_watch_sent += 1;
        } else {
          tracker.early_watch_notification_failure_reason = (sendResult && sendResult.reason) || 'telegram_failed';
          result.failures.push({ ticker, type: 'early_watch', reason: tracker.early_watch_notification_failure_reason });
        }
      } catch (error) {
        tracker.early_watch_notification_failure_reason = 'telegram_exception';
        result.failures.push({ ticker, type: 'early_watch', reason: 'telegram_exception' });
      }
    }

    if (!tracker.anti_chase_notification_attempted && earlyWatchAlreadySentBeforeThisRun && isChaseBlocked(poolItem)) {
      tracker.anti_chase_notification_attempted = true;
      tracker.anti_chase_notification_attempted_at = nowIso;
      await persist(nextState);
      try {
        const sendResult = await send(buildAntiChaseMessage(tracker, ticker, poolItem), { chat_id: chatId, disable_web_page_preview: true, timeout_ms: 5000 });
        if (sendResult && sendResult.sent) {
          tracker.anti_chase_notification_sent = true;
          tracker.anti_chase_notification_sent_at = nowIso;
          result.anti_chase_sent += 1;
        } else {
          tracker.anti_chase_notification_failure_reason = (sendResult && sendResult.reason) || 'telegram_failed';
          result.failures.push({ ticker, type: 'anti_chase', reason: tracker.anti_chase_notification_failure_reason });
        }
      } catch (error) {
        tracker.anti_chase_notification_failure_reason = 'telegram_exception';
        result.failures.push({ ticker, type: 'anti_chase', reason: 'telegram_exception' });
      }
    }
  }

  return result;
}

module.exports = {
  NON_EARLY_WATCH_STATUSES,
  PRE_CONFIRMATION_STATUSES,
  isProductionEligibilityBlocked,
  isChaseBlocked,
  isCurrentlyEarlyWatchEligible,
  buildEarlyWatchMessage,
  buildAntiChaseMessage,
  telegramGateOpen,
  sendPendingNotifications
};

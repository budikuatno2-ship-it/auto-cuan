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
 * Two, and only two, notification types, each sent AT MOST ONCE per
 * ticker/trading_date/early_watch_version (dedup is the persisted
 * early_watch_notification_sent / anti_chase_notification_sent flags on
 * the Early Watch tracker state — see intraday-fast-watcher-early-watch.js):
 *
 *   1. EARLY WATCH — sent once a ticker's Early Watch tracker has a known
 *      reference_price and is not already blocked by the existing,
 *      canonical production-eligibility decision (reused verbatim from
 *      pool.js's own `item.last_reasons` — see isProductionEligibilityBlocked
 *      below; this file never re-implements eligibility).
 *   2. ANTI-CHASE — sent once the existing, canonical, frozen Fast Watcher
 *      chase classification (pool.js status BLOCKED_CHASE/SPIKE_RADAR with
 *      a reason in intraday-fast-watcher-radar-publisher.js's CHASE_REASONS
 *      — the same Set radar-publisher.js already uses to detect a chase
 *      condition) fires for a ticker that was previously Early-Watched.
 *      This file never invents a new advance-percent cutoff.
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

const CHASE_STATUSES = new Set(['BLOCKED_CHASE', 'SPIKE_RADAR']);

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

function confirmationText(tracker) {
  const n = tracker && tracker.confirmation_count;
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
 * lib/intraday-fast-watcher-momentum.js (via pool.js status BLOCKED_CHASE /
 * SPIKE_RADAR) fired with one of the exact chase reason codes already
 * defined in lib/intraday-fast-watcher-radar-publisher.js's CHASE_REASONS
 * Set. This file never derives its own advance-percent cutoff.
 */
function isChaseBlocked(poolItem) {
  return Boolean(
    poolItem
    && CHASE_STATUSES.has(poolItem.status)
    && Array.isArray(poolItem.last_reasons)
    && poolItem.last_reasons.some(reason => radarPublisher.CHASE_REASONS.has(reason))
  );
}

function buildEarlyWatchMessage(tracker, ticker) {
  const lines = [
    '👀 EARLY WATCH — BELUM TERKONFIRMASI',
    '',
    safeText(ticker, 5).toUpperCase(),
    '',
    `Harga referensi : ${formatPrice(tracker.reference_price)}`,
    'Status           : WATCHING',
    `Konfirmasi       : ${confirmationText(tracker)}`,
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
    '🚫 HARGA SUDAH NAIK TERLALU JAU — JANGAN DIKEJAR',
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
 * intraday-fast-watcher-publisher.js / intraday-fast-watcher-radar-publisher.js:
 * FAST_WATCHER_LIVE_ENABLED gates the whole guarded-live run (already
 * enforced upstream in guarded-live.js before this is ever reachable, kept
 * here too for defense in depth / standalone callers), and
 * FAST_WATCHER_TELEGRAM_ENABLED gates Telegram specifically. The canonical
 * sender (lib/telegram-notifier.js) independently re-checks the GLOBAL
 * TELEGRAM_ENABLED switch itself — this file never bypasses that.
 */
function telegramGateOpen(env) {
  return String(env.FAST_WATCHER_LIVE_ENABLED || '') === '1' && String(env.FAST_WATCHER_TELEGRAM_ENABLED || '') === '1';
}

/**
 * Sends any pending Early Watch / anti-chase Telegram notifications for the
 * given (already-updated-this-run) Early Watch state, using the CURRENT
 * pool.js snapshot to check eligibility/chase status. Returns a NEW state
 * object (immutable-style) with sent flags flipped for whatever succeeded;
 * never throws — a send failure is reported in `failures` and simply leaves
 * that ticker's flag false so it can be retried on a later run.
 */
async function sendPendingNotifications(state, processedPoolState, context) {
  const opts = context || {};
  const env = opts.env || process.env;
  const nextState = JSON.parse(JSON.stringify(state));
  const result = { state: nextState, early_watch_sent: 0, anti_chase_sent: 0, failures: [], telegram_gate_open: telegramGateOpen(env) };
  if (!result.telegram_gate_open) return result;

  const send = opts.notifyFn || telegramNotifier.sendTelegramMessage;
  const chatId = env.FAST_WATCHER_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  const nowIso = new Date(opts.now || Date.now()).toISOString();

  for (const ticker of Object.keys(nextState.tickers)) {
    const tracker = nextState.tickers[ticker];
    const poolItem = processedPoolState && processedPoolState.tickers && processedPoolState.tickers[ticker];

    if (!tracker.early_watch_notification_sent && tracker.reference_price != null && !isProductionEligibilityBlocked(poolItem)) {
      try {
        const sendResult = await send(buildEarlyWatchMessage(tracker, ticker), { chat_id: chatId, disable_web_page_preview: true, timeout_ms: 5000 });
        if (sendResult && sendResult.sent) {
          tracker.early_watch_notification_sent = true;
          tracker.early_watch_notification_sent_at = nowIso;
          result.early_watch_sent += 1;
        } else {
          result.failures.push({ ticker, type: 'early_watch', reason: (sendResult && sendResult.reason) || 'telegram_failed' });
        }
      } catch (error) {
        result.failures.push({ ticker, type: 'early_watch', reason: 'telegram_exception' });
      }
    }

    if (!tracker.anti_chase_notification_sent && isChaseBlocked(poolItem)) {
      try {
        const sendResult = await send(buildAntiChaseMessage(tracker, ticker, poolItem), { chat_id: chatId, disable_web_page_preview: true, timeout_ms: 5000 });
        if (sendResult && sendResult.sent) {
          tracker.anti_chase_notification_sent = true;
          tracker.anti_chase_notification_sent_at = nowIso;
          result.anti_chase_sent += 1;
        } else {
          result.failures.push({ ticker, type: 'anti_chase', reason: (sendResult && sendResult.reason) || 'telegram_failed' });
        }
      } catch (error) {
        result.failures.push({ ticker, type: 'anti_chase', reason: 'telegram_exception' });
      }
    }
  }

  return result;
}

module.exports = {
  CHASE_STATUSES,
  isProductionEligibilityBlocked,
  isChaseBlocked,
  buildEarlyWatchMessage,
  buildAntiChaseMessage,
  telegramGateOpen,
  sendPendingNotifications
};

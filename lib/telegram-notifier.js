/**
 * Telegram Notifier Helper — Phase 1
 *
 * Safe, non-throwing Telegram message sender.
 * Uses Telegram Bot API sendMessage.
 *
 * Environment variables:
 *   TELEGRAM_ENABLED   — must be exactly "1" to send
 *   TELEGRAM_BOT_TOKEN — Bot API token (never logged)
 *   TELEGRAM_CHAT_ID   — Target chat/group ID (masked in logs)
 *
 * Safety:
 *   - Never throws
 *   - Never breaks the app if Telegram is down
 *   - Never logs token or full chat ID
 *   - Skips gracefully if disabled or misconfigured
 *
 * NOT connected to screeners in Phase 1.
 */

'use strict';

const { isMarketOpen, getMarketSession, getWibComponents } = require('./market-hours-guard');

// ---------------------------------------------------------------------------
// BATCH 8: Centralized stateful alert dedup / cooldown guard.
//
// The notifier is the single choke point every Telegram alert passes through,
// so the anti-duplicate state lives here. Callers opt in by passing
// `options.alert_key` (or `options.ticker`); without it behavior is unchanged.
//
// A ticker is suppressed while its cooldown window is active UNLESS the signal
// status changes significantly (upgrade to a confirmed-buy status, or a
// downgrade to AVOID/SL_HIT/INVALID), which always bypasses the window.
// ---------------------------------------------------------------------------
const DEFAULT_ALERT_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes (one trading session window)
const alertCooldownCache = new Map();

function normalizeAlertStatus(status) {
  return String(status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function isConfirmedBuyStatus(status) {
  const s = normalizeAlertStatus(status);
  return s.includes('A_PLUS') || s.includes('READY') || s.includes('TRADE_CANDIDATE') || s.includes('CONFIRMED');
}

function isKeyActionStatus(status) {
  const s = normalizeAlertStatus(status);
  return s.includes('TP1_HIT') || s.includes('TP2_HIT') || s.includes('TP3_HIT') ||
         s.includes('EARLY_EXIT') || s.includes('DISTRIBUTION') ||
         s.includes('TRAILING_STOP') || s.includes('BEP_CLOSED');
}

function isDrasticAlertStatusChange(prevStatus, nextStatus) {
  const prev = normalizeAlertStatus(prevStatus);
  const next = normalizeAlertStatus(nextStatus);
  if (!next || next === prev) return false;
  if (isKeyActionStatus(next)) return true;
  const wasNeutral = prev.includes('WATCHLIST') || prev.includes('RADAR') || prev.includes('PULLBACK') || prev.includes('SPECULATIVE');
  if (wasNeutral && isConfirmedBuyStatus(next)) return true;
  const isNowAvoid = next.includes('AVOID') || next.includes('SL_HIT') || next.includes('INVALID');
  const wasNormal = !prev.includes('AVOID') && !prev.includes('SL_HIT');
  return isNowAvoid && wasNormal;
}

function resolveAlertNow(options) {
  const raw = options && options.now != null ? options.now : Date.now();
  const ms = raw instanceof Date ? raw.getTime() : Number(raw);
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * Check whether an alert for `key` is currently suppressed by cooldown.
 * @returns {{ suppressed: boolean, reason: string|null, remainingMs: number }}
 */
function checkAlertCooldown(key, status, options) {
  options = options || {};
  if (!key) return { suppressed: false, reason: null, remainingMs: 0 };
  if (options.force === true || options.force_alert === true) {
    return { suppressed: false, reason: 'forced_bypass', remainingMs: 0 };
  }
  const k = String(key).trim().toUpperCase();
  const entry = alertCooldownCache.get(k);
  if (!entry) return { suppressed: false, reason: null, remainingMs: 0 };

  const now = resolveAlertNow(options);
  if (now >= entry.expiresAt) {
    alertCooldownCache.delete(k);
    return { suppressed: false, reason: 'cooldown_expired', remainingMs: 0 };
  }
  if (isDrasticAlertStatusChange(entry.status, status)) {
    return { suppressed: false, reason: 'status_changed_bypass', remainingMs: 0 };
  }
  const remainingMs = Math.max(0, entry.expiresAt - now);
  return { suppressed: true, reason: `in_cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`, remainingMs };
}

/**
 * Record a successfully-sent alert so subsequent identical alerts are suppressed.
 */
function recordAlertCooldown(key, status, options) {
  options = options || {};
  if (!key) return;
  const k = String(key).trim().toUpperCase();
  const cooldownMs = Number(options.cooldownMs || options.cooldown_ms) || DEFAULT_ALERT_COOLDOWN_MS;
  const now = resolveAlertNow(options);
  alertCooldownCache.set(k, {
    key: k,
    status: normalizeAlertStatus(status),
    recordedAt: now,
    expiresAt: now + cooldownMs
  });
}

function clearAlertCooldownCache() {
  alertCooldownCache.clear();
}

function getAlertCooldownStatus(key, options) {
  if (!key) return null;
  const k = String(key).trim().toUpperCase();
  const entry = alertCooldownCache.get(k);
  if (!entry) return null;
  const now = resolveAlertNow(options);
  const remainingMs = Math.max(0, entry.expiresAt - now);
  return {
    key: k,
    status: entry.status,
    recordedAt: new Date(entry.recordedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    isExpired: remainingMs === 0,
    remainingMs
  };
}

// ---------------------------------------------------------------------------
// BATCH 10: Centralized outbound throttle / queue + 429 retry_after backoff.
//
// A burst of candidates passing the filter used to fire N sends back-to-back
// (chunks included), tripping Telegram HTTP 429. Every send now passes through
// one serialized gate that spaces sends by a safe interval, and a 429 response
// parks the whole gate for the duration Telegram asked for (retry_after).
//
// Threshold note: 3000ms matches Telegram's ~20 msgs/min broadcast ceiling for
// a single chat. Tests bypass the gate (NODE_TEST_CONTEXT) or supply their own
// `min_interval_ms` + controllable `sleep` so they never wait on real timers.
// ---------------------------------------------------------------------------
const DEFAULT_SEND_INTERVAL_MS = 3000;
const throttleState = { chain: Promise.resolve(), lastSendAt: 0, retryAfterUntil: 0 };

function isTestEnv() {
  return process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT !== undefined ||
    process.argv.indexOf('--test') !== -1;
}

function resolveThrottleOptions(options) {
  options = options || {};
  const explicit = options.min_interval_ms != null ? options.min_interval_ms : options.minIntervalMs;
  if (explicit != null) {
    const v = Number(explicit);
    return { interval: Number.isFinite(v) && v >= 0 ? v : 0, sleep: typeof (options.sleep || options.sleepFn) === 'function' ? (options.sleep || options.sleepFn) : null };
  }
  if (isTestEnv()) return { interval: 0, sleep: null };
  const env = Number(process.env.TELEGRAM_SEND_INTERVAL_MS);
  return { interval: Number.isFinite(env) && env >= 0 ? env : DEFAULT_SEND_INTERVAL_MS, sleep: null };
}

function defaultThrottleSleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/**
 * Serialize and space the next outbound send. Honours an active 429 backoff.
 * Never throws; never blocks forever (real send timeout bounds each caller).
 */
async function acquireSendSlot(options) {
  const cfg = resolveThrottleOptions(options);
  const sleep = cfg.sleep || defaultThrottleSleep;
  const prev = throttleState.chain;
  let release;
  throttleState.chain = new Promise(function(resolve) { release = resolve; });
  try {
    await prev;
  } catch (_) { /* previous slot errors must not block the queue */ }
  let wait = 0;
  const now = Date.now();
  wait = Math.max(wait, throttleState.lastSendAt + cfg.interval - now);
  // Skip a live 429 backoff wait in test env unless a controllable clock was injected.
  if (throttleState.retryAfterUntil > now && (cfg.sleep || !isTestEnv())) {
    wait = Math.max(wait, throttleState.retryAfterUntil - now);
  }
  if (wait > 0) await sleep(wait);
  throttleState.lastSendAt = Date.now();
  release();
}

/**
 * Park the whole gate after a 429 so no further send ignores retry_after.
 */
function applyRateLimitBackoff(retryAfterSeconds) {
  const secs = Number(retryAfterSeconds);
  const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : DEFAULT_SEND_INTERVAL_MS;
  const until = Date.now() + ms;
  if (until > throttleState.retryAfterUntil) throttleState.retryAfterUntil = until;
  return ms;
}

function resetTelegramThrottle() {
  throttleState.chain = Promise.resolve();
  throttleState.lastSendAt = 0;
  throttleState.retryAfterUntil = 0;
}

function getTelegramThrottleState() {
  return {
    lastSendAt: throttleState.lastSendAt,
    retryAfterUntil: throttleState.retryAfterUntil,
    backoffActive: throttleState.retryAfterUntil > Date.now(),
    defaultIntervalMs: DEFAULT_SEND_INTERVAL_MS
  };
}

/**
 * Check if Telegram sending is enabled.
 * @returns {boolean}
 */
function isTelegramEnabled() {
  return process.env.TELEGRAM_ENABLED === '1';
}

/**
 * Send a message via Telegram Bot API.
 * Never throws. Returns a result object.
 *
 * @param {string} text - Message text to send
 * @param {object} [options] - Optional settings
 * @param {string} [options.parse_mode] - 'HTML' or 'MarkdownV2' (default: none/plain text)
 * @param {boolean} [options.disable_web_page_preview] - Disable link previews (default: true)
 * @returns {Promise<object>} Result: { sent, skipped, reason, status, error_message }
 */
function splitTelegramMessage(text, maxLen) {
  maxLen = maxLen || 3600;
  var clean = String(text || '');
  if (clean.length <= maxLen) return [clean];

  var chunks = [];
  var remaining = clean;
  while (remaining.length > maxLen) {
    var cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
    var part = remaining.slice(0, cut).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendTelegramChunk(url, body, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    return response;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function sendTelegramMessage(text, options) {
  options = options || {};

  // 0. Market Hours Guard: reject broadcast if market is closed (unless explicitly bypassed)
  if (options.skip_market_guard !== true && options.skipMarketGuard !== true) {
    const checkDate = options.now != null ? options.now : (options.date != null ? options.date : new Date());
    if (!isMarketOpen(checkDate)) {
      const session = getMarketSession(checkDate);
      const wib = getWibComponents(checkDate);
      console.log(`[MARKET_GUARD_BLOCKED] Broadcast cancelled: Market is CLOSED (Session: ${session}, Time: ${wib.timeStr || '-'} WIB, Day: ${wib.dayOfWeek})`);
      return {
        sent: false,
        skipped: true,
        reason: 'market_closed',
        session: session,
        time_wib: wib.timeStr,
        status: null,
        error_message: null
      };
    }
  }

  // 0b. BATCH 8: Stateful alert dedup / cooldown guard (opt-in via alert_key/ticker).
  const alertKey = options.alert_key || options.alertKey || options.ticker || null;
  if (alertKey) {
    const cooldown = checkAlertCooldown(alertKey, options.status || options.alert_status, options);
    if (cooldown.suppressed) {
      console.log(`[ALERT_DEDUP_BLOCKED] Duplicate alert suppressed for ${String(alertKey).toUpperCase()}: ${cooldown.reason}`);
      return {
        sent: false,
        skipped: true,
        reason: 'duplicate_suppressed',
        dedup_reason: cooldown.reason,
        remaining_ms: cooldown.remainingMs,
        status: null,
        error_message: null
      };
    }
  }

  // 1. Check enabled
  if (!isTelegramEnabled()) {
    return { sent: false, skipped: true, reason: 'telegram_disabled', status: null, error_message: null };
  }

  // 2. Check token
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_token', status: null, error_message: null };
  }

  // 3. Check chat ID
  var chatId = options && options.chat_id ? String(options.chat_id) : process.env.TELEGRAM_CHAT_ID;
  if (!chatId || chatId.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_chat_id', status: null, error_message: null };
  }

  // 4. Check message text
  if (!text || text.trim() === '') {
    return { sent: false, skipped: true, reason: 'empty_message', status: null, error_message: null };
  }

  // 5. Build request
  options = options || {};
  var timeoutMs = Number(options.timeout_ms || options.timeoutMs || 9000);
  if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 9000;
  var maxChunkLen = Number(options.max_chunk_length || options.maxChunkLength || 3600);
  if (!isFinite(maxChunkLen) || maxChunkLen <= 0 || maxChunkLen > 4096) maxChunkLen = 3600;

  var url = 'https://api.telegram.org/bot' + token.trim() + '/sendMessage';
  var chunks = splitTelegramMessage(text, maxChunkLen);
  var sentCount = 0;
  var lastStatus = null;

  // 6. Send (never throw)
  try {
    for (var i = 0; i < chunks.length; i++) {
      var chunkText = chunks.length > 1 ? ('Part ' + (i + 1) + '/' + chunks.length + '\n' + chunks[i]) : chunks[i];
      var body = {
        chat_id: chatId.trim(),
        text: chunkText,
        disable_web_page_preview: options.disable_web_page_preview !== false
      };
if (options.parse_mode) {
  body.parse_mode = options.parse_mode;
}
      // BATCH 10: serialize + space outbound sends
      await acquireSendSlot(options);
      var response = await sendTelegramChunk(url, body, timeoutMs);
      lastStatus = response.status;

      if (!response.ok) {
        var errBody = '';
        try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
        var errMsg = 'HTTP ' + response.status;
        if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
        if (response.status === 429) {
          var rateLimitRes = handle429RateLimit(response, errBody, errMsg);
          rateLimitRes.chunks_total = chunks.length;
          rateLimitRes.chunks_sent = sentCount;
          console.warn('[TELEGRAM_RATE_LIMITED] honoring retry_after=' + (rateLimitRes.retry_after_seconds == null ? 'unknown' : rateLimitRes.retry_after_seconds) + 's, backoff=' + Math.round(rateLimitRes.backoff_ms / 1000) + 's, chunks_sent=' + sentCount + '/' + chunks.length);
          return rateLimitRes;
        }
        return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg, chunks_total: chunks.length, chunks_sent: sentCount };
      }

      sentCount++;
    }

    // BATCH 8: record cooldown only after a confirmed successful send.
    if (alertKey) recordAlertCooldown(alertKey, options.status || options.alert_status, options);
    return { ok: true, sent: true, skipped: false, reason: null, status: lastStatus, error_message: null, chunks_total: chunks.length, chunks_sent: sentCount };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, sent: false, skipped: false, reason: 'telegram_timeout', status: null, error_message: null, chunks_total: chunks.length, chunks_sent: sentCount };
    }
    return { ok: false, sent: false, skipped: false, reason: 'fetch_error', status: null, error_message: (e.message || 'unknown').substring(0, 100), chunks_total: chunks.length, chunks_sent: sentCount };
  }
}


async function sendTelegramDocument(documentBuffer, filename, options) {
  options = options || {};

  // 0. Market Hours Guard
  if (options.skip_market_guard !== true && options.skipMarketGuard !== true) {
    const checkDate = options.now != null ? options.now : (options.date != null ? options.date : new Date());
    if (!isMarketOpen(checkDate)) {
      const session = getMarketSession(checkDate);
      const wib = getWibComponents(checkDate);
      console.log(`[MARKET_GUARD_BLOCKED] Document broadcast cancelled: Market is CLOSED (Session: ${session}, Time: ${wib.timeStr || '-'} WIB)`);
      return {
        sent: false,
        skipped: true,
        reason: 'market_closed',
        session: session,
        time_wib: wib.timeStr,
        status: null,
        error_message: null
      };
    }
  }

  if (!isTelegramEnabled()) {
    return { sent: false, skipped: true, reason: 'telegram_disabled', status: null, error_message: null };
  }
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_token', status: null, error_message: null };
  }
  options = options || {};
  var chatId = options.chat_id ? String(options.chat_id) : process.env.TELEGRAM_CHAT_ID;
  if (!chatId || chatId.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_chat_id', status: null, error_message: null };
  }
  if (!documentBuffer || !Buffer.isBuffer(documentBuffer) || documentBuffer.length === 0) {
    return { sent: false, skipped: true, reason: 'empty_document', status: null, error_message: null };
  }

  var timeoutMs = Number(options.timeout_ms || options.timeoutMs || 12000);
  if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 12000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var form = new FormData();
    form.append('chat_id', chatId.trim());
    if (options.caption) form.append('caption', String(options.caption).slice(0, 1024));
    form.append('document', new Blob([documentBuffer], { type: options.content_type || 'image/svg+xml' }), filename || 'chart.svg');
    await acquireSendSlot(options); // BATCH 10: throttle
    var response = await fetch('https://api.telegram.org/bot' + token.trim() + '/sendDocument', {
      method: 'POST',
      body: form,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      var errBody = '';
      try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
      var errMsg = 'HTTP ' + response.status;
      if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
      if (response.status === 429) {
        return handle429RateLimit(response, errBody, errMsg);
      }
      return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg };
    }
    return { ok: true, sent: true, skipped: false, reason: null, status: response.status, error_message: null };
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') return { ok: false, sent: false, skipped: false, reason: 'telegram_timeout', status: null, error_message: null };
    return { ok: false, sent: false, skipped: false, reason: 'fetch_error', status: null, error_message: (e.message || 'unknown').substring(0, 100) };
  }
}


async function sendTelegramPhoto(photoBuffer, filename, caption, options) {
  options = options || {};

  // 0. Market Hours Guard
  if (options.skip_market_guard !== true && options.skipMarketGuard !== true) {
    const checkDate = options.now != null ? options.now : (options.date != null ? options.date : new Date());
    if (!isMarketOpen(checkDate)) {
      const session = getMarketSession(checkDate);
      const wib = getWibComponents(checkDate);
      console.log(`[MARKET_GUARD_BLOCKED] Photo broadcast cancelled: Market is CLOSED (Session: ${session}, Time: ${wib.timeStr || '-'} WIB)`);
      return {
        sent: false,
        skipped: true,
        reason: 'market_closed',
        session: session,
        time_wib: wib.timeStr,
        status: null,
        error_message: null
      };
    }
  }

  if (!isTelegramEnabled()) {
    return { sent: false, skipped: true, reason: 'telegram_disabled', status: null, error_message: null };
  }
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_token', status: null, error_message: null };
  }
  options = options || {};
  var chatId = options.chat_id ? String(options.chat_id) : process.env.TELEGRAM_CHAT_ID;
  if (!chatId || chatId.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_chat_id', status: null, error_message: null };
  }
  if (!photoBuffer || !Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0) {
    return { sent: false, skipped: true, reason: 'empty_photo', status: null, error_message: null };
  }

  var timeoutMs = Number(options.timeout_ms || options.timeoutMs || 12000);
  if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 12000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var form = new FormData();
    form.append('chat_id', chatId.trim());
    if (caption) form.append('caption', String(caption).slice(0, 1024));
    form.append('photo', new Blob([photoBuffer], { type: options.content_type || 'image/png' }), filename || 'chart.png');
    await acquireSendSlot(options); // BATCH 10: throttle
    var response = await fetch('https://api.telegram.org/bot' + token.trim() + '/sendPhoto', {
      method: 'POST',
      body: form,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      var errBody = '';
      try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
      var errMsg = 'HTTP ' + response.status;
      if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
      if (response.status === 429) {
        return handle429RateLimit(response, errBody, errMsg);
      }
      return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg };
    }
    return { ok: true, sent: true, skipped: false, reason: null, status: response.status, error_message: null };
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') return { ok: false, sent: false, skipped: false, reason: 'telegram_timeout', status: null, error_message: null };
    return { ok: false, sent: false, skipped: false, reason: 'fetch_error', status: null, error_message: (e.message || 'unknown').substring(0, 100) };
  }
}


async function sendTelegramPhotoUrl(photoUrl, caption, options) {
  options = options || {};

  // 0. Market Hours Guard
  if (options.skip_market_guard !== true && options.skipMarketGuard !== true) {
    const checkDate = options.now != null ? options.now : (options.date != null ? options.date : new Date());
    if (!isMarketOpen(checkDate)) {
      const session = getMarketSession(checkDate);
      const wib = getWibComponents(checkDate);
      console.log(`[MARKET_GUARD_BLOCKED] Photo URL broadcast cancelled: Market is CLOSED (Session: ${session}, Time: ${wib.timeStr || '-'} WIB)`);
      return {
        sent: false,
        skipped: true,
        reason: 'market_closed',
        session: session,
        time_wib: wib.timeStr,
        status: null,
        error_message: null
      };
    }
  }

  if (!isTelegramEnabled()) {
    return { sent: false, skipped: true, reason: 'telegram_disabled', status: null, error_message: null };
  }
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_token', status: null, error_message: null };
  }
  options = options || {};
  var chatId = options.chat_id ? String(options.chat_id) : process.env.TELEGRAM_CHAT_ID;
  if (!chatId || chatId.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_chat_id', status: null, error_message: null };
  }
  if (!photoUrl || String(photoUrl).trim() === '') {
    return { sent: false, skipped: true, reason: 'empty_photo_url', status: null, error_message: null };
  }

  var timeoutMs = Number(options.timeout_ms || options.timeoutMs || 3500);
  if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 3500;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var body = { chat_id: chatId.trim(), photo: String(photoUrl), caption: String(caption || '').slice(0, 1024) };
    await acquireSendSlot(options); // BATCH 10: throttle
    var response = await fetch('https://api.telegram.org/bot' + token.trim() + '/sendPhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      var errBody = '';
      try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
      var errMsg = 'HTTP ' + response.status;
      if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
      if (response.status === 429) {
        return handle429RateLimit(response, errBody, errMsg);
      }
      return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg };
    }
    return { ok: true, sent: true, skipped: false, reason: null, status: response.status, error_message: null };
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') return { ok: false, sent: false, skipped: false, reason: 'telegram_timeout', status: null, error_message: null };
    return { ok: false, sent: false, skipped: false, reason: 'fetch_error', status: null, error_message: (e.message || 'unknown').substring(0, 100) };
  }
}

/**
 * Format text for safe Telegram plain-text sending.
 * Strips HTML/markdown that could break plain-text mode.
 * @param {string} text
 * @returns {string}
 */
function handle429RateLimit(response, errBody, errMsg) {
  var retryAfter = null;
  try {
    var parsed429 = errBody ? JSON.parse(errBody) : null;
    retryAfter = parsed429 && parsed429.parameters ? Number(parsed429.parameters.retry_after) : null;
  } catch (parseErr) { /* ignore */ }
  if (!Number.isFinite(retryAfter) || retryAfter < 0) {
    retryAfter = response.headers && response.headers.get ? Number(response.headers.get('retry-after')) : null;
  }
  if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = null;
  var backoffMs = applyRateLimitBackoff(retryAfter);
  return {
    ok: false,
    sent: false,
    skipped: false,
    reason: 'rate_limited',
    status: 429,
    retry_after_seconds: retryAfter,
    backoff_ms: backoffMs,
    error_message: errMsg
  };
}

function formatTelegramSafeText(text) {
  if (!text) return '';
  // Remove HTML tags
  var clean = text.replace(/<\/?(?:[a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, '');
  // Collapse multiple newlines
  clean = clean.replace(/\n{3,}/g, '\n\n');
  // Trim
  return clean.trim();
}

module.exports = {
  isTelegramEnabled: isTelegramEnabled,
  sendTelegramMessage: sendTelegramMessage,
  sendTelegramDocument: sendTelegramDocument,
  sendTelegramPhoto: sendTelegramPhoto,
  sendTelegramPhotoUrl: sendTelegramPhotoUrl,
  splitTelegramMessage: splitTelegramMessage,
  formatTelegramSafeText: formatTelegramSafeText,
  // BATCH 8: stateful alert dedup / cooldown primitives
  DEFAULT_ALERT_COOLDOWN_MS: DEFAULT_ALERT_COOLDOWN_MS,
  checkAlertCooldown: checkAlertCooldown,
  recordAlertCooldown: recordAlertCooldown,
  clearAlertCooldownCache: clearAlertCooldownCache,
  getAlertCooldownStatus: getAlertCooldownStatus,
  isDrasticAlertStatusChange: isDrasticAlertStatusChange,
  // BATCH 10: outbound throttle / 429 backoff primitives
  DEFAULT_SEND_INTERVAL_MS: DEFAULT_SEND_INTERVAL_MS,
  acquireSendSlot: acquireSendSlot,
  applyRateLimitBackoff: applyRateLimitBackoff,
  resetTelegramThrottle: resetTelegramThrottle,
  getTelegramThrottleState: getTelegramThrottleState
};

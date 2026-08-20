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
      var response = await sendTelegramChunk(url, body, timeoutMs);
      lastStatus = response.status;

      if (!response.ok) {
        var errBody = '';
        try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
        var errMsg = 'HTTP ' + response.status;
        if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
        if (response.status === 429) {
          var retryAfter = null;
          try {
            var parsed429 = errBody ? JSON.parse(errBody) : null;
            retryAfter = parsed429 && parsed429.parameters ? Number(parsed429.parameters.retry_after) : null;
          } catch (parseErr) { /* ignore */ }
          if (!Number.isFinite(retryAfter) || retryAfter < 0) {
            retryAfter = response.headers && response.headers.get ? Number(response.headers.get('retry-after')) : null;
          }
          if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = null;
          return { ok: false, sent: false, skipped: false, reason: 'rate_limited', status: 429, retry_after_seconds: retryAfter, error_message: errMsg, chunks_total: chunks.length, chunks_sent: sentCount };
        }
        return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg, chunks_total: chunks.length, chunks_sent: sentCount };
      }

      sentCount++;
    }

    return { ok: true, sent: true, skipped: false, reason: null, status: lastStatus, error_message: null, chunks_total: chunks.length, chunks_sent: sentCount };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, sent: false, skipped: false, reason: 'telegram_timeout', status: null, error_message: null, chunks_total: chunks.length, chunks_sent: sentCount };
    }
    return { ok: false, sent: false, skipped: false, reason: 'fetch_error', status: null, error_message: (e.message || 'unknown').substring(0, 100), chunks_total: chunks.length, chunks_sent: sentCount };
  }
}


async function sendTelegramDocument(documentBuffer, filename, options) {
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
function formatTelegramSafeText(text) {
  if (!text) return '';
  // Remove HTML tags
  var clean = text.replace(/<[^>]*>/g, '');
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
  formatTelegramSafeText: formatTelegramSafeText
};

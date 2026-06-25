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
  var chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId || chatId.trim() === '') {
    return { sent: false, skipped: true, reason: 'missing_chat_id', status: null, error_message: null };
  }

  // 4. Check message text
  if (!text || text.trim() === '') {
    return { sent: false, skipped: true, reason: 'empty_message', status: null, error_message: null };
  }

  // 5. Build request
  options = options || {};
  var url = 'https://api.telegram.org/bot' + token.trim() + '/sendMessage';
  var body = {
    chat_id: chatId.trim(),
    text: text,
    disable_web_page_preview: options.disable_web_page_preview !== false
  };
  if (options.parse_mode) {
    body.parse_mode = options.parse_mode;
  }

  // 6. Send (never throw)
  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    var status = response.status;

    if (response.ok) {
      return { sent: true, skipped: false, reason: null, status: status, error_message: null };
    }

    // Non-OK response
    var errBody = '';
    try { errBody = await response.text(); } catch (e) { /* ignore */ }
    var errMsg = 'HTTP ' + status;
    if (errBody && errBody.length < 200) errMsg += ': ' + errBody;

    return { sent: false, skipped: false, reason: 'api_error', status: status, error_message: errMsg };
  } catch (e) {
    return { sent: false, skipped: false, reason: 'fetch_error', status: null, error_message: (e.message || 'unknown').substring(0, 100) };
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
  formatTelegramSafeText: formatTelegramSafeText
};

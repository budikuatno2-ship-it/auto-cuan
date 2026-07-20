'use strict';

// ===========================================================================
// Telegram VERIFICATION bot client.
//
// STRICT ISOLATION:
//  - Uses ONLY process.env.TELEGRAM_VERIFY_BOT_TOKEN. It never reads
//    TELEGRAM_BOT_TOKEN and has no fallback to it.
//  - It does NOT import lib/telegram-notifier.js (the recommendation bot).
//  - The token is never logged. Full Telegram responses are never logged; only
//    coarse, sanitized error codes are surfaced.
//
// All methods are awaited HTTP calls with a short timeout so a slow Telegram API
// cannot exhaust the serverless function budget.
// ===========================================================================

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const DEFAULT_TIMEOUT_MS = 5000;
const INVITE_TTL_SECONDS = 30 * 60;
const INVITE_MEMBER_LIMIT = 1;

function getVerifyBotToken() {
  const t = process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  return (typeof t === 'string' && t.length > 0) ? t : null;
}

// Sanitized error: carries only a coarse code, never the token or raw response.
function botError(code) {
  const e = new Error('verify_bot_error');
  e.code = code;
  return e;
}

// Low-level Telegram method call. Returns the `result` field on success.
async function callTelegram(method, payload, opts) {
  const token = getVerifyBotToken();
  if (!token) throw botError('verify_bot_token_missing');

  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let signal;
  try { signal = AbortSignal.timeout(timeoutMs); } catch (e) { signal = undefined; }

  let resp;
  try {
    resp = await fetch(TELEGRAM_API_BASE + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: signal
    });
  } catch (e) {
    // Network error / timeout. Do not leak details.
    throw botError('network_error');
  }

  let json = null;
  try { json = await resp.json(); } catch (e) { json = null; }

  if (!resp.ok || !json || json.ok !== true) {
    // Surface only a coarse code; never the full Telegram response body.
    throw botError('telegram_api_error');
  }
  return json.result;
}

// --- Public methods ---------------------------------------------------------

async function sendMessage(chatId, text, options) {
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true
  };
  if (options && options.reply_markup) payload.reply_markup = options.reply_markup;
  return await callTelegram('sendMessage', payload);
}

async function editMessageText(chatId, messageId, text, options) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    disable_web_page_preview: true
  };
  if (options && options.reply_markup) payload.reply_markup = options.reply_markup;
  return await callTelegram('editMessageText', payload);
}

async function answerCallbackQuery(callbackQueryId, options) {
  const payload = { callback_query_id: callbackQueryId };
  if (options && typeof options.text === 'string') payload.text = options.text;
  return await callTelegram('answerCallbackQuery', payload);
}

async function getChatMember(chatId, userId) {
  return await callTelegram('getChatMember', { chat_id: chatId, user_id: userId });
}

// Create a single-use, ~30-minute invite link. Returns the invite_link string.
async function createChatInviteLink(chatId, options) {
  const ttl = (options && options.expireSeconds) || INVITE_TTL_SECONDS;
  const memberLimit = (options && options.memberLimit) || INVITE_MEMBER_LIMIT;
  const payload = {
    chat_id: chatId,
    expire_date: Math.floor(Date.now() / 1000) + ttl,
    member_limit: memberLimit,
    creates_join_request: false
  };
  const result = await callTelegram('createChatInviteLink', payload);
  return result && result.invite_link ? result.invite_link : null;
}

async function revokeChatInviteLink(chatId, inviteLink) {
  return await callTelegram('revokeChatInviteLink', { chat_id: chatId, invite_link: inviteLink });
}

// Factory returning a bot object (handy for dependency injection / testing).
function createVerifyBot() {
  return {
    sendMessage,
    editMessageText,
    answerCallbackQuery,
    getChatMember,
    createChatInviteLink,
    revokeChatInviteLink
  };
}

module.exports = {
  createVerifyBot,
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  getChatMember,
  createChatInviteLink,
  revokeChatInviteLink,
  // exposed for isolation tests
  __getVerifyBotToken: getVerifyBotToken
};

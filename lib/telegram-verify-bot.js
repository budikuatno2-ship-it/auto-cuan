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
// Safe, non-secret invite link name. It never encodes a user id, username, code,
// or any other identifier. Kept well under Telegram's 32-char name limit.
const INVITE_LINK_NAME = 'Auto-Cuan Verifikasi';
const INVITE_NAME_MAX = 32;

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

// Remove the inline keyboard from an existing message. Sends an EMPTY inline
// keyboard so the used "Ajukan Bergabung" button disappears while leaving the
// message text untouched. Uses TELEGRAM_VERIFY_BOT_TOKEN only, the shared short
// timeout, and sanitized errors (never logs the token or full Telegram body).
async function editMessageReplyMarkup(chatId, messageId) {
  return await callTelegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] }
  });
}

async function deleteMessage(chatId, messageId) {
  return await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
}

async function answerCallbackQuery(callbackQueryId, options) {
  const payload = { callback_query_id: callbackQueryId };
  if (options && typeof options.text === 'string') payload.text = options.text;
  return await callTelegram('answerCallbackQuery', payload);
}

async function getChatMember(chatId, userId) {
  return await callTelegram('getChatMember', { chat_id: chatId, user_id: userId });
}

// Create a JOIN-REQUEST invite link (~30-minute expiry). Clicking it creates a
// pending chat_join_request instead of adding the user immediately, so the
// webhook can match the requester's Telegram id against the approved website
// account before approving. NO member_limit is ever sent (a member limit is
// incompatible with creates_join_request and would let the FIRST clicker in).
// Returns the invite_link string.
async function createChatInviteLink(chatId, options) {
  const ttl = (options && options.expireSeconds) || INVITE_TTL_SECONDS;
  let name = (options && typeof options.name === 'string' && options.name) ? options.name : INVITE_LINK_NAME;
  if (name.length > INVITE_NAME_MAX) name = name.slice(0, INVITE_NAME_MAX);
  const payload = {
    chat_id: chatId,
    expire_date: Math.floor(Date.now() / 1000) + ttl,
    creates_join_request: true,
    name: name
  };
  const result = await callTelegram('createChatInviteLink', payload);
  return result && result.invite_link ? result.invite_link : null;
}

async function revokeChatInviteLink(chatId, inviteLink) {
  return await callTelegram('revokeChatInviteLink', { chat_id: chatId, invite_link: inviteLink });
}

// Approve a pending chat join request for a specific user id. Awaited, short
// timeout, sanitized errors only.
async function approveChatJoinRequest(chatId, userId) {
  return await callTelegram('approveChatJoinRequest', { chat_id: chatId, user_id: userId });
}

// Decline a pending chat join request for a specific user id. Awaited, short
// timeout, sanitized errors only. Used to fail closed for every request that is
// not an exact match to an approved, eligible account with a valid invite.
async function declineChatJoinRequest(chatId, userId) {
  return await callTelegram('declineChatJoinRequest', { chat_id: chatId, user_id: userId });
}

// Factory returning a bot object (handy for dependency injection / testing).
function createVerifyBot() {
  return {
    sendMessage,
    editMessageText,
    editMessageReplyMarkup,
    deleteMessage,
    answerCallbackQuery,
    getChatMember,
    createChatInviteLink,
    revokeChatInviteLink,
    approveChatJoinRequest,
    declineChatJoinRequest
  };
}

module.exports = {
  createVerifyBot,
  sendMessage,
  editMessageText,
  editMessageReplyMarkup,
  deleteMessage,
  answerCallbackQuery,
  getChatMember,
  createChatInviteLink,
  revokeChatInviteLink,
  approveChatJoinRequest,
  declineChatJoinRequest,
  INVITE_LINK_NAME,
  // exposed for isolation tests
  __getVerifyBotToken: getVerifyBotToken
};

'use strict';

const env = require('./runtime-env');
const API = 'https://api.telegram.org/bot';
const TIMEOUT = 5000;

function sanitizedError(code) { const error = new Error('admin_bot_error'); error.code = code; return error; }
function token() { return env.adminTelegramConfig().token; }
async function call(method, payload, multipart) {
  let response;
  try {
    response = await fetch(API + token() + '/' + method, {
      method: 'POST',
      headers: multipart ? undefined : { 'Content-Type': 'application/json' },
      body: multipart || JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(TIMEOUT)
    });
  } catch (_) { throw sanitizedError('network_error'); }
  let json; try { json = await response.json(); } catch (_) { json = null; }
  if (!response.ok || !json || json.ok !== true) throw sanitizedError('telegram_api_error');
  return json.result;
}
function sendMessage(chatId, text, options) {
  return call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...(options || {}) });
}
function sendChatAction(chatId) { return call('sendChatAction', { chat_id: chatId, action: 'typing' }); }
function answerCallbackQuery(id, options) { return call('answerCallbackQuery', { callback_query_id: id, ...(options || {}) }); }
async function sendBytes(chatId, bytes, mimeType, filename, caption, replyMarkup) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw sanitizedError('media_too_large');
  const image = /^image\/(jpeg|png)$/.test(mimeType);
  const field = image ? 'photo' : 'document'; const form = new FormData();
  form.set('chat_id', String(chatId)); form.set(field, new Blob([bytes], { type: mimeType }), filename);
  if (caption) form.set('caption', caption); if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
  return call(image ? 'sendPhoto' : 'sendDocument', null, form);
}
module.exports = { call, sendMessage, sendChatAction, answerCallbackQuery, sendBytes, __token: token };
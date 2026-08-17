'use strict';

async function previousMessageId(db, chatId, scope) {
  if (!db || typeof db.from !== 'function') return null;
  try {
    const result = await db.from('telegram_transient_messages')
      .select('message_id')
      .eq('chat_id', Number(chatId))
      .eq('scope', scope)
      .maybeSingle();
    const id = result && !result.error && result.data ? Number(result.data.message_id) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (_) { return null; }
}

async function forget(db, chatId, scope) {
  if (!db || typeof db.from !== 'function') return;
  try {
    await db.from('telegram_transient_messages')
      .delete()
      .eq('chat_id', Number(chatId))
      .eq('scope', scope);
  } catch (_) {}
}

async function remember(db, chatId, scope, messageId) {
  if (!db || typeof db.from !== 'function') return;
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || id < 1) return;
  try {
    await db.from('telegram_transient_messages').upsert({
      chat_id:Number(chatId),
      scope:scope,
      message_id:id,
      updated_at:new Date().toISOString()
    }, { onConflict:'chat_id,scope' });
  } catch (_) {}
}

async function deletePrevious(db, sender, chatId, scope) {
  const previous = await previousMessageId(db, chatId, scope);
  if (!previous) return false;
  try {
    if (sender && typeof sender.deleteMessage === 'function') {
      await sender.deleteMessage(Number(chatId), previous);
    }
  } catch (_) {}
  await forget(db, chatId, scope);
  return true;
}

async function sendTransient(options) {
  const opts = options || {};
  const sender = opts.sender;
  const db = opts.db;
  const chatId = Number(opts.chatId);
  const scope = String(opts.scope || 'general_user');
  if (!sender || typeof sender.sendMessage !== 'function' || !Number.isSafeInteger(chatId)) return null;

  await deletePrevious(db, sender, chatId, scope);
  let sent = null;
  try { sent = await sender.sendMessage(chatId, opts.text, opts.extra); }
  catch (_) { return null; }
  const messageId = Number(sent && sent.message_id);
  if (Number.isSafeInteger(messageId) && messageId > 0) await remember(db, chatId, scope, messageId);
  return sent;
}

module.exports = { previousMessageId, forget, remember, deletePrevious, sendTransient };

'use strict';

/**
 * Long-polling runner for the Auto-Cuan interactive Telegram bot.
 *
 * Uses Telegram getUpdates directly so the process does not pull in a bot
 * framework. Timeout is 50s, which keeps the process blocked in the network
 * read instead of spinning the CPU while idle.
 */

const http = require('http');
const path = require('path');

const {
  createInteractiveBot,
  loadRuntimeEnv
} = require('../lib/telegram-interactive-bot');

const ROOT = path.resolve(__dirname, '..');
loadRuntimeEnv(ROOT, process.env);

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_SEC = 50;

function log(level, message) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException ' + (err && err.message ? err.message : 'unknown'));
});

process.on('unhandledRejection', (err) => {
  log('error', 'unhandledRejection ' + (err && err.message ? err.message : 'unknown'));
});

function createTelegramApi(token, fetchFn) {
  async function call(method, payload) {
    let response;
    let body;
    try {
      response = await fetchFn(TELEGRAM_API + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      body = await response.json();
    } catch (err) {
      // BUG-BOT-POLL-ERR (2026-10-13): a fetch/parse failure used to surface as
      // an opaque error with no message or code. Preserve the real cause so the
      // polling loop can log err.message / err.code and operators can tell a
      // DNS failure from a 409 conflict.
      const error = new Error('telegram_' + method + '_transport_error: ' + (err && err.message ? err.message : String(err)));
      error.status = null;
      error.code = (err && err.code) || 'TRANSPORT_ERROR';
      throw error;
    }
    if (!response.ok || !body.ok) {
      // BUG-BOT-POLL-ERR: the static 'telegram_<method>_failed' text hid the
      // upstream error code and description. Telegram returns
      // { ok:false, error_code, description }; surface both explicitly.
      const description = body && body.description ? String(body.description) : '';
      const errorCode = body && body.error_code ? Number(body.error_code) : null;
      const error = new Error(
        'telegram_' + method + '_failed' +
        (errorCode ? ' code=' + errorCode : '') +
        (description ? ' desc=' + description : '')
      );
      error.status = response.status;
      error.code = errorCode || response.status;
      error.description = description || null;
      throw error;
    }
    return body.result;
  }

  return {
    sendMessage(chatId, text, extra) {
      return call('sendMessage', Object.assign({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      }, extra || {}));
    },
    editMessageText(chatId, messageId, _unused, text, extra) {
      return call('editMessageText', Object.assign({
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true
      }, extra || {}));
    },
    pinChatMessage(chatId, messageId, extra) {
      return call('pinChatMessage', Object.assign({ chat_id: chatId, message_id: messageId }, extra || {}));
    },
    deleteMessage(chatId, messageId) {
      return call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
    answerCallbackQuery(id, extra) {
      return call('answerCallbackQuery', Object.assign({ callback_query_id: id }, extra || {}));
    },
    getUpdates(offset) {
      return call('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ['message', 'callback_query']
      });
    }
  };
}

function createContext(api, update) {
  const callback = update.callback_query || null;
  const message = callback ? callback.message : update.message;
  const from = callback ? callback.from : (message && message.from);
  const chat = message && message.chat;
  const startPayload = message && typeof message.text === 'string' && message.text.startsWith('/start')
    ? message.text.split(/\s+/)[1] || ''
    : '';
  return {
    from,
    chat,
    message,
    startPayload,
    callbackQuery: callback,
    telegram: api,
    reply(text, extra) {
      return api.sendMessage(chat.id, text, extra);
    },
    deleteMessage(messageId) {
      return api.deleteMessage(chat.id, messageId);
    },
    answerCbQuery(text) {
      return api.answerCallbackQuery(callback.id, { text });
    },
    editMessageText(text, extra) {
      return api.editMessageText(chat.id, message.message_id, undefined, text, extra);
    }
  };
}

async function main() {
  const token = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log('error', 'BOT_TOKEN missing');
    process.exit(1);
  }
  let createClient = null;
  try {
    createClient = require('@supabase/supabase-js').createClient;
  } catch (_) {
    createClient = null;
  }
  const bot = createInteractiveBot({
    env: process.env,
    rootDir: ROOT,
    createClient
  });
  const port = Number(process.env.BOT_WEBVIEW_PORT || 3010);
  const server = bot.createWebServer();
  server.on('error', (err) => {
    log('error', 'web_server_error ' + (err && err.message ? err.message : 'unknown'));
    if (err && err.code === 'EADDRINUSE') {
      log('warn', `Port ${port} in use, will retry listening in 5s...`);
      setTimeout(() => {
        try { server.close(); } catch (_) {}
        server.listen(port, '127.0.0.1');
      }, 5000);
    }
  });
  server.listen(port, '127.0.0.1');
  const api = createTelegramApi(token, globalThis.fetch);
  let offset = 0;
  log('info', 'interactive bot polling started');

  async function shutdown() {
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // BUG-BOT-POLL-ERR (2026-10-13): the old loop logged the static string
  // 'poll_failed' (no err.message, no err.code) and slept a flat 3s forever.
  // Production evidence: 404 PM2 restarts on autocuan-bot from a crash-loop
  // where every failure looked identical in the logs. Now each failure logs
  // the real message and code, and the wait backs off exponentially
  // (2s -> 5s -> 10s, capped) so a persistent upstream outage cannot spin the
  // process at full speed. A successful poll resets the backoff.
  const BACKOFF_SCHEDULE_MS = [2000, 5000, 10000, 15000];
  let pollFailureStreak = 0;

  function nextBackoffMs(streak) {
    const index = Math.min(Math.max(streak - 1, 0), BACKOFF_SCHEDULE_MS.length - 1);
    return BACKOFF_SCHEDULE_MS[index];
  }

  for (;;) {
    let updates = [];
    try {
      updates = await api.getUpdates(offset);
      pollFailureStreak = 0;
    } catch (err) {
      pollFailureStreak += 1;
      const waitMs = nextBackoffMs(pollFailureStreak);
      log('error', 'poll_failed attempt=' + pollFailureStreak +
        ' code=' + ((err && err.code) || 'unknown') +
        ' status=' + ((err && err.status) || '-') +
        ' message=' + ((err && err.message) || 'unknown') +
        ' retry_in_ms=' + waitMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    for (const update of updates || []) {
      offset = update.update_id + 1;
      try {
        await bot.handleUpdate(createContext(api, update));
      } catch (err) {
        log('error', 'update_failed ' +
          'code=' + ((err && err.code) || 'internal') +
          ' message=' + ((err && err.message) || 'unknown'));
      }
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    log('error', 'fatal ' + (err && err.message ? err.message : 'unknown'));
    process.exit(1);
  });
}

module.exports = {
  createTelegramApi,
  createContext
};

'use strict';

/**
 * Long-polling runner for the AutoCuan VERIFICATION bot (@AutoCuanVerificationBot).
 *
 * WHY THIS EXISTS
 * ---------------
 * The verification bot used to depend on a Telegram webhook delivered to Vercel
 * (primary) with a trycloudflare tunnel as the VPS fallback. Both are fragile:
 * Vercel returns HTTP 402 when the deployment is disabled, and a quick tunnel
 * dies on every restart, which silently made the bot go deaf (double ticks, no
 * reply). This runner removes the webhook dependency entirely: it owns the
 * Telegram update stream with getUpdates and dispatches every update through the
 * exact same processing pipeline the webhook used, so behaviour (approval gate,
 * join-request gate, deep-link registration, account commands) is identical.
 *
 * PIPELINE (same order as lib/reset-password-legacy-handler.js handleVerifyWebhook)
 *   1. lib/auth-recovery       — password-reset approvals + enrollment codes
 *   2. lib/admin-access        — account/help/subscription/voucher-admin commands
 *   3. lib/telegram-verification — verification + account commands + join requests
 *
 * STRICT ISOLATION
 *   - Uses ONLY TELEGRAM_VERIFY_BOT_TOKEN. It never reads TELEGRAM_BOT_TOKEN.
 *   - The token is never logged.
 *   - Memory-warm: a single getUpdates long-poll loop, no framework, <100 MB.
 *
 * USAGE
 *   node tools/telegram-verify-bot.js            # run the poller (PM2 entry)
 *   node tools/telegram-verify-bot.js --once     # process one batch then exit
 *   node tools/telegram-verify-bot.js --status   # print getWebhookInfo/getMe only
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_SEC = 50;
const POLL_ERROR_BACKOFF_MS = 3000;
// Telegram deletes the webhook itself the moment getUpdates is called, but an
// explicit deleteWebhook on boot makes the "polling mode" intent unambiguous.
//
// CRITICAL: drop_pending_updates MUST be false. With `true`, EVERY restart of
// this poller permanently destroys all user messages that arrived while the
// process was down or being restarted — which is exactly what makes the bot look
// dead ("I sent /start and it never answered"). Telegram only forgets an update
// once we confirm it via getUpdates(offset), so leaving pending updates alone
// means a restart REPLAYS them instead of losing them. Reprocessing is safe:
// claimWebhookUpdate() in lib/telegram-verification.js is a durable
// exactly-once gate, so a replayed update returns 'duplicate' and is skipped.
const DROP_PENDING_ON_BOOT = process.env.VERIFY_POLL_DROP_PENDING === '1';
// Watchdog: if the poll loop cannot complete a single successful call for this
// long, exit so PM2 restarts a clean process instead of a silently stuck one.
const STALL_RESTART_MS = Number(process.env.VERIFY_POLL_STALL_RESTART_MS) || 20 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = Number(process.env.VERIFY_POLL_MAX_FAILURES) || 30;

function log(level, message) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: level,
    msg: message
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Env loading. The VPS keeps secrets split across owner-only runner files, so
// every known location is probed in order; the first non-empty value wins.
// ---------------------------------------------------------------------------
function loadEnvFile(file, env) {
  const target = env || process.env;
  if (!file || !fs.existsSync(file)) return false;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return false; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (target[key] == null || target[key] === '') target[key] = value;
  }
  return true;
}

// Same source list AND order as tools/local-dev-server.js (the process that
// served the VPS webhook fallback), so the poller sees exactly the same
// environment the webhook handler saw. First non-empty value wins, which is why
// the placeholder .env never shadows the real runner secrets.
function loadRuntimeEnv(rootDir, env) {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  const files = [
    path.join(rootDir, '.env'),
    path.join(rootDir, '.env.intraday-runtime'),
    path.join(rootDir, '.env.bot'),
    path.join(rootDir, '.env.local'),
    path.join(rootDir, '.env.preview.local'),
    path.join(rootDir, '.env.production.local'),
    path.join(runnerDir, 'telegram-webhook-v3-secret.env'),
    path.join(runnerDir, 'telegram-lifecycle.env'),
    path.join(runnerDir, 'telegram-auth-recovery-secret.env'),
    path.join(runnerDir, 'session-secret.env'),
    path.join(rootDir, '.env.ai-eval-once'),
    // Optional overrides for this poller specifically, plus the runner runtime
    // env (holds TELEGRAM_VERIFY_ADMIN_CHAT_ID). Loaded last so they only fill
    // gaps that no production source provided.
    path.join(rootDir, 'deploy', 'vps', 'telegram-verify-bot.env'),
    path.join(runnerDir, 'telegram-verify-bot.env'),
    path.join(runnerDir, '.env')
  ];
  for (const file of files) loadEnvFile(file, env);
  return env;
}

// ---------------------------------------------------------------------------
// Minimal Telegram API client (sendMessage/edit/delete/answer/callback + the
// join-request methods the verification flow needs). Short timeouts so a slow
// Telegram API can never stall the poll loop for long.
// ---------------------------------------------------------------------------
function createTelegramApi(token, fetchFn, timeoutMs) {
  const timeout = Number(timeoutMs) || 15000;
  // getUpdates holds the connection open for the whole long-poll window, so its
  // HTTP timeout MUST exceed POLL_TIMEOUT_SEC — otherwise every poll aborts with
  // a client-side timeout (DOMException code 23) and the bot looks "deaf" while
  // Telegram still considers the updates delivered.
  const pollTimeoutMs = (POLL_TIMEOUT_SEC + 20) * 1000;
  async function call(method, payload, overrideTimeoutMs) {
    let signal;
    try { signal = AbortSignal.timeout(Number(overrideTimeoutMs) || timeout); } catch (_) { signal = undefined; }
    const response = await fetchFn(TELEGRAM_API + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: signal
    });
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok || !body || body.ok !== true) {
      const error = new Error('telegram_' + method + '_failed');
      error.status = response.status;
      error.code = (body && body.description) ? String(body.description).slice(0, 120) : 'telegram_api_error';
      throw error;
    }
    return body.result;
  }

  return {
    sendMessage(chatId, text, extra) {
      return call('sendMessage', Object.assign({
        chat_id: chatId,
        text: text,
        disable_web_page_preview: true
      }, extra || {}));
    },
    editMessageText(chatId, messageId, text, extra) {
      return call('editMessageText', Object.assign({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        disable_web_page_preview: true
      }, extra || {}));
    },
    editMessageReplyMarkup(chatId, messageId) {
      return call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });
    },
    deleteMessage(chatId, messageId) {
      return call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
    scheduleMessageDeletion(chatId, messageId, delayMs) {
      if (!Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId))) return null;
      const timer = setTimeout(() => {
        call('deleteMessage', { chat_id: Number(chatId), message_id: Number(messageId) }).catch(() => {});
      }, Math.max(100, Number(delayMs) || 0));
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    answerCallbackQuery(callbackQueryId, options) {
      const payload = { callback_query_id: callbackQueryId };
      if (options && typeof options.text === 'string') payload.text = options.text;
      return call('answerCallbackQuery', payload);
    },
    getChatMember(chatId, userId) {
      return call('getChatMember', { chat_id: chatId, user_id: userId });
    },
    createChatInviteLink(chatId, options) {
      const payload = Object.assign({ chat_id: chatId }, options || {});
      return call('createChatInviteLink', payload).then((r) => (r && r.invite_link) ? r.invite_link : null);
    },
    revokeChatInviteLink(chatId, inviteLink) {
      return call('revokeChatInviteLink', { chat_id: chatId, invite_link: inviteLink });
    },
    approveChatJoinRequest(chatId, userId) {
      return call('approveChatJoinRequest', { chat_id: chatId, user_id: userId });
    },
    declineChatJoinRequest(chatId, userId) {
      return call('declineChatJoinRequest', { chat_id: chatId, user_id: userId });
    },
    getMe() {
      return call('getMe', {});
    },
    getWebhookInfo() {
      return call('getWebhookInfo', {});
    },
    deleteWebhook(dropPending) {
      return call('deleteWebhook', { drop_pending_updates: dropPending === true });
    },
    setMyCommands(commands) {
      return call('setMyCommands', { commands: commands });
    },
    getMyCommands() {
      return call('getMyCommands', {});
    },
    getUpdates(offset, timeoutSec) {
      return call('getUpdates', {
        offset: offset,
        timeout: timeoutSec || POLL_TIMEOUT_SEC,
        allowed_updates: ['message', 'callback_query', 'chat_join_request']
      }, pollTimeoutMs);
    }
  };
}

// ---------------------------------------------------------------------------
// Update dispatch. Identical ordering + isolation to the webhook handler.
// ---------------------------------------------------------------------------
function createDispatcher(deps) {
  const db = deps.db;
  const bot = deps.bot;
  const recovery = require(path.join(ROOT, 'lib', 'auth-recovery'));
  const adminAccess = require(path.join(ROOT, 'lib', 'admin-access'));
  const verification = require(path.join(ROOT, 'lib', 'telegram-verification'));
  const registerTokenStore = require(path.join(ROOT, 'lib', 'telegram-register-token'));
  const magicTokenStore = require(path.join(ROOT, 'lib', 'telegram-magic-token'));

  // Last-resort reply so a private chat is NEVER left with silent double ticks.
  // Only fires when every handler above failed to produce any output.
  async function sendSilentFailureFallback(update) {
    const msg = update && update.message;
    const chat = msg && msg.chat;
    if (!chat || chat.type !== 'private' || chat.id == null) return;
    try {
      await bot.sendMessage(chat.id, [
        '\u26A0\uFE0F Pesan Anda belum dapat diproses',
        '',
        'Terjadi gangguan sementara pada sistem kami. Silakan kirim ulang /start beberapa saat lagi.',
        'Jika masih gagal, hubungi admin.'
      ].join('\n'));
    } catch (_) { /* nothing else we can do */ }
  }

  return async function dispatch(update) {
    const recoveryResult = await recovery.handleRecoveryUpdate(update, {
      db: db,
      bot: bot,
      baseUrl: process.env.AUTH_RECOVERY_BASE_URL || 'https://autocuan.web.id'
    });
    if (recoveryResult && recoveryResult.handled) return recoveryResult;

    const adminAccessResult = await adminAccess.handleAdminAccessUpdate(update, { db: db, bot: bot });
    if (adminAccessResult && adminAccessResult.handled) return adminAccessResult;

    const result = await verification.processWebhookUpdate(update, {
      supabase: db,
      bot: bot,
      registerTokenStore: registerTokenStore,
      magicTokenStore: magicTokenStore
    });

    // A message that produced no outcome at all would leave the user staring at
    // double ticks. Answer explicitly instead of staying silent.
    if (!result || !result.outcome) {
      await sendSilentFailureFallback(update);
      return { outcome: 'no_handler_answered' };
    }
    if (result.outcome === 'error' && update && update.message) {
      await sendSilentFailureFallback(update);
      return { outcome: 'error_answered' };
    }
    return result;
  };
}

function makeDb() {
  let createClient = null;
  try { createClient = require('@supabase/supabase-js').createClient; } catch (_) { createClient = null; }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient || !url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function main() {
  loadRuntimeEnv(ROOT, process.env);

  const args = new Set(process.argv.slice(2));
  const token = process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  if (!token || typeof token !== 'string' || token.length < 16) {
    log('error', 'TELEGRAM_VERIFY_BOT_TOKEN missing');
    process.exit(1);
  }

  const api = createTelegramApi(token, globalThis.fetch, Number(process.env.VERIFY_POLL_API_TIMEOUT_MS) || 15000);

  // Identity guard: BOT 2 is @AutoCuanVerificationBot. If the token ever points
  // at another bot (e.g. the signal bot token pasted into the wrong env var),
  // fail loudly instead of silently serving the wrong bot's updates.
  const EXPECTED_USERNAME = String(process.env.VERIFY_BOT_EXPECTED_USERNAME || 'AutoCuanVerificationBot').replace(/^@/, '');
  let me = null;
  let meError = null;
  for (let attempt = 0; attempt < 3 && !me; attempt++) {
    me = await api.getMe().catch((e) => { meError = (e && e.code) || e.message || 'unknown'; return null; });
    if (!me) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!me || !me.username) {
    log('error', 'getMe failed — cannot confirm bot identity (' + meError + ')');
    process.exit(1);
  }
  if (me.username !== EXPECTED_USERNAME) {
    log('error', 'identity mismatch: token belongs to @' + me.username + ', expected @' + EXPECTED_USERNAME);
    process.exit(1);
  }
  if (me.id === Number(process.env.TELEGRAM_BOT_ID_GUARD)) {
    log('error', 'identity collision: this token is the signal bot');
    process.exit(1);
  }

  if (args.has('--status')) {
    const hook = await api.getWebhookInfo().catch(() => null);
    console.log(JSON.stringify({
      bot: { id: me.id, username: me.username, name: me.first_name || null },
      webhook: hook ? { url: hook.url || '', pending_update_count: hook.pending_update_count || 0, last_error_message: hook.last_error_message || null } : null,
      polling_mode: true
    }, null, 2));
    return;
  }

  // Optional one-shot sync of the official BotFather command menu. This is the
  // programmatic equivalent of /setcommands for @AutoCuanVerificationBot; it
  // only lists commands that the poller actually dispatches (member + admin).
  if (args.has('--set-commands')) {
    const MEMBER_COMMANDS = [
      { command: 'start', description: 'Mulai bot & panduan registrasi Auto-Cuan' },
      { command: 'verifikasi', description: 'Mulai verifikasi akun Telegram Anda' },
      { command: 'daftar', description: 'Buka formulir pendaftaran nama & Gmail' },
      { command: 'akun', description: 'Cek status akun, membership & sisa kuota' },
      { command: 'cek', description: 'Cek status pendaftaran akun Anda' },
      { command: 'help', description: 'Panduan verifikasi & pendaftaran' },
      { command: 'langganan', description: 'Lihat paket dan harga subscription' },
      { command: 'status', description: 'Cek status subscription Anda' },
      { command: 'trial', description: 'Aktifkan trial 10 hari bila memenuhi syarat' },
      { command: 'voucher', description: 'Gunakan kode voucher (contoh: /voucher AC-XXXX)' },
      { command: 'beli', description: 'Lihat pilihan paket dan cara berlangganan' }
    ];
    let setRes = null;
    let setErr = null;
    for (let attempt = 0; attempt < 3 && !setRes; attempt++) {
      setRes = await api.setMyCommands(MEMBER_COMMANDS).catch((e) => { setErr = (e && e.code) || e.message || 'unknown'; return null; });
      if (!setRes) await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(JSON.stringify({
      set_my_commands: setRes === true ? 'ok' : ('failed: ' + setErr),
      count: MEMBER_COMMANDS.length
    }, null, 2));
    process.exitCode = setRes === true ? 0 : 1;
    return;
  }

  const db = makeDb();
  if (!db) {
    log('error', 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const bot = createTelegramApi(token, globalThis.fetch, Number(process.env.VERIFY_POLL_API_TIMEOUT_MS) || 15000);
  const dispatch = createDispatcher({ db: db, bot: bot });

  // Polling mode requires the webhook to be gone; Telegram refuses getUpdates
  // while a webhook is set. The webhook is removed WITHOUT dropping pending
  // updates so messages that arrived while we were down are replayed, not lost.
  try {
    await bot.deleteWebhook(DROP_PENDING_ON_BOOT);
    log('info', 'webhook cleared (drop_pending=' + DROP_PENDING_ON_BOOT + '), long polling active');
  } catch (err) {
    log('error', 'deleteWebhook failed: ' + (err && err.code ? err.code : 'unknown'));
  }

  // Surface the queue state so a restart that replays a backlog is visible.
  try {
    const hook = await api.getWebhookInfo();
    if (hook && hook.pending_update_count > 0) {
      log('info', 'pending updates waiting to be processed: ' + hook.pending_update_count);
    }
  } catch (_) { /* non-fatal */ }

  log('info', 'verify bot @' + me.username + ' polling started');

  let offset = 0;
  let stopping = false;

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log('info', 'shutdown ' + signal);
    process.exit(0);
  }
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('uncaughtException', (err) => {
    log('error', 'uncaughtException ' + (err && err.message ? err.message : 'unknown'));
  });
  process.on('unhandledRejection', (err) => {
    log('error', 'unhandledRejection ' + (err && err.message ? err.message : 'unknown'));
  });

  // Confirm we are in polling mode before entering the loop (belt and braces:
  // a leftover webhook would make getUpdates fail forever with 409 Conflict).
  try {
    const hook = await api.getWebhookInfo();
    if (hook && hook.url) {
      await bot.deleteWebhook(DELETE_WEBHOOK_ON_BOOT);
      log('info', 'webhook re-cleared before polling');
    }
  } catch (_) { /* non-fatal */ }

  // A quiet stream logs a heartbeat every N empty polls (~N * 50s).
  const HEARTBEAT_EVERY_POLLS = Math.max(1, Number(process.env.VERIFY_POLL_HEARTBEAT_POLLS) || 3);
  let emptyPolls = 0;
  let consecutiveFailures = 0;
  let lastSuccessAt = Date.now();

  for (;;) {
    // Watchdog: PM2 restart is the only reliable cure for a wedged socket, and
    // it is safe because pending updates are no longer dropped on boot.
    if (Date.now() - lastSuccessAt > STALL_RESTART_MS) {
      log('error', 'stalled for ' + Math.round((Date.now() - lastSuccessAt) / 1000) + 's — exiting for a clean PM2 restart');
      process.exit(1);
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      log('error', 'too many consecutive poll failures (' + consecutiveFailures + ') — exiting for a clean PM2 restart');
      process.exit(1);
    }

    let updates = [];
    try {
      updates = await bot.getUpdates(offset, POLL_TIMEOUT_SEC);
      consecutiveFailures = 0;
      lastSuccessAt = Date.now();
    } catch (err) {
      consecutiveFailures += 1;
      const detail = (err && err.code ? String(err.code) : 'unknown');
      log('error', 'poll_failed #' + consecutiveFailures + ' ' + detail);
      // 409 Conflict means somebody re-registered a webhook or a second poller
      // grabbed the stream (e.g. the retired failover cron, or a leftover
      // instance). Polling owns this token, so clear the webhook and back off.
      if (err && (err.status === 409 || /Conflict/i.test(detail))) {
        try {
          await bot.deleteWebhook(false);
          log('info', 'webhook re-cleared after 409 conflict');
        } catch (_) { /* retry next cycle */ }
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_ERROR_BACKOFF_MS));
      continue;
    }

    if (!updates || updates.length === 0) {
      // Heartbeat: a quiet stream is indistinguishable from a dead one, so log a
      // liveness line periodically (offset + poll count) as proof the poller is
      // still holding and advancing the Telegram update stream.
      emptyPolls += 1;
      if (emptyPolls % HEARTBEAT_EVERY_POLLS === 0) {
        log('info', 'heartbeat: polling alive, offset=' + offset + ', empty_polls=' + emptyPolls + ', uptime_s=' + Math.round(process.uptime()));
      }
      continue;
    }
    emptyPolls = 0;

    log('info', 'received ' + updates.length + ' update(s)');
    for (const update of updates || []) {
      if (!update || typeof update.update_id !== 'number') continue;
      // Advance the offset BEFORE dispatch so a throwing handler can never make
      // the same poison update block the queue forever (Telegram would otherwise
      // redeliver it on every poll and the bot would look dead).
      offset = update.update_id + 1;
      const shape = update.chat_join_request
        ? ('join_request chat=' + (update.chat_join_request.chat && update.chat_join_request.chat.id) + ' user=' + (update.chat_join_request.from && update.chat_join_request.from.id))
        : update.callback_query
          ? ('callback data=' + JSON.stringify(String(update.callback_query.data || '').slice(0, 40)) + ' chat=' + (update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.id))
          : update.message
            ? ('message text=' + JSON.stringify(String(update.message.text || '').slice(0, 60)) + ' chat=' + (update.message.chat && update.message.chat.id) + ' type=' + (update.message.chat && update.message.chat.type) + ' from=' + (update.message.from && update.message.from.id))
            : 'other';
      try {
        const result = await dispatch(update);
        log('info', 'update ' + update.update_id + ' [' + shape + '] -> ' + (result && result.outcome ? result.outcome : 'unknown'));
      } catch (err) {
        // Never let a single bad update kill the loop.
        log('error', 'update_failed ' + update.update_id + ' [' + shape + '] ' + (err && err.message ? err.message : 'internal'));
      }
      if (args.has('--once')) {
        log('info', 'once mode complete');
        return;
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
  loadEnvFile,
  loadRuntimeEnv,
  createTelegramApi,
  createDispatcher
};

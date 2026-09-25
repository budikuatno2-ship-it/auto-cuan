'use strict';

/**
 * Live end-to-end verification of the command-isolation + deep-link UX release.
 *
 * Runs the REAL webhook processing pipeline on the VPS (real Supabase client,
 * real verify-bot client) against synthetic Telegram updates, and asserts the
 * resulting outcome codes. Because the synthetic sender ids are not real chats,
 * any outbound Telegram send fails harmlessly inside the existing try/catch —
 * the outcome code is still authoritative.
 *
 * Usage (on the VPS):
 *   node tools/verify-command-isolation-live.js
 *   node tools/verify-command-isolation-live.js --json
 *
 * Exit code 0 = every check passed.
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const verifyBotLib = require(path.join(ROOT, 'lib', 'telegram-verify-bot'));
const verification = require(path.join(ROOT, 'lib', 'telegram-verification'));
const { createInteractiveBot } = require(path.join(ROOT, 'lib', 'telegram-interactive-bot'));

const JSON_OUT = process.argv.includes('--json');

// Load the runner env files so TELEGRAM_VERIFY_* and SUPABASE_* are available.
function loadRunnerEnv() {
  const fs = require('fs');
  const candidates = [
    '/home/ubuntu/auto-cuan-runner/telegram-webhook-v3-secret.env',
    '/home/ubuntu/auto-cuan-runner/telegram-lifecycle.env',
    path.join(ROOT, '.env')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
    }
  }
}

function makeDb() {
  let createClient = null;
  try { createClient = require('@supabase/supabase-js').createClient; } catch (_) { createClient = null; }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient || !url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

let updateId = 900000000;
function nextUpdateId() { return ++updateId; }

function privateUpdate(text, senderId) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      chat: { id: senderId, type: 'private' },
      from: { id: senderId, is_bot: false, first_name: 'Verify', username: 'verifyprobe' },
      date: Math.floor(Date.now() / 1000),
      text: text
    }
  };
}

async function main() {
  loadRunnerEnv();

  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!JSON_OUT) {
      console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
    }
  };

  const db = makeDb();
  if (!db) {
    console.error('SUPABASE credentials missing — cannot run the live verification.');
    return { exitCode: 2, results };
  }

  const bot = verifyBotLib.createVerifyBot();
  const deps = {
    supabase: db,
    bot: bot,
    registerTokenStore: require(path.join(ROOT, 'lib', 'telegram-register-token'))
  };

  // A synthetic sender id that will never be a real chat. The verification bot's
  // outbound send fails silently, which is exactly what we want here.
  const PROBE_ID = 999000001;

  // --- 1. Deep-link entry (KONDISI A) ---------------------------------------
  const deep = await verification.processWebhookUpdate(privateUpdate('/start verify_' + PROBE_ID, PROBE_ID), deps);
  record('deep-link /start verify_<id> → registration_form', deep.outcome === 'registration_form', 'outcome=' + deep.outcome);

  const verif = await verification.processWebhookUpdate(privateUpdate('/verifikasi', PROBE_ID + 1), deps);
  record('/verifikasi → registration_form', verif.outcome === 'registration_form', 'outcome=' + verif.outcome);

  const daftar = await verification.processWebhookUpdate(privateUpdate('/daftar', PROBE_ID + 2), deps);
  record('/daftar → registration_form', daftar.outcome === 'registration_form', 'outcome=' + daftar.outcome);

  // --- 2. Plain /start (KONDISI B) ------------------------------------------
  const plain = await verification.processWebhookUpdate(privateUpdate('/start', PROBE_ID + 3), deps);
  record('bare /start → start (legacy guide + CTA)', plain.outcome === 'start', 'outcome=' + plain.outcome);

  // --- 3. Account status (KONDISI C) ---------------------------------------
  const akun = await verification.processWebhookUpdate(privateUpdate('/akun', PROBE_ID + 4), deps);
  record('/akun → account_status', akun.outcome === 'account_status' || akun.outcome === 'account_not_registered',
    'outcome=' + akun.outcome);

  const cek = await verification.processWebhookUpdate(privateUpdate('/cek', PROBE_ID + 5), deps);
  record('/cek → account_status', cek.outcome === 'account_status' || cek.outcome === 'account_not_registered',
    'outcome=' + cek.outcome);

  // --- 4. Foreign command guard --------------------------------------------
  const foreignCommands = ['/bandar BBCA', '/bd BBCA', '/foreign', '/ritel', '/tanya prospek', '/opini', '/screener daytrade', '/status'];
  let foreignOk = 0;
  for (let i = 0; i < foreignCommands.length; i++) {
    const res = await verification.processWebhookUpdate(privateUpdate(foreignCommands[i], PROBE_ID + 10 + i), deps);
    if (res.outcome === 'foreign_command') foreignOk += 1;
    else if (!JSON_OUT) console.log('      ' + foreignCommands[i] + ' → ' + res.outcome);
  }
  record('all signal commands refused in the verification bot', foreignOk === foreignCommands.length,
    foreignOk + '/' + foreignCommands.length);

  // --- 5. /help -------------------------------------------------------------
  const help = await verification.processWebhookUpdate(privateUpdate('/help', PROBE_ID + 20), deps);
  record('/help → help', help.outcome === 'help', 'outcome=' + help.outcome);

  // --- 6. A real-looking code still reaches the hashing path ---------------
  // It must NOT be swallowed by the command router. Depending on whether
  // TELEGRAM_VERIFY_CODE_SECRET is configured it lands on the hashing path
  // (not_found / invalid_format) or fails closed with config_error.
  const code = await verification.processWebhookUpdate(privateUpdate('ABCD2345', PROBE_ID + 21), deps);
  const codeRouted = ['not_found', 'invalid_format', 'config_error', 'expired', 'locked'].includes(code.outcome);
  record('a code-shaped token is not treated as a command', codeRouted, 'outcome=' + code.outcome);

  // --- 7. Signal bot gatekeeper (unverified group command) -----------------
  const signalBot = createInteractiveBot({
    db: null,
    env: process.env,
    rootDir: ROOT,
    skipProbe: true
  });
  const groupSent = [];
  const groupCtx = {
    from: { id: 999000777, username: 'probe' },
    chat: { id: -100999000777, type: 'supergroup' },
    message: { text: '/bandar BBCA' },
    async reply(text, extra) {
      groupSent.push({ text, extra });
      return { message_id: 1 };
    },
    async deleteMessage() { return true; },
    telegram: { async sendMessage() { return { message_id: 2 }; } },
    async answerCbQuery() {},
    async editMessageText() {}
  };
  await signalBot.handleUpdate(groupCtx);
  // The hold must carry ONLY the deep-link CTA. The bot username comes from the
  // environment, so assert the URL SHAPE (a t.me deep link carrying the sender's
  // Telegram id) rather than a hard-coded username.
  const holdButton = groupSent.length === 1 &&
    groupSent[0].extra && groupSent[0].extra.reply_markup &&
    groupSent[0].extra.reply_markup.inline_keyboard &&
    groupSent[0].extra.reply_markup.inline_keyboard[0] &&
    groupSent[0].extra.reply_markup.inline_keyboard[0][0];
  const holdOk = groupSent.length === 1 &&
    /Akun Anda belum terverifikasi/.test(groupSent[0].text) &&
    !/\/bandar/.test(groupSent[0].text) &&
    holdButton &&
    holdButton.text === '🔐 Verifikasi Akses Sekarang' &&
    /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=verify_999000777$/.test(holdButton.url || '');
  record('signal bot: unverified /bandar → hold CTA with deep link', holdOk,
    holdOk ? 'url=' + holdButton.url : JSON.stringify(groupSent.map((m) => m.text)));

  // --- 8. AI evaluator fallback shape --------------------------------------
  const evaluator = require(path.join(ROOT, 'lib', 'ai-evaluator'));
  const evalResult = await evaluator.evaluate('ping', {
    env: process.env,
    fetchFn: async function () { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    primaryTimeoutMs: 50,
    fallbackTimeoutMs: 50
  });
  record('ai-evaluator fails closed with a result object (never throws)',
    evalResult && evalResult.ok === false && evalResult.attempts === 2,
    'code=' + evalResult.code + ' attempts=' + evalResult.attempts);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  if (JSON_OUT) {
    console.log(JSON.stringify({ passed, failed, results }, null, 2));
  } else {
    console.log('');
    console.log('=== ' + passed + '/' + results.length + ' checks passed ===');
  }

  return { exitCode: failed === 0 ? 0 : 1, results, passed, failed };
}

if (require.main === module) {
  main().then((out) => { process.exitCode = out.exitCode; }).catch((err) => {
    console.error('verify-command-isolation-live error:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { main };

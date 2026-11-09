'use strict';

/**
 * lib/telegram-gate.js — single outbound Telegram send chokepoint.
 *
 * DEFAULT IS DRY-RUN. A live network send is permitted ONLY when BOTH:
 *   - TELEGRAM_ENABLED === '1'   (existing repo convention, see telegram-notifier.js)
 *   - TELEGRAM_LIVE     === 'true' (explicit live-send override)
 *
 * When the gate refuses a send, it never touches the network. Instead it
 * appends a redacted dry-run record to data/telegram-dry-run.jsonl so an
 * operator can inspect exactly what would have been sent, without leaking
 * tokens or full chat ids.
 *
 * Usage (all senders must route through this module):
 *   const gate = require('./telegram-gate');
 *   const decision = gate.decideSend(process.env, { hasToken: true });
 *   if (!decision.live) {
 *     gate.recordDryRun({ chat_id, text, source: 'my-module' });
 *     return { sent: false, skipped: true, dry_run: true, reason: decision.reason };
 *   }
 *   // proceed with actual send
 *
 * Tests must NEVER set TELEGRAM_LIVE=true; they use injected env objects so
 * process.env is never mutated and no test can trigger a live send.
 */

const fs = require('fs');
const path = require('path');
const { redactString, maskLong } = require('./secret-redaction');

const DRY_RUN_LOG = path.join(__dirname, '..', 'data', 'telegram-dry-run.jsonl');

function isLiveSendEnabled(env, opts) {
  const e = env || process.env;
  const o = opts || {};
  if (e.TELEGRAM_LIVE !== 'true') return false;
  if (e.TELEGRAM_ENABLED !== '1') return false;
  if (o.hasToken === false) return false;
  return true;
}

function decideSend(env, opts) {
  const e = env || process.env;
  const o = opts || {};
  const hasToken = o.hasToken !== undefined
    ? Boolean(o.hasToken)
    : Boolean(String(e.TELEGRAM_BOT_TOKEN || e.TELEGRAM_VERIFY_BOT_TOKEN || '').trim());
  if (e.TELEGRAM_LIVE !== 'true') return { live: false, reason: 'telegram_live_not_set' };
  if (e.TELEGRAM_ENABLED !== '1') return { live: false, reason: 'telegram_disabled' };
  if (!hasToken) return { live: false, reason: 'missing_token' };
  return { live: true, reason: 'explicit_live_consent' };
}

function maskChatId(chatId) {
  const s = String(chatId == null ? '' : chatId);
  if (!s) return '[REDACTED]';
  // Numeric-ish chat ids: keep only the last 4 digits for operator recognition.
  if (s.length >= 8 && /^[0-9\-]+$/.test(s)) return '***' + s.slice(-4);
  return maskLong(s);
}

function recordDryRun(record, seam) {
  const s = seam || {};
  const logPath = s.logPath || DRY_RUN_LOG;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: String(record.source || 'unknown'),
      method: String(record.method || 'sendMessage'),
      chat_id_masked: maskChatId(record.chat_id),
      text: redactString(String(record.text == null ? '' : record.text)).slice(0, 2000)
    }) + '\n';
    if (typeof s.writeFile === 'function') {
      s.writeFile(logPath, line);
      return { recorded: true, reason: null };
    }
    fs.appendFileSync(logPath, line, 'utf8');
    return { recorded: true, reason: null };
  } catch (e) {
    return { recorded: false, reason: String((e && e.message) || 'append_failed') };
  }
}

module.exports = {
  DRY_RUN_LOG,
  isLiveSendEnabled,
  decideSend,
  maskChatId,
  recordDryRun
};

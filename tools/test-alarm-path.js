#!/usr/bin/env node
'use strict';

/**
 * B5 (2026-10-23) — prove the alarm path actually delivers.
 *
 * Sends ONE message labelled TEST through the SAME Telegram notifier the
 * circuit breaker and the J1 skip alarm use, and prints the delivery outcome
 * (sent / skipped / failed + reason) so "the alarm was sent" is evidence, not an
 * assumption. It also writes the outcome to data/alarm-selftest.json, which the
 * Admin Console can read.
 *
 * Usage: node tools/test-alarm-path.js [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const notifier = require(path.join(ROOT_DIR, 'lib', 'telegram-notifier'));

function statePath() {
  return process.env.ALARM_SELFTEST_STATE || path.join(ROOT_DIR, 'data', 'alarm-selftest.json');
}

function buildTestMessage(nowIso) {
  return [
    '🧪 TEST — jalur alarm Auto-Cuan',
    '',
    'Ini pesan UJI, bukan insiden. Dikirim lewat jalur yang sama dengan',
    'pemutus sirkuit Arjum dan alarm J1 SKIPPED_ARJUM_BUSY.',
    '',
    'Waktu : ' + nowIso,
    'Tujuan: Admin Console + Telegram admin'
  ].join('\n');
}

async function run(argv, deps) {
  const args = argv || [];
  const json = args.includes('--json');
  const d = deps || {};
  const nowIso = new Date().toISOString();
  const text = buildTestMessage(nowIso);

  let enabled = null;
  try { enabled = typeof notifier.isTelegramEnabled === 'function' ? notifier.isTelegramEnabled() : null; } catch (_) {}

  let result;
  try {
    const res = await notifier.sendTelegramMessage(text);
    result = { sent: Boolean(res && res.ok !== false), raw_ok: res && res.ok, reason: (res && (res.reason || res.error)) || null };
  } catch (err) {
    result = { sent: false, reason: 'send_failed: ' + (err && err.message ? err.message : String(err)) };
  }

  const summary = {
    label: 'TEST',
    at: nowIso,
    telegram_enabled: enabled,
    sent: result.sent === true,
    reason: result.reason || null,
    channel: 'telegram-notifier (shared alarm path)'
  };

  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(summary, null, 2));
  } catch (_) {}

  if (json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  else process.stdout.write(`[ALARM-TEST] telegram_enabled=${enabled} sent=${summary.sent} reason=${summary.reason || '-'}\n`);

  return summary;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((s) => { process.exitCode = s.sent ? 0 : 2; }).catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { run, buildTestMessage, statePath };

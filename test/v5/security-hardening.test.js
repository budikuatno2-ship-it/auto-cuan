'use strict';

/**
 * test/v5/security-hardening.test.js — V5 security package
 * ============================================================================
 * Pure-function / injected-seam truth gates. No network, no live Telegram send.
 *
 *   A. Secret redaction (lib/secret-redaction.js)
 *   B. Telegram dry-run gate (lib/telegram-gate.js)
 * ============================================================================
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const redaction = require(ROOT + '/lib/secret-redaction');
const gate = require(ROOT + '/lib/telegram-gate');

const failures = [];
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failures.push(label + ' :: ' + e.message); console.log('  FAIL ' + label + ' :: ' + e.message); }
}

check('A1: secret-ish keys are masked in objects', function () {
  const out = redaction.redactObject({
    ARJUM_API_KEY: 'ak_live_0123456789abcdef',
    supabaseKey: 'sb_short',
    Authorization: 'Bearer x',
    session_cookie: 'cookielongvalue12345678',
    public_field: 'kept'
  });
  assert.ok(out.ARJUM_API_KEY.indexOf('ak_l') === 0 && out.ARJUM_API_KEY.indexOf('cdef') === out.ARJUM_API_KEY.length - 4, 'long key not first4+last4');
  assert.strictEqual(out.supabaseKey, '[REDACTED]', 'short secret not fully redacted');
  assert.strictEqual(out.Authorization, '[REDACTED]', 'authorization value leaked');
  assert.ok(String(out.session_cookie).indexOf('cookielongvalue') === -1, 'cookie value leaked');
  assert.strictEqual(out.public_field, 'kept', 'non-secret field was masked');
});

check('A2: short secret values are fully [REDACTED]', function () {
  assert.strictEqual(redaction.maskLong('abc'), '[REDACTED]');
  assert.strictEqual(redaction.maskLong('abcdefghijklmno'), '[REDACTED]');
  assert.strictEqual(redaction.maskLong('abcdefghijklmnop'), 'abcd...mnop');
});

check('A3: free text — bearer scheme masked', function () {
  const out = redaction.redactString('auth header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig');
  assert.ok(out.indexOf('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig') === -1, 'bearer token survived: ' + out);
});

check('A3: free text — telegram bot token masked', function () {
  const out = redaction.redactString('fetch https://api.telegram.org/bot123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-4s/sendMessage');
  assert.ok(out.indexOf('AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-4s') === -1, 'bot token survived: ' + out);
  assert.ok(out.indexOf('bot1234...') !== -1, 'bot mask missing: ' + out);
});

check('A3: free text — password= / secret: pairs masked', function () {
  const out = redaction.redactString('config { password: hunter2secret, TELEGRAM_TOKEN=123456:ABC-def }');
  assert.ok(out.indexOf('hunter2secret') === -1, 'password survived: ' + out);
  assert.ok(out.indexOf('[REDACTED]') !== -1, 'no redaction marker: ' + out);
});

check('A4: api/log.js text() redacts ingested payload before persistence', function () {
  const src = fs.readFileSync(ROOT + '/api/log.js', 'utf8');
  assert.ok(src.indexOf("require('../lib/secret-redaction')") !== -1, 'api/log.js does not wire secret-redaction');
  assert.ok(src.indexOf('redactIngestedText') !== -1, 'text() does not call redactIngestedText');
});

check('A5: safeStringify survives circular structures without leaking a secret', function () {
  const a = { api_token_abcdefghijklmnop: 'secretvalue' };
  a.self = a;
  const s = redaction.safeStringify(a);
  assert.ok(typeof s === 'string' && s.length > 0, 'safeStringify returned nothing');
  assert.ok(s.indexOf('secretvalue') === -1, 'circular object leaked token');
  assert.ok(s.indexOf('[CIRCULAR]') !== -1, 'circular reference was not handled');
});

check('B1: default env NEVER allows a live send', function () {
  const d = gate.decideSend({});
  assert.strictEqual(d.live, false);
  assert.strictEqual(d.reason, 'telegram_live_not_set');
});

check('B2: TELEGRAM_ENABLED=1 alone is not enough', function () {
  const d = gate.decideSend({ TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'tok' });
  assert.strictEqual(d.live, false, 'live send allowed without TELEGRAM_LIVE');
});

check('B3: explicit TELEGRAM_LIVE=true + TELEGRAM_ENABLED=1 allows live', function () {
  const d = gate.decideSend({ TELEGRAM_LIVE: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'tok' });
  assert.strictEqual(d.live, true);
});

check('B4: recordDryRun writes a redacted record via injected seam', function () {
  const written = [];
  const seam = { writeFile: (p, line) => written.push(line), logPath: 'unused.jsonl' };
  const r = gate.recordDryRun({
    chat_id: '6396446903',
    text: 'alert with api_key=supersecretvalue99 and token=ABCDEFGHIJKLMNOP',
    source: 'unit-test'
  }, seam);
  assert.strictEqual(r.recorded, true);
  assert.strictEqual(written.length, 1);
  const rec = JSON.parse(written[0]);
  assert.strictEqual(rec.source, 'unit-test');
  assert.ok(rec.chat_id_masked !== '6396446903', 'chat id not masked');
  assert.ok(rec.chat_id_masked === '***6903' || rec.chat_id_masked === '[REDACTED]', 'chat mask unexpected: ' + rec.chat_id_masked);
  assert.ok(rec.text.indexOf('supersecretvalue99') === -1, 'secret survived into dry-run log');
});

check('B5: process.env in this suite never enables live sends', function () {
  assert.notStrictEqual(process.env.TELEGRAM_LIVE, 'true', 'tests must never set TELEGRAM_LIVE=true');
  const d = gate.decideSend(process.env);
  assert.strictEqual(d.live, false, 'process.env-based decision must be dry-run in tests');
});

if (failures.length > 0) {
  console.error('\n[security-hardening] ' + failures.length + ' failure(s)');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n[security-hardening] all assertions passed');
process.exit(0);
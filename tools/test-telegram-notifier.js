/**
 * Local Test Script — Telegram Notifier
 * 
 * Run manually: node tools/test-telegram-notifier.js
 * 
 * NOT an API endpoint. NOT deployed. NOT run automatically.
 * 
 * Tests:
 *   1. TELEGRAM_ENABLED=0 → skip
 *   2. TELEGRAM_ENABLED=1 + missing token → skip
 *   3. TELEGRAM_ENABLED=1 + missing chat_id → skip
 *   4. TELEGRAM_ENABLED=1 + real env → send test message
 * 
 * SECURITY:
 *   - Never prints TELEGRAM_BOT_TOKEN
 *   - Chat ID is masked in output
 */

'use strict';

var notifier = require('../lib/telegram-notifier');

function maskChatId(id) {
  if (!id) return '(not set)';
  var s = String(id);
  if (s.length <= 4) return '****';
  return s.substring(0, 2) + '***' + s.substring(s.length - 2);
}

async function runTests() {
  console.log('=== Telegram Notifier Test ===');
  console.log('');

  // Report env status (safe — no secrets printed)
  console.log('Environment:');
  console.log('  TELEGRAM_ENABLED:', process.env.TELEGRAM_ENABLED || '(not set)');
  console.log('  TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? '***SET***' : '(not set)');
  console.log('  TELEGRAM_CHAT_ID:', maskChatId(process.env.TELEGRAM_CHAT_ID));
  console.log('');

  // === TEST 1: Disabled ===
  console.log('--- Test 1: TELEGRAM_ENABLED=0 ---');
  var origEnabled = process.env.TELEGRAM_ENABLED;
  process.env.TELEGRAM_ENABLED = '0';
  var r1 = await notifier.sendTelegramMessage('This should not be sent.');
  console.log('  Result:', JSON.stringify(r1));
  console.log('  Expected: skipped=true, reason=telegram_disabled');
  console.log('  PASS:', r1.skipped === true && r1.reason === 'telegram_disabled');
  console.log('');

  // === TEST 2: Enabled but missing token ===
  console.log('--- Test 2: TELEGRAM_ENABLED=1, no token ---');
  process.env.TELEGRAM_ENABLED = '1';
  var origToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '';
  var r2 = await notifier.sendTelegramMessage('This should not be sent.');
  console.log('  Result:', JSON.stringify(r2));
  console.log('  Expected: skipped=true, reason=missing_token');
  console.log('  PASS:', r2.skipped === true && r2.reason === 'missing_token');
  process.env.TELEGRAM_BOT_TOKEN = origToken;
  console.log('');

  // === TEST 3: Enabled but missing chat ID ===
  console.log('--- Test 3: TELEGRAM_ENABLED=1, no chat_id ---');
  process.env.TELEGRAM_ENABLED = '1';
  var origChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_CHAT_ID = '';
  var r3 = await notifier.sendTelegramMessage('This should not be sent.');
  console.log('  Result:', JSON.stringify(r3));
  console.log('  Expected: skipped=true, reason=missing_chat_id');
  console.log('  PASS:', r3.skipped === true && r3.reason === 'missing_chat_id');
  process.env.TELEGRAM_CHAT_ID = origChatId;
  console.log('');

  // === TEST 4: Empty message ===
  console.log('--- Test 4: Empty message ---');
  process.env.TELEGRAM_ENABLED = '1';
  if (origToken) process.env.TELEGRAM_BOT_TOKEN = origToken;
  if (origChatId) process.env.TELEGRAM_CHAT_ID = origChatId;
  var r4 = await notifier.sendTelegramMessage('');
  console.log('  Result:', JSON.stringify(r4));
  console.log('  Expected: skipped=true, reason=empty_message');
  console.log('  PASS:', r4.skipped === true && r4.reason === 'empty_message');
  console.log('');

  // === TEST 5: Real send (only if env is fully configured) ===
  console.log('--- Test 5: Real send (if env available) ---');
  process.env.TELEGRAM_ENABLED = '1';
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    var r5 = await notifier.sendTelegramMessage('Auto-Cuan Telegram notifier test OK.');
    console.log('  Result:', JSON.stringify(r5));
    if (r5.sent) {
      console.log('  PASS: Message sent successfully!');
    } else {
      console.log('  INFO: Send attempted but failed:', r5.reason, r5.error_message || '');
    }
  } else {
    console.log('  SKIPPED: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not available in local env.');
    console.log('  To test real sending, set env vars and run again.');
  }
  console.log('');

  // === TEST 6: formatTelegramSafeText ===
  console.log('--- Test 6: formatTelegramSafeText ---');
  var html = '<p><strong>BBCA</strong> naik <span>+1.2%</span></p>\n\n\n\nTest';
  var safe = notifier.formatTelegramSafeText(html);
  console.log('  Input:', JSON.stringify(html));
  console.log('  Output:', JSON.stringify(safe));
  console.log('  PASS (no HTML):', safe.indexOf('<') === -1);
  console.log('');

  // Restore
  process.env.TELEGRAM_ENABLED = origEnabled || '';

  console.log('=== All Tests Complete ===');
}

runTests().catch(function(e) {
  console.error('FATAL:', e.message);
  process.exit(1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../lib/runtime-env');
const verification = require('../lib/telegram-verification');
const verifyBot = require('../lib/telegram-verify-bot');
const adminUsers = require('../api/admin-users');

const NAMES = ['AUTO_CUAN_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_VERIFY_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_VERIFY_WEBHOOK_SECRET', 'TELEGRAM_VERIFY_CODE_SECRET', 'TELEGRAM_VERIFY_BOT_USERNAME', 'TELEGRAM_VERIFY_CHANNEL_ID', 'TELEGRAM_VERIFY_ADMIN_CHAT_ID', 'ADMIN_TELEGRAM_BIND_PEPPER', 'VOUCHER_CODE_PEPPER', 'CHANNEL_INVITE_PEPPER', 'MEMBERSHIP_BANK_INSTRUCTIONS', 'MEMBERSHIP_ADMIN_CONTACT', 'CHANNEL_DESTRUCTIVE_ENFORCEMENT_ENABLED'];
const saved = Object.fromEntries(NAMES.flatMap(n => [[n, process.env[n]], ['STAGING_' + n, process.env['STAGING_' + n]]]));
test.afterEach(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });

test('unset and production selectors use canonical variables', () => {
  process.env.SUPABASE_URL = 'canonical'; process.env.STAGING_SUPABASE_URL = 'staging'; delete process.env.AUTO_CUAN_ENV;
  assert.equal(env.resolve('SUPABASE_URL'), 'canonical'); process.env.AUTO_CUAN_ENV = 'production'; assert.equal(env.resolve('SUPABASE_URL'), 'canonical');
});
test('staging uses only STAGING variables and never falls back', () => {
  process.env.AUTO_CUAN_ENV = 'staging'; process.env.SUPABASE_URL = 'production'; delete process.env.STAGING_SUPABASE_URL;
  assert.equal(env.resolve('SUPABASE_URL'), undefined); process.env.STAGING_SUPABASE_URL = 'isolated'; assert.equal(env.resolve('SUPABASE_URL'), 'isolated');
});
test('invalid selector fails closed with a sanitized error', () => {
  process.env.AUTO_CUAN_ENV = 'preview'; assert.throws(() => env.resolve('SUPABASE_URL'), /^Error: runtime_environment_invalid$/);
});
test('all membership settings are isolated', () => {
  process.env.AUTO_CUAN_ENV = 'staging';
  for (const name of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','TELEGRAM_VERIFY_BOT_TOKEN','TELEGRAM_VERIFY_WEBHOOK_SECRET','TELEGRAM_VERIFY_CODE_SECRET','TELEGRAM_VERIFY_CHANNEL_ID','TELEGRAM_VERIFY_ADMIN_CHAT_ID','ADMIN_TELEGRAM_BIND_PEPPER','VOUCHER_CODE_PEPPER','CHANNEL_INVITE_PEPPER','MEMBERSHIP_BANK_INSTRUCTIONS','MEMBERSHIP_ADMIN_CONTACT','CHANNEL_DESTRUCTIVE_ENFORCEMENT_ENABLED']) {
    process.env[name] = 'production-' + name; process.env['STAGING_' + name] = 'staging-' + name; assert.equal(env.resolve(name), 'staging-' + name);
  }
});
test('verify token ignores recommendation bot token and staging does not fall back', () => {
  process.env.AUTO_CUAN_ENV = 'staging'; process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'production-verify'; process.env.TELEGRAM_BOT_TOKEN = 'recommendation'; delete process.env.STAGING_TELEGRAM_VERIFY_BOT_TOKEN;
  assert.equal(verifyBot.__getVerifyBotToken(), null); process.env.STAGING_TELEGRAM_VERIFY_BOT_TOKEN = 'staging-verify'; assert.equal(verifyBot.__getVerifyBotToken(), 'staging-verify');
});
test('dynamic bot identity normalizes @ and never exposes production in staging', () => {
  process.env.AUTO_CUAN_ENV = 'production'; delete process.env.TELEGRAM_VERIFY_BOT_USERNAME; assert.equal(verification.getBotUrl(), 'https://t.me/AutoCuanVerificationBot');
  process.env.TELEGRAM_VERIFY_BOT_USERNAME = '@ProductionBot'; assert.equal(verification.getBotUsername(), 'ProductionBot');
  process.env.AUTO_CUAN_ENV = 'staging'; delete process.env.STAGING_TELEGRAM_VERIFY_BOT_USERNAME; assert.equal(verification.getBotUrl(), null);
  process.env.STAGING_TELEGRAM_VERIFY_BOT_USERNAME = '@Stage_Bot'; assert.equal(verification.getBotUrl(), 'https://t.me/Stage_Bot');
  process.env.STAGING_TELEGRAM_VERIFY_BOT_USERNAME = 'bad-name'; assert.equal(verification.getBotUrl(), null);
});
test('legacy production notifier is never invoked in staging', async () => {
  process.env.AUTO_CUAN_ENV = 'staging'; let invoked = false;
  const notifier = require('../lib/telegram-notifier'); const original = notifier.sendTelegramMessage; notifier.sendTelegramMessage = async () => { invoked = true; };
  try { assert.deepEqual(await adminUsers.sendApprovalNotification({}), { status: 'skipped', reason: 'staging_legacy_approval_notifications_disabled' }); assert.equal(invoked, false); } finally { notifier.sendTelegramMessage = original; }
});

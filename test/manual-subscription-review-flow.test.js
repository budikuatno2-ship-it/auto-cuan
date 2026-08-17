'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function source(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function parses(rel) {
  assert.doesNotThrow(() => new Function(source(rel)), rel + ' must parse as JavaScript');
}

test('manual subscription server and browser runtimes parse', () => {
  parses('lib/subscription-manual-handler.js');
  parses('lib/subscription-voucher-handler.js');
  parses('api/review-access.js');
  parses('lib/subscription-voucher-claim.js');
  parses('lib/telegram-transient-message.js');
  parses('lib/telegram-unified-subscription.js');
  parses('lib/voucher-admin-bot.js');
  parses('public/subscription-manual-payment-v1.js');
  parses('public/subscription-voucher-claim-v1.js');
  parses('public/account-center-lazy-loader-v1.js');
});

test('subscription routes preserve Vercel 12-function budget', () => {
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(name => name.endsWith('.js'));
  assert.equal(apiFiles.length, 12);
  const config = source('vercel.json');
  assert.match(config, /"source": "\/api\/subscription-manual"/);
  assert.match(config, /"destination": "\/api\/review-access\?surface=subscription-manual"/);
  assert.match(config, /"source": "\/api\/subscription-voucher"/);
  assert.match(config, /"destination": "\/api\/review-access\?surface=subscription-voucher"/);
  const dispatcher = source('api/review-access.js');
  assert.match(dispatcher, /subscriptionManualHandler/);
  assert.match(dispatcher, /subscriptionVoucherHandler/);
});

test('manual payment activation is admin reviewed and server owned', () => {
  const sql = source('supabase/subscription-manual-payment-migration.sql');
  assert.match(sql, /status text NOT NULL DEFAULT 'awaiting_transfer'/);
  assert.match(sql, /p_decision NOT IN \('approve','reject'\)/);
  assert.match(sql, /INSERT INTO public\.user_entitlements/);
  assert.match(sql, /source,status,starts_at,expires_at,lifetime/);
  assert.match(sql, /'payment','active'/);
  assert.match(sql, /UPDATE public\.app_users SET is_approved=true/);

  const api = source('lib/subscription-manual-handler.js');
  assert.match(api, /subscription_payment_settings/);
  assert.match(api, /SUBSCRIPTION_BANK_NAME/);
  assert.match(api, /admin-review/);
  assert.match(api, /review_manual_subscription_payment/);
  assert.doesNotMatch(api, /account_number\s*:\s*['"]\d{6,}/);
});

test('discount voucher requires payment while direct voucher has dedicated claim endpoint', () => {
  const paymentApi = source('lib/subscription-manual-handler.js');
  assert.match(paymentApi, /type !== 'PERCENT_30' && type !== 'PERCENT_50'/);
  assert.match(paymentApi, /DIRECT_VOUCHER/);

  const voucherApi = source('lib/subscription-voucher-handler.js');
  assert.match(voucherApi, /type === 'PERCENT_30' \|\| type === 'PERCENT_50'/);
  assert.match(voucherApi, /PAYMENT_REQUIRED/);
  assert.match(voucherApi, /notifyClaim/);
});

test('direct voucher remains inside checkout modal instead of jumping to voucher panel', () => {
  const manualUi = source('public/subscription-manual-payment-v1.js');
  assert.match(manualUi, /renderDirectVoucher/);
  assert.match(manualUi, /VOUCHER_API = '\/api\/subscription-voucher'/);
  assert.match(manualUi, /Total<\/span><strong[^>]*>Rp0<\/strong>/);
  assert.match(manualUi, /Tidak perlu transfer/);
  assert.match(manualUi, /id="acPayDirectVoucher"/);
  assert.doesNotMatch(manualUi, /acVoucherInput/);
  assert.doesNotMatch(manualUi, /acVoucherQuote/);
});

test('web direct voucher notifies admin and linked user with activation dates', () => {
  const claim = source('lib/subscription-voucher-claim.js');
  assert.match(claim, /async function userTelegramChat/);
  assert.match(claim, /source === 'web'/);
  assert.match(claim, /Mulai aktif:/);
  assert.match(claim, /Berlaku sampai:/);
  assert.match(claim, /Sumber:/);
  assert.match(claim, /Voucher 100%/);
  assert.match(claim, /Voucher Lifetime/);
  assert.match(claim, /user_notified:userNotified/);

  const voucherApi = source('lib/subscription-voucher-handler.js');
  assert.match(voucherApi, /source:'web'/);
  assert.match(voucherApi, /user_notified:notification\.user_notified === true/);

  const telegram = source('lib/telegram-unified-subscription.js');
  assert.match(telegram, /source:'telegram'/);
  assert.match(telegram, /Voucher berhasil diaktifkan/);
});

test('approved payment and direct voucher refresh browser premium access', () => {
  const manualUi = source('public/subscription-manual-payment-v1.js');
  assert.match(manualUi, /autocuan:subscription-changed/);
  assert.match(manualUi, /refreshSubscriptionStatus/);
  assert.match(manualUi, /p\.status === 'approved'/);

  const voucherUi = source('public/subscription-voucher-claim-v1.js');
  assert.match(voucherUi, /\/api\/subscription-voucher/);
  assert.match(voucherUi, /stopImmediatePropagation/);
  assert.match(voucherUi, /autocuan:subscription-changed/);
});

test('Telegram purchase entry links to web checkout and voucher claims notify admin', () => {
  const module = require('../lib/telegram-unified-subscription');
  const oldBase = process.env.SUBSCRIPTION_PUBLIC_BASE_URL;
  process.env.SUBSCRIPTION_PUBLIC_BASE_URL = 'https://example.test';
  try {
    const keyboard = module.__test.buyKeyboard();
    assert.equal(keyboard.inline_keyboard.length, 4);
    assert.equal(keyboard.inline_keyboard[0][0].url, 'https://example.test/dashboard?buy=PREMIUM_1_MONTH');
    assert.equal(keyboard.inline_keyboard[3][0].url, 'https://example.test/dashboard?buy=LIFETIME');
  } finally {
    if (oldBase === undefined) delete process.env.SUBSCRIPTION_PUBLIC_BASE_URL;
    else process.env.SUBSCRIPTION_PUBLIC_BASE_URL = oldBase;
  }
  const src = source('lib/telegram-unified-subscription.js');
  assert.match(src, /notifyClaim\(\{ db, userId, voucherHash:hash, redeemed:redeemed\.data, source:'telegram' \}\)/);
});

test('voucher admin chatter is transient but code delivery remains persistent', () => {
  const bot = source('lib/voucher-admin-bot.js');
  assert.match(bot, /sendTransient\(\{ db, sender, chatId:input\.chat\.id, scope:'voucher_admin'/);
  assert.match(bot, /deletePrevious\(d\.db, sender, input\.chat\.id, 'voucher_admin'\)/);
  assert.match(bot, /await sender\.sendMessage\(input\.chat\.id, '<b>' \+ batch\.batch_reference/);

  const claim = source('lib/subscription-voucher-claim.js');
  assert.match(claim, /allFinished|finished/);
  assert.match(claim, /sender\.deleteMessage\(ADMIN_TELEGRAM_ID, messageId\)/);
});
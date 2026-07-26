'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const webhook = require('../lib/telegram-membership-webhook');
const bot = require('../lib/telegram-verify-bot');

async function withBot(stubs, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(stubs)) {
    previous[key] = bot[key];
    bot[key] = value;
  }
  try { return await fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) bot[key] = value;
  }
}

function callbackUpdate(updateId, data) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'callback-' + updateId,
      data,
      from: { id: 77 },
      message: { message_id: updateId, chat: { id: 77, type: 'private' } }
    }
  };
}

const activePurchase = {
  purchaseId: '11111111-1111-4111-8111-111111111111',
  packageSlug: 'channel-30',
  packageName: 'Bot 30 Hari',
  status: 'awaiting_payment',
  finalAmount: 50000,
  discount: 0,
  bankInstructions: 'Transfer ke BCA 1234567890 a.n. Budi Kuatno.',
  expiresAt: '2099-01-01T00:00:00Z'
};

test('an old package button cannot bypass an existing active order', async () => {
  const messages = [];
  let packageReads = 0;
  const db = {
    claimUpdate: async () => true,
    currentPurchase: async () => activePurchase,
    packageBySlug: async () => { packageReads++; return {}; }
  };
  await withBot({
    answerCallbackQuery: async () => true,
    sendChatAction: async () => true,
    editMessageText: async (_chat, _message, text, options) => messages.push({ text, options }),
    sendMessage: async (_chat, text, options) => messages.push({ text, options })
  }, async () => {
    const outcome = await webhook.processUpdate(callbackUpdate(1, 'package:channel-90'), db);
    assert.equal(outcome, 'current_purchase');
  });
  assert.equal(packageReads, 0);
  assert.match(messages[0].text, /pesanan aktif/i);
  assert.match(messages[0].text, /Sudah Transfer/i);
});

test('no-voucher checkout shows a server quote and bank account before order creation', async () => {
  const messages = [];
  let confirmed = 0;
  const db = {
    claimUpdate: async () => true,
    beginCheckout: async (_id, slug) => ({ packageSlug: slug }),
    prepareCheckout: async () => ({
      packageSlug: 'channel-90', packageName: 'Bot 90 Hari', subtotal: 120000,
      discount: 0, finalAmount: 120000, voucherApplied: false,
      bankInstructions: 'Transfer ke BCA 1234567890 a.n. Budi Kuatno.'
    }),
    confirmCheckout: async () => { confirmed++; return activePurchase; }
  };
  await withBot({
    answerCallbackQuery: async () => true,
    sendChatAction: async () => true,
    editMessageText: async (_chat, _message, text, options) => messages.push({ text, options }),
    sendMessage: async (_chat, text, options) => messages.push({ text, options })
  }, async () => {
    const outcome = await webhook.processUpdate(callbackUpdate(2, 'novoucher:channel-90'), db);
    assert.equal(outcome, 'checkout_confirm');
  });
  assert.equal(confirmed, 0);
  assert.match(messages[0].text, /KONFIRMASI CHECKOUT/);
  assert.match(messages[0].text, /BCA 1234567890/);
  assert.match(messages[0].text, /TOTAL TRANSFER: Rp120\.000/);
});

test('confirming checkout creates one order with paid, unpaid and cancel actions', async () => {
  const messages = [];
  const db = {
    claimUpdate: async () => true,
    confirmCheckout: async () => activePurchase
  };
  await withBot({
    answerCallbackQuery: async () => true,
    sendChatAction: async () => true,
    editMessageText: async (_chat, _message, text, options) => messages.push({ text, options }),
    sendMessage: async (_chat, text, options) => messages.push({ text, options })
  }, async () => {
    const outcome = await webhook.processUpdate(callbackUpdate(3, 'confirm:order'), db);
    assert.equal(outcome, 'purchase_created');
  });
  const buttons = messages[0].options.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(button => button.callback_data.startsWith('proof:')));
  assert.ok(buttons.some(button => button.callback_data.startsWith('notpaid:')));
  assert.ok(buttons.some(button => button.callback_data.startsWith('cancelpurchase:')));
});

test('a captionless image is attached to the active proof-upload session and forwarded to admin', async () => {
  const messages = [];
  let submitted = null;
  let notified = 0;
  const db = {
    claimUpdate: async () => true,
    account: async () => ({ verified: true, blocked: false, accountStatus: 'approved' }),
    checkoutSession: async () => ({ state: 'proof_upload', purchaseId: activePurchase.purchaseId }),
    currentPurchase: async () => activePurchase,
    submitProof: async (_id, purchaseId, metadata) => {
      submitted = { purchaseId, metadata };
      return { purchaseId, notificationText: 'Bukti pembayaran baru' };
    },
    cancelCheckout: async () => true,
    notifyAdminsOfProof: async () => { notified++; return true; }
  };
  const update = {
    update_id: 4,
    message: {
      from: { id: 77 },
      chat: { id: 77, type: 'private' },
      photo: [{ file_id: 'safe_file', file_unique_id: 'unique_file', file_size: 1024 }]
    }
  };
  await withBot({
    sendChatAction: async () => true,
    sendMessage: async (_chat, text, options) => messages.push({ text, options })
  }, async () => {
    const outcome = await webhook.processUpdate(update, db);
    assert.equal(outcome, 'proof');
  });
  assert.equal(submitted.purchaseId, activePurchase.purchaseId);
  assert.equal(submitted.metadata.mimeType, 'image/jpeg');
  assert.equal(notified, 1);
  assert.match(messages[0].text, /otomatis diteruskan ke admin/i);
});

test('part 4 migration provides active-order recovery, quote, confirmation and proof session RPCs', () => {
  const sql = fs.readFileSync('supabase/telegram-membership-v2-04-complete-payment-flow.sql', 'utf8');
  assert.match(sql, /membership_current_purchase_for_telegram/);
  assert.match(sql, /membership_prepare_checkout/);
  assert.match(sql, /membership_checkout_purchase_confirmed/);
  assert.match(sql, /membership_begin_proof_upload/);
  assert.match(sql, /RAISE EXCEPTION 'purchase_pending'/);
});

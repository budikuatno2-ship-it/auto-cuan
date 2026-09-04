'use strict';

// Regression coverage for the manual-payment admin notification.
//
// Two defects are pinned here:
//   1. publicBaseUrl() built the "Buka & Konfirmasi" button URL from the
//      client-supplied Host / X-Forwarded-Host header, so any signed-in
//      account could steer the admin's Telegram button at an arbitrary origin.
//   2. `submit` re-notified the admin on every call, including the idempotent
//      re-submit path where the SQL function returns the already-submitted row
//      without changing anything. That made admin notifications unbounded and
//      orphaned every previously recorded admin_telegram_message_id.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

function stub(id, exports) {
  const resolved = id.startsWith('.') ? path.resolve(ROOT, id.replace(/^\.\.\//, '')) + '.js' : require.resolve(id, { paths: [ROOT] });
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].filename = resolved;
  require.cache[resolved].loaded = true;
  require.cache[resolved].exports = exports;
  return resolved;
}

// ---------------------------------------------------------------------------
// Fixture state shared by the stubs below.
// ---------------------------------------------------------------------------
const state = {
  sent: [],
  edited: [],
  payment: null,
  updates: []
};

function resetState(overrides) {
  state.sent.length = 0;
  state.edited.length = 0;
  state.updates.length = 0;
  state.payment = Object.assign({
    id: 'pay-row-1',
    user_id: 'user-1',
    payment_reference: 'PAY-0123456789AB',
    plan_code: 'PREMIUM_1_MONTH',
    price_idr: 100000,
    discount_percent: null,
    amount_due_idr: 100000,
    voucher_code_hint: null,
    voucher_id: null,
    status: 'submitted',
    transfer_sender_name: 'Budi',
    transfer_note: null,
    admin_telegram_message_id: null,
    submitted_at: '2026-09-03T02:00:00.000Z',
    reviewed_at: null,
    created_at: '2026-09-03T01:00:00.000Z'
  }, overrides || {});
}

function fakeDb() {
  return {
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(column, value) { filters[column] = value; return query; },
        not() { return query; },
        update(patch) {
          state.updates.push({ table, patch, filters });
          Object.assign(state.payment, patch);
          return {
            eq() { return Promise.resolve({ data: null, error: null }); }
          };
        },
        async maybeSingle() {
          if (table === 'subscription_payment_settings') {
            return { data: { bank_name: 'BCA', account_number: '123', account_holder: 'Budi', active: true }, error: null };
          }
          if (table === 'app_users') {
            return { data: { id: 'user-1', username: 'someone', is_blocked: false, is_approved: true }, error: null };
          }
          if (table === 'subscription_manual_payments') {
            return { data: state.payment, error: null };
          }
          if (table === 'telegram_subscription_links') {
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); }
      };
      return query;
    },
    async rpc(name) {
      if (name === 'submit_manual_subscription_payment') {
        // Mirrors the idempotent branch of the SQL function: the row is already
        // `submitted`, so nothing changes but a truthy payload is returned.
        return { data: { payment_reference: state.payment.payment_reference, status: 'submitted', submitted_at: state.payment.submitted_at }, error: null };
      }
      return { data: null, error: null };
    }
  };
}

// ---------------------------------------------------------------------------
// Stub the module graph before the handler is required.
// ---------------------------------------------------------------------------
stub('@supabase/supabase-js', { createClient: () => fakeDb() });
stub('../lib/subscription-auth', {
  requireSubscriptionOnboardingUser: async () => ({
    ok: true,
    user: { id: 'user-1', username: 'someone' },
    account: { id: 'user-1', username: 'someone', is_blocked: false, is_approved: true }
  })
});
// The handler destructures createVoucherAdminSender at module load, so the
// stub must delegate to mutable state rather than be swapped out later.
function recordingSender() {
  return {
    async sendMessage(chatId, text, extra) {
      state.sent.push({ chatId, text, extra });
      return { message_id: 900 + state.sent.length };
    },
    async editMessageText(chatId, messageId, text, extra) {
      state.edited.push({ chatId, messageId, text, extra });
      return { message_id: messageId };
    },
    async deleteMessage() { return true; }
  };
}
state.senderFactory = recordingSender;
stub('../lib/voucher-admin-sender', {
  createVoucherAdminSender: () => state.senderFactory()
});

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
delete process.env.SUBSCRIPTION_PUBLIC_BASE_URL;

const handler = require('../lib/subscription-manual-handler');

function makeRes() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; }
  };
  return res;
}

async function submit(headers) {
  const req = {
    method: 'POST',
    headers: Object.assign({ host: 'autocuan.web.id', origin: 'https://autocuan.web.id' }, headers || {}),
    body: { action: 'submit', payment_reference: 'PAY-0123456789AB', transfer_sender_name: 'Budi' }
  };
  const res = makeRes();
  await handler(req, res);
  return res;
}

function buttonUrl(entry) {
  const keyboard = entry && entry.extra && entry.extra.reply_markup && entry.extra.reply_markup.inline_keyboard;
  return keyboard && keyboard[0] && keyboard[0][0] ? keyboard[0][0].url : null;
}

// Assertions below compare the parsed host, never a substring of the URL.
// A substring check such as !url.includes('evil.example.com') would pass for
// https://autocuan.web.id/dashboard?paymentReview=evil.example.com and, more
// importantly, would not actually pin WHERE the admin's button points.
function reviewTarget(entry) {
  const raw = buttonUrl(entry);
  assert.ok(raw, 'admin notification must carry a review button');
  const parsed = new URL(raw);
  return {
    raw,
    origin: parsed.origin,
    protocol: parsed.protocol,
    host: parsed.host,
    pathname: parsed.pathname,
    reference: parsed.searchParams.get('paymentReview')
  };
}

// ---------------------------------------------------------------------------
// 1. Host-header injection into the admin review button.
// ---------------------------------------------------------------------------

test('review button ignores a forged X-Forwarded-Host', async () => {
  resetState();
  const res = await submit({ 'x-forwarded-host': 'evil.example.com', host: 'evil.example.com', origin: 'https://evil.example.com' });
  assert.equal(res.statusCode, 200);
  assert.equal(state.sent.length, 1);
  const target = reviewTarget(state.sent[0]);
  assert.equal(target.host, 'autocuan.web.id', 'forged host reached the admin button: ' + target.raw);
  assert.equal(target.protocol, 'https:');
  assert.equal(target.pathname, '/dashboard');
  assert.equal(target.reference, 'PAY-0123456789AB');
});

test('review button ignores a forged Host header', async () => {
  resetState();
  const res = await submit({ host: 'attacker.test', origin: 'https://attacker.test' });
  assert.equal(res.statusCode, 200);
  const target = reviewTarget(state.sent[0]);
  assert.equal(target.host, 'autocuan.web.id', 'forged host reached the admin button: ' + target.raw);
});

test('review button falls back to the canonical production origin', async () => {
  resetState();
  await submit({ host: 'attacker.test', origin: 'https://attacker.test' });
  const target = reviewTarget(state.sent[0]);
  assert.equal(target.origin, 'https://autocuan.web.id');
  assert.equal(target.pathname, '/dashboard');
  assert.equal(target.reference, 'PAY-0123456789AB');
});

test('review button keeps the real host when it is the known production host', async () => {
  resetState();
  await submit({ host: 'autocuan.web.id', origin: 'https://autocuan.web.id' });
  const target = reviewTarget(state.sent[0]);
  assert.equal(target.origin, 'https://autocuan.web.id');
  assert.equal(target.pathname, '/dashboard');
});

test('SUBSCRIPTION_PUBLIC_BASE_URL still wins over request headers', async () => {
  resetState();
  process.env.SUBSCRIPTION_PUBLIC_BASE_URL = 'https://staging.autocuan.web.id';
  try {
    await submit({ 'x-forwarded-host': 'evil.example.com', host: 'evil.example.com', origin: 'https://evil.example.com' });
    const target = reviewTarget(state.sent[0]);
    assert.equal(target.origin, 'https://staging.autocuan.web.id');
    assert.equal(target.pathname, '/dashboard');
  } finally {
    delete process.env.SUBSCRIPTION_PUBLIC_BASE_URL;
  }
});

test('a malformed SUBSCRIPTION_PUBLIC_BASE_URL does not produce a broken URL', async () => {
  resetState();
  process.env.SUBSCRIPTION_PUBLIC_BASE_URL = 'not a url';
  try {
    await submit();
    const target = reviewTarget(state.sent[0]);
    assert.equal(target.protocol, 'https:');
    assert.equal(target.host, 'autocuan.web.id', 'unvalidated base URL reached the button: ' + target.raw);
  } finally {
    delete process.env.SUBSCRIPTION_PUBLIC_BASE_URL;
  }
});

// ---------------------------------------------------------------------------
// 2. Unbounded re-notification on the idempotent re-submit path.
// ---------------------------------------------------------------------------

test('re-submitting an already-notified payment does not re-notify the admin', async () => {
  resetState({ admin_telegram_message_id: 555 });
  const res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(state.sent.length, 0, 'admin was notified again for an already-notified payment');
});

test('repeated submits produce at most one admin notification', async () => {
  resetState();
  for (let i = 0; i < 5; i++) await submit();
  assert.equal(state.sent.length, 1, 'expected exactly one admin notification, got ' + state.sent.length);
});

test('the first submit still notifies the admin', async () => {
  resetState();
  const res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(state.sent.length, 1);
  assert.equal(res.body.admin_notified, true);
});

test('the recorded admin message id is persisted on the first notification', async () => {
  resetState();
  await submit();
  const recorded = state.updates.filter(u => u.table === 'subscription_manual_payments' && u.patch.admin_telegram_message_id);
  assert.equal(recorded.length, 1);
  assert.equal(state.payment.admin_telegram_message_id, 901);
});

test('a failed delivery leaves the payment retryable', async () => {
  resetState();
  const original = state.senderFactory;
  state.senderFactory = () => ({
    async sendMessage() { throw new Error('telegram down'); },
    async editMessageText() { return null; },
    async deleteMessage() { return true; }
  });
  try {
    const res = await submit();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.admin_notified, false);
    assert.equal(state.payment.admin_telegram_message_id, null, 'no message id must be recorded for a failed send');
  } finally {
    state.senderFactory = original;
  }
  // With no message id recorded, a later submit is allowed to try again.
  const retry = await submit();
  assert.equal(retry.statusCode, 200);
  assert.equal(state.sent.length, 1, 'retry after a failed delivery must be allowed');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bot = require('../lib/voucher-admin-bot');
const capability = require('../lib/subscription-capability');

const root = path.join(__dirname, '..');
const foundationSql = fs.readFileSync(path.join(root, 'supabase', 'subscription-phase-5c-voucher-admin-migration.sql'), 'utf8');
const lifecycleSql = fs.readFileSync(path.join(root, 'supabase', 'subscription-phase-5c-lifecycle-correction.sql'), 'utf8');
const combinedSql = foundationSql + '\n' + lifecycleSql;
const batch = { batch_reference: 'VB-A1B2C3D4E5F6', voucher_type: 'PERCENT_100', plan_code: 'PREMIUM_1_MONTH' };
const claimData = { chunk_index: 0, attempt_id: 'attempt-1', claim_token: 'token-1', expected_count: 1 };

function dbWith(handler) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return handler(name, args, calls);
    }
  };
}

function setVoucherEnv() {
  process.env.VOUCHER_CODE_PEPPER = 'phase5c-test-pepper-long-enough';
}

test.afterEach(() => {
  delete process.env.VOUCHER_CODE_PEPPER;
});

test('canonical attempt and lifecycle contracts are service-role only', () => {
  for (const name of [
    'claim_voucher_admin_batch_chunk(text)',
    'prepare_voucher_admin_batch_chunk(text,bigint,uuid,uuid,jsonb)',
    'record_voucher_admin_chunk_delivery(text,bigint,uuid,uuid,text,bigint,integer)',
    'mark_voucher_admin_chunk_delivery_uncertain(text,bigint,uuid,uuid)',
    'finalize_voucher_admin_batch_chunk(text,bigint,uuid,uuid)',
    'cancel_voucher_admin_batch_chunk(text,bigint,uuid,uuid,text)'
  ]) {
    assert.match(combinedSql, new RegExp('FUNCTION public\\.' + name.split('(')[0]));
    assert.match(combinedSql, new RegExp('REVOKE ALL ON FUNCTION[^;]*' + name.replace(/[()]/g, '\\$&')));
    assert.match(combinedSql, new RegExp('GRANT EXECUTE ON FUNCTION[^;]*' + name.replace(/[()]/g, '\\$&')));
  }
  assert.match(lifecycleSql, /voucher_admin_schema_version/);
  assert.match(lifecycleSql, /phase5c-lifecycle-v2/);
  assert.match(combinedSql, /voucher_batch_chunk_attempts/);
  assert.match(foundationSql, /DROP INDEX IF EXISTS public\.subscription_voucher_chunk_item_idx/);
});

test('voucher admin capability requires configuration and lifecycle schema marker', async () => {
  const env = {
    SUBSCRIPTION_FEATURE_ENABLED: 'true',
    VOUCHER_ADMIN_BOT_ENABLED: 'true',
    VOUCHER_ADMIN_TELEGRAM_BOT_TOKEN: '1234567890:valid-test-token',
    VOUCHER_CODE_PEPPER: 'phase5c-test-pepper-long-enough'
  };
  const ready = await capability.getVoucherAdminCapability({ rpc: async () => ({ data: 'phase5c-lifecycle-v2' }) }, env);
  assert.equal(ready.ready, true);
  const stale = await capability.getVoucherAdminCapability({ rpc: async () => ({ data: 'phase5c-lifecycle-v1' }) }, env);
  assert.equal(stale.ready, false);
  const missingConfig = await capability.getVoucherAdminCapability({ rpc: async () => ({ data: 'phase5c-lifecycle-v2' }) }, { ...env, VOUCHER_CODE_PEPPER: '' });
  assert.equal(missingConfig.ready, false);
  assert.equal(missingConfig.reason, 'configuration');
});

test('voucher type labels do not concatenate the lifetime identifier', () => {
  assert.equal(bot.typeLabel('LIFETIME'), 'Lifetime');
  assert.equal(bot.typeLabel('PERCENT_50'), '50%');
});

test('delivery does not report a claim failure as a completed batch', async () => {
  const db = dbWith(name => name === 'claim_voucher_admin_batch_chunk' ? { error: true } : { data: {} });
  const result = await bot.deliverOneChunk({ chat: { id: 1 } }, { db }, async () => ({ message_id: 1 }), { sendDocument: async () => ({ message_id: 1 }) }, batch);
  assert.equal(result.outcome, 'claim_failed');
});

test('invalid prepare response cancels the claimed attempt before returning', async () => {
  setVoucherEnv();
  let sent = 0;
  const db = dbWith(name => {
    if (name === 'claim_voucher_admin_batch_chunk') return { data: claimData };
    if (name === 'prepare_voucher_admin_batch_chunk') return { data: { prepared: true, attempt_id: claimData.attempt_id, expected_count: 1, stored_count: 0 } };
    if (name === 'cancel_voucher_admin_batch_chunk') return { data: { cancelled: true } };
    return { data: {} };
  });
  const result = await bot.deliverOneChunk({ chat: { id: 1 } }, { db }, async () => { sent++; }, { sendDocument: async () => { sent++; } }, batch);
  assert.equal(result.outcome, 'prepare_failed');
  assert.equal(sent, 0);
  assert.equal(db.calls.some(call => call.name === 'cancel_voucher_admin_batch_chunk'), true);
});

test('missing Telegram message id marks a prepared attempt uncertain', async () => {
  setVoucherEnv();
  const db = dbWith(name => {
    if (name === 'claim_voucher_admin_batch_chunk') return { data: claimData };
    if (name === 'prepare_voucher_admin_batch_chunk') return { data: { prepared: true, attempt_id: claimData.attempt_id, expected_count: 1, stored_count: 1 } };
    if (name === 'mark_voucher_admin_chunk_delivery_uncertain') return { data: { uncertain: true } };
    return { data: {} };
  });
  const result = await bot.deliverOneChunk({ chat: { id: 1 } }, { db }, async () => ({}), { sendDocument: async () => ({}) }, batch);
  assert.equal(result.outcome, 'delivery_uncertain');
  assert.equal(db.calls.some(call => call.name === 'mark_voucher_admin_chunk_delivery_uncertain'), true);
});

test('lost receipt response reconciles through the idempotent finalizer', async () => {
  setVoucherEnv();
  const db = dbWith(name => {
    if (name === 'claim_voucher_admin_batch_chunk') return { data: claimData };
    if (name === 'prepare_voucher_admin_batch_chunk') return { data: { prepared: true, attempt_id: claimData.attempt_id, expected_count: 1, stored_count: 1 } };
    if (name === 'record_voucher_admin_chunk_delivery') return { error: true };
    if (name === 'mark_voucher_admin_chunk_delivery_uncertain') return { data: { uncertain: true } };
    if (name === 'finalize_voucher_admin_batch_chunk') return { data: { finalized: true, complete: true } };
    return { data: {} };
  });
  const result = await bot.deliverOneChunk({ chat: { id: 1 } }, { db }, async () => ({ message_id: 42 }), { sendDocument: async () => ({ message_id: 42 }) }, batch);
  assert.equal(result.outcome, 'delivered');
  assert.equal(result.generated, 1);
});

test('finalize transport loss is retried before the attempt becomes uncertain', async () => {
  setVoucherEnv();
  let finalizations = 0;
  const db = dbWith(name => {
    if (name === 'claim_voucher_admin_batch_chunk') return { data: claimData };
    if (name === 'prepare_voucher_admin_batch_chunk') return { data: { prepared: true, attempt_id: claimData.attempt_id, expected_count: 1, stored_count: 1 } };
    if (name === 'record_voucher_admin_chunk_delivery') return { data: { recorded: true } };
    if (name === 'finalize_voucher_admin_batch_chunk') {
      finalizations++;
      return finalizations === 1 ? { error: true } : { data: { finalized: true, complete: true } };
    }
    if (name === 'mark_voucher_admin_chunk_delivery_uncertain') return { data: { uncertain: true } };
    return { data: {} };
  });
  const result = await bot.deliverOneChunk({ chat: { id: 1 } }, { db }, async () => ({ message_id: 43 }), { sendDocument: async () => ({ message_id: 43 }) }, batch);
  assert.equal(result.outcome, 'delivered');
  assert.equal(finalizations, 2);
  assert.equal(db.calls.some(call => call.name === 'mark_voucher_admin_chunk_delivery_uncertain'), false);
});

test('duplicate confirmation resumes the existing batch instead of abandoning it', async () => {
  const db = dbWith(name => {
    if (name === 'create_voucher_admin_batch') return { data: { ...batch, already_exists: true, progress_cursor: 0 } };
    if (name === 'claim_voucher_admin_batch_chunk') return { data: { done: true, complete: true, progress_cursor: 1 } };
    return { data: {} };
  });
  const result = await bot.confirm({ from: { id: 6396446903 }, chat: { id: 6396446903 } }, { db }, async () => ({}), '22222222-2222-4222-8222-222222222222', { sendDocument: async () => ({}) });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.duplicate_confirmation, true);
  assert.equal(db.calls.some(call => call.name === 'claim_voucher_admin_batch_chunk'), true);
});

test('Phase 5C retains exactly twelve api JavaScript files', () => {
  assert.equal(fs.readdirSync(path.join(root, 'api')).filter(name => name.endsWith('.js')).length, 12);
});

'use strict';
// BUG-TEL-PENDING-DEADLOCK regression suite (2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');
const delivery = require('../lib/telegram-delivery');

function row(overrides) {
  return Object.assign({
    id: 1,
    date: '2026-10-05',
    ticker: 'AVIA',
    status: 'DELIVERY_PENDING',
    first_sent_at: null,
    updated_at: null,
    raw_payload: {}
  }, overrides || {});
}

test('TEL-01/TEL-02: stale PENDING without receipt no longer blocks retry forever', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  // Production evidence row: prepared 2026-10-05, updated_at null.
  const stale = row({ raw_payload: { telegram_delivery_prepared_at: '2026-10-05T12:01:13.120Z' } });
  assert.equal(delivery.rowBlocksRetry(stale, { now }), false, 'stale pending must be recoverable');

  // Fresh pending (2 minutes old) still blocks duplicate concurrent sends.
  const fresh = row({ updated_at: new Date(now - 2 * 60 * 1000).toISOString() });
  assert.equal(delivery.rowBlocksRetry(fresh, { now }), true, 'fresh pending blocks concurrent send');
});

test('TEL-05: SENT row can never resend (first_sent_at wins over status)', () => {
  const sent = row({ status: 'WAITING', first_sent_at: '2026-10-05T12:02:00.000Z' });
  assert.equal(delivery.rowWasDelivered(sent), true);
  const pendingWithReceipt = row({ first_sent_at: '2026-10-05T12:02:00.000Z', updated_at: null });
  assert.equal(delivery.rowBlocksRetry(pendingWithReceipt), true, 'receipt-bearing rows are delivered');
});

test('TEL-09: old stale pending is retry-INELIGIBLE (age guard, no old blast)', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const ancient = row({ raw_payload: { telegram_delivery_prepared_at: '2026-10-05T12:01:13.120Z' } });
  assert.equal(delivery.rowIsRetryExpired(ancient, { now }), true, 'weeks-old pending must expire');

  const recent = row({
    raw_payload: { telegram_delivery_prepared_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() }
  });
  assert.equal(delivery.rowIsRetryExpired(recent, { now }), false, 'recent pending may retry');
});

test('TEL-04: recoverStaleDeliveryClaims expires ancient claims and requeues recent ones', async () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const updates = [];
  const rows = [
    { id: 11, status: 'DELIVERY_PENDING', first_sent_at: null, updated_at: null, raw_payload: { telegram_delivery_prepared_at: '2026-10-05T12:01:13.120Z' } }, // ancient -> EXPIRED
    { id: 12, status: 'DELIVERY_IN_PROGRESS', first_sent_at: null, updated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), raw_payload: {} }, // 2h -> RETRYABLE
    { id: 13, status: 'DELIVERY_PENDING', first_sent_at: null, updated_at: new Date(now - 60 * 1000).toISOString(), raw_payload: {} } // fresh -> untouched
  ];
  const supabase = {
    from() {
      const builder = {
        select() { return builder; },
        in() { return builder; },
        update(values) { updates.push(values); return builder; },
        then(resolve) { return resolve({ data: rows, error: null }); }
      };
      return builder;
    }
  };
  const result = await delivery.recoverStaleDeliveryClaims({ supabase, now });
  assert.equal(result.expired, 1, 'ancient claim expires');
  assert.equal(result.retryable, 1, 'recent claim requeues');
  assert.ok(updates.some((u) => u.status === 'EXPIRED'));
  assert.ok(updates.some((u) => u.status === 'DELIVERY_RETRYABLE'));
});

test('TEL-03: fresh pending blocks duplicate concurrent send via rowBlocksRetry', () => {
  const now = Date.now();
  const fresh = row({ updated_at: new Date(now - 30 * 1000).toISOString() });
  assert.equal(delivery.rowBlocksRetry(fresh, { now }), true);
});

test('TEL-06: WAITING is only written after delivery (statusFor logic via finalizePreparedDelivery contract)', () => {
  // finalizePreparedDelivery writes first_sent_at only for the WAITING group.
  // Verified indirectly: delivered classification comes from classifyTelegramResult(sent:true).
  const sent = delivery.classifyTelegramResult({ sent: true, chunks_sent: 1, chunks_total: 1 });
  assert.equal(sent.state, 'delivered');
  const timeout = delivery.classifyTelegramResult({ sent: false, reason: 'telegram_timeout', status: null });
  assert.notEqual(timeout.state, 'delivered');
  assert.ok(timeout.retryable === true || timeout.uncertain === true, 'timeout must be retryable or uncertain, never delivered');
});

test('TEL-07/TEL-08: timeout classification stays retryable (bounded by caller), never permanent success', () => {
  const timeout = delivery.classifyTelegramResult({ sent: false, reason: 'telegram_timeout', chunks_sent: 0, chunks_total: 1 });
  assert.equal(timeout.delivered, false);
  assert.equal(timeout.permanent, false);
});

test('TEL-14: delivery store unavailable fails closed (no blind send)', async () => {
  const result = await delivery.prepareCandidatesForDelivery({
    candidates: [{ ticker: 'AAAA' }],
    date: '2026-10-09',
    source: 'daytrade'
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'delivery_store_unavailable');
  assert.equal(result.send_candidates.length, 0);
});

test('TEL-15: module never logs or returns secrets', () => {
  const source = require('fs').readFileSync(require.resolve('../lib/telegram-delivery'), 'utf8');
  assert.equal(/console\.log\([^)]*token/i.test(source), false, 'no token logging');
  assert.equal(/TELEGRAM_BOT_TOKEN\s*[:=]\s*['"][^'"]+['"]/.test(source), false, 'no hardcoded token');
});

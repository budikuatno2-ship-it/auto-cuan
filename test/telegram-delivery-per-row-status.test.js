'use strict';

/**
 * One failed Telegram message must not poison the whole Top 5 batch.
 *
 * The nightly Top 5 path sends SEVERAL messages for one prepared batch — a
 * header, one card per candidate, and (in watchlist mode) a footer — and hands
 * every result to finalizePreparedDelivery as `send_results`
 * (api/sector-hot.js:6512).
 *
 * finalizePreparedDelivery reduces those results to ONE delivery state and
 * writes it to EVERY prepared row. So a single failure anywhere in the batch —
 * including the header, which is not a candidate row at all — marks every row
 * DELIVERY_UNCERTAIN and leaves first_sent_at null.
 *
 * That is not a cosmetic status. A row without first_sent_at and with a
 * DELIVERY_* status fails monitorRowIsTrackable(), so a signal that WAS
 * published to Telegram is never monitored for entry / TP1 / TP2 / SL. And
 * DELIVERY_UNCERTAIN satisfies rowBlocksRetry(), so the one that genuinely
 * failed can never be retried either.
 *
 * These tests assert the property: each row's recorded state must follow ITS OWN
 * message, not the batch aggregate.
 */

const test = require('node:test');
const assert = require('node:assert');

const delivery = require('../lib/telegram-delivery');

/** Supabase double capturing every update issued against telegram_daily_picks. */
function fakeSupabase() {
  const updates = [];
  return {
    updates,
    from(table) {
      assert.strictEqual(table, 'telegram_daily_picks');
      return {
        update(patch) {
          return {
            in(column, ids) {
              assert.strictEqual(column, 'id');
              updates.push({ patch, ids: ids.slice() });
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    }
  };
}

const OK = { sent: true, status: 200 };
const FAILED = { sent: false, reason: 'api_error', status: 500 };

/** The status each row id ended up with, across all captured updates. */
function statusById(supabase) {
  const out = {};
  for (const u of supabase.updates) {
    for (const id of u.ids) out[id] = u.patch;
  }
  return out;
}

async function finalize(supabase, rowIds, sendResults, rowResults) {
  const options = {
    supabase,
    preparation: { row_ids: rowIds, legacy_fallback: false },
    send_results: sendResults
  };
  if (rowResults) options.row_results = rowResults;
  return delivery.finalizePreparedDelivery(options);
}

test('1. every message delivered -> every row WAITING with first_sent_at', async () => {
  const db = fakeSupabase();
  await finalize(db, ['r1', 'r2', 'r3'], [OK, OK, OK, OK], [OK, OK, OK]);
  const byId = statusById(db);
  for (const id of ['r1', 'r2', 'r3']) {
    assert.strictEqual(byId[id].status, 'WAITING', id + ' must be WAITING');
    assert.ok(byId[id].first_sent_at, id + ' must carry first_sent_at');
  }
});

test('2. the header fails but every card is delivered -> every row still WAITING', async () => {
  const db = fakeSupabase();
  // results: header FAILED, then one OK card per row.
  await finalize(db, ['r1', 'r2', 'r3'], [FAILED, OK, OK, OK], [OK, OK, OK]);
  const byId = statusById(db);
  for (const id of ['r1', 'r2', 'r3']) {
    assert.strictEqual(
      byId[id].status, 'WAITING',
      id + ' was published to Telegram; a failed header must not mark it uncertain'
    );
    assert.ok(byId[id].first_sent_at, id + ' must carry first_sent_at so the monitor tracks it');
  }
});

test('3. one card fails -> only that row is not delivered', async () => {
  const db = fakeSupabase();
  await finalize(db, ['r1', 'r2', 'r3'], [OK, OK, FAILED, OK], [OK, FAILED, OK]);
  const byId = statusById(db);
  assert.strictEqual(byId.r1.status, 'WAITING', 'r1 was delivered');
  assert.ok(byId.r1.first_sent_at);
  assert.strictEqual(byId.r3.status, 'WAITING', 'r3 was delivered');
  assert.ok(byId.r3.first_sent_at);
  assert.notStrictEqual(byId.r2.status, 'WAITING', 'r2 genuinely failed');
  assert.ok(!byId.r2.first_sent_at, 'r2 must not claim a send time');
});

test('4. a failed row stays retryable, not uncertain', async () => {
  const db = fakeSupabase();
  await finalize(db, ['r1', 'r2'], [OK, OK, FAILED], [OK, FAILED]);
  const byId = statusById(db);
  assert.strictEqual(
    byId.r2.status, 'DELIVERY_RETRYABLE',
    'a clean 500 with no chunk sent is retryable; DELIVERY_UNCERTAIN would block the retry forever'
  );
});

test('5. a permanent rejection is recorded as permanent for that row only', async () => {
  const db = fakeSupabase();
  const forbidden = { sent: false, reason: 'api_error', status: 403 };
  await finalize(db, ['r1', 'r2'], [OK, OK, forbidden], [OK, forbidden]);
  const byId = statusById(db);
  assert.strictEqual(byId.r1.status, 'WAITING');
  assert.strictEqual(byId.r2.status, 'DELIVERY_FAILED');
});

test('6. an uncertain send stays uncertain for that row only', async () => {
  const db = fakeSupabase();
  const timedOut = { sent: false, reason: 'telegram_timeout' };
  await finalize(db, ['r1', 'r2'], [OK, OK, timedOut], [OK, timedOut]);
  const byId = statusById(db);
  assert.strictEqual(byId.r1.status, 'WAITING');
  assert.strictEqual(byId.r2.status, 'DELIVERY_UNCERTAIN');
});

test('7. monitor_registered_count counts only the rows actually delivered', async () => {
  const db = fakeSupabase();
  const out = await finalize(db, ['r1', 'r2', 'r3'], [OK, OK, FAILED, OK], [OK, FAILED, OK]);
  assert.strictEqual(out.monitor_registered_count, 2);
  assert.strictEqual(out.persistence_ok, true);
});

test('8. without row_results the existing batch behaviour is unchanged', async () => {
  // The three single-message callers (Day Trade, Swing Konglo, Swing Non-Konglo)
  // send ONE message for the whole batch and pass no per-row mapping. There the
  // aggregate IS the right answer and must not change.
  const db = fakeSupabase();
  const out = await finalize(db, ['r1', 'r2'], [OK]);
  const byId = statusById(db);
  assert.strictEqual(byId.r1.status, 'WAITING');
  assert.strictEqual(byId.r2.status, 'WAITING');
  assert.strictEqual(out.delivery_state, 'delivered');

  const db2 = fakeSupabase();
  const out2 = await finalize(db2, ['r1', 'r2'], [FAILED]);
  assert.strictEqual(statusById(db2).r1.status, 'DELIVERY_RETRYABLE');
  assert.strictEqual(out2.delivery_state, 'retryable_failure');
});

test('9. a row with no result of its own is left retryable, never marked sent', async () => {
  const db = fakeSupabase();
  await finalize(db, ['r1', 'r2'], [OK, OK], [OK, null]);
  const byId = statusById(db);
  assert.strictEqual(byId.r1.status, 'WAITING');
  assert.strictEqual(byId.r2.status, 'DELIVERY_RETRYABLE', 'no result means not sent, and retryable');
  assert.ok(!byId.r2.first_sent_at);
});

test('10. a delivered row is trackable and a poisoned one would not have been', () => {
  // Ties the status back to the consequence this bug actually has.
  const delivered = { status: 'WAITING', first_sent_at: '2026-09-03T10:00:00.000Z', raw_payload: {} };
  const poisoned = { status: 'DELIVERY_UNCERTAIN', first_sent_at: null, raw_payload: {} };
  assert.strictEqual(delivery.monitorRowIsTrackable(delivered), true);
  assert.strictEqual(
    delivery.monitorRowIsTrackable(poisoned), false,
    'this is why the wrong status silently stops entry/TP/SL monitoring'
  );
  assert.strictEqual(delivery.rowBlocksRetry(poisoned), true, 'and why it can never be retried');
});

// ---------------------------------------------------------------------------
// Wiring: the per-row mapping only helps if the Top 5 caller actually supplies
// it, and only if it is aligned to the array the notifier was given.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const sectorHotSource = fs.readFileSync(
  path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8'
);

test('11. the Top 5 notifier returns a per-candidate result array', () => {
  assert.match(
    sectorHotSource,
    /per_candidate_results:\s*perCandidateResults/,
    'sendDailyTop5Telegram must expose its per-candidate results'
  );
  assert.match(
    sectorHotSource,
    /var perCandidateResults = new Array\(\(picks \|\| \[\]\)\.length\)\.fill\(null\)/,
    'the array must be sized and indexed by the INPUT picks array, which is what row_ids is aligned to'
  );
  assert.match(
    sectorHotSource,
    /var candidateIndex = \(picks \|\| \[\]\)\.indexOf\(safePicks\[i\]\);/,
    'each card result must be filed under its candidate position in the input array'
  );
});

test('12. the Top 5 finalize call passes row_results', () => {
  const call = sectorHotSource.match(
    /finalizePreparedDelivery\(\{[\s\S]{0,600}?preparation:\s*top5DeliveryPrep[\s\S]{0,600}?\}\)/
  );
  assert.ok(call, 'the Top 5 finalize call must be present');
  assert.match(
    call[0],
    /row_results:\s*\n?\s*notifier\.per_candidate_results/,
    'the Top 5 path sends several messages per batch, so it must supply the per-row mapping'
  );
});

test('13. the three single-message callers deliberately do NOT pass row_results', () => {
  // Day Trade, Swing Konglo and Swing Non-Konglo each send ONE message for the
  // whole batch. There the aggregate is the correct answer and passing a mapping
  // would be wrong, so their calls must stay as they are.
  for (const prep of ['dtDeliveryPrep', 'skDeliveryPrep', 'nkDeliveryPrep']) {
    const re = new RegExp(
      'finalizePreparedDelivery\\(\\{[\\s\\S]{0,400}?preparation:\\s*' + prep + '[\\s\\S]{0,400}?\\}\\)'
    );
    const call = sectorHotSource.match(re);
    assert.ok(call, 'expected a finalize call for ' + prep);
    assert.ok(
      !/row_results/.test(call[0]),
      prep + ' sends one message for the batch; it must keep the aggregate behaviour'
    );
    assert.match(call[0], /send_result:\s*result/, prep + ' passes a single send_result');
  }
});

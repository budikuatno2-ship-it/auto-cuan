'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const delivery =
  require('../lib/telegram-delivery');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeDb(initialRows) {
  const rows = (initialRows || []).map(clone);
  let nextId = rows.length + 1;

  return {
    rows,

    from(table) {
      assert.equal(
        table,
        'telegram_daily_picks'
      );

      return {
        select() {
          return {
            eq(field, value) {
              return Promise.resolve({
                data: rows
                  .filter(row => row[field] === value)
                  .map(clone),
                error: null
              });
            }
          };
        },

        insert(values) {
          const inserted =
            (values || []).map(value => {
              const row = Object.assign(
                {},
                clone(value),
                { id: nextId++ }
              );

              rows.push(row);
              return clone(row);
            });

          return {
            select() {
              return Promise.resolve({
                data: inserted,
                error: null
              });
            }
          };
        },

        update(patch) {
          const filters = [];
          let cached = null;

          function run() {
            if (cached) return cached;

            const matched = rows.filter(row =>
              filters.every(filter =>
                filter.values.includes(row[filter.field])
              )
            );

            matched.forEach(row =>
              Object.assign(row, clone(patch))
            );

            cached = Promise.resolve({
              data: matched.map(clone),
              error: null
            });

            return cached;
          }

          const builder = {
            in(field, values) {
              filters.push({
                field,
                values
              });

              return builder;
            },

            select() {
              return run();
            },

            then(resolve, reject) {
              return run().then(resolve, reject);
            }
          };

          return builder;
        }
      };
    }
  };
}

function identity(candidate, date, source) {
  return {
    valid: true,
    ticker: candidate.ticker,
    monitor_source: source,
    plan_lock_id:
      candidate.plan_lock_id || 'plan-1',
    trade_plan_source: 'test'
  };
}

function buildRow(candidate, date) {
  return {
    date,
    ticker: candidate.ticker,
    status: 'WAITING',
    first_sent_at: null,
    raw_payload: {}
  };
}

test(
  'mixed sent and failed batch is uncertain',
  () => {
    const summary =
      delivery.summarizeTelegramResults([
        { sent: true },
        {
          sent: false,
          reason: 'api_error',
          status: 500
        }
      ]);

    assert.equal(
      summary.delivery_state,
      'delivery_uncertain'
    );
  }
);

test(
  'prepare happens before send and success prevents retry',
  async () => {
    const db = makeDb([]);

    const prepared =
      await delivery.prepareCandidatesForDelivery({
        supabase: db,
        candidates: [{
          ticker: 'TEST',
          plan_lock_id: 'plan-1'
        }],
        date: '2026-08-05',
        source: 'daytrade_signal',
        build_identity: identity,
        build_row: buildRow
      });

    assert.equal(prepared.ready, true);
    assert.equal(
      db.rows[0].status,
      'DELIVERY_IN_PROGRESS'
    );

    const finalized =
      await delivery.finalizePreparedDelivery({
        supabase: db,
        preparation: prepared,
        send_results: [{ sent: true }]
      });

    assert.equal(
      finalized.delivery_state,
      'delivered'
    );

    assert.equal(db.rows[0].status, 'WAITING');
    assert.ok(db.rows[0].first_sent_at);

    const retry =
      await delivery.prepareCandidatesForDelivery({
        supabase: db,
        candidates: [{
          ticker: 'TEST',
          plan_lock_id: 'plan-1'
        }],
        date: '2026-08-05',
        source: 'daytrade_signal',
        build_identity: identity,
        build_row: buildRow
      });

    assert.equal(retry.ready, false);
    assert.equal(
      retry.reason,
      'already_delivered'
    );
  }
);

test(
  'Top5 can claim an existing unsent locked row by id',
  async () => {
    const db = makeDb([{
      id: 91,
      date: '2026-08-05',
      ticker: 'LOCK',
      monitor_source: 'daily_top5',
      plan_lock_id: 'top-plan',
      status: 'WAITING',
      first_sent_at: null,
      raw_payload: {
        lock_source:
          'telegram-daily-picks.lock_only'
      }
    }]);

    const prepared =
      await delivery.prepareCandidatesForDelivery({
        supabase: db,
        candidates: [{
          ticker: 'LOCK',
          plan_lock_id: 'top-plan',
          _daily_pick_row_id: 91
        }],
        date: '2026-08-05',
        source: 'daily_top5',
        build_identity: identity,
        build_row: buildRow,
        allow_existing_unsent: true
      });

    assert.equal(prepared.ready, true);
    assert.equal(prepared.inserted_count, 0);
    assert.deepEqual(prepared.row_ids, [91]);

    assert.equal(
      db.rows[0].status,
      'DELIVERY_IN_PROGRESS'
    );
  }
);

test(
  'source contains Top5 prepare-send-finalize ordering',
  () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'api',
        'sector-hot.js'
      ),
      'utf8'
    );

    const start = source.indexOf(
      'async function handleTelegramDailyPicks'
    );

    const end = source.indexOf(
      '\nfunction resolveMonitorSetupOrigin',
      start
    );

    const body = source.slice(start, end);

    const prepareAt = body.indexOf(
      'prepareCandidatesForDelivery'
    );

    const sendAt = body.indexOf(
      'sendDailyTop5Telegram'
    );

    const finalizeAt = body.indexOf(
      'finalizePreparedDelivery'
    );

    assert.ok(prepareAt >= 0);
    assert.ok(sendAt > prepareAt);
    assert.ok(finalizeAt > sendAt);
  }
);

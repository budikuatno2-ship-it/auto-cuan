'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../lib/intraday-fast-watcher-pool');

test(
  'dropped ticker re-entry starts a fresh watch cycle',
  function () {
    const date = '2026-07-31';

    const priorState = {
      schema_version: 2,
      date,
      rule_version: pool.RULE_VERSION,
      updated_at: '2026-07-31T03:13:00.000Z',
      shortlist: ['DMAS'],
      tickers: {
        DMAS: {
          active: false,
          in_latest_shortlist: false,
          shortlist_rank: 1,
          board: null,
          source_score: 90,
          source_status: 'WAIT_PULLBACK',
          status: 'DROPPED_FROM_WATCH_POOL',
          ready_streak: 1,

          first_price: 158,
          first_time: '09:10',
          first_observation_minute: 550,
          expires_at_minute: 562,
          max_expires_at_minute: 598,
          extension_count: 3,

          last_time: '10:13',
          last_observation_minute: 613,
          last_price: 160,
          last_volume: 1000000,
          last_volume_rate: 10000,
          last_watch_score: 90.8,
          last_publish_score: 90.8,
          stagnant_count: 0,

          processed_keys: ['old-cycle-key'],
          last_reasons: ['max_watch_age_reached'],
          last_observation: { ticker: 'DMAS' },
          last_metrics: {
            current_price: 160,
            watch_score: 90.8,
            publish_score: 90.8
          }
        }
      }
    };

    const result = pool.process({
      sampleDate: date,
      scheduledTime: '10:22',
      shortlistRows: [{
        ticker: 'DMAS',
        source_rank: 1,
        score: 90,
        source_status: 'WAIT_PULLBACK'
      }],
      observations: [],
      priorState,
      now: '2026-07-31T03:22:00.000Z'
    });

    const item = result.state.tickers.DMAS;

    assert.equal(item.active, true);
    assert.equal(item.status, 'WATCHING');
    assert.equal(item.ready_streak, 0);

    // 10:22 WIB = minute 622.
    assert.equal(item.first_observation_minute, 622);
    assert.equal(item.expires_at_minute, 634);
    assert.equal(item.max_expires_at_minute, 670);

    assert.equal(item.first_price, null);
    assert.equal(item.last_watch_score, null);
    assert.equal(item.last_publish_score, null);
    assert.deepEqual(item.processed_keys, []);

    assert.equal(
      result.events.some(function (event) {
        return event.ticker === 'DMAS' &&
          event.to_status === 'DROPPED_FROM_WATCH_POOL';
      }),
      false
    );
  }
);

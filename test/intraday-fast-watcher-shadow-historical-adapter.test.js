'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const adapter =
  require(
    '../lib/intraday-fast-watcher-shadow-historical-adapter'
  );

function radarItem(extra) {
  return Object.assign({
    key:
      'WATCHING|RADAR|100|105|115|120|95',
    status:
      'RADAR AKTIF — PANTAU',
    watch_score: 70,
    sent_at:
      '2026-08-10T02:10:05.000Z',
    scheduled_time:
      '09:10'
  }, extra || {});
}

function candidate(extra) {
  return Object.assign({
    ticker: 'TEST',
    sample_timestamp:
      '2026-08-10T02:13:03.000Z',
    scheduled_time:
      '09:13',
    current_price: 103,
    open: 90,
    high: 999,
    low: 1,
    freshness: {
      is_stale: false,
      stale_reason: null
    },
    selected_trade_plan: {
      entry_zone_low: 1,
      entry_zone_high: 2,
      tp1: 3,
      tp2: 4,
      stop_loss: 0
    }
  }, extra || {});
}

function event(extra) {
  return Object.assign({
    ticker: 'TEST',
    time: '09:13',
    metrics: {
      volume_rate_vs_average: 4.25
    }
  }, extra || {});
}

test(
  'normalizes dictionary radar schema',
  () => {
    const rows =
      adapter.normalizeRadarEntries({
        tickers: {
          TEST:
            radarItem()
        }
      });

    assert.equal(
      rows.length,
      1
    );

    assert.equal(
      rows[0].ticker,
      'TEST'
    );
  }
);

test(
  'parses immutable plan from published radar key',
  () => {
    const plan =
      adapter.parseRadarPlan(
        radarItem()
      );

    assert.equal(
      plan.valid,
      true
    );

    assert.equal(
      plan.entry_low,
      100
    );

    assert.equal(
      plan.entry_high,
      105
    );

    assert.equal(
      plan.tp1,
      115
    );

    assert.equal(
      plan.tp2,
      120
    );

    assert.equal(
      plan.stop_loss,
      95
    );

    assert.equal(
      plan.source,
      'published_radar_key'
    );
  }
);

test(
  'invalid radar plan fails closed',
  () => {
    const plan =
      adapter.parseRadarPlan(
        radarItem({
          key:
            'WATCHING|RADAR|100|105|102|120|95'
        })
      );

    assert.equal(
      plan.valid,
      false
    );
  }
);

test(
  'drops pre-publication snapshots and keeps only post-publication prices',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate({
            sample_timestamp:
              '2026-08-10T02:10:04.000Z',
            current_price: 101
          }),

          candidate({
            sample_timestamp:
              '2026-08-10T02:13:03.000Z',
            current_price: 103
          })
        ],

        events: []
      });

    assert.equal(
      result.observations.length,
      1
    );

    assert.equal(
      result.observations[0]
        .current_price,
      103
    );
  }
);

test(
  'never forwards historical daily OHLC as 15m evidence',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate()
        ],

        events: []
      });

    const row =
      result.observations[0];

    assert.equal(
      Object.hasOwn(row, 'high'),
      false
    );

    assert.equal(
      Object.hasOwn(row, 'low'),
      false
    );

    assert.equal(
      Object.hasOwn(row, 'open'),
      false
    );

    assert.equal(
      Object.hasOwn(row, 'candle_time'),
      false
    );
  }
);

test(
  'published radar plan wins over candidate plan drift',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate({
            entry_low: 1,
            entry_high: 2,
            tp1: 3,
            tp2: 4,
            sl: 0
          })
        ],

        events: []
      });

    const row =
      result.observations[0];

    assert.equal(
      row.entry_low,
      100
    );

    assert.equal(
      row.entry_high,
      105
    );

    assert.equal(
      row.tp1,
      115
    );

    assert.equal(
      row.stop_loss,
      95
    );
  }
);

test(
  'joins exact production volume rate by ticker and scheduled time',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate()
        ],

        events: [
          event()
        ]
      });

    assert.equal(
      result.observations[0]
        .volume_rate_vs_average,
      4.25
    );

    assert.equal(
      result.diagnostics
        .exact_volume_rate_join,
      1
    );

    assert.equal(
      result.diagnostics
        .volume_rate_ge_4,
      1
    );
  }
);

test(
  'does not borrow volume rate from a different scheduled time',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate()
        ],

        events: [
          event({
            time: '09:22'
          })
        ]
      });

    assert.equal(
      Object.hasOwn(
        result.observations[0],
        'volume_rate_vs_average'
      ),
      false
    );
  }
);

test(
  'conflicting exact volume rates fail closed',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate()
        ],

        events: [
          event({
            metrics: {
              volume_rate_vs_average:
                4.25
            }
          }),

          event({
            metrics: {
              volume_rate_vs_average:
                5.10
            }
          })
        ]
      });

    assert.equal(
      Object.hasOwn(
        result.observations[0],
        'volume_rate_vs_average'
      ),
      false
    );

    assert.equal(
      result.diagnostics
        .volume_rate_conflicts,
      1
    );
  }
);

test(
  'duplicate identical event rates remain usable',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate()
        ],

        events: [
          event(),
          event()
        ]
      });

    assert.equal(
      result.observations[0]
        .volume_rate_vs_average,
      4.25
    );

    assert.equal(
      result.diagnostics
        .volume_rate_conflicts,
      0
    );
  }
);

test(
  'stale candidate is preserved but explicitly marked freshness invalid',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate({
            freshness: {
              is_stale: true,
              stale_reason:
                'stale_fixture'
            }
          })
        ],

        events: []
      });

    assert.equal(
      result.observations[0]
        .freshness_valid,
      false
    );

    assert.equal(
      result.observations[0]
        .stale_reason,
      'stale_fixture'
    );

    assert.equal(
      result.diagnostics
        .stale_observations,
      1
    );
  }
);

test(
  'ticker without post-publication observation is surfaced as NO_POST',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate({
            sample_timestamp:
              '2026-08-10T02:10:04.000Z'
          })
        ],

        events: []
      });

    assert.equal(
      result.observations.length,
      0
    );

    assert.deepEqual(
      result.no_post_tickers,
      ['TEST']
    );

    assert.equal(
      result.diagnostics
        .no_post_tickers,
      1
    );
  }
);

test(
  'output observations are chronological and renderer-ready',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            BBBB:
              radarItem({
                sent_at:
                  '2026-08-10T02:10:00.000Z'
              }),

            AAAA:
              radarItem({
                sent_at:
                  '2026-08-10T02:10:00.000Z'
              })
          }
        },

        candidates: [
          candidate({
            ticker: 'BBBB',
            sample_timestamp:
              '2026-08-10T02:20:00.000Z',
            scheduled_time:
              '09:20',
            current_price: 104
          }),

          candidate({
            ticker: 'AAAA',
            sample_timestamp:
              '2026-08-10T02:15:00.000Z',
            scheduled_time:
              '09:15',
            current_price: 103
          })
        ],

        events: []
      });

    assert.deepEqual(
      result.observations.map(
        row => row.ticker
      ),
      ['AAAA', 'BBBB']
    );

    for (
      const row of
      result.observations
    ) {
      assert.equal(
        row.fetch_ok,
        true
      );

      assert.equal(
        row.freshness_valid,
        true
      );

      assert.ok(
        row.observed_at
      );

      assert.ok(
        row.published_sent_at
      );
    }
  }
);

test(
  'missing current price is counted and omitted',
  () => {
    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate({
            current_price: null
          })
        ],

        events: []
      });

    assert.equal(
      result.observations.length,
      0
    );

    assert.equal(
      result.diagnostics
        .current_price_missing,
      1
    );
  }
);


test(
  'production TP2 below TP1 remains valid because lifecycle contract uses TP1',
  () => {
    const plan =
      adapter.parseRadarPlan({
        ticker: 'HRUM',
        key:
          'WATCHING|RADAR|835|850|910|905|815'
      });

    assert.equal(
      plan.valid,
      true
    );

    assert.equal(
      plan.entry_low,
      835
    );

    assert.equal(
      plan.entry_high,
      850
    );

    assert.equal(
      plan.tp1,
      910
    );

    /*
     * Preserve production provenance exactly.
     * Do not rewrite TP2 to manufacture ordering.
     */
    assert.equal(
      plan.tp2,
      905
    );

    assert.equal(
      plan.stop_loss,
      815
    );
  }
);

test(
  'adapter output satisfies renderer nested plan contract',
  () => {
    const renderer =
      require(
        '../lib/intraday-fast-watcher-shadow-renderer'
      );

    const result =
      adapter.buildHistoricalObservations({
        sampleDate:
          '2026-08-10',

        radar: {
          tickers: {
            TEST:
              radarItem()
          }
        },

        candidates: [
          candidate({
            current_price: 103
          })
        ],

        events: []
      });

    const row =
      result.observations[0];

    assert.ok(
      row.plan
    );

    assert.equal(
      row.plan.entry_low,
      100
    );

    assert.equal(
      row.plan.entry_high,
      105
    );

    assert.equal(
      row.plan.tp1,
      115
    );

    assert.equal(
      row.plan.tp2,
      120
    );

    assert.equal(
      row.plan.stop_loss,
      95
    );

    const classification =
      renderer.classifyObservation(
        row,
        renderer.initialTickerState(),
        {}
      );

    assert.equal(
      classification.status,
      'ENTRY_TRIGGERED'
    );

    assert.equal(
      classification.reason,
      'sampled_price_inside_entry'
    );

    assert.equal(
      classification.plan.valid,
      true
    );
  }
);

'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const cli =
  require(
    '../tools/run-intraday-fast-watcher-shadow-historical-replay'
  );

function radar(extra) {
  return {
    tickers: {
      TEST:
        Object.assign({
          key:
            'WATCHING|RADAR|100|105|115|120|95',

          status:
            'RADAR AKTIF — PANTAU',

          watch_score:
            70,

          sent_at:
            '2026-08-10T02:10:05.000Z',

          scheduled_time:
            '09:10'
        }, extra || {})
    }
  };
}

function candidate(extra) {
  return Object.assign({
    ticker:
      'TEST',

    sample_timestamp:
      '2026-08-10T02:13:03.000Z',

    scheduled_time:
      '09:13',

    current_price:
      103,

    /*
     * Deliberately dangerous daily OHLC fixture.
     * Adapter must never use this as a 15m candle.
     */
    high:
      999,

    low:
      1,

    open:
      50,

    freshness: {
      is_stale:
        false
    }
  }, extra || {});
}

function event(extra) {
  return Object.assign({
    ticker:
      'TEST',

    time:
      '09:13',

    metrics: {
      volume_rate_vs_average:
        4.5
    }
  }, extra || {});
}

test(
  'CLI parses multiple dates and deduplicates them',
  () => {
    const parsed =
      cli.parseArgs([
        '--prod-root',
        '/tmp/prod',
        '--date',
        '2026-08-10',
        '--dates',
        '2026-08-07,2026-08-10',
        '--rescue-rate',
        '4'
      ]);

    assert.deepEqual(
      parsed.dates,
      [
        '2026-08-10',
        '2026-08-07'
      ]
    );

    assert.equal(
      parsed.rescueRate,
      4
    );
  }
);

test(
  'CLI rejects unsupported send option',
  () => {
    assert.throws(
      () =>
        cli.parseArgs([
          '--send'
        ]),
      /unsupported_option/
    );
  }
);

test(
  'CLI requires explicit production root and date',
  () => {
    assert.throws(
      () =>
        cli.validateOptions({
          dates:
            ['2026-08-10']
        }),
      /prod_root_required/
    );

    assert.throws(
      () =>
        cli.validateOptions({
          prodRoot:
            '/tmp/prod',
          dates:
            []
        }),
      /at_least_one_date_required/
    );
  }
);

test(
  'entry then sampled TP1 becomes real terminal TP1',
  () => {
    const result =
      cli.replayHistoricalDayData({
        sampleDate:
          '2026-08-10',

        radar:
          radar(),

        candidates: [
          candidate({
            current_price:
              103
          }),

          candidate({
            sample_timestamp:
              '2026-08-10T02:22:03.000Z',

            scheduled_time:
              '09:22',

            current_price:
              115
          })
        ],

        events:
          [],

        rescueRate:
          4
      });

    assert.equal(
      result.renderer.final_tickers.TEST,
      'TP1'
    );

    assert.equal(
      result.renderer.transition_count,
      2
    );

    assert.equal(
      result.safety.state_written,
      false
    );
  }
);

test(
  'pre-publication only ticker remains NO_POST',
  () => {
    const result =
      cli.replayHistoricalDayData({
        sampleDate:
          '2026-08-10',

        radar:
          radar(),

        candidates: [
          candidate({
            sample_timestamp:
              '2026-08-10T02:10:04.000Z'
          })
        ],

        events:
          []
      });

    assert.deepEqual(
      result.adapter.no_post_tickers,
      ['TEST']
    );

    assert.equal(
      result.renderer.input_observations,
      0
    );

    assert.equal(
      result.renderer.final_ticker_count,
      0
    );
  }
);

test(
  'daily high low cannot manufacture TP or SL',
  () => {
    const result =
      cli.replayHistoricalDayData({
        sampleDate:
          '2026-08-10',

        radar:
          radar(),

        candidates: [
          candidate({
            current_price:
              103,

            high:
              9999,

            low:
              1
          })
        ],

        events:
          []
      });

    assert.equal(
      result.renderer.final_tickers.TEST,
      'ENTRY_TRIGGERED'
    );

    assert.equal(
      result.renderer.final_status_counts.TP1,
      undefined
    );

    assert.equal(
      result.renderer.final_status_counts.SL,
      undefined
    );
  }
);

test(
  'exact 4x event metric enables momentum rescue',
  () => {
    const result =
      cli.replayHistoricalDayData({
        sampleDate:
          '2026-08-10',

        radar:
          radar(),

        candidates: [
          candidate({
            current_price:
              110
          })
        ],

        events: [
          event()
        ],

        rescueRate:
          4
      });

    assert.equal(
      result.renderer.final_tickers.TEST,
      'MOMENTUM_RESCUE'
    );
  }
);

test(
  'missing exact rescue rate fails closed as late',
  () => {
    const result =
      cli.replayHistoricalDayData({
        sampleDate:
          '2026-08-10',

        radar:
          radar(),

        candidates: [
          candidate({
            current_price:
              110
          })
        ],

        events:
          [],

        rescueRate:
          4
      });

    assert.equal(
      result.renderer.final_tickers.TEST,
      'LATE'
    );
  }
);

test(
  'human output explicitly states all side effects are off',
  () => {
    const result =
      cli.replayHistoricalDayData({
        sampleDate:
          '2026-08-10',

        radar:
          radar(),

        candidates: [
          candidate()
        ],

        events:
          []
      });

    const text =
      cli.formatHumanRun({
        results:
          [result]
      });

    assert.match(
      text,
      /STATE_WRITE=FALSE/
    );

    assert.match(
      text,
      /NETWORK_FETCH=FALSE/
    );

    assert.match(
      text,
      /TELEGRAM_SEND=FALSE/
    );

    assert.match(
      text,
      /DATABASE_WRITE=FALSE/
    );

    assert.match(
      text,
      /TELEGRAM PREVIEW ONLY/
    );
  }
);

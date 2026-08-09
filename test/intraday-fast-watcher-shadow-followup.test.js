'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const followup =
  require('../lib/intraday-fast-watcher-shadow-followup');

async function tempRoot() {
  return fs.mkdtemp(
    path.join(
      os.tmpdir(),
      'fw-shadow-followup-'
    )
  );
}

async function writeLedger(
  root,
  date,
  tickers
) {
  const dir =
    path.join(root, 'radar');

  await fs.mkdir(
    dir,
    { recursive: true }
  );

  await fs.writeFile(
    path.join(
      dir,
      `${date}.json`
    ),
    JSON.stringify({
      tickers
    }, null, 2) + '\n'
  );
}

test(
  'parses both historical radar-key schemas',
  () => {
    const legacy =
      followup.parseRadarKey(
        'KONFIRMASI 1/2|520|530|560|570|505'
      );

    assert.equal(
      legacy.valid,
      true
    );

    assert.equal(
      legacy.schema,
      'LEGACY_6'
    );

    assert.equal(
      legacy.entry_low,
      520
    );

    assert.equal(
      legacy.tp1,
      560
    );

    const enriched =
      followup.parseRadarKey(
        'READY_PENDING|EARLY_RADAR|64|65|67|68|63'
      );

    assert.equal(
      enriched.valid,
      true
    );

    assert.equal(
      enriched.schema,
      'ENRICHED_7'
    );

    assert.equal(
      enriched.source,
      'EARLY_RADAR'
    );

    assert.equal(
      enriched.stop_loss,
      63
    );
  }
);

test(
  'default preview reads ledger but never calls network fetch',
  async () => {
    const root =
      await tempRoot();

    const date =
      '2026-08-07';

    await writeLedger(
      root,
      date,
      {
        LPKR: {
          sent_at:
            '2026-08-07T02:22:00.000Z',
          scheduled_time:
            '09:22',
          key:
            'READY_PENDING|EARLY_RADAR|64|65|67|68|63'
        }
      }
    );

    let calls = 0;

    const result =
      await followup.runShadowFollowup({
        sampleDate: date,
        publishedDir: root,
        networkFetch: false,
        persist: false,
        fetchFn: async () => {
          calls++;
          return [];
        }
      });

    assert.equal(
      result.status,
      'preview_no_network'
    );

    assert.equal(
      result.published_count,
      1
    );

    assert.deepEqual(
      result.tickers,
      ['LPKR']
    );

    assert.equal(calls, 0);
    assert.equal(
      result.persisted,
      false
    );
  }
);

test(
  'historical network fetch is fail-closed',
  async () => {
    const root =
      await tempRoot();

    await writeLedger(
      root,
      '2026-08-07',
      {}
    );

    let calls = 0;

    const result =
      await followup.runShadowFollowup({
        sampleDate:
          '2026-08-07',
        publishedDir:
          root,
        networkFetch:
          true,
        nowMs:
          Date.parse(
            '2026-08-10T03:00:00+07:00'
          ),
        fetchFn:
          async () => {
            calls++;
            return [];
          }
      });

    assert.equal(
      result.status,
      'blocked_historical_network_fetch'
    );

    assert.equal(
      result.network_fetch_attempted,
      false
    );

    assert.equal(calls, 0);
  }
);

test(
  'current-date mock fetch creates observation without persistence by default',
  async () => {
    const root =
      await tempRoot();

    const date =
      '2026-08-10';

    await writeLedger(
      root,
      date,
      {
        TEST: {
          sent_at:
            '2026-08-10T02:00:00.000Z',
          scheduled_time:
            '09:00',
          key:
            'WATCHING|RADAR|100|102|106|108|98'
        }
      }
    );

    let calls = 0;

    const nowMs =
      Date.parse(
        '2026-08-10T10:00:00+07:00'
      );

    const candleTime =
      Math.floor(
        Date.parse(
          '2026-08-10T09:45:00+07:00'
        ) / 1000
      );

    const result =
      await followup.runShadowFollowup({
        sampleDate: date,
        publishedDir: root,
        networkFetch: true,
        persist: false,
        nowMs,
        fetchFn:
          async ticker => {
            calls++;
            assert.equal(
              ticker,
              'TEST'
            );

            return [{
              time: candleTime,
              open: 101,
              high: 103,
              low: 100,
              close: 102,
              volume: 123456
            }];
          }
      });

    assert.equal(
      result.status,
      'ok'
    );

    assert.equal(calls, 1);

    assert.equal(
      result.fetched_count,
      1
    );

    assert.equal(
      result.persisted,
      false
    );

    assert.equal(
      result.observations[0]
        .current_price,
      102
    );

    assert.equal(
      result.observations[0]
        .interval,
      '15m'
    );
  }
);

test(
  'persistence writes only to explicitly supplied shadow root',
  async () => {
    const root =
      await tempRoot();

    const publishedRoot =
      path.join(
        root,
        'published'
      );

    const outputRoot =
      path.join(
        root,
        'shadow-output'
      );

    const date =
      '2026-08-10';

    await writeLedger(
      publishedRoot,
      date,
      {
        TEST: {
          sent_at:
            '2026-08-10T02:00:00.000Z',
          scheduled_time:
            '09:00',
          key:
            'WATCHING|RADAR|100|102|106|108|98'
        }
      }
    );

    const candleTime =
      Math.floor(
        Date.parse(
          '2026-08-10T09:45:00+07:00'
        ) / 1000
      );

    const result =
      await followup.runShadowFollowup({
        sampleDate: date,
        publishedDir:
          publishedRoot,
        outputRoot,
        networkFetch: true,
        persist: true,
        nowMs:
          Date.parse(
            '2026-08-10T10:00:00+07:00'
          ),
        fetchFn:
          async () => [{
            time: candleTime,
            open: 101,
            high: 103,
            low: 100,
            close: 102,
            volume: 123456
          }]
      });

    assert.equal(
      result.status,
      'ok'
    );

    assert.equal(
      result.persisted,
      true
    );

    const expected =
      path.join(
        outputRoot,
        date,
        'observations.jsonl'
      );

    assert.equal(
      result.output_file,
      expected
    );

    const saved =
      await fs.readFile(
        expected,
        'utf8'
      );

    const rows =
      saved
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);

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
  'network fetch is blocked on weekend even when sample date matches',
  async () => {
    let calls = 0;

    const result =
      await followup.runShadowFollowup({
        sampleDate: '2026-08-09',
        publishedDir: '/tmp/not-needed',
        networkFetch: true,
        nowMs: Date.parse(
          '2026-08-09T10:00:00+07:00'
        ),
        fetchFn: async () => {
          calls++;
          return [];
        }
      });

    assert.equal(
      result.status,
      'blocked_market_closed'
    );

    assert.equal(
      result.reason,
      'weekend'
    );

    assert.equal(
      result.network_fetch_attempted,
      false
    );

    assert.equal(calls, 0);
  }
);

test(
  'network fetch is blocked outside market session',
  async () => {
    let calls = 0;

    const result =
      await followup.runShadowFollowup({
        sampleDate: '2026-08-10',
        publishedDir: '/tmp/not-needed',
        networkFetch: true,
        nowMs: Date.parse(
          '2026-08-10T18:00:00+07:00'
        ),
        fetchFn: async () => {
          calls++;
          return [];
        }
      });

    assert.equal(
      result.status,
      'blocked_market_closed'
    );

    assert.equal(
      result.reason,
      'outside_market_session'
    );

    assert.equal(calls, 0);
  }
);

test(
  'old-session candle is fail-closed instead of treated as fresh current price',
  () => {
    const candleTime =
      Math.floor(
        Date.parse(
          '2026-08-07T15:45:00+07:00'
        ) / 1000
      );

    const row =
      followup.observationFromCandles({
        sampleDate: '2026-08-10',
        nowMs: Date.parse(
          '2026-08-10T10:00:00+07:00'
        ),
        published: {
          ticker: 'TEST',
          sent_at: null,
          scheduled_time: '10:00',
          plan: followup.parseRadarKey(
            'WATCHING|RADAR|100|102|106|108|98'
          )
        },
        candles: [{
          time: candleTime,
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 1000
        }]
      });

    assert.equal(
      row.fetch_ok,
      false
    );

    assert.equal(
      row.freshness_valid,
      false
    );

    assert.equal(
      row.stale_reason,
      'candle_not_from_current_trading_date'
    );

    assert.equal(
      row.candle_wib_date,
      '2026-08-07'
    );
  }
);


test(
  'ticker filter selects only a published ticker',
  async () => {
    const root = await tempRoot();
    const date = '2026-08-10';

    await writeLedger(
      root,
      date,
      {
        AAAA: {
          sent_at: '2026-08-10T02:00:00.000Z',
          scheduled_time: '09:00',
          key: 'WATCHING|RADAR|100|102|106|108|98'
        },
        BBBB: {
          sent_at: '2026-08-10T02:05:00.000Z',
          scheduled_time: '09:05',
          key: 'WATCHING|RADAR|200|204|212|216|196'
        }
      }
    );

    let calls = 0;

    const result =
      await followup.runShadowFollowup({
        sampleDate: date,
        publishedDir: root,
        tickerFilter: 'bbbb',
        networkFetch: false,
        fetchFn: async () => {
          calls++;
          return [];
        }
      });

    assert.equal(
      result.status,
      'preview_no_network'
    );

    assert.equal(
      result.published_total,
      2
    );

    assert.equal(
      result.published_count,
      1
    );

    assert.equal(
      result.requested_ticker,
      'BBBB'
    );

    assert.deepEqual(
      result.tickers,
      ['BBBB']
    );

    assert.equal(calls, 0);
  }
);

test(
  'ticker filter fails closed when ticker was never published',
  async () => {
    const root = await tempRoot();
    const date = '2026-08-10';

    await writeLedger(
      root,
      date,
      {
        AAAA: {
          sent_at: '2026-08-10T02:00:00.000Z',
          scheduled_time: '09:00',
          key: 'WATCHING|RADAR|100|102|106|108|98'
        }
      }
    );

    let calls = 0;

    const result =
      await followup.runShadowFollowup({
        sampleDate: date,
        publishedDir: root,
        tickerFilter: 'ZZZZ',
        networkFetch: true,
        nowMs: Date.parse(
          '2026-08-10T10:00:00+07:00'
        ),
        fetchFn: async () => {
          calls++;
          return [];
        }
      });

    assert.equal(
      result.status,
      'published_ticker_not_found'
    );

    assert.equal(
      result.requested_ticker,
      'ZZZZ'
    );

    assert.equal(
      result.published_count,
      0
    );

    assert.equal(
      result.network_fetch_attempted,
      false
    );

    assert.equal(calls, 0);
  }
);

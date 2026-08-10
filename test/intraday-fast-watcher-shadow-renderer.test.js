'use strict';

const assert =
  require('node:assert/strict');

const fs =
  require('node:fs/promises');

const os =
  require('node:os');

const path =
  require('node:path');

const test =
  require('node:test');

const renderer =
  require('../lib/intraday-fast-watcher-shadow-renderer');

function plan() {
  return {
    status: 'WATCHING',
    source: 'RADAR',
    entry_low: 100,
    entry_high: 102,
    tp1: 108,
    tp2: 112,
    stop_loss: 97
  };
}

function row(overrides) {
  return Object.assign({
    ticker: 'TEST',
    observed_at:
      '2026-08-10T03:00:00.000Z',
    published_sent_at:
      '2026-08-10T02:00:00.000Z',
    candle_time:
      '2026-08-10T02:45:00.000Z',
    candle_age_minutes: 15,
    fetch_ok: true,
    freshness_valid: true,
    current_price: 99,
    open: 99,
    high: 100,
    low: 98,
    volume: 1000,
    plan: plan()
  }, overrides || {});
}

test(
  'Lane A becomes WORTH_IT',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          current_price: 99,
          high: 99,
          low: 98
        }),
        null,
        {}
      );

    assert.equal(
      result.status,
      'WORTH_IT'
    );
  }
);

test(
  'sampled price inside entry becomes ENTRY_TRIGGERED',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          current_price: 101,
          high: 101,
          low: 100
        }),
        null,
        {}
      );

    assert.equal(
      result.status,
      'ENTRY_TRIGGERED'
    );

    assert.equal(
      result.entry_triggered_now,
      true
    );
  }
);

test(
  'price beyond TP without proven entry is LATE not fake win',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          /*
           * Candle overlaps publication, therefore
           * only current price is trusted.
           */
          candle_time:
            '2026-08-10T01:45:00.000Z',
          current_price: 110,
          high: 112,
          low: 109
        }),
        null,
        {}
      );

    assert.equal(
      result.status,
      'LATE'
    );
  }
);

test(
  'TP1 after previously proven entry is terminal win transition',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          current_price: 109,
          high: 109,
          low: 103
        }),
        {
          entry_triggered: true,
          closed: false
        },
        {}
      );

    assert.equal(
      result.status,
      'TP1'
    );

    assert.equal(
      result.terminal,
      true
    );
  }
);

test(
  'stale observation fails closed',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          candle_age_minutes: 45
        }),
        null,
        {
          maxCandleAgeMinutes: 20
        }
      );

    assert.equal(
      result.status,
      'STALE'
    );
  }
);

test(
  'above entry high can use exact 4x momentum rescue',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          current_price: 104,
          high: 104,
          low: 103,
          volume_rate_vs_average: 4.25
        }),
        null,
        {
          rescueRate: 4
        }
      );

    assert.equal(
      result.status,
      'MOMENTUM_RESCUE'
    );
  }
);

test(
  'above entry high without exact rescue rate is fail-closed LATE',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          current_price: 104,
          high: 104,
          low: 103
        }),
        null,
        {
          rescueRate: 4
        }
      );

    assert.equal(
      result.status,
      'LATE'
    );
  }
);

test(
  'first entry and TP inside same 15m candle is ambiguous',
  () => {
    const result =
      renderer.classifyObservation(
        row({
          current_price: 106,
          high: 109,
          low: 100
        }),
        null,
        {}
      );

    assert.equal(
      result.status,
      'AMBIGUOUS'
    );

    assert.equal(
      result.reason,
      'entry_and_terminal_same_15m_interval'
    );
  }
);

test(
  'unchanged status is suppressed change-only',
  () => {
    const rows = [
      row({
        observed_at:
          '2026-08-10T03:00:00.000Z',
        current_price: 99,
        high: 99,
        low: 98
      }),
      row({
        observed_at:
          '2026-08-10T03:15:00.000Z',
        candle_time:
          '2026-08-10T03:00:00.000Z',
        current_price: 99,
        high: 99,
        low: 98
      })
    ];

    const result =
      renderer.processObservationSequence(
        rows,
        null,
        {}
      );

    assert.equal(
      result.transitions.length,
      1
    );

    assert.equal(
      result.transitions[0].to_status,
      'WORTH_IT'
    );

    assert.equal(
      result.diagnostics
        .suppressed_same_status,
      1
    );
  }
);

test(
  'entry then TP lifecycle produces real transitions',
  () => {
    const rows = [
      row({
        observed_at:
          '2026-08-10T03:00:00.000Z',
        current_price: 101,
        high: 101,
        low: 100
      }),
      row({
        observed_at:
          '2026-08-10T03:15:00.000Z',
        candle_time:
          '2026-08-10T03:00:00.000Z',
        current_price: 109,
        high: 109,
        low: 103
      })
    ];

    const result =
      renderer.processObservationSequence(
        rows,
        null,
        {}
      );

    assert.deepEqual(
      result.transitions.map(
        item => item.to_status
      ),
      [
        'ENTRY_TRIGGERED',
        'TP1'
      ]
    );

    assert.equal(
      result.state.tickers.TEST.closed,
      true
    );
  }
);

test(
  'renderer keeps late tickers compact and never prints win rate',
  () => {
    const rendered =
      renderer.renderDigest([
        {
          ticker: 'AAAA',
          to_status: 'LATE',
          current_price: 105,
          plan: plan()
        },
        {
          ticker: 'BBBB',
          to_status: 'LATE',
          current_price: 106,
          plan: plan()
        }
      ], {
        nowMs:
          Date.parse(
            '2026-08-10T11:00:00+07:00'
          )
      });

    assert.match(
      rendered.text,
      /⏰ SUDAH TERLAMBAT: AAAA, BBBB/
    );

    assert.doesNotMatch(
      rendered.text,
      /Win Rate/i
    );

    assert.doesNotMatch(
      rendered.text,
      /AAAA \| Harga/
    );
  }
);

test(
  'renderer prioritizes actionable detail and terminal compact output',
  () => {
    const rendered =
      renderer.renderDigest([
        {
          ticker: 'AAAA',
          to_status: 'WORTH_IT',
          current_price: 99,
          plan: plan()
        },
        {
          ticker: 'BBBB',
          to_status: 'ENTRY_TRIGGERED',
          current_price: 101,
          plan: plan()
        },
        {
          ticker: 'CCCC',
          to_status: 'TP1',
          current_price: 109,
          plan: plan()
        }
      ], {
        nowMs:
          Date.parse(
            '2026-08-10T11:00:00+07:00'
          )
      });

    assert.match(
      rendered.text,
      /✅ MASIH WORTH IT/
    );

    assert.match(
      rendered.text,
      /🎯 ENTRY TERPICU/
    );

    assert.match(
      rendered.text,
      /🏆 TP1 TERCAPAI: CCCC/
    );
  }
);

test(
  'second run with committed state emits no duplicate unchanged alert',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'fw-renderer-'
        )
      );

    const observationsFile =
      path.join(
        root,
        'observations.jsonl'
      );

    const stateFile =
      path.join(
        root,
        'state.json'
      );

    await fs.writeFile(
      observationsFile,
      JSON.stringify(
        row({
          current_price: 99
        })
      ) + '\n'
    );

    const first =
      await renderer.runRenderer({
        observationsFile,
        stateFile,
        commitState: true
      });

    assert.equal(
      first.status,
      'ok'
    );

    assert.equal(
      first.state_committed,
      true
    );

    const second =
      await renderer.runRenderer({
        observationsFile,
        stateFile,
        commitState: false
      });

    assert.equal(
      second.status,
      'no_changes'
    );

    assert.equal(
      second.diagnostics
        .transition_count,
      0
    );

    assert.equal(
      second.state_committed,
      false
    );
  }
);

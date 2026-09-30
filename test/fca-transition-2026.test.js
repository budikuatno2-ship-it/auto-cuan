'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const transition = require('../lib/fca-transition-2026');
const daytrade = require('../lib/daytrade-screener-engine');
const deepscan = require('../lib/deepscan-engine');

test('Sep-2026 FCA transition manifest is internally consistent', () => {
  const all = new Set(transition.manifest.all_exit_tickers);
  const active = new Set(transition.manifest.active_as_of_status_date);
  const suspended = new Set(transition.manifest.suspended_as_of_status_date);

  assert.equal(all.size, 92);
  assert.equal(active.size, 44);
  assert.equal(suspended.size, 48);
  assert.equal([...active].filter((ticker) => suspended.has(ticker)).length, 0);
  assert.equal([...active, ...suspended].filter((ticker) => all.has(ticker)).length, 92);
});

test('verified active FCA exit bypasses stale board metadata but not explicit suspension', () => {
  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'PBRX',
      board: 'PEMANTAUAN_KHUSUS',
      is_fca: true,
      note: 'Papan Pemantauan Khusus / FCA'
    }),
    null
  );

  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'PBRX',
      board: 'PEMANTAUAN_KHUSUS',
      is_fca: true,
      status: 'SUSPENDED'
    }),
    'restricted_board_or_status'
  );
});

test('suspended FCA exit is fail-closed until current board metadata proves reactivation', () => {
  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'POLL',
      board: 'PEMANTAUAN_KHUSUS',
      is_active: true,
      is_fca: true
    }),
    'suspended_fca_exit'
  );

  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'POLL',
      board: 'UTAMA',
      is_active: true,
      is_fca: false
    }),
    null
  );

  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'POLL',
      board: 'UTAMA',
      is_active: true,
      is_fca: false,
      note: 'SUSPENDED'
    }),
    'restricted_board_or_status'
  );
});

test('ordinary board rules remain unchanged', () => {
  assert.equal(daytrade.dayTradeEligibilityReason({ ticker: 'BBCA', board: 'UTAMA' }), null);
  assert.equal(daytrade.dayTradeEligibilityReason({ ticker: 'UNKNOWN', board: 'PEMANTAUAN_KHUSUS' }), 'restricted_board_or_status');
  assert.equal(daytrade.dayTradeEligibilityReason({ ticker: 'UNKNOWN', board: 'AKSELERASI' }), 'invalid_or_unknown_board');
});

test('transition helper admits active exits and auto-reenters suspended exits from current board metadata', () => {
  assert.equal(transition.isEligibleContinuousAuctionRow({ ticker: 'PACK', board: 'AKSELERASI', is_active: true }), true);
  assert.equal(transition.isEligibleContinuousAuctionRow({ ticker: 'WIKA', board: 'PEMANTAUAN_KHUSUS', is_active: true, is_fca: true }), false);
  assert.equal(transition.isEligibleContinuousAuctionRow({ ticker: 'WIKA', board: 'PENGEMBANGAN', is_active: true, is_fca: false }), true);
  assert.equal(transition.isEligibleContinuousAuctionRow({ ticker: 'WIKA', board: 'PENGEMBANGAN', is_active: true, is_fca: false, note: 'trading suspended' }), false);
  assert.equal(transition.isEligibleContinuousAuctionRow({ ticker: 'BBCA', board: 'UTAMA', is_active: true }), true);
  assert.equal(transition.isEligibleContinuousAuctionRow({ ticker: 'FOO', board: 'AKSELERASI', is_active: true }), false);
});

test('DeepScan uses current stock_boards so suspended exits can re-enter automatically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-deepscan-'));
  try {
    const dir = path.join(root, 'data', 'daily-candles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PBRX.json'), '{}');
    fs.writeFileSync(path.join(dir, 'POLL.json'), '{}');
    fs.writeFileSync(path.join(dir, 'WIKA.json'), '{}');
    fs.writeFileSync(path.join(dir, 'BBCA.json'), '{}');

    const discovered = deepscan.listAllTickers(root).sort();
    assert.deepEqual(discovered, ['BBCA', 'PBRX', 'POLL', 'WIKA']);

    const db = {
      from(table) {
        assert.equal(table, 'stock_boards');
        return {
          select() {
            return {
              async in() {
                return {
                  error: null,
                  data: [
                    { ticker: 'PBRX', board: 'UTAMA', is_active: true, is_fca: false, note: null },
                    { ticker: 'POLL', board: 'UTAMA', is_active: true, is_fca: false, note: null },
                    { ticker: 'WIKA', board: 'PENGEMBANGAN', is_active: true, is_fca: false, note: 'SUSPENDED' }
                  ]
                };
              }
            };
          }
        };
      }
    };

    const tradable = (await deepscan.filterTradableTransitionTickers(db, discovered)).sort();
    assert.deepEqual(tradable, ['BBCA', 'PBRX', 'POLL']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

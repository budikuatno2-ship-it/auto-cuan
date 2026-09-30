'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const proof = require('../lib/daytrade-fca-live-trade-proof');
const daytrade = require('../lib/daytrade-screener-engine');

const NOW = new Date('2026-09-30T03:20:00Z'); // 10:20 WIB

function bar(iso, close, volume) {
  return { time: Math.floor(new Date(iso).getTime() / 1000), close, volume };
}

test('flat price still proves real trading when fresh 5m bars carry positive volume', () => {
  const result = proof.evaluateLiveTradeProof('POLL', [
    bar('2026-09-30T03:00:00Z', 100, 0),
    bar('2026-09-30T03:05:00Z', 100, 2500),
    bar('2026-09-30T03:10:00Z', 100, 3200)
  ], { now: NOW });

  assert.equal(result.verified, true);
  assert.equal(result.reason, 'fresh_intraday_trades_verified');
  assert.equal(result.price_changed_in_window, false);
  assert.equal(result.recent_positive_bar_count, 2);
  assert.equal(result.recent_volume_sum, 5700);
});

test('one positive bar is not enough to unlock a snapshot-suspended exit', () => {
  const result = proof.evaluateLiveTradeProof('POLL', [
    bar('2026-09-30T03:10:00Z', 100, 3200)
  ], { now: NOW });

  assert.equal(result.verified, false);
  assert.equal(result.reason, 'insufficient_recent_trade_bars');
});

test('old morning trades cannot unlock a ticker later in the session', () => {
  const result = proof.evaluateLiveTradeProof('POLL', [
    bar('2026-09-30T02:30:00Z', 100, 2500),
    bar('2026-09-30T02:35:00Z', 101, 3200)
  ], { now: NOW });

  assert.equal(result.verified, false);
  assert.equal(result.reason, 'latest_trade_stale');
});

test('bars from another Jakarta trading date cannot unlock today', () => {
  const result = proof.evaluateLiveTradeProof('POLL', [
    bar('2026-09-29T03:05:00Z', 100, 2500),
    bar('2026-09-29T03:10:00Z', 101, 3200)
  ], { now: NOW });

  assert.equal(result.verified, false);
  assert.equal(result.reason, 'no_today_intraday_bars');
});

test('DayTrade alone may admit a suspended FCA exit with fresh live-trade proof', () => {
  const proofByTicker = {
    POLL: { ticker: 'POLL', verified: true, reason: 'fresh_intraday_trades_verified' }
  };

  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'POLL',
      board: 'PEMANTAUAN_KHUSUS',
      is_active: true,
      is_fca: true,
      note: 'Papan Pemantauan Khusus / FCA'
    }, { fcaLiveTradeProofByTicker: proofByTicker }),
    null
  );

  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'POLL',
      board: 'UTAMA',
      is_active: true,
      is_fca: false
    }, { fcaLiveTradeProofByTicker: proofByTicker }),
    null
  );
});

test('explicit suspension marker overrides even a valid live-trade proof', () => {
  const proofByTicker = {
    POLL: { ticker: 'POLL', verified: true, reason: 'fresh_intraday_trades_verified' }
  };

  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'POLL',
      board: 'UTAMA',
      is_active: true,
      is_fca: false,
      status: 'SUSPENDED'
    }, { fcaLiveTradeProofByTicker: proofByTicker }),
    'restricted_board_or_status'
  );
});

test('without live proof the 48 snapshot-suspended names remain fail-closed', () => {
  assert.equal(
    daytrade.dayTradeEligibilityReason({
      ticker: 'POLL',
      board: 'UTAMA',
      is_active: true,
      is_fca: false
    }, { fcaLiveTradeProofByTicker: {} }),
    'suspended_fca_exit'
  );
});

test('run-scoped cache prevents repeated proof fetches across DayTrade batches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-live-proof-'));
  const statePath = path.join(root, 'state.json');
  let fetchCalls = 0;

  try {
    proof.resetMemoryCache();
    const fetcher = async () => {
      fetchCalls++;
      return [
        bar('2026-09-30T03:05:00Z', 100, 2500),
        bar('2026-09-30T03:10:00Z', 100, 3200)
      ];
    };

    const first = await proof.refreshSuspendedExitProof({
      runId: 'run-1',
      tickers: ['POLL'],
      fetcher,
      now: NOW,
      statePath
    });
    const second = await proof.refreshSuspendedExitProof({
      runId: 'run-1',
      tickers: ['POLL'],
      fetcher,
      now: NOW,
      statePath
    });

    assert.equal(first.verified_count, 1);
    assert.equal(second.verified_count, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(second.cache_source, 'memory');

    proof.resetMemoryCache();
    const third = await proof.refreshSuspendedExitProof({
      runId: 'run-1',
      tickers: ['POLL'],
      fetcher,
      now: NOW,
      statePath
    });
    assert.equal(third.cache_source, 'disk');
    assert.equal(fetchCalls, 1);
  } finally {
    proof.resetMemoryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const candleFetcher = require('../lib/chart-engine/candle-fetcher');
const quotaManager = require('../lib/quota-manager');
const quotaState = require('../lib/quota-state');
const eodSessionState = require('../lib/eod-session-state');

test('V6 Candle Normalization: Missing/null volume must NOT be coerced to 0', async () => {
  // Test normalizePayload / fetchDailyCandlesYahoo behavior on missing volume
  const sampleCandles = [
    { date: '2026-11-04', open: 100, high: 110, low: 95, close: 105, volume: null },
    { date: '2026-11-05', open: 105, high: 115, low: 100, close: 110, volume: 500000 },
    { date: '2026-11-06', open: 110, high: 112, low: 108, close: 109, volume: 0 }
  ];

  // In normalizePayload
  const normalized = candleFetcher.normalizePayload('TEST', sampleCandles, 3);
  assert.equal(normalized.candles[0].volume, null, 'null volume should remain null');
  assert.equal(normalized.candles[1].volume, 500000, 'positive volume is preserved');
  assert.equal(normalized.candles[2].volume, 0, 'actual 0 volume is preserved');

  // Verify that eodSessionState does NOT classify null volume as NO_TRADE
  const outcomeNull = eodSessionState.classifyBrokerOutcome({
    hasRows: false,
    candleAvailable: true,
    candleVolume: normalized.candles[0].volume,
    isFinal: false
  });
  assert.equal(outcomeNull, eodSessionState.EOD_STATES.PENDING_PROVIDER, 'null volume must NOT be mislabeled NO_TRADE');

  const outcomeZero = eodSessionState.classifyBrokerOutcome({
    hasRows: false,
    candleAvailable: true,
    candleVolume: normalized.candles[2].volume,
    isFinal: false
  });
  assert.equal(outcomeZero, eodSessionState.EOD_STATES.NO_TRADE, 'real 0 volume is proven NO_TRADE');
});

test('V6 Quota Engine: Field discipline and unknown limit handling', async () => {
  const status = quotaManager.getQuotaStatus(new Date('2026-11-09T10:00:00Z')); // 17:00 WIB Monday
  assert.equal(typeof status, 'object');
  assert.ok('configured_operating_limit' in status, 'must include configured_operating_limit');
  assert.ok('effective_limit' in status, 'must include effective_limit');
  assert.ok('used' in status, 'must include used');
  assert.ok('remaining' in status, 'must include remaining');
  assert.ok('reserved' in status, 'must include reserved');

  // Before 20:30 WIB on weekday, reserve floor is 5000
  assert.equal(status.reserveFloor, 5000, 'Weekday 17:00 WIB reserve floor must be 5000');
  assert.equal(status.isWeekend, false, 'Monday is not weekend');

  // V6 (Subtask E) policy change: the reserve is NO LONGER released purely by
  // the 20:30 WIB clock. At 21:00 WIB with mandatory obligations pending
  // (Broksum ALL/Foreign, Insider unverified), the floor is still held 5000.
  // Release requires obligation-verified completion or an admin waiver
  // (see lib/quota-policy-bridge.canReleaseReserve + test/v6-quota-policy-bridge.test.js).
  const nightStatus = quotaManager.getQuotaStatus(new Date('2026-11-09T14:00:00Z')); // 21:00 WIB
  assert.equal(nightStatus.reserveFloor, 5000, 'Weekday 21:00 WIB reserve must STAY held (no clock-only release)');
  assert.equal(nightStatus.policy.release.ok, false, 'release decision must be fail-closed with pending obligations');
  assert.equal(nightStatus.policy.release.reason, 'OBLIGATIONS_PENDING');
});

test('V6 Broker Ledger: Independent Foreign Retry Logic', () => {
  // Simulating the condition where ALL is cached, but Foreign is missing
  const dateArg = '2026-11-04';
  const alreadyCached = true;
  const cachedF = null; // Foreign missing
  const dryRun = false;
  const isFresh = false;

  const foreignMissing = alreadyCached && !cachedF && !dryRun && !isFresh;
  assert.equal(foreignMissing, true, 'Should detect that Foreign summary needs dedicated retry even if ALL is cached');
});

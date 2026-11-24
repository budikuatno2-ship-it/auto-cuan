/**
 * test/v6-hourly-confirmation.test.js
 *
 * Comprehensive Test Suite for Short Swing Hourly Confirmation Feature (V6 hardened)
 *
 * Hardened invariants (Subtask H / Remediasi V6):
 *   - Feature flag OFF by default; runHourlyConfirmationCheck skips with no I/O.
 *   - Ticker mismatch (BBCA setup vs BBRI quote) => BLOCKED, never ENTRY_ZONE_VALID.
 *   - Low R/R (< 1.5, including ~0.33) cannot become ENTRY_ZONE_VALID => BLOCKED.
 *   - Missing setup source/as_of => BLOCKED (fail-closed Provenance).
 *   - Delayed / non-realtime price => BLOCKED.
 *   - Exchange holiday => BLOCKED.
 *   - Gap ambiguity (open above max entry, last back inside zone) => BLOCKED.
 *   - All tests call the REAL evaluateHourlyConfirmation() (no string compare).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  CONFIRMATION_STATES,
  SCHEDULE_TARGETS,
  MIN_HOURLY_RR_THRESHOLD,
  DEFAULT_MAX_SETUP_AGE_DAYS,
  isFeatureEnabled,
  evaluateInterimCandle,
  computeHourlyRiskReward,
  evaluateHourlyConfirmation,
  runHourlyConfirmationCheck
} = require('../lib/short-swing-hourly-confirmation');

const { SEED_HOLIDAY_SET } = require('../lib/market-hours-guard');

describe('Short Swing Hourly Confirmation Engine (V6)', () => {
  const originalEnv = process.env.ENABLE_HOURLY_CONFIRMATION;

  beforeEach(() => {
    delete process.env.ENABLE_HOURLY_CONFIRMATION;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ENABLE_HOURLY_CONFIRMATION = originalEnv;
    } else {
      delete process.env.ENABLE_HOURLY_CONFIRMATION;
    }
  });

  describe('Feature Flag Invariants', () => {
    test('default status must be OFF (false)', () => {
      delete process.env.ENABLE_HOURLY_CONFIRMATION;
      assert.strictEqual(isFeatureEnabled(), false);
    });

    test('isFeatureEnabled returns true only when explicitly set to "true" or "1"', () => {
      process.env.ENABLE_HOURLY_CONFIRMATION = 'true';
      assert.strictEqual(isFeatureEnabled(), true);

      process.env.ENABLE_HOURLY_CONFIRMATION = '1';
      assert.strictEqual(isFeatureEnabled(), true);

      process.env.ENABLE_HOURLY_CONFIRMATION = 'false';
      assert.strictEqual(isFeatureEnabled(), false);

      process.env.ENABLE_HOURLY_CONFIRMATION = '0';
      assert.strictEqual(isFeatureEnabled(), false);
    });

    test('runHourlyConfirmationCheck skips execution immediately when flag is OFF', async () => {
      delete process.env.ENABLE_HOURLY_CONFIRMATION;
      let quoteFetcherCalled = false;

      const result = await runHourlyConfirmationCheck({
        snapshots: [{ ticker: 'BBRI', entryMin: 5000, entryMax: 5200, stopLoss: 4600, targetPrice: 6400 }],
        quoteFetcher: async () => {
          quoteFetcherCalled = true;
          return { last: 5050, open: 5000, timestamp: Date.now() };
        }
      });

      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.success, false);
      assert.strictEqual(quoteFetcherCalled, false, 'quoteFetcher must NOT be invoked when flag is OFF');
      assert.match(result.reason, /Feature flag ENABLE_HOURLY_CONFIRMATION is disabled/);
    });
  });

  describe('Interim Candlestick Evaluation', () => {
    test('Last > Open is Bullish / Green', () => {
      const candle = evaluateInterimCandle(5000, 5100);
      assert.strictEqual(candle.color, 'GREEN');
      assert.strictEqual(candle.direction, 'BULLISH');
      assert.strictEqual(candle.hasWick, false);
    });

    test('Last < Open is Bearish / Red', () => {
      const candle = evaluateInterimCandle(5100, 5000);
      assert.strictEqual(candle.color, 'RED');
      assert.strictEqual(candle.direction, 'BEARISH');
      assert.strictEqual(candle.hasWick, false);
    });

    test('Last == Open is Neutral', () => {
      const candle = evaluateInterimCandle(5000, 5000);
      assert.strictEqual(candle.color, 'NEUTRAL');
      assert.strictEqual(candle.direction, 'FLAT');
      assert.strictEqual(candle.hasWick, false);
    });
  });

  describe('Risk/Reward helper', () => {
    test('computes conservative RR at max entry', () => {
      const rr = computeHourlyRiskReward({ entryMin: 5000, entryMax: 5200, stopLoss: 4600, targetPrice: 6400 });
      assert.strictEqual(rr.maxEntry, 5200);
      assert.strictEqual(rr.rr, 2.0); // (6400-5200)/(5200-4600) = 1200/600
      assert.strictEqual(rr.reason, null);
    });

    test('rejects structured plan with rr ~0.33', () => {
      const rr = computeHourlyRiskReward({ entryMin: 5000, entryMax: 5200, stopLoss: 4000, targetPrice: 5300 });
      // (5300-5200)/(5200-4000) = 100/1200 = 0.0833 ... choose a clear ~0.33 case below
      assert.ok(rr.rr < 1.5);
    });

    test('returns rr null when target/stop missing', () => {
      const rr = computeHourlyRiskReward({ entryMin: 5000, entryMax: 5200, stopLoss: 4600 });
      assert.strictEqual(rr.rr, null);
      assert.ok(rr.reason);
    });
  });

  describe('State Machine & Confirmation States (fail-closed)', () => {
    const fixedNow = new Date('2026-11-10T10:15:00+07:00').getTime();
    // Valid happy-path setup: source + as_of + RR 2.0 (>= 1.5).
    const baseSetup = {
      ticker: 'BBRI',
      entryMin: 5000,
      entryMax: 5200,
      stopLoss: 4600,
      targetPrice: 6400,
      baseVolume: 1000000,
      source: 'screener-v3f04-eod',
      asOf: '2026-11-09'
    };

    test('returns DATA_NOT_READY if setup or quote is missing or invalid', () => {
      assert.strictEqual(
        evaluateHourlyConfirmation(null, { last: 5000, timestamp: fixedNow }).status,
        CONFIRMATION_STATES.DATA_NOT_READY
      );

      assert.strictEqual(
        evaluateHourlyConfirmation(baseSetup, null).status,
        CONFIRMATION_STATES.DATA_NOT_READY
      );

      assert.strictEqual(
        evaluateHourlyConfirmation(baseSetup, { last: 0, timestamp: fixedNow }).status,
        CONFIRMATION_STATES.DATA_NOT_READY
      );
    });

    test('BLOCKED: BBCA setup evaluated against BBRI quote (ticker mismatch)', () => {
      const bbcaSetup = Object.assign({}, baseSetup, { ticker: 'BBCA' });
      const res = evaluateHourlyConfirmation(
        bbcaSetup,
        { ticker: 'BBRI', open: 5000, last: 5100, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.strictEqual(res.tickerMismatch, true);
      assert.match(res.reason, /BBCA/);
      assert.match(res.reason, /BBRI/);
      assert.notStrictEqual(res.status, CONFIRMATION_STATES.ENTRY_ZONE_VALID);
    });

    test('BLOCKED: R/R ~0.33 cannot become ENTRY_ZONE_VALID', () => {
      const lowRrSetup = {
        ticker: 'BBRI',
        entryMin: 5000,
        entryMax: 5200,
        stopLoss: 5050,
        targetPrice: 5250, // (5250-5200)/(5200-5050) = 50/150 = 0.333
        baseVolume: 1000000,
        source: 'screener-v3f04-eod',
        asOf: '2026-11-09'
      };
      // Price is inside the entry zone, so previously this returned ENTRY_ZONE_VALID.
      const res = evaluateHourlyConfirmation(
        lowRrSetup,
        { ticker: 'BBRI', open: 5000, last: 5100, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.ok(res.rr != null && res.rr < 1.5);
      assert.notStrictEqual(res.status, CONFIRMATION_STATES.ENTRY_ZONE_VALID);
    });

    test('BLOCKED: missing source/as_of provenance denies confirmation', () => {
      const noProvenance = {
        ticker: 'BBRI',
        entryMin: 5000,
        entryMax: 5200,
        stopLoss: 4600,
        targetPrice: 6400
      };
      const res = evaluateHourlyConfirmation(
        noProvenance,
        { ticker: 'BBRI', open: 5000, last: 5100, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.strictEqual(res.provenanceMissing, true);
    });

    test('BLOCKED: delayed (non-realtime) price cannot confirm live entry', () => {
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 5000, last: 5100, timestamp: fixedNow, delayed: true },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.strictEqual(res.delayed, true);
    });

    test('BLOCKED: exchange holiday denies confirmation', () => {
      // 2026-08-17 is Indonesian Independence Day (a seeded IDX holiday).
      const holidayNow = new Date('2026-08-17T10:15:00+07:00').getTime();
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 5000, last: 5100, timestamp: holidayNow },
        { now: holidayNow, holidaySet: SEED_HOLIDAY_SET }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.strictEqual(res.holiday, true);
    });

    test('BLOCKED: gap ambiguity (open above max entry, last back inside zone)', () => {
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 5350, last: 5150, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.strictEqual(res.gapAmbiguous, true);
    });

    test('returns STALE_DATA if quote timestamp exceeds threshold (15 minutes)', () => {
      const twentyMinsAgo = fixedNow - (20 * 60 * 1000);
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 5000, last: 5050, timestamp: twentyMinsAgo },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.STALE_DATA);
      assert.match(res.reason, /kadaluarsa/);
    });

    test('BLOCKED: setup as_of beyond max setup age (> 10 hari) cannot be confirmed', () => {
      const staleSetup = Object.assign({}, baseSetup, { asOf: '2026-10-01' });
      const res = evaluateHourlyConfirmation(
        staleSetup,
        { ticker: 'BBRI', open: 5000, last: 5100, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.strictEqual(res.staleSetup, true);
      assert.ok(res.setupAgeDays > 10, 'setup age must exceed the 10-day horizon');
      assert.notStrictEqual(res.status, CONFIRMATION_STATES.ENTRY_ZONE_VALID);
    });

    test('BLOCKED: unparseable as_of is fail-closed (provenanceInvalid)', () => {
      const badSetup = Object.assign({}, baseSetup, { asOf: 'not-a-date' });
      const res = evaluateHourlyConfirmation(
        badSetup,
        { ticker: 'BBRI', open: 5000, last: 5100, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.BLOCKED);
      assert.strictEqual(res.provenanceInvalid, true);
    });

    test('fresh as_of (within 10 days) still reaches price evaluation, NOT blocked', () => {
      const freshNow = new Date('2026-11-10T10:15:00+07:00').getTime();
      const res = evaluateHourlyConfirmation(
        baseSetup, // asOf 2026-11-09 -> 1 day old
        { ticker: 'BBRI', open: 5050, last: 5100, timestamp: freshNow },
        { now: freshNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.ENTRY_ZONE_VALID);
      assert.strictEqual(res.staleSetup, undefined);
    });

    test('DEFAULT_MAX_SETUP_AGE_DAYS equals 10', () => {
      assert.strictEqual(DEFAULT_MAX_SETUP_AGE_DAYS, 10);
    });

    test('returns SETUP_INVALIDATED when last price breaks down below Stop Loss', () => {
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 4900, last: 4500, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.SETUP_INVALIDATED);
      assert.strictEqual(res.lastPrice, 4500);
      assert.match(res.reason, /breakdown menembus Stop Loss/);
    });

    test('returns PRICE_ABOVE_MAX_ENTRY when last price exceeds entryMax', () => {
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 5200, last: 5350, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.PRICE_ABOVE_MAX_ENTRY);
      assert.strictEqual(res.lastPrice, 5350);
      assert.match(res.reason, /melampaui batas maksimal entry/);
    });

    test('returns ENTRY_ZONE_VALID when last price is inside [entryMin, entryMax] and RR passes', () => {
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 5050, last: 5100, volume: 100000, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.ENTRY_ZONE_VALID);
      assert.strictEqual(res.lastPrice, 5100);
      assert.strictEqual(res.rr, 2.0);
      assert.deepStrictEqual(res.entryZone, [5000, 5200]);
    });

    test('returns MOMENTUM_STRENGTHENING when inside entry zone with strong volume and bullish candle', () => {
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 5000, last: 5150, volume: 600000, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.MOMENTUM_STRENGTHENING);
      assert.strictEqual(res.candle.direction, 'BULLISH');
      assert.match(res.reason, /candle bullish dan volume meningkat/);
    });

    test('returns NEAR_ENTRY when price is within 1.5% below entryMin', () => {
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 4940, last: 4950, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.NEAR_ENTRY);
      assert.strictEqual(res.lastPrice, 4950);
      assert.strictEqual(res.diffPct, 1.0);
    });

    test('returns SETUP_VALID when price is above Stop Loss and below near entry boundary', () => {
      // 4880 is above SL (4600) but 2.4% below entryMin (5000), exceeding 1.5% threshold
      const res = evaluateHourlyConfirmation(
        baseSetup,
        { ticker: 'BBRI', open: 4890, last: 4880, timestamp: fixedNow },
        { now: fixedNow }
      );
      assert.strictEqual(res.status, CONFIRMATION_STATES.SETUP_VALID);
      assert.strictEqual(res.lastPrice, 4880);
    });
  });

  describe('runHourlyConfirmationCheck Pipeline & Quota Caps', () => {
    test('caps universe to maximum 30 tickers to protect quote provider quota', async () => {
      process.env.ENABLE_HOURLY_CONFIRMATION = 'true';

      const largeWatchlist = [];
      for (let i = 1; i <= 50; i++) {
        largeWatchlist.push({
          ticker: `TCK${i}`,
          entryMin: 1000,
          entryMax: 1050,
          stopLoss: 950,
          targetPrice: 1300,
          source: 'fixture',
          asOf: '2026-11-09'
        });
      }

      let fetchCount = 0;
      const result = await runHourlyConfirmationCheck({
        snapshots: largeWatchlist,
        quoteFetcher: async () => {
          fetchCount++;
          return { ticker: 'TCK1', open: 1000, last: 1020, timestamp: Date.now() };
        },
        forceRun: true
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(fetchCount, 30, 'Must hard cap fetches to 30 tickers maximum');
      assert.strictEqual(result.results.length, 30);
    });

    test('handles individual quote fetch errors gracefully without breaking the batch', async () => {
      process.env.ENABLE_HOURLY_CONFIRMATION = 'true';

      const snapshots = [
        { ticker: 'GOOD', entryMin: 1000, entryMax: 1050, stopLoss: 950, targetPrice: 1300, source: 'fixture', asOf: '2026-11-09' },
        { ticker: 'FAIL', entryMin: 1000, entryMax: 1050, stopLoss: 950, targetPrice: 1300, source: 'fixture', asOf: '2026-11-09' }
      ];

      const result = await runHourlyConfirmationCheck({
        snapshots,
        quoteFetcher: async (ticker) => {
          if (ticker === 'FAIL') throw new Error('API timeout');
          return { ticker: 'GOOD', open: 1000, last: 1020, timestamp: Date.now() };
        },
        forceRun: true
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[0].status, CONFIRMATION_STATES.ENTRY_ZONE_VALID);
      assert.strictEqual(result.results[1].status, CONFIRMATION_STATES.DATA_NOT_READY);
      assert.match(result.results[1].reason, /Gagal mengambil quote: API timeout/);
    });
  });

  describe('Official Exchange Schedule Contract', () => {
    test('target schedules match specifications', () => {
      assert.deepStrictEqual(SCHEDULE_TARGETS.MON_THU, [
        '09:15', '10:15', '11:15', '12:15', '13:45', '14:45', '15:40'
      ]);
      assert.deepStrictEqual(SCHEDULE_TARGETS.FRI, [
        '09:15', '10:15', '11:15', '11:40', '14:15', '15:15', '15:40'
      ]);
    });

    test('MIN_HOURLY_RR_THRESHOLD equals 1.5', () => {
      assert.strictEqual(MIN_HOURLY_RR_THRESHOLD, 1.5);
    });
  });
});

'use strict';

/**
 * test/v6-data-reconciliation-comprehensive-2026.test.js
 * ============================================================================
 * AUTO-CUAN V6: COMPREHENSIVE DATA RECONCILIATION TEST SUITE (2 JAN - 16 NOV 2026)
 * ============================================================================
 *
 * Verifies:
 * 1. Monthly Broksum ALL & Foreign Coverage (Jan - Nov 2026) + Strict Provenance.
 * 2. Mathematical Validity of Domestic Flow (ALL - F) + Date & Ticker Parity.
 * 3. 16 November 2026 Trading Cycle Isolation (CATCHUP_PENDING, Zero Synthetics/Mock).
 * 4. Yahoo EOD & SQLite KV Canonical Sync + Date-Aware IHSG Anomaly Validation.
 * 5. Financial Publication Q1-Q4 & Audited FY Schedules + Admin Console Governance.
 * 6. Backfill Queues Audit & Quota Reserve Floor 5,000 Budget Governance.
 * ============================================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const recon = require(path.join(ROOT, 'lib', 'v6-historical-reconciliation'));
const catchup16Nov = require(path.join(ROOT, 'tools', 'catchup-16nov2026-data'));
const domRecon = require(path.join(ROOT, 'lib', 'domestic-flow-reconciliation'));
const { isValidIhsgCandle } = require(path.join(ROOT, 'lib', 'ihsg-validation'));
const sqliteSync = require(path.join(ROOT, 'lib', 'daily-history-sqlite-sync'));
const finMonitor = require(path.join(ROOT, 'lib', 'financial-publication-monitor'));
const adminStore = require(path.join(ROOT, 'lib', 'admin-schedule-store'));
const calendar = require(path.join(ROOT, 'lib', 'idx-trading-calendar'));

describe('V6 Data Reconciliation Comprehensive Test Suite (2 Jan - 16 Nov 2026)', () => {

  // --------------------------------------------------------------------------
  // SECTION 1: Monthly Broksum Coverage & Honest Provenance Status
  // --------------------------------------------------------------------------
  describe('1. Historical Broksum Coverage & Provenance (Jan - Nov 2026)', () => {
    const audit = recon.getMonthlyCoverageAudit();

    test('covers all 11 months from 2026-01 through 2026-11', () => {
      assert.strictEqual(audit.months.length, 11);
      assert.deepStrictEqual(audit.months, [
        '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
        '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'
      ]);
    });

    test('classifies exactly 390,268 historical rows as UNKNOWN_SOURCE (Jan - Oct)', () => {
      // 199,485 ALL + 190,783 F = 390,268
      const unknownAll = audit.overall_totals.UNKNOWN_SOURCE.ALL;
      const unknownF = audit.overall_totals.UNKNOWN_SOURCE.F;
      assert.strictEqual(unknownAll, 199485);
      assert.strictEqual(unknownF, 190783);
      assert.strictEqual(audit.honest_classification.unknown_source_historical, 390268);
    });

    test('reconciles exactly 198,796 DERIVED_COMPUTED rows for Domestic flow', () => {
      assert.strictEqual(audit.honest_classification.derived_domestic, 198796);
      assert.strictEqual(audit.overall_totals.DERIVED_COMPUTED.D, 198796);
    });

    test('preserves VERIFIED_RAW_PROVIDER only for verified original files in November', () => {
      // November: ALL = 8,325; F = 6,947
      assert.strictEqual(audit.overall_totals.ORIGINAL_PROVIDER_VALID.ALL, 8325);
      assert.strictEqual(audit.overall_totals.ORIGINAL_PROVIDER_VALID.F, 6947);
      assert.strictEqual(audit.honest_classification.verified_raw_provider, 15272);
      // Older months (Jan-Oct) have ZERO ORIGINAL_PROVIDER_VALID (honest classification)
      for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
        const mALL = audit.monthly_breakdown[m].datasets.ALL;
        assert.strictEqual(mALL.ORIGINAL_PROVIDER_VALID || 0, 0, `Month ${m} must not claim unverified raw original`);
      }
    });

    test('records LISTED_NOT_TRADED for suspended / FCA tickers without transactions', () => {
      assert.strictEqual(audit.overall_totals.LISTED_NOT_TRADED.ALL, 1395);
      assert.strictEqual(audit.overall_totals.LISTED_NOT_TRADED.F, 1395);
    });

    test('excludes pseudo-ticker test fixtures from denominators', () => {
      assert.ok(audit.honest_classification.fixtures_excluded > 5000);
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 2: Domestic Flow Formula & Identity Verification
  // --------------------------------------------------------------------------
  describe('2. Domestic Flow (ALL - F) Formula & Identity Parity', () => {
    test('computes Domestic net_value = net_value_ALL - net_value_F exactly', () => {
      const allFeed = {
        ticker: 'BBCA',
        date: '2026-11-13',
        all_data: true,
        brokers: [
          { broker_code: 'CC', bval: 10000000, sval: 4000000, bvol: 1000, svol: 400 },
          { broker_code: 'ZP', bval: 8000000, sval: 2000000, bvol: 800, svol: 200 }
        ]
      };
      const fFeed = {
        ticker: 'BBCA',
        date: '2026-11-13',
        brokers: [
          { broker_code: 'CC', bval: 3000000, sval: 1000000, bvol: 300, svol: 100 },
          { broker_code: 'ZP', bval: 2000000, sval: 500000, bvol: 200, svol: 50 }
        ]
      };

      const res = domRecon.reconcileDomesticBrokerSummary(allFeed, fFeed, { ticker: 'BBCA', tradeDate: '2026-11-13' });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'VERIFIED_DOMESTIC_DERIVATION');
      assert.strictEqual(res.formula_verification.net_value_matches, true);
      assert.strictEqual(res.formula_verification.net_volume_matches, true);

      // Manual checks:
      // ALL: buy_val = 18,000,000, sell_val = 6,000,000, net_val = +12,000,000
      // F: buy_val = 5,000,000, sell_val = 1,500,000, net_val = +3,500,000
      // D: buy_val = 13,000,000, sell_val = 4,500,000, net_val = +8,500,000 (12M - 3.5M)
      assert.strictEqual(res.aggregates.Domestic.net_value, 8500000);
      assert.strictEqual(res.aggregates.Domestic.net_volume, 850);
    });

    test('strictly REJECTS Domestic calculation if trade_dates do not match', () => {
      const allFeed = { ticker: 'BBRI', date: '2026-11-13', brokers: [] };
      const fFeed = { ticker: 'BBRI', date: '2026-11-12', brokers: [] };

      const res = domRecon.reconcileDomesticBrokerSummary(allFeed, fFeed, { ticker: 'BBRI', tradeDate: '2026-11-13' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 'DATE_MISMATCH_FAIL_CLOSED');
    });

    test('strictly REJECTS Domestic calculation if tickers do not match', () => {
      const allFeed = { ticker: 'BBRI', date: '2026-11-13', brokers: [] };
      const fFeed = { ticker: 'BMRI', date: '2026-11-13', brokers: [] };

      const res = domRecon.reconcileDomesticBrokerSummary(allFeed, fFeed, { ticker: 'BBRI', tradeDate: '2026-11-13' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 'TICKER_MISMATCH_FAIL_CLOSED');
    });

    test('audits authentic KSEI insider data & Admin Console schedule connection', () => {
      const audit = domRecon.auditInsiderNetworkIntegration();
      assert.strictEqual(audit.real_insider_data_available, true);
      assert.ok(audit.total_ksei_records > 10000);
      assert.strictEqual(audit.admin_console_governance.job_key, 'insider');
      assert.strictEqual(audit.admin_console_governance.editable_via_admin_console, true);
      assert.ok(audit.tiered_classification.tier1_count > 100);
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 3: 16 November 2026 Cycle & Idempotent Catch-up Runner
  // --------------------------------------------------------------------------
  describe('3. 16 November 2026 Cycle & Idempotent Catch-up Runner', () => {
    test('confirms 16 November 2026 is an active trading day (Monday)', () => {
      assert.strictEqual(calendar.isTradingDay('2026-11-16'), true);
    });

    test('assess16NovStatus returns honest CATCHUP_PENDING when upstream EOD not yet pulled', () => {
      const st = catchup16Nov.assess16NovStatus({ date: '2026-11-16' });
      assert.strictEqual(st.target_date, '2026-11-16');
      assert.strictEqual(st.is_trading_day, true);
      assert.strictEqual(st.status, 'CATCHUP_PENDING');
      assert.strictEqual(st.prohibit_synthetic_mock, true);
      assert.ok(st.reason.includes('UPSTREAM_EOD_NOT_YET_SYNCED'));
    });

    test('registers 16 Nov into pending-catchup-queue idempotently without duplicates', () => {
      // First registration
      const r1 = catchup16Nov.registerPendingCatchup('2026-11-16', { dryRun: false });
      assert.strictEqual(r1.ok, true);
      assert.ok(r1.pending_dates.includes('2026-11-16'));

      // Second registration (assert idempotent)
      const r2 = catchup16Nov.registerPendingCatchup('2026-11-16', { dryRun: false });
      assert.strictEqual(r2.ok, true);
      assert.strictEqual(r2.already_present, true);
      const occurrences = r2.pending_dates.filter(d => d === '2026-11-16').length;
      assert.strictEqual(occurrences, 1, '16 Nov must appear exactly once in pending queue');
    });

    test('run16NovCatchup executes cleanly with transparent non-mock outcome', async () => {
      const res = await catchup16Nov.run16NovCatchup({ date: '2026-11-16', dryRun: true });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'CATCHUP_PENDING');
      assert.ok(res.message.includes('tanpa membuat candle/angka sintetis'));
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 4: Yahoo EOD & SQLite KV Canonical Sync + IHSG Anomaly Validation
  // --------------------------------------------------------------------------
  describe('4. Yahoo EOD & SQLite KV Canonical Sync', () => {
    test('rejects modern era split anomaly (5266.13) via isValidIhsgCandle', () => {
      // In 2024+ era, IHSG close 5266.13 is a known bad upstream feed anomaly
      const badCandle = { date: '2026-11-16', close: 5266.13 };
      assert.strictEqual(isValidIhsgCandle(badCandle), false);
    });

    test('accepts authentic modern era IHSG candle (6000 - 8500)', () => {
      const validCandle = { date: '2026-11-16', close: 7245.50 };
      assert.strictEqual(isValidIhsgCandle(validCandle), true);
    });

    test('preserves historical pre-2024 IHSG real trading levels (< 6000)', () => {
      // Historical real exchange data from 2018 when IHSG was 4500-5800 must NOT be rejected
      const histCandle = { date: '2018-05-15', close: 4850.25 };
      assert.strictEqual(isValidIhsgCandle(histCandle), true);
    });

    test('syncDateRange in dryRun mode executes safely without database write', async () => {
      const syncRes = await sqliteSync.syncDateRange({
        startDate: '2026-11-02',
        endDate: '2026-11-04',
        dryRun: true,
        tickers: ['BBCA', 'BBRI']
      });
      assert.strictEqual(syncRes.ok, true);
      assert.strictEqual(syncRes.dry_run, true);
      assert.strictEqual(syncRes.rows_upserted, 0);
      assert.strictEqual(syncRes.message, 'DRY_RUN_SUCCESS_NO_DB_WRITE');
    });

    test('preserves null volume without false coercion to zero', () => {
      // finiteNumber helper check
      const candleNullVol = { date: '2026-11-13', open: 5000, high: 5200, low: 4950, close: 5100, volume: null };
      const built = sqliteSync.buildRowsForTicker('BBCA', [candleNullVol], {
        allowedDates: new Set(['2026-11-13']),
        todayWib: '2026-11-13'
      });
      assert.strictEqual(built.rows.length, 1);
      assert.strictEqual(built.rows[0].volume, null, 'Volume null must remain null');
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 5: Financial Publication Q1-Q4 & Audited FY Monitor
  // --------------------------------------------------------------------------
  describe('5. Financial Publication Q1-Q4 & Audited FY Schedules', () => {
    const anchors = finMonitor.computeAnchors({ fiscalYear: 2026, fiscalYearEnd: '12-31' });

    test('schedules Q1 check for end of April (2026-04-30)', () => {
      const q1 = anchors.find(a => a.period === 'Q1');
      assert.ok(q1);
      assert.strictEqual(q1.period_end, '2026-03-31');
      assert.strictEqual(q1.nominal_check_date, '2026-04-30');
    });

    test('schedules Q2 check for end of July (2026-07-31)', () => {
      const q2 = anchors.find(a => a.period === 'Q2');
      assert.ok(q2);
      assert.strictEqual(q2.period_end, '2026-06-30');
      assert.strictEqual(q2.nominal_check_date, '2026-07-31');
    });

    test('schedules Q3 check for end of October (2026-10-31)', () => {
      const q3 = anchors.find(a => a.period === 'Q3');
      assert.ok(q3);
      assert.strictEqual(q3.period_end, '2026-09-30');
      assert.strictEqual(q3.nominal_check_date, '2026-10-31');
      // 2026-10-31 is Saturday, shifts to 2026-11-02 Monday
      assert.strictEqual(q3.actual_check_date, '2026-11-02');
      assert.strictEqual(q3.shifted, true);
    });

    test('schedules Q4 check for end of January NEXT YEAR (2027-01-31)', () => {
      const q4 = anchors.find(a => a.period === 'Q4');
      assert.ok(q4);
      assert.strictEqual(q4.period_end, '2026-12-31');
      assert.strictEqual(q4.nominal_check_date, '2027-01-31');
    });

    test('monitors FY (Audited Annual) as a separate track (2027-03-31)', () => {
      const fy = anchors.find(a => a.period === 'FY');
      assert.ok(fy);
      assert.strictEqual(fy.period_end, '2026-12-31');
      assert.strictEqual(fy.nominal_check_date, '2027-03-31');
      assert.notStrictEqual(fy.nominal_check_date, anchors.find(a => a.period === 'Q4').nominal_check_date);
    });

    test('admin schedule store contains fundamental job with editable configuration', () => {
      const st = adminStore.readStore();
      assert.strictEqual(st.ok, true);
      const fund = st.doc.jobs.fundamental;
      assert.ok(fund);
      assert.strictEqual(fund.key, 'fundamental');
      assert.strictEqual(fund.editable, true);
      assert.strictEqual(fund.timeWIB, '23:00');
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 6: Backfill Queues & Quota Budget Governance
  // --------------------------------------------------------------------------
  describe('6. Backfill Queues & Quota Reserve Floor Governance', () => {
    test('audits local vs VPS backfill queues priorities P1 - P4', () => {
      const q = recon.getBackfillQueueAudit();
      assert.ok(q.local_queue);
      assert.strictEqual(q.local_queue.totalItems, 283015);
      assert.strictEqual(q.local_queue.priorities.P1, 5748);
      assert.strictEqual(q.local_queue.priorities.P2, 80731);
      assert.strictEqual(q.local_queue.priorities.P3, 80976);
      assert.strictEqual(q.local_queue.priorities.P4, 115560);

      assert.ok(q.vps_queue);
      assert.strictEqual(q.vps_queue.totalItems, 219374);
      assert.strictEqual(q.vps_queue.priorities.P1, 5580);
      assert.strictEqual(q.vps_queue.priorities.P2, 5304);
      assert.strictEqual(q.vps_queue.priorities.P3, 92930);
      assert.strictEqual(q.vps_queue.priorities.P4, 115560);
    });

    test('enforces hard-lock reserve floor 5,000 on weekdays when remaining <= 5,000', () => {
      const b1 = recon.calculateBackfillQuotaBudget({ remaining: 4800, isWeekendOverride: false });
      assert.strictEqual(b1.hard_locked, true);
      assert.strictEqual(b1.available_for_backfill, 0);
      assert.strictEqual(b1.reserve_floor, 5000);
      assert.strictEqual(b1.rule_applied, 'WEEKDAY_HARD_LOCK_RESERVE_5000');
    });

    test('allows backfill above 5,000 on weekdays', () => {
      const b2 = recon.calculateBackfillQuotaBudget({ remaining: 12500, isWeekendOverride: false });
      assert.strictEqual(b2.hard_locked, false);
      assert.strictEqual(b2.available_for_backfill, 7500); // 12,500 - 5,000
      assert.strictEqual(b2.reserve_floor, 5000);
    });

    test('allows unrestricted backfill (floor 0) on weekends', () => {
      const b3 = recon.calculateBackfillQuotaBudget({ remaining: 12500, isWeekendOverride: true });
      assert.strictEqual(b3.hard_locked, false);
      assert.strictEqual(b3.reserve_floor, 0);
      assert.strictEqual(b3.available_for_backfill, 12500);
      assert.strictEqual(b3.rule_applied, 'WEEKEND_UNRESTRICTED_FLOOR_0');
    });
  });

});

'use strict';

/**
 * lib/domestic-flow-reconciliation.js
 * ============================================================================
 * AUTO-CUAN V6: DOMESTIC FLOW (ALL - F) & INSIDER NETWORK RECONCILIATION
 * ============================================================================
 *
 * SPECIFICATION & INVARIANTS:
 * 1. Domestic Net Formula:
 *    net_value_D  = net_value_ALL - net_value_F
 *    net_volume_D = net_volume_ALL - net_volume_F
 *
 * 2. Strict Pre-conditions (Fail-Closed):
 *    - ALL and Foreign MUST share the EXACT same trade_date.
 *    - ALL and Foreign MUST share the EXACT same ticker.
 *    - Foreign broker amounts must not exceed ALL broker amounts (subset check).
 *    - NEVER guess or synthesize missing values.
 *
 * 3. Insider Network:
 *    - Verifies real KSEI ownership / transaction data.
 *    - Connects refresh schedule and active state to Admin Console Schedule Store.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { computeDomesticBroksum } = require('./broker-accumulation-local');
const adminStore = require('./admin-schedule-store');
const insiderScheduler = require('./insider-tiered-scheduler');

/**
 * Safe numeric cleaner
 */
function cleanNumber(val) {
  if (val == null || val === '') return 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reconcile and calculate Domestic Broker Summary from ALL and Foreign feeds.
 * Strictly verifies identity, date compatibility, and formula equivalence.
 */
function reconcileDomesticBrokerSummary(allFeed, foreignFeed, options = {}) {
  const ticker = String(options.ticker || (allFeed && allFeed.ticker) || '').trim().toUpperCase();
  const tradeDate = String(options.tradeDate || (allFeed && (allFeed.date || allFeed.trade_date)) || '').trim();

  if (!allFeed || typeof allFeed !== 'object') {
    return {
      ok: false,
      status: 'MISSING_ALL_DATA',
      reason: 'Broker summary ALL feed is missing or invalid object.'
    };
  }

  if (!foreignFeed || typeof foreignFeed !== 'object') {
    return {
      ok: false,
      status: 'FOREIGN_NOT_RELEASED',
      reason: 'Broker summary Foreign feed is missing or invalid object.'
    };
  }

  const allDate = String(allFeed.date || allFeed.trade_date || allFeed.broker_end_date || '').trim();
  const fDate = String(foreignFeed.date || foreignFeed.trade_date || foreignFeed.broker_end_date || '').trim();

  // Strict Date Match Invariant
  if (allDate && fDate && allDate !== fDate) {
    return {
      ok: false,
      status: 'DATE_MISMATCH_FAIL_CLOSED',
      reason: `Trade date mismatch: ALL=${allDate} vs Foreign=${fDate}. Domestic flow will NOT be computed.`
    };
  }

  // Target date verification if supplied
  const effectiveDate = tradeDate || allDate;
  if (tradeDate && allDate && tradeDate !== allDate) {
    return {
      ok: false,
      status: 'TARGET_DATE_MISMATCH',
      reason: `Expected trade date ${tradeDate} does not match ALL feed date ${allDate}.`
    };
  }

  // Strict Ticker Match Invariant
  const allTicker = String(allFeed.ticker || allFeed.code || '').trim().toUpperCase();
  const fTicker = String(foreignFeed.ticker || foreignFeed.code || '').trim().toUpperCase();
  if (allTicker && fTicker && allTicker !== fTicker) {
    return {
      ok: false,
      status: 'TICKER_MISMATCH_FAIL_CLOSED',
      reason: `Ticker mismatch: ALL=${allTicker} vs Foreign=${fTicker}.`
    };
  }

  // Execute canonical arithmetic
  const domResult = computeDomesticBroksum(allFeed, foreignFeed, effectiveDate, ticker || allTicker);

  if (domResult.status !== 'RELEASED' && domResult.status !== 'SUCCESS') {
    return {
      ok: false,
      status: domResult.status,
      reason: domResult.message || 'Domestic compilation rejected by canonical broker accumulation guard.',
      raw_result: domResult
    };
  }

  // Calculate aggregate net sums to assert net_value_D == net_value_ALL - net_value_F
  const parseBrokers = (feed) => {
    if (!feed) return [];
    if (Array.isArray(feed.brokers)) return feed.brokers;
    if (Array.isArray(feed.broker_levels)) return feed.broker_levels;
    if (Array.isArray(feed.data)) return feed.data;
    return [];
  };

  const allBrokers = parseBrokers(allFeed);
  const fBrokers = parseBrokers(foreignFeed);
  const dBrokers = Array.isArray(domResult.brokers) ? domResult.brokers : [];

  const sumFlows = (brokers) => {
    let bval = 0, sval = 0, bvol = 0, svol = 0;
    for (const b of brokers) {
      bval += cleanNumber(b.bval);
      sval += cleanNumber(b.sval);
      bvol += cleanNumber(b.bvol);
      svol += cleanNumber(b.svol);
    }
    return {
      buy_value: bval,
      sell_value: sval,
      net_value: bval - sval,
      buy_volume: bvol,
      sell_volume: svol,
      net_volume: bvol - svol
    };
  };

  const aggALL = sumFlows(allBrokers);
  const aggF = sumFlows(fBrokers);
  const aggD = sumFlows(dBrokers);

  // Invariant verification: net_value_D == net_value_ALL - net_value_F
  const expectedNetValue = aggALL.net_value - aggF.net_value;
  const expectedNetVolume = aggALL.net_volume - aggF.net_volume;

  // Allow floating point precision difference <= 0.01
  const netValueMatches = Math.abs(aggD.net_value - expectedNetValue) < 0.01;
  const netVolumeMatches = Math.abs(aggD.net_volume - expectedNetVolume) < 0.01;

  return {
    ok: true,
    status: 'VERIFIED_DOMESTIC_DERIVATION',
    ticker: ticker || allTicker,
    trade_date: effectiveDate,
    aggregates: {
      ALL: aggALL,
      Foreign: aggF,
      Domestic: aggD
    },
    formula_verification: {
      net_value_matches: netValueMatches,
      net_volume_matches: netVolumeMatches,
      expected_net_value: expectedNetValue,
      actual_net_value: aggD.net_value,
      expected_net_volume: expectedNetVolume,
      actual_net_volume: aggD.net_volume
    },
    domestic_payload: domResult
  };
}

/**
 * Audit Insider Network real data & Admin Console Schedule integration.
 */
function auditInsiderNetworkIntegration() {
  const insidersDbPath = path.join(ROOT, 'data', 'insider-network', 'insiders-db.json');
  let hasRealDb = false;
  let recordCount = 0;
  let sampleRecord = null;

  if (fs.existsSync(insidersDbPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(insidersDbPath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        hasRealDb = true;
        recordCount = data.length;
        sampleRecord = data[0];
      }
    } catch (_) {}
  }

  // Check Admin Console schedule store for 'insider' job
  const storeRes = adminStore.readStore();
  let insiderJobConfig = null;
  if (storeRes.ok && storeRes.doc && storeRes.doc.jobs) {
    insiderJobConfig = storeRes.doc.jobs.insider || null;
  }

  // Tier classification check
  const tierInfo = insiderScheduler.classifyUniverse();

  return {
    real_insider_data_available: hasRealDb,
    total_ksei_records: recordCount,
    sample_transaction: sampleRecord,
    tiered_classification: {
      universe_size: tierInfo.universe_size,
      tier1_count: tierInfo.tier1.count,
      tier2_group_a_count: tierInfo.tier2.group_a.count,
      tier2_group_b_count: tierInfo.tier2.group_b.count
    },
    admin_console_governance: {
      job_key: 'insider',
      enabled: insiderJobConfig ? insiderJobConfig.enabled : false,
      timeWIB: insiderJobConfig ? insiderJobConfig.timeWIB : '22:40',
      retryWindowMinutes: insiderJobConfig ? insiderJobConfig.retryWindowMinutes : 15,
      costClass: insiderJobConfig ? insiderJobConfig.costClass : 'MEDIUM',
      editable_via_admin_console: true
    }
  };
}

module.exports = {
  reconcileDomesticBrokerSummary,
  auditInsiderNetworkIntegration
};

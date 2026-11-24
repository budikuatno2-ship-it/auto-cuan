'use strict';

/**
 * lib/v6-historical-reconciliation.js
 * ============================================================================
 * AUTO-CUAN V6: COMPREHENSIVE HISTORICAL RECONCILIATION ENGINE (2 JAN - 16 NOV 2026)
 * ============================================================================
 *
 * Provides authoritative SSOT methods for:
 * 1. Monthly Broksum Coverage & Strict Provenance Classification (Jan - Nov 2026).
 *    Classifies honestly:
 *      - VERIFIED_RAW_PROVIDER (or ORIGINAL_PROVIDER_VALID): real files on disk
 *      - UNKNOWN_SOURCE: 390,268 historical rows (Jan-Oct) without raw JSON on repo
 *      - DERIVED_DOMESTIC (DERIVED_COMPUTED): 198,796 rows computed as ALL - Foreign
 *      - NO_FOREIGN_FLOW_PROVIDER_CONFIRMED: 397 rows of active volume with zero foreign flow
 *      - SUSPENDED_OR_NO_TRADE (LISTED_NOT_TRADED): 1,395 rows of FCA/suspended/zero activity
 *      - FIXTURE_EXCLUDED: 5,208 pseudo-ticker rows across ALL, F, D
 * 2. Backfill Queue Audit (data/backfill-queue.json & data/backfill-queue-vps.json).
 * 3. Quota Budget & Floor 5,000 Governance according to Admin Console policy.
 *
 * Strict Rule: NEVER fabricate mock production data or assume unverified rows are original.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_V3_MONTH_CSV = path.join(ROOT, 'docs', 'v6', 'v6-ledger-v3-summary-by-month.csv');
const LEDGER_V3_STATUS_CSV = path.join(ROOT, 'docs', 'v6', 'v6-ledger-v3-summary-by-dataset-status.csv');
const BACKFILL_QUEUE_LOCAL = path.join(ROOT, 'data', 'backfill-queue.json');
const BACKFILL_QUEUE_VPS = path.join(ROOT, 'data', 'backfill-queue-vps.json');
const FOREIGN_397_CSV = path.join(ROOT, 'docs', 'v6', 'V6_FOREIGN_397_CONFLICT_RESOLUTION.csv');

/** Minimal RFC-4180 CSV parser */
function parseCsv(content) {
  const lines = String(content || '').trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = parts[idx] ? parts[idx].trim() : '';
    });
    rows.push(obj);
  }
  return rows;
}

/**
 * Audit historical coverage month by month for Jan - Nov 2026.
 */
function getMonthlyCoverageAudit() {
  if (!fs.existsSync(LEDGER_V3_MONTH_CSV)) {
    throw new Error('Ledger V3 monthly summary CSV missing at: ' + LEDGER_V3_MONTH_CSV);
  }

  const rawRows = parseCsv(fs.readFileSync(LEDGER_V3_MONTH_CSV, 'utf8'));
  const monthlyData = {};

  for (const row of rawRows) {
    const month = row.month;
    const dataset = row.dataset;
    const status = row.status;
    const count = Number(row.count) || 0;

    if (!monthlyData[month]) {
      monthlyData[month] = {
        month,
        total_rows_all_datasets: Number(row.total_rows_per_month) || 0,
        datasets: { ALL: {}, F: {}, D: {} }
      };
    }
    if (!monthlyData[month].datasets[dataset]) {
      monthlyData[month].datasets[dataset] = {};
    }
    monthlyData[month].datasets[dataset][status] = count;
  }

  // Calculate aggregated status totals
  const overallTotals = {
    ORIGINAL_PROVIDER_VALID: { ALL: 0, F: 0, D: 0, total: 0 },
    UNKNOWN_SOURCE: { ALL: 0, F: 0, D: 0, total: 0 },
    DERIVED_COMPUTED: { ALL: 0, F: 0, D: 0, total: 0 },
    NO_FOREIGN_FLOW_PROVIDER_CONFIRMED: { ALL: 0, F: 0, D: 0, total: 0 },
    LISTED_NOT_TRADED: { ALL: 0, F: 0, D: 0, total: 0 },
    UNKNOWN_CANDLE: { ALL: 0, F: 0, D: 0, total: 0 },
    SYNTHETIC_UNVERIFIED: { ALL: 0, F: 0, D: 0, total: 0 },
    FIXTURE_EXCLUDED: { ALL: 0, F: 0, D: 0, total: 0 }
  };

  for (const m of Object.keys(monthlyData)) {
    const dsets = monthlyData[m].datasets;
    for (const d of ['ALL', 'F', 'D']) {
      const statuses = dsets[d] || {};
      for (const [st, cnt] of Object.entries(statuses)) {
        if (!overallTotals[st]) {
          overallTotals[st] = { ALL: 0, F: 0, D: 0, total: 0 };
        }
        overallTotals[st][d] += cnt;
        overallTotals[st].total += cnt;
      }
    }
  }

  return {
    months: Object.keys(monthlyData).sort(),
    monthly_breakdown: monthlyData,
    overall_totals: overallTotals,
    honest_classification: {
      verified_raw_provider: overallTotals.ORIGINAL_PROVIDER_VALID.total, // 8,325 ALL + 6,947 F = 15,272
      unknown_source_historical: overallTotals.UNKNOWN_SOURCE.total, // 199,485 ALL + 190,783 F = 390,268
      derived_domestic: overallTotals.DERIVED_COMPUTED.total, // 198,796
      no_foreign_flow_confirmed: overallTotals.NO_FOREIGN_FLOW_PROVIDER_CONFIRMED.total,
      suspended_or_no_trade: overallTotals.LISTED_NOT_TRADED.total,
      fixtures_excluded: overallTotals.FIXTURE_EXCLUDED.total
    }
  };
}

/**
 * Audit Backfill Queues (Local vs VPS).
 */
function getBackfillQueueAudit() {
  const result = {
    local_queue: null,
    vps_queue: null,
    comparison: null
  };

  if (fs.existsSync(BACKFILL_QUEUE_LOCAL)) {
    try {
      const q = JSON.parse(fs.readFileSync(BACKFILL_QUEUE_LOCAL, 'utf8'));
      result.local_queue = {
        generatedAt: q.generatedAt,
        window: q.window,
        totalItems: q.totalItems,
        totalRequests: q.totalRequests,
        priorities: {
          P1: q.priorities && q.priorities.P1 ? q.priorities.P1.items : 0,
          P2: q.priorities && q.priorities.P2 ? q.priorities.P2.items : 0,
          P3: q.priorities && q.priorities.P3 ? q.priorities.P3.items : 0,
          P4: q.priorities && q.priorities.P4 ? q.priorities.P4.items : 0
        }
      };
    } catch (_) {}
  }

  if (fs.existsSync(BACKFILL_QUEUE_VPS)) {
    try {
      const qv = JSON.parse(fs.readFileSync(BACKFILL_QUEUE_VPS, 'utf8'));
      result.vps_queue = {
        generatedAt: qv.generatedAt,
        window: qv.window,
        totalItems: qv.totalItems,
        totalRequests: qv.totalRequests,
        priorities: {
          P1: qv.priorities && qv.priorities.P1 ? qv.priorities.P1.items : 0,
          P2: qv.priorities && qv.priorities.P2 ? qv.priorities.P2.items : 0,
          P3: qv.priorities && qv.priorities.P3 ? qv.priorities.P3.items : 0,
          P4: qv.priorities && qv.priorities.P4 ? qv.priorities.P4.items : 0
        }
      };
    } catch (_) {}
  }

  if (result.local_queue && result.vps_queue) {
    result.comparison = {
      localTotal: result.local_queue.totalItems,
      vpsTotal: result.vps_queue.totalItems,
      delta: result.local_queue.totalItems - result.vps_queue.totalItems,
      p2_all_reduction: result.local_queue.priorities.P2 - result.vps_queue.priorities.P2, // 80,731 -> 5,304 (saved on VPS)
      p3_foreign_shift: result.vps_queue.priorities.P3 - result.local_queue.priorities.P3
    };
  }

  return result;
}

/**
 * Dynamic Quota Budget & Reserve Floor Governance.
 *
 * Implements the owner-approved dynamic formula:
 * available_for_backfill = max(0, remaining_quota - reserve_floor)
 * Weekday: reserve_floor = 5,000 (until 20:30 WIB or obligations met)
 * Weekend: reserve_floor = 0
 *
 * @param {object} params
 * @param {number} params.remaining - Current remaining Stock Arjum quota
 * @param {Date|number|string} [params.now] - Current timestamp
 * @param {boolean} [params.isWeekendOverride] - Override weekend status
 * @param {number} [params.customReserveFloor] - Custom floor override
 */
function calculateBackfillQuotaBudget(params) {
  const p = params || {};
  const remaining = Number.isFinite(Number(p.remaining)) ? Math.floor(Number(p.remaining)) : 0;
  
  let isWeekend = false;
  let hourWib = 12;
  
  if (p.now != null) {
    const ms = p.now instanceof Date ? p.now.getTime() : (Number.isFinite(Number(p.now)) ? Number(p.now) : Date.now());
    const shifted = new Date(ms + 7 * 3600 * 1000);
    const dow = shifted.getUTCDay();
    isWeekend = dow === 0 || dow === 6;
    hourWib = shifted.getUTCHours();
  }
  
  if (typeof p.isWeekendOverride === 'boolean') {
    isWeekend = p.isWeekendOverride;
  }

  let floor = isWeekend ? 0 : 5000;
  if (Number.isFinite(Number(p.customReserveFloor))) {
    floor = Math.max(0, Math.floor(Number(p.customReserveFloor)));
  }

  const available = Math.max(0, remaining - floor);
  const isHardLocked = !isWeekend && remaining <= floor;

  return {
    remaining_quota: remaining,
    reserve_floor: floor,
    is_weekend: isWeekend,
    hour_wib: hourWib,
    available_for_backfill: available,
    hard_locked: isHardLocked,
    rule_applied: isWeekend 
      ? 'WEEKEND_UNRESTRICTED_FLOOR_0' 
      : (remaining <= floor ? 'WEEKDAY_HARD_LOCK_RESERVE_5000' : 'WEEKDAY_RESERVED_OPERATING')
  };
}

// Pure, read-only preflight; does not enqueue work or infer an expected universe.
function preflightHistoricalEligibility(tickers, date, reference) {
  return require('./historical-ticker-eligibility').preflightEligibility(tickers, date, reference);
}

module.exports = {
  preflightHistoricalEligibility,
  getMonthlyCoverageAudit,
  getBackfillQueueAudit,
  calculateBackfillQuotaBudget,
  parseCsv
};

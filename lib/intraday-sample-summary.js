'use strict';

/**
 * Intraday Sample End-of-Day Summary Generator
 * 
 * Generates a research summary after the final 16:00 snapshot.
 * For manual review only — NOT published or sent automatically.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const lifecycle = require('./intraday-sample-lifecycle');
const eligibility = require('./intraday-production-eligibility');

/**
 * Sampled-price accessors. Prefer the explicit v1.1 alias, fall back to the
 * original canonical field for legacy lifecycle entries.
 * Both MFE/MAE are computed from SAMPLED current_price extrema, NOT candle
 * high/low.
 */
function sampledMfe(entry) {
  return entry.sampled_mfe_pct != null ? entry.sampled_mfe_pct : entry.max_favorable_excursion_pct;
}
function sampledMae(entry) {
  return entry.sampled_mae_pct != null ? entry.sampled_mae_pct : entry.max_adverse_excursion_pct;
}

/**
 * Summarize a list of positive numeric excursion values into {max,avg,count}.
 */
function summarizeExcursion(values) {
  const nums = values.filter((v) => v != null && v > 0);
  if (nums.length === 0) return { max: 0, avg: 0, count: 0 };
  return {
    max: Math.max(...nums),
    avg: round2(nums.reduce((s, v) => s + v, 0) / nums.length),
    count: nums.length
  };
}

/**
 * Resolve a lifecycle entry's production eligibility over its WHOLE lifecycle.
 *
 * A candidate is data-quality-risk (ineligible) if ANY observation across the
 * day carried a production-excluded data-quality condition — not only its
 * first observation. A later clean status never erases an earlier risk flag.
 *
 * Classification precedence (evaluated in order):
 *   1. Whole-lifecycle status history: if any element of `data_quality_statuses`
 *      (or `initial_data_quality_status` when the array is absent) is a
 *      risk status per the shared pure policy -> classification 'data_quality_risk'.
 *   2. Persisted flag metadata: if `first_data_quality_flag_at` is set ->
 *      'data_quality_risk' (defensive; covers arrays that were pruned).
 *   3. First-seen boolean: if `production_eligible_at_first_seen === false` ->
 *      'data_quality_risk'. (Used as an ADDITIONAL exclusion, never as the sole
 *      basis for eligibility.)
 *   4. Positive proof of eligibility: clean status history, OR
 *      `production_eligible_at_first_seen === true` -> 'eligible'.
 *   5. Legacy with no data-quality evidence at all (older tracker dropped the
 *      status): 'legacy_unclassified' — reason `legacy_missing_data_quality`.
 *      Such entries are NOT counted as production-eligible (conservative) but
 *      are retained in combined metrics and surfaced in their own partition.
 *
 * @returns {{ eligible:boolean, classification:('eligible'|'data_quality_risk'|'legacy_unclassified'), reason:string, source:string }}
 */
function resolveEntryEligibility(entry) {
  const statuses = Array.isArray(entry.data_quality_statuses)
    ? entry.data_quality_statuses
    : (entry.initial_data_quality_status != null ? [entry.initial_data_quality_status] : []);
  const hasStatusEvidence = statuses.some((s) => s != null);

  // 1. Whole-lifecycle risk: any observation carried a risk status.
  const riskStatus = statuses.find((s) => eligibility.isDataQualityRiskStatus(s));
  if (riskStatus) {
    const c = eligibility.classifyProductionEligibility({ data_quality_status: riskStatus });
    return {
      eligible: false,
      classification: 'data_quality_risk',
      reason: c.reason,
      source: 'whole_lifecycle_status_history'
    };
  }

  // 2. Persisted flag metadata (risk flagged even if the status array was pruned).
  if (entry.first_data_quality_flag_at) {
    return {
      eligible: false,
      classification: 'data_quality_risk',
      reason: 'data_quality_flagged',
      source: 'first_data_quality_flag_at'
    };
  }

  // 3. First-seen ineligibility snapshot (additional exclusion only).
  if (entry.production_eligible_at_first_seen === false) {
    return {
      eligible: false,
      classification: 'data_quality_risk',
      reason: entry.production_eligibility_reason || 'production_ineligible_at_first_seen',
      source: 'production_eligible_at_first_seen'
    };
  }

  // 4. Positive proof of eligibility.
  if (hasStatusEvidence) {
    // All recorded statuses are non-risk (risk was ruled out in step 1).
    return { eligible: true, classification: 'eligible', reason: 'ok', source: 'whole_lifecycle_status_history' };
  }
  if (entry.production_eligible_at_first_seen === true) {
    return { eligible: true, classification: 'eligible', reason: 'ok', source: 'production_eligible_at_first_seen' };
  }

  // 5. Legacy entry with no data-quality evidence: conservative, NOT eligible.
  return {
    eligible: false,
    classification: 'legacy_unclassified',
    reason: 'legacy_missing_data_quality',
    source: 'legacy_conservative'
  };
}

/**
 * Compute the metric block for a partition (list of lifecycle entries).
 * Touch counts use discrete sampled current_price (raw, unchanged from the
 * lifecycle tracker). MFE/MAE use sampled prices, not candle high/low.
 */
function computePartitionMetrics(entries) {
  const outcomeDistribution = {};
  for (const e of entries) {
    const outcome = e.final_simulated_outcome || 'UNKNOWN';
    outcomeDistribution[outcome] = (outcomeDistribution[outcome] || 0) + 1;
  }
  return {
    candidate_count: entries.length,
    entry_touch_count: entries.filter((e) => e.first_entry_touch_at).length,
    tp1_touch_count: entries.filter((e) => e.first_tp1_touch_at).length,
    tp2_touch_count: entries.filter((e) => e.first_tp2_touch_at).length,
    sl_touch_count: entries.filter((e) => e.first_sl_touch_at).length,
    invalid_count: entries.filter((e) => e.first_invalid_at).length,
    entry_missed_count: entries.filter((e) => e.first_entry_missed_at).length,
    outcome_distribution: outcomeDistribution,
    sampled_mfe: summarizeExcursion(entries.map(sampledMfe)),
    sampled_mae: summarizeExcursion(entries.map(sampledMae))
  };
}

/**
 * Read all run records from runs.jsonl
 */
async function readRunsJsonl(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); }
      catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Read all candidate records from candidates.jsonl
 */
async function readCandidatesJsonl(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); }
      catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Read all error records from errors.jsonl
 */
async function readErrorsJsonl(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); }
      catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Generate the full end-of-day research summary.
 */
async function generateSummary(outputDir, approvedSchedule, sampleDate) {
  const runsFile = path.join(outputDir, 'runs.jsonl');
  const candidatesFile = path.join(outputDir, 'candidates.jsonl');
  const errorsFile = path.join(outputDir, 'errors.jsonl');
  const lifecycleFile = path.join(outputDir, 'lifecycle.json');

  // Load all data
  const runs = await readRunsJsonl(runsFile);
  const candidates = await readCandidatesJsonl(candidatesFile);
  const errors = await readErrorsJsonl(errorsFile);

  // Finalize lifecycle
  const lifecycleData = await lifecycle.finalizeLifecycle(lifecycleFile);

  // Compute snapshot stats
  const successfulRuns = runs.filter((r) => r.type === 'sample_run' && r.status === 'success');
  const skippedRuns = runs.filter((r) => r.type === 'skipped_due_to_lock');
  const failedRuns = errors.filter((r) => r.type === 'run_error');

  const completedTimes = successfulRuns.map((r) => r.scheduled_time);
  const missingTimes = approvedSchedule.filter((t) => !completedTimes.includes(t));

  // Unique tickers across all observations
  const allTickers = new Set(candidates.map((c) => c.ticker).filter(Boolean));
  
  // Ticker appearance counts
  const tickerObservationCount = {};
  for (const c of candidates) {
    if (c.ticker) {
      tickerObservationCount[c.ticker] = (tickerObservationCount[c.ticker] || 0) + 1;
    }
  }

  const repeatedTickers = Object.entries(tickerObservationCount)
    .filter(([, count]) => count > 1)
    .map(([ticker, count]) => ({ ticker, count }))
    .sort((a, b) => b.count - a.count);

  const singleObservationTickers = Object.entries(tickerObservationCount)
    .filter(([, count]) => count === 1)
    .map(([ticker]) => ticker);

  // First appearance time per ticker
  const firstAppearance = {};
  for (const c of candidates) {
    if (c.ticker && !firstAppearance[c.ticker]) {
      firstAppearance[c.ticker] = c.scheduled_time;
    }
  }

  // Lifecycle-based stats
  const lifecycleEntries = Object.values(lifecycleData);
  const entryTouchCount = lifecycleEntries.filter((e) => e.first_entry_touch_at).length;
  const tp1TouchCount = lifecycleEntries.filter((e) => e.first_tp1_touch_at).length;
  const tp2TouchCount = lifecycleEntries.filter((e) => e.first_tp2_touch_at).length;
  const slTouchCount = lifecycleEntries.filter((e) => e.first_sl_touch_at).length;
  const invalidCount = lifecycleEntries.filter((e) => e.first_invalid_at).length;
  const staleCount = lifecycleEntries.filter((e) => e.first_stale_at).length;
  const entryMissedCount = lifecycleEntries.filter((e) => e.first_entry_missed_at).length;

  // Final outcomes
  const outcomeDistribution = {};
  for (const entry of lifecycleEntries) {
    const outcome = entry.final_simulated_outcome || 'UNKNOWN';
    outcomeDistribution[outcome] = (outcomeDistribution[outcome] || 0) + 1;
  }

  // Max favorable/adverse movements
  const mfeValues = lifecycleEntries
    .map((e) => e.max_favorable_excursion_pct)
    .filter((v) => v != null && v > 0);
  const maeValues = lifecycleEntries
    .map((e) => e.max_adverse_excursion_pct)
    .filter((v) => v != null && v > 0);

  // Production-eligibility partitions (additive, v1.1).
  // - combined: ALL candidates (matches existing top-level totals).
  // - production_eligible: candidates that would pass the production
  //   data-quality gate (clean).
  // - data_quality_risk: candidates excluded from production for data-quality
  //   reasons (e.g. CORPORATE_ACTION_RISK). Their RAW touch outcomes (e.g.
  //   TP1_HIT) are preserved and still counted in combined + this partition,
  //   but excluded from production_eligible.
  // Whole-lifecycle classification: a candidate is data-quality-risk if ANY
  // observation carried a risk status (see resolveEntryEligibility). Legacy
  // entries with no data-quality evidence are conservatively kept out of the
  // production-eligible headline and surfaced in their own partition.
  const eligibleEntries = [];
  const riskEntries = [];
  const legacyUnclassifiedEntries = [];
  for (const entry of lifecycleEntries) {
    const res = resolveEntryEligibility(entry);
    if (res.classification === 'eligible') eligibleEntries.push(entry);
    else if (res.classification === 'legacy_unclassified') legacyUnclassifiedEntries.push(entry);
    else riskEntries.push(entry);
  }
  const combinedMetrics = computePartitionMetrics(lifecycleEntries);
  const productionEligibleMetrics = computePartitionMetrics(eligibleEntries);
  const dataQualityRiskMetrics = computePartitionMetrics(riskEntries);
  const legacyUnclassifiedMetrics = computePartitionMetrics(legacyUnclassifiedEntries);

  // Data quality / provider errors
  const providerErrors = errors.filter((e) => e.type === 'run_error');
  const dataQualityIssues = runs
    .filter((r) => r.stale_data_indicators && r.stale_data_indicators.fetch_fail_count > 0)
    .map((r) => ({ scheduled_time: r.scheduled_time, fetch_fail_count: r.stale_data_indicators.fetch_fail_count }));

  // Build summary
  const summaryData = {
    generated_at: new Date().toISOString(),
    sample_date: sampleDate,
    timezone: 'Asia/Jakarta',
    version: 'intraday-sample-summary-v1.1',

    // Snapshot counts
    expected_snapshot_count: approvedSchedule.length,
    completed_snapshot_count: successfulRuns.length,
    missing_snapshot_times: missingTimes,
    skipped_runs: skippedRuns.length,
    failed_runs: failedRuns.length,

    // Ticker stats
    total_unique_tickers_observed: allTickers.size,
    repeated_tickers: repeatedTickers,
    candidates_appeared_only_once: singleObservationTickers,
    candidates_persisted_multiple_samples: repeatedTickers.map((r) => r.ticker),

    // First appearance
    first_appearance_time_per_ticker: firstAppearance,

    // Final observed status per ticker (last seen status)
    final_observed_status: Object.fromEntries(
      lifecycleEntries.map((e) => [e.ticker, e.statuses[e.statuses.length - 1] || 'UNKNOWN'])
    ),

    // Movement stats
    max_favorable_movement: mfeValues.length > 0 ? {
      max: Math.max(...mfeValues),
      avg: round2(mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length),
      count: mfeValues.length
    } : { max: 0, avg: 0, count: 0 },

    max_adverse_movement: maeValues.length > 0 ? {
      max: Math.max(...maeValues),
      avg: round2(maeValues.reduce((s, v) => s + v, 0) / maeValues.length),
      count: maeValues.length
    } : { max: 0, avg: 0, count: 0 },

    // Touch counts
    entry_touch_count: entryTouchCount,
    tp1_touch_count: tp1TouchCount,
    tp2_touch_count: tp2TouchCount,
    sl_touch_count: slTouchCount,
    invalid_count: invalidCount,
    stale_count: staleCount,
    entry_missed_count: entryMissedCount,

    // Outcome distribution
    outcome_distribution: outcomeDistribution,

    // Production-eligibility partitions (additive, v1.1).
    // combined = production_eligible + data_quality_risk + legacy_unclassified.
    combined_metrics: combinedMetrics,
    production_eligible_metrics: productionEligibleMetrics,
    data_quality_risk_metrics: dataQualityRiskMetrics,
    legacy_unclassified_metrics: legacyUnclassifiedMetrics,

    // Explanatory notes about the metric semantics (see partitions above).
    metric_semantics_notes: [
      'Touch detection (entry/TP1/TP2/SL) uses discrete SAMPLED current_price at snapshot times, not intrabar candle high/low. Touches between snapshots may be missed.',
      'Sampled MFE/MAE (sampled_mfe / sampled_mae) are computed from sampled current_price extrema relative to the frozen reference entry price, NOT from candle high/low.',
      'Eligibility is classified over the WHOLE lifecycle: a candidate is data-quality-risk if ANY observation carried a risk status (CORPORATE_ACTION_RISK, INVALID_CANDLE, SHORT_HISTORY, MISSING_REFERENCE, SPARSE_TRADING_DAYS, NEEDS_REVALIDATION). A later clean status does not erase an earlier risk flag.',
      'production_eligible_metrics EXCLUDE data-quality-risk candidates, matching the shared production data-quality gate (lib/intraday-production-eligibility, also used by api/sector-hot.js).',
      'A data-quality-risk candidate keeps its RAW simulated outcome (e.g. TP1_HIT); it is counted in combined_metrics and data_quality_risk_metrics but not in production_eligible_metrics.',
      'legacy_unclassified_metrics holds old lifecycle entries with no recorded data-quality evidence (initial_data_quality_status / data_quality_statuses / production_eligible_at_first_seen / first_data_quality_flag_at all absent). They are conservatively EXCLUDED from production_eligible_metrics (never assumed eligible) but retained in combined_metrics. Legacy entries whose available fields positively prove clean/risk are classified accordingly instead.'
    ],

    // Data quality
    data_quality_and_provider_errors: {
      total_errors: providerErrors.length,
      data_quality_issues: dataQualityIssues
    },

    // Note: for manual review only
    note: 'This summary is for manual review only. Not published or sent automatically.'
  };

  // Write summary.json
  const summaryFile = path.join(outputDir, 'summary.json');
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(summaryFile, JSON.stringify(summaryData, null, 2) + '\n');

  return summaryData;
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  generateSummary,
  readRunsJsonl,
  readCandidatesJsonl,
  readErrorsJsonl,
  computePartitionMetrics,
  resolveEntryEligibility,
  sampledMfe,
  sampledMae
};

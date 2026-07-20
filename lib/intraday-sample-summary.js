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
    version: 'intraday-sample-summary-v1.0',

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
  readErrorsJsonl
};

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const BUNDLE_PREFIX = 'daytrade-intraday-validation-bundle-';
const AGGREGATE_PREFIX = 'daytrade-intraday-validation-aggregate-';
const POLICY_PREFIX = 'daytrade-intraday-policy-';

// Helper functions
function asArray(v) { return Array.isArray(v) ? v : []; }
function numberOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function inc(map, key, by) { if (!key) return; map[key] = (map[key] || 0) + (by == null ? 1 : by); }
function fmtObj(obj) { return '`' + JSON.stringify(obj || {}) + '`'; }
function todayIso(nowMs) { return new Date(nowMs || Date.now()).toISOString().slice(0, 10); }
function fmtList(arr) { return arr && arr.length ? arr.join(', ') : 'none'; }
function uniqueTickers(arr) { return Array.from(new Set(asArray(arr).filter(Boolean))); }

/**
 * Policy decisions for intraday data-quality problems
 */
const POLICY_DECISIONS = {
  BLOCK_PRODUCTION_ENABLE: {
    reason: 'Ticker has critical data-quality blocker - cannot enable production',
    scoring_impact: 'BLOCKED',
    watch: true
  },
  EXCLUDE_INTRADAY_ADJUSTMENT: {
    reason: 'Ticker has incomplete data - exclude from intraday scoring but keep daily',
    scoring_impact: 'DAILY_ONLY',
    watch: true
  },
  DAILY_SCORE_ONLY: {
    reason: 'Intraday data unavailable or incomplete - recommend daily score only',
    scoring_impact: 'DAILY_ONLY',
    watch: true
  },
  WATCH_NEXT_SESSION: {
    reason: 'Non-recurring issue - watch in next session',
    scoring_impact: 'UNCHANGED',
    watch: true
  },
  OK_FOR_INTRADAY_DRY_RUN: {
    reason: 'Data quality OK - eligible for intraday dry-run',
    scoring_impact: 'UNCHANGED',
    watch: false
  }
};

/**
 * Determine policy decision for a single ticker based on data quality status
 * Returns: { ticker, decision, fallback_action, reason, reason_detail, ...policy }
 * 
 * decision: primary decision (BLOCK_PRODUCTION_ENABLE, EXCLUDE_INTRADAY_ADJUSTMENT, WATCH_NEXT_SESSION, OK_FOR_INTRADAY_DRY_RUN)
 * fallback_action: scoring policy (DAILY_SCORE_ONLY for data-quality issues, else UNCHANGED)
 */
function decidePolicy(ticker, bundleData, aggregateData) {
  const {
    no_intraday_data_tickers = [],
    incomplete_intraday_tickers = [],
    intraday_unknown_tickers = [],
    rows = []
  } = bundleData || {};

  // Find row data for this ticker, or use bundle-level data if not found in rows
  const row = rows.find(r => r.ticker === ticker);
  const data_quality = row ? row.data_quality : (bundleData && bundleData.data_quality);
  const intraday_priority_label = row ? row.intraday_priority_label : (bundleData && bundleData.intraday_priority_label);
  const intraday_confirmation_label = row ? row.intraday_confirmation_label : (bundleData && bundleData.intraday_confirmation_label);

  // Find ticker in aggregate recurring data if available
  const recurring = aggregateData || {};
  const recurringNoData = asArray(recurring.no_intraday_data_tickers || []).map(t => typeof t === 'string' ? t : t.ticker);
  const recurringIncomplete = asArray(recurring.incomplete_intraday_tickers || []).map(t => typeof t === 'string' ? t : t.ticker);
  const recurringUnknown = asArray(recurring.intraday_unknown_tickers || []).map(t => typeof t === 'string' ? t : t.ticker);
  const isRecurringNoData = recurringNoData.includes(ticker);
  const isRecurringIncomplete = recurringIncomplete.includes(ticker);
  const isRecurringUnknown = recurringUnknown.includes(ticker);

  // Check if ticker has any data-quality blocker
  const hasDataQualityBlocker = 
    data_quality === 'NO_INTRADAY_DATA' || 
    no_intraday_data_tickers.includes(ticker) || 
    isRecurringNoData ||
    intraday_priority_label === 'INTRADAY_UNKNOWN' || 
    intraday_confirmation_label === 'INTRADAY_UNKNOWN' || 
    intraday_unknown_tickers.includes(ticker) || 
    isRecurringUnknown;

  const hasIncompleteData = 
    data_quality === 'INCOMPLETE_INTRADAY' || 
    incomplete_intraday_tickers.includes(ticker) || 
    isRecurringIncomplete;

  // BLOCK_PRODUCTION_ENABLE: critical data-quality blocker (NO_INTRADAY_DATA, INTRADAY_UNKNOWN)
  if (hasDataQualityBlocker) {
    const isNoData = data_quality === 'NO_INTRADAY_DATA' || no_intraday_data_tickers.includes(ticker) || isRecurringNoData;
    return {
      ticker,
      decision: 'BLOCK_PRODUCTION_ENABLE',
      fallback_action: 'DAILY_SCORE_ONLY',
      ...POLICY_DECISIONS.BLOCK_PRODUCTION_ENABLE,
      reason_detail: isNoData ? `NO_INTRADAY_DATA (recurring: ${isRecurringNoData})` : `INTRADAY_UNKNOWN (recurring: ${isRecurringUnknown})`
    };
  }

  // EXCLUDE_INTRADAY_ADJUSTMENT: incomplete data but not critical blocker
  if (hasIncompleteData) {
    return {
      ticker,
      decision: 'EXCLUDE_INTRADAY_ADJUSTMENT',
      fallback_action: 'DAILY_SCORE_ONLY',
      ...POLICY_DECISIONS.EXCLUDE_INTRADAY_ADJUSTMENT,
      reason_detail: `INCOMPLETE_INTRADAY (recurring: ${isRecurringIncomplete})`
    };
  }

  // OK_FOR_INTRADAY_DRY_RUN: data quality is OK, no data-quality blockers
  // INTRADAY_CAUTION and INTRADAY_AVOID do NOT block this - only flags for WATCH_NEXT_SESSION
  if (data_quality === 'OK' || !data_quality) {
    // Check for warnings that don't block intraday but should be watched
    const hasCaution = intraday_confirmation_label === 'INTRADAY_CAUTION';
    const hasAvoid = intraday_priority_label === 'INTRADAY_AVOID' || intraday_confirmation_label === 'INTRADAY_AVOID';

    if (hasAvoid) {
      // AVOID doesn't block intraday, but flag for watching
      return {
        ticker,
        decision: 'WATCH_NEXT_SESSION',
        fallback_action: 'UNCHANGED', // Still OK for intraday - just watched
        ...POLICY_DECISIONS.WATCH_NEXT_SESSION,
        reason_detail: 'INTRADAY_AVOID label (data quality OK, but flagged for review)'
      };
    }

    if (hasCaution) {
      // CAUTION doesn't block intraday, but flag for watching
      return {
        ticker,
        decision: 'WATCH_NEXT_SESSION',
        fallback_action: 'UNCHANGED', // Still OK for intraday - just watched
        ...POLICY_DECISIONS.WATCH_NEXT_SESSION,
        reason_detail: 'INTRADAY_CAUTION label (data quality OK, but flagged for review)'
      };
    }

    // All good - OK for intraday dry-run
    return {
      ticker,
      decision: 'OK_FOR_INTRADAY_DRY_RUN',
      fallback_action: 'UNCHANGED',
      ...POLICY_DECISIONS.OK_FOR_INTRADAY_DRY_RUN,
      reason_detail: 'Data quality OK, no data-quality blockers'
    };
  }

  // Default: watch next session for unknown status
  return {
    ticker,
    decision: 'WATCH_NEXT_SESSION',
    fallback_action: 'UNCHANGED',
    ...POLICY_DECISIONS.WATCH_NEXT_SESSION,
    reason_detail: `Unhandled data_quality: ${data_quality}`
  };
}

/**
 * Build policy report from bundle and optional aggregate data
 */
function buildPolicyReport(bundle, aggregate) {
  const allTickers = new Set();

  // Collect all tickers from bundle
  if (bundle) {
    asArray(bundle.no_intraday_data_tickers).forEach(t => allTickers.add(t));
    asArray(bundle.incomplete_intraday_tickers).forEach(t => allTickers.add(t));
    asArray(bundle.intraday_unknown_tickers).forEach(t => allTickers.add(t));
    asArray(bundle.rows).forEach(r => allTickers.add(r.ticker));
  }

  // Add tickers from aggregate recurring lists
  if (aggregate) {
    asArray(aggregate.no_intraday_data_tickers).forEach(t => allTickers.add(typeof t === 'string' ? t : t.ticker));
    asArray(aggregate.incomplete_intraday_tickers).forEach(t => allTickers.add(typeof t === 'string' ? t : t.ticker));
    asArray(aggregate.intraday_unknown_tickers).forEach(t => allTickers.add(typeof t === 'string' ? t : t.ticker));
  }

  const policies = [];
  const decisionCounts = {};
  const tickersByDecision = {};
  const fallbackActionCounts = {};
  const tickersByFallbackAction = {};

  for (const ticker of allTickers) {
    const policy = decidePolicy(ticker, bundle, aggregate);
    policies.push(policy);

    // Primary decision
    inc(decisionCounts, policy.decision);
    if (!tickersByDecision[policy.decision]) tickersByDecision[policy.decision] = [];
    tickersByDecision[policy.decision].push(ticker);

    // Fallback action (scoring policy)
    const fallback = policy.fallback_action || 'UNCHANGED';
    inc(fallbackActionCounts, fallback);
    if (!tickersByFallbackAction[fallback]) tickersByFallbackAction[fallback] = [];
    tickersByFallbackAction[fallback].push(ticker);
  }

  // Get specific ticker lists
  const noDataTickers = asArray(bundle && bundle.no_intraday_data_tickers) || [];
  const incompleteTickers = asArray(bundle && bundle.incomplete_intraday_tickers) || [];
  const unknownTickers = asArray(bundle && bundle.intraday_unknown_tickers) || [];
  const okTickers = (tickersByDecision['OK_FOR_INTRADAY_DRY_RUN'] || []).slice();

  // Get recurring blockers from aggregate
  const recurringNoData = aggregate && aggregate.no_intraday_data_tickers ? 
    aggregate.no_intraday_data_tickers.map(t => typeof t === 'string' ? t : t.ticker) : [];
  const recurringIncomplete = aggregate && aggregate.incomplete_intraday_tickers ?
    aggregate.incomplete_intraday_tickers.map(t => typeof t === 'string' ? t : t.ticker) : [];
  const recurringUnknown = aggregate && aggregate.intraday_unknown_tickers ?
    aggregate.intraday_unknown_tickers.map(t => typeof t === 'string' ? t : t.ticker) : [];

  // Determine status based on rules
  let policy_status = 'PASS';
  let block_reasons = [];
  let warn_reasons = [];

  // BLOCK rules
  const hasBlockProduction = decisionCounts['BLOCK_PRODUCTION_ENABLE'] > 0;
  const aggregateStatus = (aggregate && aggregate.aggregate_status) || (bundle && bundle.validation_status);
  const hasRecurringNoData = recurringNoData.length > 0;
  const hasRecurringUnknown = recurringUnknown.length > 0;

  if (hasBlockProduction || aggregateStatus === 'BLOCK' || hasRecurringNoData || hasRecurringUnknown) {
    policy_status = 'BLOCK';
    if (hasBlockProduction) block_reasons.push('BLOCK_PRODUCTION_ENABLE ticker exists');
    if (aggregateStatus === 'BLOCK') block_reasons.push('aggregate_status is BLOCK');
    if (hasRecurringNoData) block_reasons.push('recurring NO_INTRADAY_DATA ticker exists');
    if (hasRecurringUnknown) block_reasons.push('recurring INTRADAY_UNKNOWN ticker exists');
  }
  // WARN rules
  else if (decisionCounts['EXCLUDE_INTRADAY_ADJUSTMENT'] > 0 || 
           decisionCounts['WATCH_NEXT_SESSION'] > 0 || 
           aggregateStatus === 'WARN') {
    policy_status = 'WARN';
    if (decisionCounts['EXCLUDE_INTRADAY_ADJUSTMENT'] > 0) warn_reasons.push('EXCLUDE_INTRADAY_ADJUSTMENT ticker exists');
    if (decisionCounts['WATCH_NEXT_SESSION'] > 0) warn_reasons.push('WATCH_NEXT_SESSION ticker exists');
    if (aggregateStatus === 'WARN') warn_reasons.push('aggregate_status is WARN');
  }
  // PASS rules
  else if (okTickers.length > 0) {
    policy_status = 'PASS';
  }

  // Generate recommendation
  let recommendation = '';
  if (policy_status === 'BLOCK') {
    recommendation = 'Do NOT enable production intraday scoring. Fix data-quality blockers first.';
  } else if (policy_status === 'WARN') {
    recommendation = 'Review EXCLUDE_INTRADAY_ADJUSTMENT and WATCH_NEXT_SESSION tickers before enabling production.';
  } else {
    recommendation = 'Data quality looks good. Eligible for intraday dry-run after final review.';
  }

  return {
    date: bundle && bundle.date || todayIso(),
    generated_at: new Date().toISOString(),
    policy_status,
    recommendation,
    total_tickers_evaluated: allTickers.size,
    decision_counts: decisionCounts,
    tickers_by_decision: tickersByDecision,
    fallback_action_counts: fallbackActionCounts,
    tickers_by_fallback_action: tickersByFallbackAction,
    recurring_blocker_tickers: {
      no_intraday_data: recurringNoData,
      incomplete_intraday: recurringIncomplete,
      intraday_unknown: recurringUnknown
    },
    no_intraday_data_tickers: noDataTickers,
    incomplete_intraday_tickers: incompleteTickers,
    intraday_unknown_tickers: unknownTickers,
    ok_for_intraday_dry_run_tickers: okTickers,
    has_aggregate: !!aggregate,
    block_reasons,
    warn_reasons,
    read_only_confirmation: 'This policy report only reads local validation bundle and aggregate JSON files and writes local report artifacts. It does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED, change production scoring defaults, change daytrade engine scoring, send Telegram, write Supabase, add API endpoints, add SQL/migrations, change Dashboard/UI, change cron, add AI, or commit generated reports.'
  };
}

/**
 * Format policy report as markdown
 */
function markdownReport(report) {
  const lines = [
    `# Day Trade Intraday Policy Report — ${report.date}`,
    '',
    `Generated at: ${report.generated_at}`,
    '',
    '## Policy Status',
    '',
    `- policy_status: **${report.policy_status}**`,
    `- recommendation: ${report.recommendation}`,
    `- total_tickers_evaluated: ${report.total_tickers_evaluated}`,
    ''
  ];

  if (report.block_reasons && report.block_reasons.length) {
    lines.push('### Block Reasons', '');
    report.block_reasons.forEach(r => lines.push(`- ${r}`));
    lines.push('');
  }

  if (report.warn_reasons && report.warn_reasons.length) {
    lines.push('### Warn Reasons', '');
    report.warn_reasons.forEach(r => lines.push(`- ${r}`));
    lines.push('');
  }

  lines.push('## Decision Counts', '');
  for (const [decision, count] of Object.entries(report.decision_counts || {})) {
    lines.push(`- ${decision}: ${count}`);
  }
  lines.push('');

  lines.push('## Fallback Action Counts (Scoring Policy)', '');
  for (const [fallback, count] of Object.entries(report.fallback_action_counts || {})) {
    lines.push(`- ${fallback}: ${count}`);
  }
  lines.push('');

  lines.push('## Tickers by Decision', '');
  for (const [decision, tickers] of Object.entries(report.tickers_by_decision || {})) {
    lines.push(`### ${decision}`, '');
    if (tickers && tickers.length) {
      lines.push(fmtList(tickers));
    } else {
      lines.push('none');
    }
    lines.push('');
  }

  lines.push('## Recurring Blocker Tickers', '');
  lines.push(`- no_intraday_data: ${fmtList(report.recurring_blocker_tickers?.no_intraday_data || [])}`);
  lines.push(`- incomplete_intraday: ${fmtList(report.recurring_blocker_tickers?.incomplete_intraday || [])}`);
  lines.push(`- intraday_unknown: ${fmtList(report.recurring_blocker_tickers?.intraday_unknown || [])}`);
  lines.push('');

  lines.push('## Data Quality Tickers', '');
  lines.push(`- no_intraday_data: ${fmtList(report.no_intraday_data_tickers || [])}`);
  lines.push(`- incomplete_intraday: ${fmtList(report.incomplete_intraday_tickers || [])}`);
  lines.push(`- intraday_unknown: ${fmtList(report.intraday_unknown_tickers || [])}`);
  lines.push('');

  lines.push('## OK for Intraday Dry-Run', '');
  lines.push(fmtList(report.ok_for_intraday_dry_run_tickers || []));
  lines.push('');

  lines.push('## DAILY_SCORE_ONLY (Fallback Action)', '');
  lines.push('Tickers with data-quality issues that should use daily score only:');
  lines.push(fmtList(report.tickers_by_fallback_action?.DAILY_SCORE_ONLY || []));
  lines.push('');

  lines.push('## Read-only Confirmation', '');
  lines.push(report.read_only_confirmation);

  return lines.join('\n');
}

/**
 * Get latest file matching prefix in reports directory
 * prefix: 'daytrade-intraday-validation-bundle-' or 'daytrade-intraday-validation-aggregate-'
 */
async function latestFile(reportsDir, prefix) {
  let names;
  try { names = await fs.readdir(reportsDir); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }

  const matches = names
    .filter(n => n.startsWith(prefix) && n.endsWith('.json'))
    .map(n => {
      // Extract date from filename like daytrade-intraday-validation-bundle-2026-07-08.json
      const m = n.match(/^daytrade-intraday-validation-(?:bundle|aggregate)-(\d{4}-\d{2}-\d{2})\.json$/);
      return m ? { name: n, date: m[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));

  return matches.length > 0 ? path.join(reportsDir, matches[0].name) : null;
}

/**
 * Get report date from filename
 */
function reportDate(report, file, prefix) {
  if (report && report.date) return report.date;
  const m = file && file.match(/(\d{4}-\d{2}-\d{2})\.json$/);
  return m ? m[1] : null;
}

/**
 * Load bundle and aggregate files
 */
async function loadInputs(opts) {
  const reportsDir = opts.reportsDir || DEFAULT_REPORTS_DIR;
  const bundleFile = opts.bundleFile;
  const aggregateFile = opts.aggregateFile;

  let bundle = null;
  let aggregate = null;

  // Load bundle
  if (bundleFile) {
    bundle = JSON.parse(await fs.readFile(bundleFile, 'utf8'));
  } else {
    const latestBundle = await latestFile(reportsDir, BUNDLE_PREFIX);
    if (latestBundle) {
      bundle = JSON.parse(await fs.readFile(latestBundle, 'utf8'));
      bundle._file = latestBundle;
    }
  }

  if (!bundle) {
    throw new Error('No validation bundle found. Run validation bundle first.');
  }

  // Load aggregate (optional)
  if (aggregateFile) {
    aggregate = JSON.parse(await fs.readFile(aggregateFile, 'utf8'));
  } else {
    const latestAggregate = await latestFile(reportsDir, AGGREGATE_PREFIX);
    if (latestAggregate) {
      aggregate = JSON.parse(await fs.readFile(latestAggregate, 'utf8'));
      aggregate._file = latestAggregate;
    }
  }

  return { bundle, aggregate };
}

/**
 * Write reports to disk
 */
async function writeReports(report, opts) {
  const dir = opts.reportsDir || DEFAULT_REPORTS_DIR;
  await fs.mkdir(dir, { recursive: true });

  const base = path.join(dir, POLICY_PREFIX + report.date);
  const markdownPath = base + '.md';
  await fs.writeFile(markdownPath, markdownReport(report));

  let jsonPath = null;
  if (opts.writeJson) {
    jsonPath = base + '.json';
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
  }

  return { markdown: markdownPath, json: jsonPath };
}

/**
 * Main run function
 */
async function run(opts) {
  const { bundle, aggregate } = await loadInputs(opts);
  const report = buildPolicyReport(bundle, aggregate);
  const paths = await writeReports(report, opts);
  return { report, paths };
}

// CLI argument parsing (also exported for testing)
function parseArgs(argv) {
  const args = {
    reportsDir: DEFAULT_REPORTS_DIR,
    bundleFile: null,
    aggregateFile: null,
    writeJson: false
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.writeJson = true;
    } else if (a === '--reports-dir' && argv[i + 1]) {
      args.reportsDir = argv[++i];
    } else if (a === '--bundle-file' && argv[i + 1]) {
      args.bundleFile = argv[++i];
    } else if (a === '--aggregate-file' && argv[i + 1]) {
      args.aggregateFile = argv[++i];
    }
  }

  return args;
}

module.exports = {
  DEFAULT_REPORTS_DIR,
  BUNDLE_PREFIX,
  AGGREGATE_PREFIX,
  POLICY_PREFIX,
  POLICY_DECISIONS,
  decidePolicy,
  buildPolicyReport,
  markdownReport,
  loadInputs,
  writeReports,
  run,
  latestFile,
  reportDate,
  parseArgs
};
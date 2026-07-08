'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const BUNDLE_PREFIX = 'daytrade-intraday-validation-bundle-';
const AGGREGATE_PREFIX = 'daytrade-intraday-validation-aggregate-';
const POLICY_PREFIX = 'daytrade-intraday-policy-';

const POLICY_DECISIONS = Object.freeze({
  BLOCK_PRODUCTION_ENABLE: {
    reason: 'Ticker has a critical intraday data-quality blocker; do not enable production intraday scoring.',
    scoring_impact: 'BLOCKED',
    watch: true
  },
  EXCLUDE_INTRADAY_ADJUSTMENT: {
    reason: 'Ticker has incomplete intraday data; exclude from intraday adjustment and keep daily score only.',
    scoring_impact: 'DAILY_ONLY',
    watch: true
  },
  DAILY_SCORE_ONLY: {
    reason: 'Intraday data is unavailable or incomplete; use daily score only.',
    scoring_impact: 'DAILY_ONLY',
    watch: true
  },
  WATCH_NEXT_SESSION: {
    reason: 'Ticker should be watched next session without changing the dry-run eligibility decision.',
    scoring_impact: 'UNCHANGED',
    watch: true
  },
  OK_FOR_INTRADAY_DRY_RUN: {
    reason: 'Ticker has acceptable intraday data quality and is eligible for intraday dry-run.',
    scoring_impact: 'UNCHANGED',
    watch: false
  }
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function inc(map, key, by) {
  if (!key) return;
  map[key] = (map[key] || 0) + (by == null ? 1 : by);
}

function todayIso(nowMs) {
  return new Date(nowMs || Date.now()).toISOString().slice(0, 10);
}

function normalizeTicker(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase().replace(/\.JK$/, '');
}

function normalizeTickerList(values) {
  const out = [];
  for (const item of asArray(values)) {
    const ticker = normalizeTicker(typeof item === 'string' ? item : item && item.ticker);
    if (ticker && !out.includes(ticker)) out.push(ticker);
  }
  return out;
}

function fmtList(values) {
  const tickers = normalizeTickerList(values);
  return tickers.length ? tickers.join(', ') : 'none';
}

function fmtObj(obj) {
  return '`' + JSON.stringify(obj || {}) + '`';
}

function getBundleRows(bundle) {
  if (!bundle) return [];
  const rows = [];
  for (const key of ['rows', 'top_candidates', 'candidates', 'intraday_rows', 'observations']) {
    for (const row of asArray(bundle[key])) {
      if (row && typeof row === 'object') rows.push(row);
    }
  }
  return rows;
}

function getRowTicker(row) {
  return normalizeTicker(row && (row.ticker || row.symbol || row.code));
}

function findRow(rows, ticker) {
  const normalized = normalizeTicker(ticker);
  return rows.find((row) => getRowTicker(row) === normalized) || null;
}

function aggregateRecurringTickers(aggregate, repeatedKey, fallbackKey) {
  if (!aggregate) return [];
  const primary = normalizeTickerList(aggregate[repeatedKey]);
  if (primary.length) return primary;
  return normalizeTickerList(aggregate[fallbackKey]);
}

function recurringListsFromAggregate(aggregate) {
  return {
    no_intraday_data: aggregateRecurringTickers(aggregate, 'repeated_no_intraday_data_tickers', 'no_intraday_data_tickers'),
    incomplete_intraday: aggregateRecurringTickers(aggregate, 'repeated_incomplete_intraday_tickers', 'incomplete_intraday_tickers'),
    intraday_unknown: aggregateRecurringTickers(aggregate, 'repeated_intraday_unknown_tickers', 'intraday_unknown_tickers')
  };
}

function bundleTickerLists(bundle) {
  return {
    no_intraday_data: normalizeTickerList(bundle && bundle.no_intraday_data_tickers),
    incomplete_intraday: normalizeTickerList(bundle && bundle.incomplete_intraday_tickers),
    intraday_unknown: normalizeTickerList(bundle && bundle.intraday_unknown_tickers)
  };
}

function rowPriorityLabel(row) {
  return row && (row.intraday_priority_label || row.priority_label || row.priority || row.intraday_priority) || '';
}

function rowConfirmationLabel(row) {
  return row && (row.intraday_confirmation_label || row.confirmation_label || row.confirmation || row.intraday_confirmation) || '';
}

function rowDataQuality(row) {
  return row && (row.data_quality || row.intraday_data_quality || row.quality) || '';
}

function collectTickers(bundle, aggregate) {
  const tickers = new Set();
  const bundleLists = bundleTickerLists(bundle);
  for (const list of Object.values(bundleLists)) {
    for (const ticker of list) tickers.add(ticker);
  }
  for (const row of getBundleRows(bundle)) {
    const ticker = getRowTicker(row);
    if (ticker) tickers.add(ticker);
  }
  const recurring = recurringListsFromAggregate(aggregate);
  for (const list of Object.values(recurring)) {
    for (const ticker of list) tickers.add(ticker);
  }
  return Array.from(tickers).sort();
}

function decidePolicy(ticker, bundleData, aggregateData) {
  const normalizedTicker = normalizeTicker(ticker);
  const rows = getBundleRows(bundleData);
  const row = findRow(rows, normalizedTicker);
  const bundleLists = bundleTickerLists(bundleData);
  const recurring = recurringListsFromAggregate(aggregateData);
  const dataQuality = String(rowDataQuality(row) || (bundleData && bundleData.data_quality) || '').toUpperCase();
  const priorityLabel = String(rowPriorityLabel(row) || (bundleData && bundleData.intraday_priority_label) || '').toUpperCase();
  const confirmationLabel = String(rowConfirmationLabel(row) || (bundleData && bundleData.intraday_confirmation_label) || '').toUpperCase();

  const hasNoData = dataQuality === 'NO_INTRADAY_DATA' || bundleLists.no_intraday_data.includes(normalizedTicker) || recurring.no_intraday_data.includes(normalizedTicker);
  const hasUnknown = priorityLabel === 'INTRADAY_UNKNOWN' || confirmationLabel === 'INTRADAY_UNKNOWN' || bundleLists.intraday_unknown.includes(normalizedTicker) || recurring.intraday_unknown.includes(normalizedTicker);
  const hasIncomplete = dataQuality === 'INCOMPLETE_INTRADAY' || bundleLists.incomplete_intraday.includes(normalizedTicker) || recurring.incomplete_intraday.includes(normalizedTicker);

  if (hasNoData || hasUnknown) {
    const reasonDetail = hasNoData
      ? `NO_INTRADAY_DATA (recurring: ${recurring.no_intraday_data.includes(normalizedTicker)})`
      : `INTRADAY_UNKNOWN (recurring: ${recurring.intraday_unknown.includes(normalizedTicker)})`;
    return {
      ticker: normalizedTicker,
      decision: 'BLOCK_PRODUCTION_ENABLE',
      fallback_action: 'DAILY_SCORE_ONLY',
      watch_next_session: true,
      watch_reason: reasonDetail,
      data_quality: dataQuality || 'UNKNOWN',
      priority_label: priorityLabel || null,
      confirmation_label: confirmationLabel || null,
      ...POLICY_DECISIONS.BLOCK_PRODUCTION_ENABLE,
      reason_detail: reasonDetail
    };
  }

  if (hasIncomplete) {
    const reasonDetail = `INCOMPLETE_INTRADAY (recurring: ${recurring.incomplete_intraday.includes(normalizedTicker)})`;
    return {
      ticker: normalizedTicker,
      decision: 'EXCLUDE_INTRADAY_ADJUSTMENT',
      fallback_action: 'DAILY_SCORE_ONLY',
      watch_next_session: true,
      watch_reason: reasonDetail,
      data_quality: dataQuality || 'UNKNOWN',
      priority_label: priorityLabel || null,
      confirmation_label: confirmationLabel || null,
      ...POLICY_DECISIONS.EXCLUDE_INTRADAY_ADJUSTMENT,
      reason_detail: reasonDetail
    };
  }

  const hasCaution = confirmationLabel === 'INTRADAY_CAUTION';
  const hasAvoid = priorityLabel === 'INTRADAY_AVOID' || confirmationLabel === 'INTRADAY_AVOID';
  const watchReason = hasAvoid
    ? 'INTRADAY_AVOID label with OK data quality'
    : hasCaution
      ? 'INTRADAY_CAUTION label with OK data quality'
      : null;

  if (dataQuality === 'OK' || !dataQuality) {
    return {
      ticker: normalizedTicker,
      decision: 'OK_FOR_INTRADAY_DRY_RUN',
      fallback_action: 'UNCHANGED',
      watch_next_session: Boolean(watchReason),
      watch_reason: watchReason,
      data_quality: dataQuality || 'OK',
      priority_label: priorityLabel || null,
      confirmation_label: confirmationLabel || null,
      ...POLICY_DECISIONS.OK_FOR_INTRADAY_DRY_RUN,
      reason_detail: watchReason || 'Data quality OK, no recurring aggregate blocker'
    };
  }

  return {
    ticker: normalizedTicker,
    decision: 'WATCH_NEXT_SESSION',
    fallback_action: 'UNCHANGED',
    watch_next_session: true,
    watch_reason: `Unhandled data_quality: ${dataQuality}`,
    data_quality: dataQuality || 'UNKNOWN',
    priority_label: priorityLabel || null,
    confirmation_label: confirmationLabel || null,
    ...POLICY_DECISIONS.WATCH_NEXT_SESSION,
    reason_detail: `Unhandled data_quality: ${dataQuality}`
  };
}

function buildPolicyReport(bundle, aggregate, opts) {
  const tickers = collectTickers(bundle, aggregate);
  const recurring = recurringListsFromAggregate(aggregate);
  const bundleLists = bundleTickerLists(bundle);
  const policies = [];
  const decisionCounts = {};
  const tickersByDecision = {};
  const fallbackActionCounts = {};
  const tickersByFallbackAction = {};
  const watchNextSessionTickers = [];
  const watchReasons = {};

  for (const ticker of tickers) {
    const policy = decidePolicy(ticker, bundle, aggregate);
    policies.push(policy);
    inc(decisionCounts, policy.decision);
    if (!tickersByDecision[policy.decision]) tickersByDecision[policy.decision] = [];
    tickersByDecision[policy.decision].push(policy.ticker);

    const fallback = policy.fallback_action || 'UNCHANGED';
    inc(fallbackActionCounts, fallback);
    if (!tickersByFallbackAction[fallback]) tickersByFallbackAction[fallback] = [];
    tickersByFallbackAction[fallback].push(policy.ticker);

    if (policy.watch_next_session) {
      watchNextSessionTickers.push(policy.ticker);
      watchReasons[policy.ticker] = policy.watch_reason || policy.reason_detail || 'watch next session';
    }
  }

  const aggregateStatus = aggregate && aggregate.aggregate_status || bundle && bundle.validation_status || null;
  const okTickers = (tickersByDecision.OK_FOR_INTRADAY_DRY_RUN || []).slice().sort();
  const hasBlockProduction = numberOrZero(decisionCounts.BLOCK_PRODUCTION_ENABLE) > 0;
  const hasExclude = numberOrZero(decisionCounts.EXCLUDE_INTRADAY_ADJUSTMENT) > 0;
  const hasWatch = watchNextSessionTickers.length > 0;
  const hasRecurringNoData = recurring.no_intraday_data.length > 0;
  const hasRecurringUnknown = recurring.intraday_unknown.length > 0;

  const blockReasons = [];
  const warnReasons = [];
  let policyStatus = 'PASS';

  if (hasBlockProduction || aggregateStatus === 'BLOCK' || hasRecurringNoData || hasRecurringUnknown) {
    policyStatus = 'BLOCK';
    if (hasBlockProduction) blockReasons.push('BLOCK_PRODUCTION_ENABLE ticker exists');
    if (aggregateStatus === 'BLOCK') blockReasons.push('aggregate_status is BLOCK');
    if (hasRecurringNoData) blockReasons.push('recurring NO_INTRADAY_DATA ticker exists');
    if (hasRecurringUnknown) blockReasons.push('recurring INTRADAY_UNKNOWN ticker exists');
  } else if (hasExclude || hasWatch || aggregateStatus === 'WARN') {
    policyStatus = 'WARN';
    if (hasExclude) warnReasons.push('EXCLUDE_INTRADAY_ADJUSTMENT ticker exists');
    if (hasWatch) warnReasons.push('watch_next_session_tickers exists');
    if (aggregateStatus === 'WARN') warnReasons.push('aggregate_status is WARN');
  } else if (!okTickers.length) {
    policyStatus = 'WARN';
    warnReasons.push('no OK_FOR_INTRADAY_DRY_RUN ticker exists');
  }

  const recommendation = policyStatus === 'BLOCK'
    ? 'Do NOT enable production intraday scoring. Resolve data-quality or recurring aggregate blockers first.'
    : policyStatus === 'WARN'
      ? 'Review exclude/watch tickers before considering a production dry-run. Keep production scoring defaults unchanged.'
      : 'Data-quality policy is clean for dry-run review. Keep production scoring defaults unchanged until separately approved.';

  return {
    date: bundle && bundle.date || aggregate && aggregate.date || todayIso(opts && opts.nowMs),
    generated_at: new Date(opts && opts.nowMs || Date.now()).toISOString(),
    policy_status: policyStatus,
    recommendation,
    total_tickers_evaluated: tickers.length,
    decision_counts: decisionCounts,
    tickers_by_decision: tickersByDecision,
    fallback_action_counts: fallbackActionCounts,
    tickers_by_fallback_action: tickersByFallbackAction,
    watch_next_session_tickers: Array.from(new Set(watchNextSessionTickers)).sort(),
    watch_reasons: watchReasons,
    recurring_blocker_tickers: recurring,
    no_intraday_data_tickers: bundleLists.no_intraday_data,
    incomplete_intraday_tickers: bundleLists.incomplete_intraday,
    intraday_unknown_tickers: bundleLists.intraday_unknown,
    ok_for_intraday_dry_run_tickers: okTickers,
    policies,
    has_aggregate: Boolean(aggregate),
    aggregate_status: aggregateStatus,
    block_reasons: blockReasons,
    warn_reasons: warnReasons,
    read_only_confirmation: 'This policy report only reads local validation bundle and aggregate JSON files and writes local report artifacts. It does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED, change production scoring defaults, change daytrade engine scoring, send Telegram, write Supabase, add API endpoints, add SQL/migrations, change Dashboard/UI, change cron, add AI, or commit generated reports.'
  };
}

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
    `- aggregate_status: ${report.aggregate_status || 'n/a'}`,
    ''
  ];

  if (report.block_reasons && report.block_reasons.length) {
    lines.push('### Block Reasons', '');
    for (const reason of report.block_reasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  if (report.warn_reasons && report.warn_reasons.length) {
    lines.push('### Warn Reasons', '');
    for (const reason of report.warn_reasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  lines.push('## Decision Counts', '');
  lines.push(`- counts: ${fmtObj(report.decision_counts)}`);
  lines.push('');

  lines.push('## Fallback Action Counts (Scoring Policy)', '');
  lines.push(`- counts: ${fmtObj(report.fallback_action_counts)}`);
  lines.push('');

  lines.push('## Tickers by Decision', '');
  for (const [decision, values] of Object.entries(report.tickers_by_decision || {})) {
    lines.push(`- ${decision}: ${fmtList(values)}`);
  }
  if (!Object.keys(report.tickers_by_decision || {}).length) lines.push('- none');
  lines.push('');

  lines.push('## Watch Next Session Tickers', '');
  lines.push(fmtList(report.watch_next_session_tickers || []));
  const watchReasons = report.watch_reasons || {};
  for (const ticker of report.watch_next_session_tickers || []) {
    if (watchReasons[ticker]) lines.push(`- ${ticker}: ${watchReasons[ticker]}`);
  }
  lines.push('');

  lines.push('## Recurring Blocker Tickers', '');
  lines.push(`- no_intraday_data: ${fmtList(report.recurring_blocker_tickers && report.recurring_blocker_tickers.no_intraday_data || [])}`);
  lines.push(`- incomplete_intraday: ${fmtList(report.recurring_blocker_tickers && report.recurring_blocker_tickers.incomplete_intraday || [])}`);
  lines.push(`- intraday_unknown: ${fmtList(report.recurring_blocker_tickers && report.recurring_blocker_tickers.intraday_unknown || [])}`);
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
  lines.push(fmtList(report.tickers_by_fallback_action && report.tickers_by_fallback_action.DAILY_SCORE_ONLY || []));
  lines.push('');

  lines.push('## Read-only Confirmation', '');
  lines.push(report.read_only_confirmation);
  lines.push('');

  return lines.join('\n');
}

async function latestFile(reportsDir, prefix) {
  let names;
  try {
    names = await fs.readdir(reportsDir);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const matches = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const m = name.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      return m ? { name, date: m[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
  return matches.length ? path.join(reportsDir, matches[0].name) : null;
}

function reportDate(report, file) {
  if (report && report.date) return report.date;
  const m = file && String(file).match(/(\d{4}-\d{2}-\d{2})\.json$/);
  return m ? m[1] : null;
}

async function loadInputs(opts) {
  const options = opts || {};
  const reportsDir = options.reportsDir || DEFAULT_REPORTS_DIR;
  let bundle = null;
  let aggregate = null;

  if (options.bundleFile) {
    bundle = JSON.parse(await fs.readFile(options.bundleFile, 'utf8'));
    bundle._file = options.bundleFile;
  } else {
    const latestBundle = await latestFile(reportsDir, BUNDLE_PREFIX);
    if (latestBundle) {
      bundle = JSON.parse(await fs.readFile(latestBundle, 'utf8'));
      bundle._file = latestBundle;
    }
  }

  if (!bundle) throw new Error('No validation bundle found. Run validation bundle first.');

  if (options.aggregateFile) {
    aggregate = JSON.parse(await fs.readFile(options.aggregateFile, 'utf8'));
    aggregate._file = options.aggregateFile;
  } else {
    const latestAggregate = await latestFile(reportsDir, AGGREGATE_PREFIX);
    if (latestAggregate) {
      aggregate = JSON.parse(await fs.readFile(latestAggregate, 'utf8'));
      aggregate._file = latestAggregate;
    }
  }

  return { bundle, aggregate };
}

async function writeReports(report, opts) {
  const options = opts || {};
  const dir = options.reportsDir || DEFAULT_REPORTS_DIR;
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, POLICY_PREFIX + report.date);
  const paths = { markdown: base + '.md' };
  await fs.writeFile(paths.markdown, markdownReport(report));
  if (options.writeJson) {
    paths.json = base + '.json';
    await fs.writeFile(paths.json, JSON.stringify(report, null, 2) + '\n');
  }
  return paths;
}

async function run(opts) {
  const { bundle, aggregate } = await loadInputs(opts || {});
  const report = buildPolicyReport(bundle, aggregate);
  const paths = await writeReports(report, opts || {});
  return { report, paths };
}

function parseArgs(argv) {
  const args = {
    reportsDir: DEFAULT_REPORTS_DIR,
    bundleFile: null,
    aggregateFile: null,
    writeJson: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a === '--reports-dir' && argv[i + 1]) args.reportsDir = argv[++i];
    else if (a === '--bundle-file' && argv[i + 1]) args.bundleFile = argv[++i];
    else if (a === '--aggregate-file' && argv[i + 1]) args.aggregateFile = argv[++i];
  }
  return args;
}

module.exports = {
  DEFAULT_REPORTS_DIR,
  BUNDLE_PREFIX,
  AGGREGATE_PREFIX,
  POLICY_PREFIX,
  POLICY_DECISIONS,
  asArray,
  normalizeTicker,
  normalizeTickerList,
  recurringListsFromAggregate,
  decidePolicy,
  buildPolicyReport,
  markdownReport,
  latestFile,
  reportDate,
  loadInputs,
  writeReports,
  run,
  parseArgs
};

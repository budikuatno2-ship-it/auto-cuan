'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const BUNDLE_PREFIX = 'daytrade-intraday-validation-bundle-';
const AGGREGATE_PREFIX = 'daytrade-intraday-validation-aggregate-';
const POLICY_PREFIX = 'daytrade-intraday-policy-';
const PROVIDER_CACHE_QUALITY_PREFIX = 'daytrade-intraday-provider-cache-quality-';

function asArray(v) { return Array.isArray(v) ? v : []; }
function numberOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function inc(map, key, by) { if (!key) return; map[key] = (map[key] || 0) + (by == null ? 1 : by); }
function fmtObj(obj) { return '`' + JSON.stringify(obj || {}) + '`'; }
function fmtList(values) { const arr = asArray(values).map(formatSummaryItem).filter(Boolean); return arr.length ? arr.join(', ') : 'none'; }
function formatSummaryItem(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    const value = item.ticker || item.key || item.value;
    const count = item.count;
    if (value && count != null) return `${value} (${count})`;
    if (value) return String(value);
  }
  return String(item);
}
function todayIso(nowMs) { return new Date(nowMs || Date.now()).toISOString().slice(0, 10); }
function bundleCandidateCount(bundle) {
  if (!bundle) return 0;
  if (Array.isArray(bundle.rows)) return new Set(bundle.rows.map((r) => String(r && r.ticker || '').trim().toUpperCase()).filter(Boolean)).size;
  return numberOrZero(bundle.intraday_candidates_count);
}

function quarantineTickers(report) { return new Set(asArray(report && report.intraday_quarantine_tickers).map((r) => String(r && (r.ticker || r)).trim().toUpperCase()).filter(Boolean)); }
function providerCacheQualityIsCleanQuarantine(report) {
  return !!report
    && report.quality_status === 'PASS_WITH_QUARANTINE'
    && numberOrZero(report.non_quarantined_provider_missing_count) === 0
    && numberOrZero(report.non_quarantined_incomplete_intraday_count) === 0
    && numberOrZero(report.non_quarantined_intraday_unknown_count) === 0;
}
function providerCacheQualityQuarantineSummary(report) {
  if (!report) return null;
  const totalProviderMissing = numberOrZero(report.total_provider_missing_count ?? report.provider_missing_count);
  const quarantinedProviderMissing = numberOrZero(report.quarantined_provider_missing_count);
  return {
    provider_cache_quality_status: report.quality_status || null,
    intraday_quarantine_count: numberOrZero(report.intraday_quarantine_count),
    intraday_quarantine_tickers: asArray(report.intraday_quarantine_tickers),
    total_provider_missing_count: totalProviderMissing,
    visible_provider_missing_count: numberOrZero(report.visible_provider_missing_count),
    quarantined_provider_missing_count: quarantinedProviderMissing,
    non_quarantined_provider_missing_count: numberOrZero(report.non_quarantined_provider_missing_count ?? (totalProviderMissing - quarantinedProviderMissing)),
    non_quarantined_incomplete_intraday_count: numberOrZero(report.non_quarantined_incomplete_intraday_count ?? report.incomplete_intraday_count),
    non_quarantined_intraday_unknown_count: numberOrZero(report.non_quarantined_intraday_unknown_count ?? report.intraday_unknown_count)
  };
}
function nonQuarantinedItems(items, quarantinedTickers) {
  return asArray(items).filter((item) => {
    const ticker = String(item && (item.ticker || item.key || item.value || item) || '').trim().toUpperCase();
    return ticker && !quarantinedTickers.has(ticker);
  });
}
function nonQuarantinedCount(report, field, fallback) {
  const direct = report && report[field];
  if (direct != null) return numberOrZero(direct);
  return numberOrZero(fallback);
}

function policyCoverage(policy, bundle) {
  const bundleCount = bundleCandidateCount(bundle);
  const evaluated = policy ? numberOrZero(policy.policy_evaluated_count ?? policy.total_tickers_evaluated) : 0;
  const status = policy && policy.coverage_status || (bundleCount && evaluated < bundleCount ? 'INCOMPLETE' : 'OK');
  return { bundle_candidate_count: bundleCount, policy_evaluated_count: evaluated, coverage_status: status };
}

async function latestFile(reportsDir, prefix) {
  let names;
  try { names = await fs.readdir(reportsDir); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
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
  const reportsDir = opts && opts.reportsDir || DEFAULT_REPORTS_DIR;
  let bundle = null;
  let aggregate = null;
  let policy = null;
  let providerCacheQuality = null;

  // Load bundle
  if (opts.bundleFile) {
    bundle = JSON.parse(await fs.readFile(opts.bundleFile, 'utf8'));
    bundle._file = opts.bundleFile;
  } else {
    const latestBundle = await latestFile(reportsDir, BUNDLE_PREFIX);
    if (latestBundle) {
      bundle = JSON.parse(await fs.readFile(latestBundle, 'utf8'));
      bundle._file = latestBundle;
    }
  }

  // Load aggregate (optional)
  if (opts.aggregateFile) {
    aggregate = JSON.parse(await fs.readFile(opts.aggregateFile, 'utf8'));
    aggregate._file = opts.aggregateFile;
  } else {
    const latestAggregate = await latestFile(reportsDir, AGGREGATE_PREFIX);
    if (latestAggregate) {
      aggregate = JSON.parse(await fs.readFile(latestAggregate, 'utf8'));
      aggregate._file = latestAggregate;
    }
  }

  // Load provider/cache quality (optional)
  if (opts.providerCacheQualityFile) {
    providerCacheQuality = JSON.parse(await fs.readFile(opts.providerCacheQualityFile, 'utf8'));
    providerCacheQuality._file = opts.providerCacheQualityFile;
  } else {
    const latestProviderCacheQuality = await latestFile(reportsDir, PROVIDER_CACHE_QUALITY_PREFIX);
    if (latestProviderCacheQuality) {
      providerCacheQuality = JSON.parse(await fs.readFile(latestProviderCacheQuality, 'utf8'));
      providerCacheQuality._file = latestProviderCacheQuality;
    }
  }

  // Load policy (required)
  if (opts.policyFile) {
    policy = JSON.parse(await fs.readFile(opts.policyFile, 'utf8'));
    policy._file = opts.policyFile;
  } else {
    const latestPolicy = await latestFile(reportsDir, POLICY_PREFIX);
    if (latestPolicy) {
      policy = JSON.parse(await fs.readFile(latestPolicy, 'utf8'));
      policy._file = latestPolicy;
    }
  }

  return { bundle, aggregate, policy, providerCacheQuality };
}

function checkDateAlignment(bundle, aggregate, policy, providerCacheQuality) {
  const dates = [];
  if (bundle) dates.push({ name: 'bundle', date: reportDate(bundle, bundle._file) });
  if (aggregate) dates.push({ name: 'aggregate', date: reportDate(aggregate, aggregate._file) });
  if (policy) dates.push({ name: 'policy', date: reportDate(policy, policy._file) });
  if (providerCacheQuality) dates.push({ name: 'provider_cache_quality', date: reportDate(providerCacheQuality, providerCacheQuality._file) });

  const uniqueDates = [...new Set(dates.map(d => d.date).filter(Boolean))];
  const aligned = uniqueDates.length <= 1;
  const alignedDate = uniqueDates[0] || todayIso();

  return { aligned, date: alignedDate, dates, uniqueDates };
}

function evaluateGate(bundle, aggregate, policy, dateAlignment, providerCacheQuality) {
  const quarantineSummary = providerCacheQualityQuarantineSummary(providerCacheQuality);
  const qualityAllowsQuarantinePass = providerCacheQualityIsCleanQuarantine(providerCacheQuality);

  const blockReasons = [];
  const warnReasons = [];
  const legacyStatusReasons = [];

  // Missing file checks
  if (!policy) {
    blockReasons.push('policy file missing');
  }
  if (!bundle) {
    blockReasons.push('bundle file missing');
  }

  // Date alignment check
  if (!dateAlignment.aligned) {
    blockReasons.push(`report date mismatch: ${dateAlignment.uniqueDates.join(' vs ')}`);
  }

  // If we have BLOCK already, skip detailed checks
  if (blockReasons.length > 0) {
    return { blockReasons, warnReasons, legacyStatusReasons, gateStatus: 'BLOCK' };
  }

  const coverage = policyCoverage(policy, bundle);
  if (policy && (coverage.coverage_status === 'INCOMPLETE' || coverage.policy_evaluated_count < coverage.bundle_candidate_count)) {
    blockReasons.push(`policy coverage incomplete: evaluated ${coverage.policy_evaluated_count}/${coverage.bundle_candidate_count} candidates`);
  }

  // Legacy component status BLOCK values may be caused by quarantined provider/cache
  // blockers that the provider/cache quality report has already isolated. Preserve
  // these legacy statuses without letting them block dry-run/reporting when the
  // quarantine report proves all non-quarantined provider/cache blocker counts
  // are zero.
  function addLegacyStatusReason(reason) {
    if (qualityAllowsQuarantinePass) {
      legacyStatusReasons.push(reason);
      warnReasons.push(`legacy status retained for visibility; quarantine explains provider/cache blockers: ${reason}`);
    } else {
      blockReasons.push(reason);
    }
  }

  // Bundle validation_status BLOCK
  if (bundle && bundle.validation_status === 'BLOCK') {
    addLegacyStatusReason('validation bundle validation_status is BLOCK');
  }

  // Aggregate aggregate_status BLOCK
  if (aggregate && aggregate.aggregate_status === 'BLOCK') {
    addLegacyStatusReason('aggregate aggregate_status is BLOCK');
  }

  // Policy policy_status BLOCK
  if (policy && policy.policy_status === 'BLOCK') {
    addLegacyStatusReason('policy policy_status is BLOCK');
  }

  const qTickers = quarantineTickers(providerCacheQuality || bundle);
  const hasQuarantine = qTickers.size > 0;

  // Provider metrics from bundle (latest sample)
  if (bundle) {
    const nonQProviderMissing = quarantineSummary ? quarantineSummary.non_quarantined_provider_missing_count : nonQuarantinedCount(bundle, 'non_quarantined_provider_missing_count', bundle.provider_missing_count);
    if (nonQProviderMissing > 0) {
      blockReasons.push(`non_quarantined_provider_missing_count (${nonQProviderMissing}) > 0`);
    }
    if (numberOrZero(bundle.provider_matched_count) < 10) {
      blockReasons.push(`provider_matched_count (${bundle.provider_matched_count}) < 10`);
    }
  }

  // Data quality counts from bundle
  if (bundle && bundle.data_quality_counts) {
    const dq = bundle.data_quality_counts;
    const nonQNoData = quarantineSummary ? quarantineSummary.non_quarantined_provider_missing_count : nonQuarantinedCount(bundle, 'non_quarantined_provider_missing_count', dq.NO_INTRADAY_DATA);
    const nonQIncomplete = quarantineSummary ? quarantineSummary.non_quarantined_incomplete_intraday_count : nonQuarantinedCount(bundle, 'non_quarantined_incomplete_intraday_count', dq.INCOMPLETE_INTRADAY);
    if (nonQNoData > 0) {
      blockReasons.push(`data_quality_counts.NO_INTRADAY_DATA non-quarantined (${nonQNoData}) > 0`);
    }
    if (nonQIncomplete > 0) {
      blockReasons.push(`data_quality_counts.INCOMPLETE_INTRADAY non-quarantined (${nonQIncomplete}) > 0`);
    }
  }

  // Priority label counts from bundle
  if (bundle && bundle.priority_label_counts) {
    const nonQUnknown = quarantineSummary ? quarantineSummary.non_quarantined_intraday_unknown_count : nonQuarantinedCount(bundle, 'non_quarantined_intraday_unknown_count', bundle.priority_label_counts.INTRADAY_UNKNOWN);
    if (nonQUnknown > 0) {
      blockReasons.push(`priority_label_counts.INTRADAY_UNKNOWN non-quarantined (${nonQUnknown}) > 0`);
    }
  }

  // Confirmation label counts from bundle
  if (bundle && bundle.confirmation_label_counts) {
    const nonQUnknown = quarantineSummary ? quarantineSummary.non_quarantined_intraday_unknown_count : nonQuarantinedCount(bundle, 'non_quarantined_intraday_unknown_count', bundle.confirmation_label_counts.INTRADAY_UNKNOWN);
    if (nonQUnknown > 0) {
      blockReasons.push(`confirmation_label_counts.INTRADAY_UNKNOWN non-quarantined (${nonQUnknown}) > 0`);
    }
  }

  // Policy decision_counts
  if (policy) {
    if (numberOrZero(policy.decision_counts && policy.decision_counts.BLOCK_PRODUCTION_ENABLE) > 0) {
      blockReasons.push('policy decision_counts.BLOCK_PRODUCTION_ENABLE > 0');
    }
    const fallbackCount = numberOrZero(policy.fallback_action_counts && policy.fallback_action_counts.DAILY_SCORE_ONLY);
    if (fallbackCount > qTickers.size) {
      blockReasons.push('policy fallback_action_counts.DAILY_SCORE_ONLY non-quarantined > 0');
      blockReasons.push('policy fallback_action_counts.DAILY_SCORE_ONLY > 0');
    }
  }

  // Recurring blockers from aggregate
  if (aggregate) {
    const recurring = nonQuarantinedItems(aggregate.repeated_no_intraday_data_tickers || [], qualityAllowsQuarantinePass ? qTickers : new Set());
    if (asArray(recurring).length > 0) {
      blockReasons.push('recurring no_intraday_data exists in aggregate');
    }
    const recurringUnknown = nonQuarantinedItems(aggregate.repeated_intraday_unknown_tickers || [], qualityAllowsQuarantinePass ? qTickers : new Set());
    if (asArray(recurringUnknown).length > 0) {
      blockReasons.push('recurring intraday_unknown exists in aggregate');
    }
    const recurringIncomplete = nonQuarantinedItems(aggregate.repeated_incomplete_intraday_tickers || [], qualityAllowsQuarantinePass ? qTickers : new Set());
    if (asArray(recurringIncomplete).length > 0) {
      blockReasons.push('recurring incomplete_intraday exists in aggregate');
    }
  }

  if (hasQuarantine || qualityAllowsQuarantinePass) warnReasons.push('PASS_WITH_QUARANTINE for dry-run/reporting only; quarantined tickers remain DAILY_SCORE_ONLY and production flag stays off');

  // If BLOCK, return early
  if (blockReasons.length > 0) {
    return { blockReasons, warnReasons, legacyStatusReasons, gateStatus: 'BLOCK' };
  }

  // WARN checks (only if no BLOCK)
  // Aggregate missing
  if (!aggregate) {
    warnReasons.push('aggregate file missing');
  }

  // Aggregate aggregate_status WARN
  if (aggregate && aggregate.aggregate_status === 'WARN') {
    warnReasons.push('aggregate aggregate_status is WARN');
  }

  // Policy policy_status WARN
  if (policy && policy.policy_status === 'WARN') {
    warnReasons.push('policy policy_status is WARN');
  }

  // Policy decision_counts EXCLUDE_INTRADAY_ADJUSTMENT
  if (policy && numberOrZero(policy.decision_counts && policy.decision_counts.EXCLUDE_INTRADAY_ADJUSTMENT) > 0) {
    warnReasons.push('policy decision_counts.EXCLUDE_INTRADAY_ADJUSTMENT > 0');
  }

  // Policy watch_next_session_tickers
  if (policy && asArray(policy.watch_next_session_tickers).length > 0) {
    warnReasons.push(`policy watch_next_session_tickers length (${policy.watch_next_session_tickers.length}) > 0`);
  }

  // Aggregate top5_churn_ratio
  if (aggregate && aggregate.metrics && numberOrZero(aggregate.metrics.top5_churn_ratio) >= 0.5) {
    warnReasons.push(`aggregate top5_churn_ratio (${aggregate.metrics.top5_churn_ratio}) >= 0.5`);
  }

  // Aggregate avg_absolute_score_delta
  if (aggregate && aggregate.metrics && numberOrZero(aggregate.metrics.avg_absolute_score_delta) > 5) {
    warnReasons.push(`aggregate avg_absolute_score_delta (${aggregate.metrics.avg_absolute_score_delta}) > 5`);
  }

  // Aggregate sample_count
  if (aggregate && numberOrZero(aggregate.sample_count) < 5) {
    warnReasons.push(`aggregate sample_count (${aggregate.sample_count}) < 5`);
  }

  // If WARN, return
  if (warnReasons.length > 0) {
    return { blockReasons, warnReasons, legacyStatusReasons, gateStatus: hasQuarantine && blockReasons.length === 0 ? 'PASS_WITH_QUARANTINE' : 'WARN' };
  }

  // PASS checks
  // Must have at least one OK_FOR_INTRADAY_DRY_RUN ticker
  const okTickers = policy && policy.ok_for_intraday_dry_run_tickers || [];
  if (asArray(okTickers).length === 0) {
    warnReasons.push('no OK_FOR_INTRADAY_DRY_RUN ticker in policy');
    return { blockReasons, warnReasons, legacyStatusReasons, gateStatus: hasQuarantine && blockReasons.length === 0 ? 'PASS_WITH_QUARANTINE' : 'WARN' };
  }

  // provider_matched_count >= 10 (already checked above for < 10)
  // provider_missing_count === 0 (already checked above for > 0)

  // All PASS conditions met
  return { blockReasons, warnReasons, legacyStatusReasons, gateStatus: 'PASS' };
}

function recommendationForStatus(status) {
  switch (status) {
    case 'BLOCK':
      return 'Do NOT enable production intraday scoring. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off.';
    case 'WARN':
      return 'Dry-run gate has warnings. Keep production flag off and review before staged enable.';
    case 'PASS_WITH_QUARANTINE':
      return 'Dry-run/reporting can proceed with explicit quarantine. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off; quarantined tickers are DAILY_SCORE_ONLY and this is not production enablement.';
    case 'PASS':
      return 'Dry-run gate passed. Production flag must still remain off until a separate staged enable PR is approved.';
    default:
      return 'Unknown gate status.';
  }
}

function buildGateReport(bundle, aggregate, policy, opts) {
  const providerCacheQuality = opts && opts.providerCacheQuality;
  const dateAlignment = checkDateAlignment(bundle, aggregate, policy, providerCacheQuality);
  const { blockReasons, warnReasons, legacyStatusReasons, gateStatus } = evaluateGate(bundle, aggregate, policy, dateAlignment, providerCacheQuality);
  const recommendation = recommendationForStatus(gateStatus);

  const providerMatchedCount = bundle ? numberOrZero(bundle.provider_matched_count) : 0;
  const providerMissingCount = bundle ? numberOrZero(bundle.provider_missing_count) : 0;

  const dataQualityCounts = bundle ? bundle.data_quality_counts || {} : {};
  const priorityLabelCounts = bundle ? bundle.priority_label_counts || {} : {};
  const confirmationLabelCounts = bundle ? bundle.confirmation_label_counts || {} : {};

  const coverage = policyCoverage(policy, bundle);
  const policyDecisionCounts = policy ? policy.decision_counts || {} : {};
  const policyFallbackCounts = policy ? policy.fallback_action_counts || {} : {};

  const watchNextSessionTickers = policy ? policy.watch_next_session_tickers || [] : [];
  const okForIntradayDryRunTickers = policy ? policy.ok_for_intraday_dry_run_tickers || [] : [];

  const quarantineSummary = providerCacheQualityQuarantineSummary(providerCacheQuality);

  const recurringBlockerSummary = aggregate ? {
    no_intraday_data: aggregate.repeated_no_intraday_data_tickers || [],
    incomplete_intraday: aggregate.repeated_incomplete_intraday_tickers || [],
    intraday_unknown: aggregate.repeated_intraday_unknown_tickers || []
  } : { no_intraday_data: [], incomplete_intraday: [], intraday_unknown: [] };

  return {
    date: dateAlignment.date,
    generated_at: new Date((opts && opts.nowMs) || Date.now()).toISOString(),
    gate_status: gateStatus,
    recommendation,
    files_used: {
      bundle: bundle ? { file: bundle._file, date: reportDate(bundle, bundle._file) } : null,
      aggregate: aggregate ? { file: aggregate._file, date: reportDate(aggregate, aggregate._file) } : null,
      policy: policy ? { file: policy._file, date: reportDate(policy, policy._file) } : null,
      provider_cache_quality: providerCacheQuality ? { file: providerCacheQuality._file, date: reportDate(providerCacheQuality, providerCacheQuality._file) } : null
    },
    date_alignment: {
      aligned: dateAlignment.aligned,
      date: dateAlignment.date,
      details: dateAlignment.dates
    },
    block_reasons: blockReasons,
    warn_reasons: warnReasons,
    legacy_status_reasons: legacyStatusReasons || [],
    quarantine_summary: providerCacheQualityQuarantineSummary(providerCacheQuality),
    provider_metrics: {
      provider_matched_count: providerMatchedCount,
      provider_missing_count: providerMissingCount,
      non_quarantined_provider_missing_count: quarantineSummary ? quarantineSummary.non_quarantined_provider_missing_count : (bundle ? nonQuarantinedCount(bundle, 'non_quarantined_provider_missing_count', providerMissingCount) : 0)
    },
    data_quality_summary: {
      NO_INTRADAY_DATA: numberOrZero(dataQualityCounts.NO_INTRADAY_DATA),
      INCOMPLETE_INTRADAY: numberOrZero(dataQualityCounts.INCOMPLETE_INTRADAY),
      priority_label_INTRADAY_UNKNOWN: numberOrZero(priorityLabelCounts.INTRADAY_UNKNOWN),
      confirmation_label_INTRADAY_UNKNOWN: numberOrZero(confirmationLabelCounts.INTRADAY_UNKNOWN),
      non_quarantined_incomplete_intraday_count: quarantineSummary ? quarantineSummary.non_quarantined_incomplete_intraday_count : (bundle ? nonQuarantinedCount(bundle, 'non_quarantined_incomplete_intraday_count', dataQualityCounts.INCOMPLETE_INTRADAY) : 0),
      non_quarantined_intraday_unknown_count: quarantineSummary ? quarantineSummary.non_quarantined_intraday_unknown_count : (bundle ? nonQuarantinedCount(bundle, 'non_quarantined_intraday_unknown_count', numberOrZero(priorityLabelCounts.INTRADAY_UNKNOWN) + numberOrZero(confirmationLabelCounts.INTRADAY_UNKNOWN)) : 0),
      intraday_quarantine_count: quarantineSummary ? quarantineSummary.intraday_quarantine_count : (bundle ? numberOrZero(bundle.intraday_quarantine_count) : 0),
      intraday_quarantine_tickers: quarantineSummary ? quarantineSummary.intraday_quarantine_tickers : (bundle ? asArray(bundle.intraday_quarantine_tickers) : [])
    },
    policy_summary: {
      decision_counts: policyDecisionCounts,
      fallback_action_counts: policyFallbackCounts,
      ok_for_intraday_dry_run_count: okForIntradayDryRunTickers.length,
      watch_next_session_count: watchNextSessionTickers.length,
      bundle_candidate_count: coverage.bundle_candidate_count,
      policy_evaluated_count: coverage.policy_evaluated_count,
      coverage_status: coverage.coverage_status
    },
    recurring_blocker_summary: recurringBlockerSummary,
    ok_for_intraday_dry_run_tickers: okForIntradayDryRunTickers,
    watch_next_session_tickers: watchNextSessionTickers,
    read_only_confirmation: 'This dry-run gate report only reads local validation bundle, aggregate, policy, and optional provider/cache quality JSON files and writes local report artifacts. It does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED, change production scoring defaults, change daytrade engine scoring, send Telegram, write Supabase, add API endpoints, add SQL/migrations, change Dashboard/UI, change cron, add AI, or commit generated reports.'
  };
}

function markdownReport(report) {
  const lines = [
    `# Day Trade Intraday Dry-Run Gate — ${report.date}`,
    '',
    `Generated at: ${report.generated_at}`,
    '',
    '## Gate Status',
    '',
    `- gate_status: **${report.gate_status}**`,
    `- recommendation: ${report.recommendation}`,
    ''
  ];

  // Date alignment
  lines.push('## Date Alignment', '');
  lines.push(`- aligned: ${report.date_alignment.aligned ? 'yes' : 'NO'}`);
  lines.push(`- report date: ${report.date_alignment.date || 'n/a'}`);
  if (report.date_alignment.details && report.date_alignment.details.length > 1) {
    lines.push('- dates found:');
    for (const d of report.date_alignment.details) {
      lines.push(`  - ${d.name}: ${d.date}`);
    }
  }
  lines.push('');

  // Files used
  lines.push('## Files Used', '');
  lines.push(`- bundle: ${report.files_used.bundle ? report.files_used.bundle.file : 'MISSING'}`);
  lines.push(`- aggregate: ${report.files_used.aggregate ? report.files_used.aggregate.file : 'MISSING'}`);
  lines.push(`- policy: ${report.files_used.policy ? report.files_used.policy.file : 'MISSING'}`);
  lines.push(`- provider_cache_quality: ${report.files_used.provider_cache_quality ? report.files_used.provider_cache_quality.file : 'MISSING'}`);
  lines.push('');

  // Block reasons
  lines.push('## Block Reasons', '');
  if (report.block_reasons && report.block_reasons.length) {
    for (const reason of report.block_reasons) {
      lines.push(`- ${reason}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');

  // Warn reasons
  lines.push('## Warn Reasons', '');
  if (report.warn_reasons && report.warn_reasons.length) {
    for (const reason of report.warn_reasons) {
      lines.push(`- ${reason}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');

  // Legacy status reasons
  lines.push('## Legacy Status Reasons', '');
  if (report.legacy_status_reasons && report.legacy_status_reasons.length) {
    for (const reason of report.legacy_status_reasons) {
      lines.push(`- ${reason}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');


  // Quarantine summary
  lines.push('## Quarantine Summary', '');
  if (report.quarantine_summary) {
    const q = report.quarantine_summary;
    lines.push(`- provider_cache_quality_status: ${q.provider_cache_quality_status}`);
    lines.push(`- intraday_quarantine_count: ${q.intraday_quarantine_count}`);
    lines.push(`- intraday_quarantine_tickers: ${fmtList(q.intraday_quarantine_tickers)}`);
    lines.push(`- total_provider_missing_count: ${q.total_provider_missing_count}`);
    lines.push(`- visible_provider_missing_count: ${q.visible_provider_missing_count}`);
    lines.push(`- quarantined_provider_missing_count: ${q.quarantined_provider_missing_count}`);
    lines.push(`- non_quarantined_provider_missing_count: ${q.non_quarantined_provider_missing_count}`);
    lines.push(`- non_quarantined_incomplete_intraday_count: ${q.non_quarantined_incomplete_intraday_count}`);
    lines.push(`- non_quarantined_intraday_unknown_count: ${q.non_quarantined_intraday_unknown_count}`);
  } else {
    lines.push('- none');
  }
  lines.push('');

  // Provider metrics
  lines.push('## Provider Metrics', '');
  lines.push(`- provider_matched_count: ${report.provider_metrics.provider_matched_count}`);
  lines.push(`- provider_missing_count: ${report.provider_metrics.provider_missing_count}`);
  lines.push(`- non_quarantined_provider_missing_count: ${report.provider_metrics.non_quarantined_provider_missing_count}`);
  lines.push('');

  // Data quality summary
  lines.push('## Data Quality Summary', '');
  lines.push(`- NO_INTRADAY_DATA: ${report.data_quality_summary.NO_INTRADAY_DATA}`);
  lines.push(`- INCOMPLETE_INTRADAY: ${report.data_quality_summary.INCOMPLETE_INTRADAY}`);
  lines.push(`- priority_label INTRADAY_UNKNOWN: ${report.data_quality_summary.priority_label_INTRADAY_UNKNOWN}`);
  lines.push(`- confirmation_label INTRADAY_UNKNOWN: ${report.data_quality_summary.confirmation_label_INTRADAY_UNKNOWN}`);
  lines.push(`- non_quarantined_incomplete_intraday_count: ${report.data_quality_summary.non_quarantined_incomplete_intraday_count}`);
  lines.push(`- non_quarantined_intraday_unknown_count: ${report.data_quality_summary.non_quarantined_intraday_unknown_count}`);
  lines.push(`- intraday_quarantine_count: ${report.data_quality_summary.intraday_quarantine_count}`);
  lines.push(`- intraday_quarantine_tickers: ${fmtList(report.data_quality_summary.intraday_quarantine_tickers)}`);
  lines.push('');

  // Policy summary
  lines.push('## Policy Summary', '');
  lines.push(`- decision_counts: ${fmtObj(report.policy_summary.decision_counts)}`);
  lines.push(`- fallback_action_counts: ${fmtObj(report.policy_summary.fallback_action_counts)}`);
  lines.push(`- ok_for_intraday_dry_run_count: ${report.policy_summary.ok_for_intraday_dry_run_count}`);
  lines.push(`- watch_next_session_count: ${report.policy_summary.watch_next_session_count}`);
  lines.push(`- evaluated_count: ${report.policy_summary.policy_evaluated_count}`);
  lines.push(`- bundle_candidate_count: ${report.policy_summary.bundle_candidate_count}`);
  lines.push(`- coverage_status: ${report.policy_summary.coverage_status}`);
  lines.push('');

  // Recurring blocker summary
  lines.push('## Recurring Blocker Summary', '');
  lines.push(`- no_intraday_data: ${fmtList(report.recurring_blocker_summary.no_intraday_data)}`);
  lines.push(`- incomplete_intraday: ${fmtList(report.recurring_blocker_summary.incomplete_intraday)}`);
  lines.push(`- intraday_unknown: ${fmtList(report.recurring_blocker_summary.intraday_unknown)}`);
  lines.push('');

  // OK_FOR_INTRADAY_DRY_RUN tickers
  lines.push('## OK_FOR_INTRADAY_DRY_RUN Tickers', '');
  lines.push(fmtList(report.ok_for_intraday_dry_run_tickers));
  lines.push('');

  // WATCH_NEXT_SESSION tickers
  lines.push('## WATCH_NEXT_SESSION Tickers', '');
  lines.push(fmtList(report.watch_next_session_tickers));
  lines.push('');

  // Read-only confirmation
  lines.push('## Read-only Confirmation', '');
  lines.push(report.read_only_confirmation);
  lines.push('');

  return lines.join('\n');
}

async function writeReports(report, opts) {
  const dir = (opts && opts.reportsDir) || DEFAULT_REPORTS_DIR;
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, 'daytrade-intraday-dry-run-gate-' + report.date);
  const paths = { markdown: base + '.md' };
  await fs.writeFile(paths.markdown, markdownReport(report));
  if (opts && opts.writeJson) {
    paths.json = base + '.json';
    await fs.writeFile(paths.json, JSON.stringify(report, null, 2) + '\n');
  }
  return paths;
}

async function run(opts) {
  const inputs = await loadInputs(opts || {});
  const report = buildGateReport(inputs.bundle, inputs.aggregate, inputs.policy, { ...(opts || {}), providerCacheQuality: inputs.providerCacheQuality });
  const paths = await writeReports(report, opts || {});
  return { report, paths };
}

function parseArgs(argv) {
  const args = {
    reportsDir: DEFAULT_REPORTS_DIR,
    bundleFile: null,
    aggregateFile: null,
    policyFile: null,
    providerCacheQualityFile: null,
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
    } else if (a === '--policy-file' && argv[i + 1]) {
      args.policyFile = argv[++i];
    } else if (a === '--provider-cache-quality-file' && argv[i + 1]) {
      args.providerCacheQualityFile = argv[++i];
    }
  }

  return args;
}

function recommendationForStatus(status) {
  switch (status) {
    case 'BLOCK':
      return 'Do NOT enable production intraday scoring. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off.';
    case 'WARN':
      return 'Dry-run gate has warnings. Keep production flag off and review before staged enable.';
    case 'PASS_WITH_QUARANTINE':
      return 'Dry-run/reporting can proceed with explicit quarantine. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off; quarantined tickers are DAILY_SCORE_ONLY and this is not production enablement.';
    case 'PASS':
      return 'Dry-run gate passed. Production flag must still remain off until a separate staged enable PR is approved.';
    default:
      return 'Unknown gate status.';
  }
}

module.exports = {
  DEFAULT_REPORTS_DIR,
  BUNDLE_PREFIX,
  AGGREGATE_PREFIX,
  POLICY_PREFIX,
  PROVIDER_CACHE_QUALITY_PREFIX,
  asArray,
  numberOrZero,
  bundleCandidateCount,
  policyCoverage,
  latestFile,
  reportDate,
  loadInputs,
  checkDateAlignment,
  evaluateGate,
  recommendationForStatus,
  buildGateReport,
  markdownReport,
  writeReports,
  run,
  parseArgs,
  formatSummaryItem,
  quarantineTickers,
  nonQuarantinedCount,
  providerCacheQualityIsCleanQuarantine,
  providerCacheQualityQuarantineSummary
};

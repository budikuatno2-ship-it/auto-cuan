'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const GATE_PREFIX = 'daytrade-intraday-dry-run-gate-';
const POLICY_PREFIX = 'daytrade-intraday-policy-';
const AGGREGATE_PREFIX = 'daytrade-intraday-validation-aggregate-';
const BUNDLE_PREFIX = 'daytrade-intraday-validation-bundle-';

function asArray(v) { return Array.isArray(v) ? v : []; }
function numberOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmtList(values) { const arr = asArray(values); return arr.length ? arr.join(', ') : 'none'; }
function todayIso(nowMs) { return new Date(nowMs || Date.now()).toISOString().slice(0, 10); }

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
  let gate = null;
  let policy = null;
  let aggregate = null;
  let bundle = null;

  // Load gate (required)
  if (opts.gateFile) {
    gate = JSON.parse(await fs.readFile(opts.gateFile, 'utf8'));
    gate._file = opts.gateFile;
  } else {
    const latestGate = await latestFile(reportsDir, GATE_PREFIX);
    if (latestGate) {
      gate = JSON.parse(await fs.readFile(latestGate, 'utf8'));
      gate._file = latestGate;
    }
  }

  // Load policy (optional)
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

  // Load bundle (optional)
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

  return { gate, policy, aggregate, bundle };
}

function evaluateStatus(gate) {
  // NOT_READY if gate file missing
  if (!gate) {
    return { status: 'NOT_READY', reason: 'dry-run gate file missing' };
  }

  // NOT_READY if gate_status is BLOCK
  if (gate.gate_status === 'BLOCK') {
    return { status: 'NOT_READY', reason: 'dry-run gate status is BLOCK' };
  }

  // REVIEW_REQUIRED if gate_status is WARN
  if (gate.gate_status === 'WARN') {
    return { status: 'REVIEW_REQUIRED', reason: 'dry-run gate status is WARN' };
  }

  // READY_FOR_MANUAL_APPROVAL if gate_status is PASS
  if (gate.gate_status === 'PASS') {
    return { status: 'READY_FOR_MANUAL_APPROVAL', reason: 'dry-run gate status is PASS' };
  }

  // Default fallback
  return { status: 'NOT_READY', reason: `unknown gate_status: ${gate.gate_status}` };
}

function recommendationForStatus(status) {
  switch (status) {
    case 'NOT_READY':
      return 'Do NOT enable production intraday scoring. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off.';
    case 'REVIEW_REQUIRED':
      return 'Do not enable yet. Review warnings and repeat validation.';
    case 'READY_FOR_MANUAL_APPROVAL':
      return 'Eligible for human review. Production flag must remain off until separate explicit approval.';
    default:
      return 'Unknown runbook status.';
  }
}

function buildRunbookReport(gate, policy, aggregate, bundle, opts) {
  const { status, reason } = evaluateStatus(gate);
  const recommendation = recommendationForStatus(status);

  const date = gate ? reportDate(gate, gate._file) : todayIso(opts && opts.nowMs);

  // Build blockers/warnings summary from gate
  const blockers = gate ? asArray(gate.block_reasons) : [];
  const warnings = gate ? asArray(gate.warn_reasons) : [];

  // Extract key metrics
  const providerMetrics = gate ? gate.provider_metrics || {} : {};
  const dataQualitySummary = gate ? gate.data_quality_summary || {} : {};
  const policySummary = gate ? gate.policy_summary || {} : {};

  return {
    date,
    generated_at: new Date((opts && opts.nowMs) || Date.now()).toISOString(),
    runbook_status: status,
    reason,
    recommendation,
    files_used: {
      gate: gate ? { file: gate._file, date: reportDate(gate, gate._file) } : null,
      policy: policy ? { file: policy._file, date: reportDate(policy, policy._file) } : null,
      aggregate: aggregate ? { file: aggregate._file, date: reportDate(aggregate, aggregate._file) } : null,
      bundle: bundle ? { file: bundle._file, date: reportDate(bundle, bundle._file) } : null
    },
    blockers,
    warnings,
    gate_summary: {
      gate_status: gate ? gate.gate_status : null,
      provider_matched_count: providerMetrics.provider_matched_count || 0,
      provider_missing_count: providerMetrics.provider_missing_count || 0,
      no_intraday_data: dataQualitySummary.NO_INTRADAY_DATA || 0,
      incomplete_intraday: dataQualitySummary.INCOMPLETE_INTRADAY || 0,
      ok_for_intraday_dry_run_count: policySummary.ok_for_intraday_dry_run_count || 0,
      watch_next_session_count: policySummary.watch_next_session_count || 0,
      bundle_candidate_count: policySummary.bundle_candidate_count || 0,
      policy_evaluated_count: policySummary.policy_evaluated_count || 0,
      coverage_status: policySummary.coverage_status || 'UNKNOWN',
      session_spacing_status: (aggregate && aggregate.session_spacing_status) || (gate && gate.session_spacing_status) || null,
      min_session_gap_minutes: (aggregate && aggregate.min_session_gap_minutes) ?? (gate && gate.min_session_gap_minutes) ?? null,
      session_span_minutes: (aggregate && aggregate.session_span_minutes) ?? (gate && gate.session_span_minutes) ?? null,
      close_session_pair_count: (aggregate && aggregate.close_session_pair_count) ?? (gate && gate.close_session_pair_count) ?? null
    },
    pre_enable_checklist: [
      'Confirm dry-run gate status is PASS',
      'Verify no BLOCK reasons in recent validation reports',
      'Confirm provider_missing_count is 0',
      'Confirm NO_INTRADAY_DATA is 0',
      'Confirm INCOMPLETE_INTRADAY is 0',
      'Confirm INTRADAY_UNKNOWN is 0',
      'Review recent score deltas in aggregate report',
      'Review watch_next_session_tickers for anomalies',
      'Confirm operators are available for monitoring',
      'Confirm rollback access is available'
    ],
    manual_enable_instructions: [
      'Only after separate approval, set DAYTRADE_INTRADAY_SCORE_ENABLED=1 in Vercel production env.',
      'Redeploy production after env update.',
      'Run read-only smoke checks first.',
      'Do not use force/send_radar unless intentionally sending Telegram.'
    ],
    production_smoke_checklist: [
      'Verify /api/quote returns intraday scores',
      'Verify /api/candles returns intraday data',
      'Check system logs for errors',
      'Confirm Telegram bot is responding',
      'Monitor first 5 minutes of picks for anomalies',
      'Confirm no false positives in high-confidence signals'
    ],
    monitoring_checklist: [
      'Monitor provider_missing_count metric',
      'Monitor NO_INTRADAY_DATA ticker count',
      'Monitor INCOMPLETE_INTRADAY ticker count',
      'Monitor score delta distribution',
      'Review Telegram output for accuracy',
      'Check Top 5 churn ratio',
      'Review watch_next_session_tickers weekly'
    ],
    rollback_instructions: [
      'Remove or unset DAYTRADE_INTRADAY_SCORE_ENABLED from Vercel production env.',
      'Redeploy production.',
      'Confirm default scoring behavior.',
      'Keep Telegram/VPS cron unchanged unless separately approved.'
    ],
    stop_loss_conditions: [
      'gate_status returns BLOCK',
      'provider_missing_count > 0',
      'NO_INTRADAY_DATA > 0',
      'INCOMPLETE_INTRADAY > 0',
      'INTRADAY_UNKNOWN > 0',
      'unexpected Top 5 churn',
      'score deltas exceed threshold',
      'Telegram output becomes misleading',
      'any production API error appears'
    ],
    read_only_confirmation: 'This staged-enable runbook report only reads local validation bundle, aggregate, policy, and dry-run gate JSON files and writes local report artifacts as read-only. It does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED, change Vercel env, modify production scoring defaults, change daytrade engine scoring, send Telegram, write Supabase, add API endpoints, add SQL/migrations, change Dashboard/UI, change cron, add AI, or commit generated reports.'
  };
}

function markdownReport(report) {
  const lines = [
    `# Day Trade Intraday Staged-Enable Runbook — ${report.date}`,
    '',
    `Generated at: ${report.generated_at}`,
    '',
    '## Runbook Status',
    '',
    `- status: **${report.runbook_status}**`,
    `- reason: ${report.recommendation}`,
    ''
  ];

  // Recommendation
  lines.push('## Recommendation', '');
  lines.push(report.recommendation);
  lines.push('');

  // Files used
  lines.push('## Files Used', '');
  lines.push(`- gate: ${report.files_used.gate ? report.files_used.gate.file : 'MISSING'}`);
  lines.push(`- policy: ${report.files_used.policy ? report.files_used.policy.file : 'not available'}`);
  lines.push(`- aggregate: ${report.files_used.aggregate ? report.files_used.aggregate.file : 'not available'}`);
  lines.push(`- bundle: ${report.files_used.bundle ? report.files_used.bundle.file : 'not available'}`);
  lines.push('');

  // Current blockers/warnings summary
  lines.push('## Current Blockers/Warnings Summary', '');
  if (report.blockers && report.blockers.length) {
    lines.push('### Blockers', '');
    for (const reason of report.blockers) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  } else {
    lines.push('### Blockers: none');
    lines.push('');
  }

  if (report.warnings && report.warnings.length) {
    lines.push('### Warnings', '');
    for (const reason of report.warnings) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  } else {
    lines.push('### Warnings: none');
    lines.push('');
  }

  // Gate summary
  lines.push('## Gate Summary', '');
  lines.push(`- gate_status: ${report.gate_summary.gate_status || 'n/a'}`);
  lines.push(`- provider_matched_count: ${report.gate_summary.provider_matched_count}`);
  lines.push(`- provider_missing_count: ${report.gate_summary.provider_missing_count}`);
  lines.push(`- NO_INTRADAY_DATA: ${report.gate_summary.no_intraday_data}`);
  lines.push(`- INCOMPLETE_INTRADAY: ${report.gate_summary.incomplete_intraday}`);
  lines.push(`- ok_for_intraday_dry_run_count: ${report.gate_summary.ok_for_intraday_dry_run_count}`);
  lines.push(`- watch_next_session_count: ${report.gate_summary.watch_next_session_count}`);
  lines.push(`- policy_evaluated_count: ${report.gate_summary.policy_evaluated_count}`);
  lines.push(`- bundle_candidate_count: ${report.gate_summary.bundle_candidate_count}`);
  lines.push(`- policy coverage_status: ${report.gate_summary.coverage_status}`);
  if (report.gate_summary.session_spacing_status) {
    lines.push(`- session_spacing_status: ${report.gate_summary.session_spacing_status}`);
    lines.push(`- min_session_gap_minutes: ${report.gate_summary.min_session_gap_minutes ?? 'n/a'}`);
    lines.push(`- session_span_minutes: ${report.gate_summary.session_span_minutes ?? 'n/a'}`);
    lines.push(`- close_session_pair_count: ${report.gate_summary.close_session_pair_count ?? 'n/a'}`);
  }
  lines.push('');

  // Pre-enable checklist
  lines.push('## Pre-enable Checklist', '');
  for (const item of report.pre_enable_checklist) {
    lines.push(`- [ ] ${item}`);
  }
  lines.push('');

  // Manual enable instructions
  lines.push('## Manual Enable Instructions', '');
  lines.push('**WARNING: Do not automate these steps. These are read-only manual instructions.**', '');
  for (const item of report.manual_enable_instructions) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  // Production smoke checklist
  lines.push('## Production Smoke Checklist', '');
  lines.push('**Only run after enabling the flag:**', '');
  for (const item of report.production_smoke_checklist) {
    lines.push(`- [ ] ${item}`);
  }
  lines.push('');

  // Monitoring checklist
  lines.push('## Monitoring Checklist', '');
  for (const item of report.monitoring_checklist) {
    lines.push(`- [ ] ${item}`);
  }
  lines.push('');

  // Rollback instructions
  lines.push('## Rollback Instructions', '');
  lines.push('**If stop-loss condition is triggered:**', '');
  for (const item of report.rollback_instructions) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  // Stop-loss conditions
  lines.push('## Stop-loss Conditions', '');
  lines.push('**If ANY of these conditions occur, rollback immediately:**', '');
  for (const condition of report.stop_loss_conditions) {
    lines.push(`- ${condition}`);
  }
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
  const base = path.join(dir, 'daytrade-intraday-staged-enable-runbook-' + report.date);
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
  const report = buildRunbookReport(inputs.gate, inputs.policy, inputs.aggregate, inputs.bundle, opts);
  const paths = await writeReports(report, opts || {});
  return { report, paths };
}

function parseArgs(argv) {
  const args = {
    reportsDir: DEFAULT_REPORTS_DIR,
    gateFile: null,
    policyFile: null,
    aggregateFile: null,
    bundleFile: null,
    writeJson: false
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.writeJson = true;
    } else if (a === '--reports-dir' && argv[i + 1]) {
      args.reportsDir = argv[++i];
    } else if (a === '--gate-file' && argv[i + 1]) {
      args.gateFile = argv[++i];
    } else if (a === '--policy-file' && argv[i + 1]) {
      args.policyFile = argv[++i];
    } else if (a === '--aggregate-file' && argv[i + 1]) {
      args.aggregateFile = argv[++i];
    } else if (a === '--bundle-file' && argv[i + 1]) {
      args.bundleFile = argv[++i];
    }
  }

  return args;
}

function recommendationForStatus(status) {
  switch (status) {
    case 'NOT_READY':
      return 'Do NOT enable production intraday scoring. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off.';
    case 'REVIEW_REQUIRED':
      return 'Do not enable yet. Review warnings and repeat validation.';
    case 'READY_FOR_MANUAL_APPROVAL':
      return 'Eligible for human review. Production flag must remain off until separate explicit approval.';
    default:
      return 'Unknown runbook status.';
  }
}

module.exports = {
  DEFAULT_REPORTS_DIR,
  GATE_PREFIX,
  POLICY_PREFIX,
  AGGREGATE_PREFIX,
  BUNDLE_PREFIX,
  asArray,
  numberOrZero,
  latestFile,
  reportDate,
  loadInputs,
  evaluateStatus,
  recommendationForStatus,
  buildRunbookReport,
  markdownReport,
  writeReports,
  run,
  parseArgs
};
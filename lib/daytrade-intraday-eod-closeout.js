'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const PREFIXES = {
  bundle: 'daytrade-intraday-validation-bundle-',
  aggregate: 'daytrade-intraday-validation-aggregate-',
  policy: 'daytrade-intraday-policy-',
  gate: 'daytrade-intraday-dry-run-gate-',
  runbook: 'daytrade-intraday-staged-enable-runbook-'
};
const DONE_NOT_READY_RECOMMENDATION = 'Done for today. Do not run more archive collection today. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off. Evaluate again next trading session with fresh market data.';

function asArray(v) { return Array.isArray(v) ? v : []; }
function numberOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function todayIso(nowMs) { return new Date(nowMs || Date.now()).toISOString().slice(0, 10); }
function fmtList(values) { const arr = asArray(values).map(formatItem).filter(Boolean); return arr.length ? arr.join(', ') : 'none'; }
function formatItem(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    const ticker = item.ticker || item.key || item.value || item.symbol;
    const count = item.count ?? item.total ?? item.frequency;
    if (ticker && count != null) return `${ticker} (${count})`;
    if (ticker) return String(ticker);
  }
  return JSON.stringify(item);
}
function countRows(rows) { return asArray(rows).reduce((sum, row) => sum + numberOrZero(row && row.count != null ? row.count : 1), 0); }

async function latestFile(reportsDir, prefix) {
  let names;
  try { names = await fs.readdir(reportsDir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const matches = names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const m = name.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      return m ? { name, date: m[1] } : null;
    }).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
  return matches.length ? path.join(reportsDir, matches[0].name) : null;
}
async function loadJson(file) { const obj = JSON.parse(await fs.readFile(file, 'utf8')); obj._file = file; return obj; }
async function loadInputs(opts) {
  const reportsDir = opts && opts.reportsDir || DEFAULT_REPORTS_DIR;
  const out = {};
  for (const [key, prefix] of Object.entries(PREFIXES)) {
    const file = await latestFile(reportsDir, prefix);
    out[key] = file ? await loadJson(file) : null;
  }
  return out;
}
function reportDate(report, file) { return (report && report.date) || ((String(file || '').match(/(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]); }
function localTimeParts(nowMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(nowMs || Date.now()));
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { date: `${m.year}-${m.month}-${m.day}`, minutes: Number(m.hour) * 60 + Number(m.minute) };
}
function marketClosed(opts) {
  const timezone = opts.timezone || 'Asia/Jakarta';
  const close = opts.marketCloseLocal || '16:00';
  const m = close.match(/^(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid --market-close-local value: ${close}`);
  return localTimeParts(opts.nowMs, timezone).minutes >= Number(m[1]) * 60 + Number(m[2]);
}
function classifyBlockers({ bundle, aggregate, policy, gate }) {
  const spacing = [];
  const non = [];
  const sessionStatus = (aggregate && aggregate.session_spacing_status) || (gate && gate.session_spacing_status);
  if (sessionStatus === 'BLOCK') spacing.push('session_spacing_status BLOCK');
  for (const reason of asArray(aggregate && aggregate.block_reasons).concat(asArray(gate && gate.block_reasons))) {
    const lower = String(reason).toLowerCase();
    if (lower.includes('session samples too close') || lower.includes('session span too short') || lower.includes('session_spacing_status')) spacing.push(String(reason));
  }
  if (numberOrZero(bundle && bundle.provider_missing_count) > 0) non.push(`provider_missing_count ${bundle.provider_missing_count} > 0`);
  const dq = bundle && bundle.data_quality_counts || {};
  for (const key of ['NO_INTRADAY_DATA', 'INCOMPLETE_INTRADAY', 'INTRADAY_UNKNOWN']) if (numberOrZero(dq[key]) > 0) non.push(`${key} ${dq[key]} > 0`);
  const pr = bundle && bundle.priority_label_counts || {}; const cr = bundle && bundle.confirmation_label_counts || {};
  if (numberOrZero(pr.INTRADAY_UNKNOWN) > 0 || numberOrZero(cr.INTRADAY_UNKNOWN) > 0) non.push(`INTRADAY_UNKNOWN ${numberOrZero(pr.INTRADAY_UNKNOWN) + numberOrZero(cr.INTRADAY_UNKNOWN)} > 0`);
  if (numberOrZero(policy && policy.fallback_action_counts && policy.fallback_action_counts.DAILY_SCORE_ONLY) > 0) non.push(`fallback_action_counts.DAILY_SCORE_ONLY ${policy.fallback_action_counts.DAILY_SCORE_ONLY} > 0`);
  const recurring = {
    no_intraday_data: asArray(aggregate && aggregate.repeated_no_intraday_data_tickers),
    incomplete_intraday: asArray(aggregate && aggregate.repeated_incomplete_intraday_tickers),
    intraday_unknown: asArray(aggregate && aggregate.repeated_intraday_unknown_tickers)
  };
  if (recurring.no_intraday_data.length || recurring.incomplete_intraday.length || recurring.intraday_unknown.length) non.push('recurring incomplete/no-data/unknown tickers');
  const hasRealNonSpacingEvidence = non.length > 0;
  if (bundle && bundle.validation_status === 'BLOCK' && hasRealNonSpacingEvidence) non.push('validation bundle BLOCK');
  if (policy && policy.policy_status === 'BLOCK' && hasRealNonSpacingEvidence) non.push('policy_status BLOCK');
  return { spacing_blockers: [...new Set(spacing)], non_spacing_blockers: [...new Set(non)], recurring_blocker_tickers: recurring };
}
function buildCloseoutReport(inputs, opts) {
  opts = opts || {};
  const { bundle, aggregate, policy, gate, runbook } = inputs;
  const closed = Boolean(opts.forceDoneForDay) || marketClosed(opts);
  const gateStatus = gate && gate.gate_status || null;
  const runbookStatus = (runbook && (runbook.runbook_status || runbook.status)) || null;
  const blockers = classifyBlockers(inputs);
  let closeoutStatus; let shouldCollect = false; let recommendation = '';
  if (gateStatus === 'PASS' && runbookStatus === 'READY_FOR_MANUAL_APPROVAL') {
    closeoutStatus = 'READY_FOR_MANUAL_APPROVAL'; recommendation = 'Manual approval required before enabling. Do not enable automatically.';
  } else if ((gateStatus === 'BLOCK' || runbookStatus === 'NOT_READY') && closed) {
    closeoutStatus = 'DONE_FOR_DAY_NOT_READY'; recommendation = DONE_NOT_READY_RECOMMENDATION;
  } else if ((gateStatus === 'WARN' || runbookStatus === 'REVIEW_REQUIRED') && closed) {
    closeoutStatus = 'DONE_FOR_DAY_REVIEW_REQUIRED'; recommendation = 'Done for today. Review required tomorrow before any enablement decision.';
  } else if (!closed && blockers.spacing_blockers.length && blockers.non_spacing_blockers.length === 0) {
    closeoutStatus = 'NEED_MORE_SPACED_SAMPLES'; shouldCollect = true; recommendation = 'Market is still open and only spacing blockers remain. Collect more spaced samples before close.';
  } else if (!closed && blockers.non_spacing_blockers.length) {
    closeoutStatus = 'NOT_READY_NON_SPACING_BLOCKERS'; recommendation = 'Do not chase more archives until non-spacing blockers are resolved.';
  } else {
    closeoutStatus = closed ? 'DONE_FOR_DAY_REVIEW_REQUIRED' : 'NOT_READY_NON_SPACING_BLOCKERS'; recommendation = closed ? 'Done for today. Review the latest reports next trading session.' : 'Do not chase more archives until blockers are resolved.';
  }
  const date = reportDate(gate, gate && gate._file) || reportDate(runbook, runbook && runbook._file) || reportDate(bundle, bundle && bundle._file) || todayIso(opts.nowMs);
  return {
    date, generated_at: new Date(opts.nowMs || Date.now()).toISOString(), closeout_status: closeoutStatus, should_collect_more_archives_today: shouldCollect, market_closed_for_closeout: closed, recommendation,
    gate_status: gateStatus, runbook_status: runbookStatus, aggregate_status: aggregate && aggregate.aggregate_status || null,
    provider_matched_count: (gate && gate.provider_metrics && gate.provider_metrics.provider_matched_count) ?? (bundle && bundle.provider_matched_count) ?? 0,
    provider_missing_count: (gate && gate.provider_metrics && gate.provider_metrics.provider_missing_count) ?? (bundle && bundle.provider_missing_count) ?? 0,
    coverage_status: (gate && gate.policy_summary && gate.policy_summary.coverage_status) || (policy && policy.coverage_status) || null,
    session_spacing_status: (aggregate && aggregate.session_spacing_status) || (gate && gate.session_spacing_status) || null,
    min_session_gap_minutes: (aggregate && aggregate.min_session_gap_minutes) ?? (gate && gate.min_session_gap_minutes) ?? null,
    session_span_minutes: (aggregate && aggregate.session_span_minutes) ?? (gate && gate.session_span_minutes) ?? null,
    spacing_blockers: blockers.spacing_blockers, non_spacing_blockers: blockers.non_spacing_blockers, recurring_blocker_tickers: blockers.recurring_blocker_tickers,
    next_action_for_tomorrow: 'Evaluate again next trading session with fresh market data. Keep DAYTRADE_INTRADAY_SCORE_ENABLED off unless a separate manual approval is granted.',
    read_only_confirmation: 'This EOD closeout report only reads local validation bundle, aggregate, policy, dry-run gate, and staged-enable runbook JSON files and writes local report artifacts as read-only. It does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED, change Vercel env, modify production scoring defaults, change daytrade engine scoring, send Telegram, write Supabase, add API endpoints, add SQL/migrations, change Dashboard/UI, change cron, add AI, or commit generated reports.'
  };
}
function markdownReport(r) {
  return `# Day Trade Intraday EOD Closeout — ${r.date}\n\nGenerated at: ${r.generated_at}\n\n## Closeout\n\n- closeout_status: ${r.closeout_status}\n- should_collect_more_archives_today: ${r.should_collect_more_archives_today}\n- market_closed_for_closeout: ${r.market_closed_for_closeout}\n- recommendation: ${r.recommendation}\n\n## Latest Status Inputs\n\n- gate_status: ${r.gate_status || 'n/a'}\n- runbook_status: ${r.runbook_status || 'n/a'}\n- aggregate_status: ${r.aggregate_status || 'n/a'}\n- provider_matched_count: ${r.provider_matched_count}\n- provider_missing_count: ${r.provider_missing_count}\n- coverage_status: ${r.coverage_status || 'n/a'}\n- session_spacing_status: ${r.session_spacing_status || 'n/a'}\n- min_session_gap_minutes: ${r.min_session_gap_minutes ?? 'n/a'}\n- session_span_minutes: ${r.session_span_minutes ?? 'n/a'}\n\n## Blocker Classification\n\n- spacing_blockers: ${fmtList(r.spacing_blockers)}\n- non_spacing_blockers: ${fmtList(r.non_spacing_blockers)}\n\n## Recurring Blocker Tickers\n\n- no_intraday_data: ${fmtList(r.recurring_blocker_tickers.no_intraday_data)}\n- incomplete_intraday: ${fmtList(r.recurring_blocker_tickers.incomplete_intraday)}\n- intraday_unknown: ${fmtList(r.recurring_blocker_tickers.intraday_unknown)}\n- recurring blocker total count: ${countRows(r.recurring_blocker_tickers.no_intraday_data) + countRows(r.recurring_blocker_tickers.incomplete_intraday) + countRows(r.recurring_blocker_tickers.intraday_unknown)}\n\n## Next Action For Tomorrow\n\n${r.next_action_for_tomorrow}\n\n## Read-only Confirmation\n\n${r.read_only_confirmation}\n`;
}
async function writeReports(report, opts) {
  const dir = opts && opts.reportsDir || DEFAULT_REPORTS_DIR; await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, `daytrade-intraday-eod-closeout-${report.date}`);
  const paths = { markdown: `${base}.md`, json: `${base}.json` };
  await fs.writeFile(paths.markdown, markdownReport(report));
  await fs.writeFile(paths.json, JSON.stringify(report, null, 2) + '\n');
  return paths;
}
async function run(opts) { const inputs = await loadInputs(opts || {}); const report = buildCloseoutReport(inputs, opts || {}); const paths = await writeReports(report, opts || {}); return { report, paths }; }
function parseArgs(argv) {
  const args = { reportsDir: DEFAULT_REPORTS_DIR, writeJson: false, timezone: 'Asia/Jakarta', marketCloseLocal: '16:00', forceDoneForDay: false };
  for (let i = 2; i < argv.length; i++) { const a = argv[i]; if (a === '--json') args.writeJson = true; else if (a === '--reports-dir') args.reportsDir = argv[++i]; else if (a === '--timezone') args.timezone = argv[++i]; else if (a === '--market-close-local') args.marketCloseLocal = argv[++i]; else if (a === '--force-done-for-day') args.forceDoneForDay = true; }
  return args;
}
module.exports = { DEFAULT_REPORTS_DIR, PREFIXES, DONE_NOT_READY_RECOMMENDATION, asArray, numberOrZero, latestFile, loadInputs, localTimeParts, marketClosed, classifyBlockers, buildCloseoutReport, markdownReport, writeReports, run, parseArgs };

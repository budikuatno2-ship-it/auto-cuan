'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const INTRADAY_PREFIX = 'daytrade-intraday-observe-';
const COMPARE_PREFIX = 'daytrade-adjusted-vs-normal-';
const READINESS_PREFIX = 'daytrade-intraday-readiness-';

function asObject(value) { return value && typeof value === 'object' ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function numberOrNull(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function countValue(counts, key) { return Number(asObject(counts)[key] || 0); }
function hasCaution(cautions, key) { return asArray(cautions).map(String).includes(key); }
function ratio(count, total) { return total > 0 ? count / total : 0; }
function today() { return new Date().toISOString().slice(0, 10); }

function normalizeInputs(input) {
  const intraday = asObject(input && input.intraday);
  const compare = asObject(input && input.compare);
  const intradaySummary = asObject(intraday.summary);
  const compareMetrics = asObject(asObject(compare.comparison).metrics);
  const intradayRows = asArray(intraday.rows);
  const candidates = numberOrNull(intradaySummary.candidates) ?? intradayRows.length;
  const priority = Object.assign({}, asObject(intradaySummary.intraday_priority_label), asObject(compareMetrics.priority_label_counts));
  const confirmation = Object.assign({}, asObject(intradaySummary.intraday_confirmation_label), asObject(compareMetrics.confirmation_label_counts));
  const dataQuality = Object.assign({}, asObject(intradaySummary.data_quality));
  const compareRoot = asObject(compare.comparison);
  const cautions = Array.from(new Set([
    ...asArray(compareRoot.cautions),
    ...asArray(compareMetrics.cautions),
    ...asArray(compare.cautions)
  ].map(String)));
  return {
    intraday,
    compare,
    candidates,
    provider_matched_count: numberOrNull(compareMetrics.provider_matched_count),
    provider_missing_count: numberOrNull(compareMetrics.provider_missing_count),
    avg_score_delta: numberOrNull(compareMetrics.avg_score_delta),
    max_score_delta: numberOrNull(compareMetrics.max_score_delta),
    priority_label_counts: priority,
    confirmation_label_counts: confirmation,
    data_quality: dataQuality,
    cautions
  };
}

function evaluateIntradayReadiness(input) {
  const m = normalizeInputs(input);
  const block = [];
  const warn = [];
  const matched = m.provider_matched_count ?? 0;

  if (m.candidates < 10) block.push(`intraday candidates below minimum: ${m.candidates}/10`);
  if (m.provider_matched_count === null || m.provider_matched_count < 10) block.push(`provider_matched_count below minimum: ${m.provider_matched_count ?? 'n/a'}/10`);
  if ((m.provider_missing_count ?? 0) > 0) block.push(`provider_missing_count is non-zero: ${m.provider_missing_count}`);
  const unknown = countValue(m.confirmation_label_counts, 'INTRADAY_UNKNOWN') + countValue(m.priority_label_counts, 'INTRADAY_UNKNOWN');
  if (unknown > 0) block.push(`INTRADAY_UNKNOWN count is non-zero: ${unknown}`);
  const noData = countValue(m.data_quality, 'NO_INTRADAY_DATA');
  if (noData > 0) block.push(`NO_INTRADAY_DATA count is non-zero: ${noData}`);
  if (hasCaution(m.cautions, 'STALE_OR_INCOMPLETE_INTRADAY_DATA')) block.push('STALE_OR_INCOMPLETE_INTRADAY_DATA caution exists');
  if (hasCaution(m.cautions, 'MANY_BELOW_VWAP_RISK')) block.push('MANY_BELOW_VWAP_RISK caution exists');

  if (hasCaution(m.cautions, 'MANY_CHASE_RISK')) warn.push('MANY_CHASE_RISK caution exists');
  if (hasCaution(m.cautions, 'LARGE_TOP5_CHURN')) warn.push('LARGE_TOP5_CHURN caution exists');
  if ((m.max_score_delta ?? 0) > 10) warn.push(`max_score_delta above 10: ${m.max_score_delta}`);
  if (Math.abs(m.avg_score_delta ?? 0) > 5) warn.push(`abs(avg_score_delta) above 5: ${m.avg_score_delta}`);
  const avoid = countValue(m.priority_label_counts, 'INTRADAY_AVOID');
  if (ratio(avoid, matched) >= 0.3) warn.push(`INTRADAY_AVOID count >= 30% of matched candidates: ${avoid}/${matched}`);
  const caution = countValue(m.confirmation_label_counts, 'INTRADAY_CAUTION');
  if (ratio(caution, matched) >= 0.5) warn.push(`INTRADAY_CAUTION count >= 50% of matched candidates: ${caution}/${matched}`);

  return { readiness_status: block.length ? 'BLOCK' : (warn.length ? 'WARN' : 'PASS'), block_reasons: block, warn_reasons: warn, metrics: m };
}

function recommendation(status) {
  if (status === 'BLOCK') return 'BLOCK: do not enable production flag DAYTRADE_INTRADAY_SCORE_ENABLED.';
  if (status === 'WARN') return 'WARN: observe more sessions before enabling.';
  return 'PASS: eligible for next manual review, not auto-enable.';
}

function buildIntradayReadinessReport(input) {
  const evaluated = evaluateIntradayReadiness(input);
  const date = (input && input.date) || (evaluated.metrics.intraday.date) || (evaluated.metrics.compare.date) || today();
  return { date, generated_at: new Date().toISOString(), sources: asObject(input && input.sources), readiness_status: evaluated.readiness_status, block_reasons: evaluated.block_reasons, warn_reasons: evaluated.warn_reasons, recommendation: recommendation(evaluated.readiness_status), metrics: evaluated.metrics };
}

function formatObj(obj) { return '`' + JSON.stringify(obj || {}) + '`'; }
function markdownReport(report) {
  const m = report.metrics;
  return `# Day Trade Intraday Readiness — ${report.date}\n\nGenerated at: ${report.generated_at}\n\n## Readiness\n\n- readiness_status: ${report.readiness_status}\n- recommendation: ${report.recommendation}\n\n## Block Reasons\n\n${report.block_reasons.length ? report.block_reasons.map((r) => '- ' + r).join('\n') : '- none'}\n\n## Warn Reasons\n\n${report.warn_reasons.length ? report.warn_reasons.map((r) => '- ' + r).join('\n') : '- none'}\n\n## Key Metrics\n\n- candidates: ${m.candidates}\n- provider_matched_count: ${m.provider_matched_count ?? 'n/a'}\n- provider_missing_count: ${m.provider_missing_count ?? 'n/a'}\n- avg_score_delta: ${m.avg_score_delta ?? 'n/a'}\n- max_score_delta: ${m.max_score_delta ?? 'n/a'}\n- priority_label_counts: ${formatObj(m.priority_label_counts)}\n- confirmation_label_counts: ${formatObj(m.confirmation_label_counts)}\n- data_quality counts: ${formatObj(m.data_quality)}\n- cautions: ${m.cautions.length ? m.cautions.join(', ') : 'none'}\n\n## Read-only Confirmation\n\nThis report only reads local generated JSON reports and writes local readiness report artifacts. It does not enable DAYTRADE_INTRADAY_SCORE_ENABLED, write Supabase, send Telegram, add API endpoints, add SQL or migrations, change Dashboard/UI, change cron, change production scoring, or use AI.\n`;
}

async function readJsonFile(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') throw new Error('Input file not found: ' + file); throw e; } }
function extractDate(file, prefix) { const m = path.basename(file).match(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d{4}-\\d{2}-\\d{2})\\.json$')); return m ? m[1] : null; }
async function latestFile(reportsDir, prefix) {
  let entries;
  try { entries = await fs.readdir(reportsDir); } catch (e) { if (e.code === 'ENOENT') throw new Error('Reports directory not found: ' + reportsDir); throw e; }
  const matches = entries.map((name) => ({ name, date: extractDate(name, prefix) })).filter((x) => x.date).sort((a, b) => b.date.localeCompare(a.date));
  if (!matches.length) throw new Error('No latest ' + prefix + '*.json report found in ' + reportsDir);
  return path.join(reportsDir, matches[0].name);
}
async function loadInputs(opts) {
  opts = Object.assign({ reportsDir: DEFAULT_REPORTS_DIR }, opts || {});
  const intradayFile = opts.latest ? await latestFile(opts.reportsDir, INTRADAY_PREFIX) : opts.intradayFile;
  const compareFile = opts.latest ? await latestFile(opts.reportsDir, COMPARE_PREFIX) : opts.compareFile;
  if (!intradayFile) throw new Error('Missing --intraday-file (or use --latest).');
  if (!compareFile) throw new Error('Missing --compare-file (or use --latest).');
  return { intraday: await readJsonFile(intradayFile), compare: await readJsonFile(compareFile), sources: { intraday: intradayFile, compare: compareFile } };
}
async function writeReports(report, opts) {
  const dir = (opts && opts.reportsDir) || DEFAULT_REPORTS_DIR;
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, READINESS_PREFIX + report.date);
  const markdown = base + '.md';
  await fs.writeFile(markdown, markdownReport(report));
  let json = null;
  if (opts && opts.writeJson) { json = base + '.json'; await fs.writeFile(json, JSON.stringify(report, null, 2) + '\n'); }
  return { markdown, json };
}

module.exports = { DEFAULT_REPORTS_DIR, INTRADAY_PREFIX, COMPARE_PREFIX, READINESS_PREFIX, evaluateIntradayReadiness, buildIntradayReadinessReport, markdownReport, readJsonFile, latestFile, loadInputs, writeReports };

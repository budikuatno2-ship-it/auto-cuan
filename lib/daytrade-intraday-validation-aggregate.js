'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const BUNDLE_PREFIX = 'daytrade-intraday-validation-bundle-';
const AGGREGATE_PREFIX = 'daytrade-intraday-validation-aggregate-';

function asArray(v) { return Array.isArray(v) ? v : []; }
function numberOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(v) { return Math.round(numberOrZero(v) * 100) / 100; }
function inc(map, key, by) { if (!key) return; map[key] = (map[key] || 0) + (by == null ? 1 : by); }
function sum(arr) { return arr.reduce((s, v) => s + numberOrZero(v), 0); }
function avg(arr) { return arr.length ? round2(sum(arr) / arr.length) : 0; }
function max(arr) { return arr.length ? Math.max(...arr.map(numberOrZero)) : 0; }
function sortedCounts(map) { return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([ticker, count]) => ({ ticker, count })); }
function repeated(map) { return sortedCounts(map).filter((r) => r.count >= 2); }
function fmtCountRows(rows) { return rows.length ? rows.map((r) => `${r.ticker} (${r.count})`).join(', ') : 'none'; }
function fmtObj(obj) { return '`' + JSON.stringify(obj || {}) + '`'; }
function todayIso(nowMs) { return new Date(nowMs || Date.now()).toISOString().slice(0, 10); }

function dateFromFile(file) {
  const m = path.basename(file).match(/^daytrade-intraday-validation-bundle-(\d{4}-\d{2}-\d{2})\.json$/);
  return m ? m[1] : null;
}

async function listBundleFiles(reportsDir, days) {
  let names;
  try { names = await fs.readdir(reportsDir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names
    .filter((n) => n.startsWith(BUNDLE_PREFIX) && n.endsWith('.json') && dateFromFile(n))
    .sort()
    .slice(-Number(days || 5))
    .map((n) => path.join(reportsDir, n));
}

async function loadBundles(opts) {
  const reportsDir = opts && opts.reportsDir || DEFAULT_REPORTS_DIR;
  const files = await listBundleFiles(reportsDir, opts && opts.days || 5);
  if (!files.length) throw new Error(`No daytrade intraday validation bundle JSON files found in ${reportsDir}`);
  const samples = [];
  for (const file of files) {
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    samples.push(Object.assign({ _file: file, date: report.date || dateFromFile(file) }, report));
  }
  return samples;
}

function parseMover(item) {
  if (item && typeof item === 'object') return { ticker: String(item.ticker || '').toUpperCase(), delta: Number(item.score_delta ?? item.delta) };
  const s = String(item || '');
  const m = s.match(/^([A-Z0-9._-]+)\s*\(([+-]?\d+(?:\.\d+)?)\)/i);
  return m ? { ticker: m[1].toUpperCase().replace(/\.JK$/, ''), delta: Number(m[2]) } : { ticker: s.trim().split(/\s+/)[0].toUpperCase(), delta: NaN };
}

function sampleAvgAbsoluteScoreDelta(sample) {
  const direct = Number(sample && sample.avg_absolute_score_delta);
  if (Number.isFinite(direct)) return direct;
  const summary = sample && sample.score_delta_summary || sample && sample.score_delta_metrics;
  const summaryAvg = Number(summary && summary.avg_absolute_score_delta);
  if (Number.isFinite(summaryAvg)) return summaryAvg;
  const comparisonAvg = Number(sample && sample.comparison && sample.comparison.metrics && sample.comparison.metrics.avg_absolute_score_delta);
  return Number.isFinite(comparisonAvg) ? comparisonAvg : null;
}

function buildAggregateReport(samples, opts) {
  samples = asArray(samples).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const sampleCount = samples.length;
  const statusCounts = { PASS: 0, WARN: 0, BLOCK: 0 };
  const providerMatched = [];
  const providerMissing = [];
  const noCounts = [], incompleteCounts = [], unknownCounts = [], avgAbsScoreDeltas = [];
  const noTickerCounts = {}, incompleteTickerCounts = {}, unknownTickerCounts = {}, blockerCounts = {}, moverCounts = {}, enteringCounts = {}, leavingCounts = {};
  let cautionSamples = 0, churnSamples = 0;

  for (const s of samples) {
    inc(statusCounts, s.validation_status || 'UNKNOWN');
    providerMatched.push(s.provider_matched_count);
    providerMissing.push(s.provider_missing_count);
    const dq = s.data_quality_counts || {};
    noCounts.push(dq.NO_INTRADAY_DATA || 0);
    incompleteCounts.push(dq.INCOMPLETE_INTRADAY || 0);
    const priorityUnknown = Number(s.priority_label_counts && s.priority_label_counts.INTRADAY_UNKNOWN || 0);
    const confirmationUnknown = Number(s.confirmation_label_counts && s.confirmation_label_counts.INTRADAY_UNKNOWN || 0);
    const tickerUnknown = asArray(s.intraday_unknown_tickers).length;
    const unknown = priorityUnknown + confirmationUnknown || tickerUnknown;
    unknownCounts.push(unknown);
    if ((s.confirmation_label_counts && s.confirmation_label_counts.INTRADAY_CAUTION || 0) / Math.max(1, numberOrZero(s.intraday_candidates_count)) >= 0.5) cautionSamples++;
    const churn = asArray(s.top5_entering).length + asArray(s.top5_leaving).length;
    if (churn > 0) churnSamples++;
    for (const t of asArray(s.no_intraday_data_tickers)) { inc(noTickerCounts, t); inc(blockerCounts, t); }
    for (const t of asArray(s.incomplete_intraday_tickers)) { inc(incompleteTickerCounts, t); inc(blockerCounts, t); }
    for (const t of asArray(s.intraday_unknown_tickers)) { inc(unknownTickerCounts, t); inc(blockerCounts, t); }
    for (const t of asArray(s.top5_entering)) inc(enteringCounts, t);
    for (const t of asArray(s.top5_leaving)) inc(leavingCounts, t);
    for (const item of asArray(s.top_score_movers)) { const p = parseMover(item); inc(moverCounts, p.ticker); }
    const sampleAvgDelta = sampleAvgAbsoluteScoreDelta(s);
    if (sampleAvgDelta !== null) avgAbsScoreDeltas.push(sampleAvgDelta);
  }

  const metrics = {
    average_provider_matched_count: avg(providerMatched),
    total_provider_missing_count: sum(providerMissing),
    no_intraday_data: { average: avg(noCounts), max: max(noCounts) },
    incomplete_intraday: { average: avg(incompleteCounts), max: max(incompleteCounts) },
    intraday_unknown: { average: avg(unknownCounts), max: max(unknownCounts) },
    repeated_intraday_caution_ratio: sampleCount ? round2(cautionSamples / sampleCount) : 0,
    top5_churn_ratio: sampleCount ? round2(churnSamples / sampleCount) : 0,
    avg_absolute_score_delta: avg(avgAbsScoreDeltas)
  };
  const blockReasons = [];
  if (sampleCount < 3) blockReasons.push('sample_count < 3');
  if (providerMissing.some((v) => numberOrZero(v) > 0)) blockReasons.push('provider_missing_count > 0 in at least one sample');
  if (noCounts.some((v) => numberOrZero(v) > 0)) blockReasons.push('NO_INTRADAY_DATA count > 0 in at least one sample');
  if (incompleteCounts.some((v) => numberOrZero(v) > 0)) blockReasons.push('INCOMPLETE_INTRADAY count > 0 in at least one sample');
  if (unknownCounts.some((v) => numberOrZero(v) > 0)) blockReasons.push('INTRADAY_UNKNOWN count > 0 in at least one sample');
  if (statusCounts.BLOCK > 0) blockReasons.push('BLOCK appears in at least one sample');
  const warnReasons = [];
  if (!blockReasons.length && metrics.repeated_intraday_caution_ratio >= 0.5) warnReasons.push('repeated INTRADAY_CAUTION ratio >= 50%');
  if (!blockReasons.length && metrics.top5_churn_ratio >= 0.5) warnReasons.push('top5 churn appears in >= 50% samples');
  if (!blockReasons.length && metrics.avg_absolute_score_delta > 5) warnReasons.push('avg absolute score delta > 5');
  const aggregateStatus = blockReasons.length ? 'BLOCK' : warnReasons.length ? 'WARN' : 'PASS';
  const dateRange = { start: samples[0] && samples[0].date, end: samples[samples.length - 1] && samples[samples.length - 1].date };
  return {
    date: todayIso(opts && opts.nowMs), generated_at: new Date(opts && opts.nowMs || Date.now()).toISOString(), aggregate_status: aggregateStatus,
    recommendation: aggregateStatus === 'PASS' ? 'Intraday validation is stable across sessions; keep production scoring defaults unchanged until separately approved.' : aggregateStatus === 'WARN' ? 'Investigate recurring caution/churn before enabling production intraday scoring.' : 'Do not enable production intraday scoring; resolve recurring data-quality/provider blockers first.',
    sample_count: sampleCount, date_range: dateRange, samples: samples.map((s) => ({ date: s.date, file: s._file, validation_status: s.validation_status })), status_counts: statusCounts,
    metrics, block_reasons: blockReasons, warn_reasons: warnReasons,
    repeated_no_intraday_data_tickers: repeated(noTickerCounts), repeated_incomplete_intraday_tickers: repeated(incompleteTickerCounts), repeated_intraday_unknown_tickers: repeated(unknownTickerCounts),
    top_recurring_blockers: sortedCounts(blockerCounts).slice(0, 10), top_recurring_score_movers: sortedCounts(moverCounts).slice(0, 10), top5_entering_frequency: sortedCounts(enteringCounts).slice(0, 10), top5_leaving_frequency: sortedCounts(leavingCounts).slice(0, 10),
    read_only_confirmation: 'This aggregate report only reads local validation bundle JSON files and writes local aggregate report artifacts. It does not enable DAYTRADE_INTRADAY_SCORE_ENABLED, change production scoring defaults, send Telegram, write Supabase, add API endpoints, add SQL or migrations, change Dashboard/UI, change cron, or use AI.'
  };
}

function markdownReport(r) {
  return `# Day Trade Intraday Validation Aggregate — ${r.date}\n\nGenerated at: ${r.generated_at}\n\n## Aggregate Status\n\n- aggregate_status: ${r.aggregate_status}\n- recommendation: ${r.recommendation}\n- sample_count: ${r.sample_count}\n- date range: ${r.date_range.start || 'n/a'} to ${r.date_range.end || 'n/a'}\n\n## Samples Included\n\n${r.samples.map((s) => `- ${s.date}: ${s.validation_status} (${s.file})`).join('\n')}\n\n## Status Counts\n\n- status counts: ${fmtObj(r.status_counts)}\n- block reasons: ${r.block_reasons.length ? r.block_reasons.join('; ') : 'none'}\n- warn reasons: ${r.warn_reasons.length ? r.warn_reasons.join('; ') : 'none'}\n\n## Recurring Blocker Tickers\n\n- top recurring blockers: ${fmtCountRows(r.top_recurring_blockers)}\n- recurring no_intraday_data tickers: ${fmtCountRows(r.repeated_no_intraday_data_tickers)}\n- recurring incomplete_intraday tickers: ${fmtCountRows(r.repeated_incomplete_intraday_tickers)}\n- recurring intraday_unknown tickers: ${fmtCountRows(r.repeated_intraday_unknown_tickers)}\n\n## Provider Metrics\n\n- average provider_matched_count: ${r.metrics.average_provider_matched_count}\n- total provider_missing_count: ${r.metrics.total_provider_missing_count}\n- NO_INTRADAY_DATA average/max: ${r.metrics.no_intraday_data.average}/${r.metrics.no_intraday_data.max}\n- INCOMPLETE_INTRADAY average/max: ${r.metrics.incomplete_intraday.average}/${r.metrics.incomplete_intraday.max}\n- INTRADAY_UNKNOWN average/max: ${r.metrics.intraday_unknown.average}/${r.metrics.intraday_unknown.max}\n\n## Score Delta Summary\n\n- avg absolute score delta: ${r.metrics.avg_absolute_score_delta}\n- top recurring score movers: ${fmtCountRows(r.top_recurring_score_movers)}\n- top5_entering frequency: ${fmtCountRows(r.top5_entering_frequency)}\n- top5_leaving frequency: ${fmtCountRows(r.top5_leaving_frequency)}\n- repeated INTRADAY_CAUTION ratio: ${r.metrics.repeated_intraday_caution_ratio}\n- top5 churn ratio: ${r.metrics.top5_churn_ratio}\n\n## Read-only Confirmation\n\n${r.read_only_confirmation}\n`;
}

async function writeReports(report, opts) {
  const dir = opts && opts.reportsDir || DEFAULT_REPORTS_DIR;
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, AGGREGATE_PREFIX + report.date);
  const paths = { markdown: base + '.md' };
  await fs.writeFile(paths.markdown, markdownReport(report));
  if (opts && opts.writeJson) { paths.json = base + '.json'; await fs.writeFile(paths.json, JSON.stringify(report, null, 2) + '\n'); }
  return paths;
}

module.exports = { DEFAULT_REPORTS_DIR, BUNDLE_PREFIX, AGGREGATE_PREFIX, listBundleFiles, loadBundles, buildAggregateReport, markdownReport, writeReports, parseMover, sampleAvgAbsoluteScoreDelta };

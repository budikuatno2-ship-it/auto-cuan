#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const readinessLib = require('../lib/daytrade-intraday-readiness');
const BUNDLE_PREFIX = 'daytrade-intraday-validation-bundle-';
const INTRADAY_PREFIX = 'daytrade-intraday-observe-';
const COMPARE_PREFIX = 'daytrade-adjusted-vs-normal-';
const READINESS_PREFIX = 'daytrade-intraday-readiness-';

function parseArgs(argv) {
  const args = {
    limit: '30',
    reportsDir: path.resolve(process.cwd(), 'data', 'reports'),
    logsFile: path.resolve(process.cwd(), 'logs', 'daytrade-vps-worker', 'runs.jsonl'),
    writeJson: false,
    skipIntradayObserve: false,
    tickers: ''
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a === '--skip-intraday-observe') args.skipIntradayObserve = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

function childEnv(baseEnv, overrides) {
  const env = Object.assign({}, baseEnv || process.env, overrides || {});
  if (env.TELEGRAM_ENABLED === undefined) env.TELEGRAM_ENABLED = '0';
  return env;
}

function normalObserveEnv(baseEnv) {
  const env = childEnv(baseEnv);
  delete env.DAYTRADE_INTRADAY_SCORE_ENABLED;
  return env;
}

function adjustedObserveEnv(baseEnv) {
  return childEnv(baseEnv, { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' });
}

function commandPlan(args) {
  const limit = String(args.limit || '30');
  const reportsDir = args.reportsDir;
  const logsFile = args.logsFile;
  const tickers = args.tickers;
  const plan = [];
  if (!args.skipIntradayObserve) {
    plan.push({ name: 'intraday observe', cmd: process.execPath, args: ['tools/report-daytrade-intraday-observe.js', '--limit', limit, '--json', '--output-dir', reportsDir], envKind: 'safe' });
  }
  plan.push({ name: 'normal observe', cmd: process.execPath, args: ['tools/daytrade-vps-worker-observe.js', '--mode', 'observe', '--tickers', tickers], envKind: 'normal' });
  plan.push({ name: 'adjusted observe', cmd: process.execPath, args: ['tools/daytrade-vps-worker-observe.js', '--mode', 'observe', '--tickers', tickers, '--latest-intraday-adjustments', '--intraday-reports-dir', reportsDir], envKind: 'adjusted' });
  plan.push({ name: 'adjusted-vs-normal report', cmd: process.execPath, args: ['tools/report-daytrade-adjusted-vs-normal.js', '--logs-file', logsFile, '--output-dir', reportsDir, '--json'], envKind: 'safe' });
  plan.push({ name: 'readiness report', cmd: process.execPath, args: ['tools/report-daytrade-intraday-readiness.js', '--latest', '--reports-dir', reportsDir, '--json'], envKind: 'safe' });
  return plan;
}

function envForStep(step, baseEnv) {
  if (step.envKind === 'normal') return normalObserveEnv(baseEnv);
  if (step.envKind === 'adjusted') return adjustedObserveEnv(baseEnv);
  return childEnv(baseEnv);
}

function runStep(step, baseEnv) {
  const res = spawnSync(step.cmd, step.args, { stdio: 'inherit', env: envForStep(step, baseEnv) });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${step.name} failed with exit code ${res.status}`);
}

function asArray(v) { return Array.isArray(v) ? v : []; }
function uniqueTickers(rows) { return Array.from(new Set(asArray(rows).map((r) => String(r && r.ticker || '').trim().toUpperCase()).filter(Boolean))); }
function tickersBy(rows, pred) { return uniqueTickers(asArray(rows).filter(pred)); }
function fmtList(arr) { return arr && arr.length ? arr.join(', ') : 'none'; }
function fmtObj(obj) { return '`' + JSON.stringify(obj || {}) + '`'; }
function bundleRows(intraday, compare) {
  const compareByTicker = new Map(finiteScoreDeltaRows(compare).map((r) => [String(r.ticker || '').trim().toUpperCase(), r]));
  const seen = new Set();
  const out = [];
  for (const row of asArray(intraday && intraday.rows)) {
    const ticker = String(row && row.ticker || '').trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const cmp = compareByTicker.get(ticker) || {};
    out.push({
      ticker,
      data_quality: row.data_quality || null,
      intraday_priority_label: row.intraday_priority_label || null,
      intraday_confirmation_label: row.intraday_confirmation_label || null,
      intraday_score_adjustment_preview: row.intraday_score_adjustment_preview ?? null,
      intraday_labels: row.intraday_labels || [],
      ...(Number.isFinite(Number(cmp.score_delta)) ? { score_delta: Number(cmp.score_delta) } : {}),
      ...((row.normal_rank ?? cmp.normal_rank) != null ? { normal_rank: row.normal_rank ?? cmp.normal_rank } : {}),
      ...((row.adjusted_rank ?? cmp.adjusted_rank) != null ? { adjusted_rank: row.adjusted_rank ?? cmp.adjusted_rank } : {})
    });
  }
  return out;
}

function finiteScoreDeltaRows(compare) {
  return asArray(compare && compare.comparison && compare.comparison.rows)
    .map((r) => ({ ticker: r && r.ticker, score_delta: Number(r && r.score_delta), normal_rank: r && r.normal_rank, adjusted_rank: r && r.adjusted_rank }))
    .filter((r) => Number.isFinite(r.score_delta));
}

function topScoreMovers(compare, n) {
  return finiteScoreDeltaRows(compare)
    .sort((a, b) => Math.abs(b.score_delta) - Math.abs(a.score_delta))
    .slice(0, n || 10)
    .map((r) => `${r.ticker} (${r.score_delta >= 0 ? '+' : ''}${r.score_delta})`);
}

function scoreDeltaSummary(compare) {
  const rows = finiteScoreDeltaRows(compare);
  const deltas = rows.map((r) => Math.abs(r.score_delta));
  const count = deltas.length;
  const total = deltas.reduce((sum, v) => sum + v, 0);
  return {
    score_delta_count: count,
    avg_absolute_score_delta: count ? Math.round((total / count) * 100) / 100 : 0,
    max_absolute_score_delta: count ? Math.max(...deltas) : 0
  };
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function latestReport(dir, prefix) { return readinessLib.latestFile(dir, prefix); }
function dateFromReport(report, file, prefix) { return readinessLib.reportDate(report, file, prefix); }

function buildBundleReport(input) {
  const intraday = input.intraday;
  const compare = input.compare;
  const readiness = input.readiness;
  const rows = bundleRows(intraday, compare);
  const m = readiness.metrics || {};
  const cm = compare.comparison && compare.comparison.metrics || {};
  const noData = tickersBy(rows, (r) => r && r.data_quality === 'NO_INTRADAY_DATA');
  const incomplete = tickersBy(rows, (r) => r && r.data_quality === 'INCOMPLETE_INTRADAY');
  const unknown = tickersBy(rows, (r) => r && (r.intraday_priority_label === 'INTRADAY_UNKNOWN' || r.intraday_confirmation_label === 'INTRADAY_UNKNOWN'));
  const scoreDeltas = scoreDeltaSummary(compare);
  return {
    date: readiness.date || intraday.date || compare.date,
    generated_at: new Date().toISOString(),
    validation_status: readiness.readiness_status,
    recommendation: readiness.recommendation,
    intraday_candidates_count: m.candidates,
    provider_matched_count: m.provider_matched_count,
    provider_missing_count: m.provider_missing_count,
    data_quality_counts: m.data_quality || {},
    priority_label_counts: m.priority_label_counts || {},
    confirmation_label_counts: m.confirmation_label_counts || {},
    cautions: m.cautions || [],
    top5_entering: cm.top5_entering || [],
    top5_leaving: cm.top5_leaving || [],
    score_delta_count: scoreDeltas.score_delta_count,
    avg_absolute_score_delta: scoreDeltas.avg_absolute_score_delta,
    max_absolute_score_delta: scoreDeltas.max_absolute_score_delta,
    top_score_movers: topScoreMovers(compare, 10),
    rows,
    no_intraday_data_tickers: noData,
    incomplete_intraday_tickers: incomplete,
    intraday_unknown_tickers: unknown,
    paths: input.paths,
    read_only_confirmation: 'Local/VPS observe-only bundle. Does not enable production scoring, set Vercel env, send Telegram, write Supabase, add API endpoints, add SQL/migrations, change Dashboard/UI, change cron, or use AI.'
  };
}

function markdownReport(report) {
  return `# Day Trade Intraday Validation Bundle — ${report.date}\n\nGenerated at: ${report.generated_at}\n\n## Validation\n\n- validation_status: ${report.validation_status}\n- recommendation: ${report.recommendation}\n- intraday candidates count: ${report.intraday_candidates_count}\n- provider_matched_count: ${report.provider_matched_count ?? 'n/a'}\n- provider_missing_count: ${report.provider_missing_count ?? 'n/a'}\n- data_quality counts: ${fmtObj(report.data_quality_counts)}\n- priority_label_counts: ${fmtObj(report.priority_label_counts)}\n- confirmation_label_counts: ${fmtObj(report.confirmation_label_counts)}\n- cautions: ${fmtList(report.cautions)}\n\n## Movement\n\n- top5_entering: ${fmtList(report.top5_entering)}\n- top5_leaving: ${fmtList(report.top5_leaving)}\n- top score movers: ${fmtList(report.top_score_movers)}\n\n## Data Quality Tickers\n\n- no_intraday_data tickers: ${fmtList(report.no_intraday_data_tickers)}\n- incomplete_intraday tickers: ${fmtList(report.incomplete_intraday_tickers)}\n- intraday_unknown tickers: ${fmtList(report.intraday_unknown_tickers)}\n\n## Generated Reports\n\n- intraday observe: ${report.paths.intraday}\n- adjusted-vs-normal: ${report.paths.compare}\n- readiness: ${report.paths.readiness}\n- bundle markdown: ${report.paths.markdown}\n${report.paths.json ? `- bundle json: ${report.paths.json}\n` : ''}\n## Read-only Confirmation\n\n${report.read_only_confirmation}\n`;
}

async function writeBundle(report, opts) {
  await fs.mkdir(opts.reportsDir, { recursive: true });
  const base = path.join(opts.reportsDir, BUNDLE_PREFIX + report.date);
  report.paths.markdown = base + '.md';
  if (opts.writeJson) report.paths.json = base + '.json';
  await fs.writeFile(report.paths.markdown, markdownReport(report));
  if (report.paths.json) await fs.writeFile(report.paths.json, JSON.stringify(report, null, 2) + '\n');
  return report.paths;
}

async function prepare(args, runner) {
  const reportsDir = args.reportsDir;
  if (!args.skipIntradayObserve) (runner || runStep)(commandPlan(Object.assign({}, args, { tickers: '' }))[0], process.env);
  const intradayFile = await latestReport(reportsDir, INTRADAY_PREFIX);
  const intraday = await readJson(intradayFile);
  let tickers = args.tickers || uniqueTickers(intraday.rows).join(',');
  if (!tickers) throw new Error('Latest intraday observe report has zero candidates; cannot run validation bundle.');
  const plan = commandPlan(Object.assign({}, args, { tickers })).filter((s) => s.name !== 'intraday observe');
  for (const step of plan) (runner || runStep)(step, process.env);
  const compareFile = await latestReport(reportsDir, COMPARE_PREFIX);
  const readinessFile = await latestReport(reportsDir, READINESS_PREFIX);
  const compare = await readJson(compareFile);
  const readiness = await readJson(readinessFile);
  const intradayDate = dateFromReport(intraday, intradayFile, INTRADAY_PREFIX);
  const compareDate = dateFromReport(compare, compareFile, COMPARE_PREFIX);
  const readinessDate = dateFromReport(readiness, readinessFile, READINESS_PREFIX);
  if (intradayDate !== compareDate || intradayDate !== readinessDate) throw new Error(`Generated report dates mismatch: intraday=${intradayDate} compare=${compareDate} readiness=${readinessDate}`);
  return { intraday, compare, readiness, paths: { intraday: intradayFile, compare: compareFile, readiness: readinessFile } };
}

async function main() {
  const args = parseArgs(process.argv);
  const input = await prepare(args);
  const report = buildBundleReport(input);
  const paths = await writeBundle(report, args);
  console.log(markdownReport(report));
  console.log('Bundle written:');
  console.log('- markdown: ' + paths.markdown);
  if (paths.json) console.log('- json: ' + paths.json);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });

module.exports = { parseArgs, childEnv, normalObserveEnv, adjustedObserveEnv, commandPlan, envForStep, uniqueTickers, buildBundleReport, markdownReport, prepare, writeBundle, finiteScoreDeltaRows, scoreDeltaSummary, bundleRows, BUNDLE_PREFIX };

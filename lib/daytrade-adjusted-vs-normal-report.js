'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_LOGS_FILE = path.resolve(process.cwd(), 'logs', 'daytrade-vps-worker', 'runs.jsonl');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'data', 'reports');
const TOP5 = 5;
const TOP20 = 20;

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.candidates)) return value.candidates;
  if (Array.isArray(value.top_candidates)) return value.top_candidates;
  return [];
}

function normalizeTicker(value) { return String(value || '').trim().toUpperCase(); }
function numberOrNull(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function firstDefined(row, keys) { for (const key of keys) if (row && row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key]; return null; }
function list(value) { if (Array.isArray(value)) return value.filter(Boolean).map(String); if (value === null || value === undefined || value === '') return []; return String(value).split(/[,;|]/).map((s) => s.trim()).filter(Boolean); }

function normalizeCandidate(row, index) {
  row = row || {};
  return {
    ticker: normalizeTicker(firstDefined(row, ['ticker', 'symbol', 'code'])),
    score: numberOrNull(firstDefined(row, ['daytrade_score', 'score', 'daily_score'])),
    rank: index + 1,
    status: firstDefined(row, ['final_status', 'status', 'action_label']),
    intraday_priority_label: firstDefined(row, ['intraday_priority_label']),
    intraday_confirmation_label: firstDefined(row, ['intraday_confirmation_label']),
    intraday_score_adjustment_applied: numberOrNull(firstDefined(row, ['intraday_score_adjustment_applied', 'intraday_score_adjustment_preview'])),
    intraday_labels: list(firstDefined(row, ['intraday_labels'])),
    reasons: list(firstDefined(row, ['intraday_score_adjustment_reasons', 'reasons', 'key_reasons', 'notes'])),
    raw: row
  };
}

function rowsFromRun(run) { return asArray(run && (run.results || run.candidates || run.top_candidates || run.data || run)); }
function indexByTicker(rows) { const map = new Map(); asArray(rows).map(normalizeCandidate).forEach((r) => { if (r.ticker) map.set(r.ticker, r); }); return map; }
function countBy(rows, key) { return rows.reduce((acc, r) => { const v = r[key] || 'n/a'; acc[v] = (acc[v] || 0) + 1; return acc; }, {}); }
function topSet(rows, n) { return new Set(rows.slice(0, n).map((r) => r.ticker).filter(Boolean)); }
function setDiff(a, b) { return Array.from(a).filter((x) => !b.has(x)); }

function compareRuns(normalRun, adjustedRun) {
  const normalRows = rowsFromRun(normalRun).map(normalizeCandidate).filter((r) => r.ticker);
  const adjustedRows = rowsFromRun(adjustedRun).map(normalizeCandidate).filter((r) => r.ticker);
  const normal = indexByTicker(normalRows);
  const adjusted = indexByTicker(adjustedRows);
  const tickers = Array.from(new Set([...normal.keys(), ...adjusted.keys()])).sort();
  const rows = [];
  const deltas = [];
  const metrics = {
    normal_count: normal.size,
    adjusted_count: adjusted.size,
    matched_tickers: 0,
    normal_only: [],
    adjusted_only: [],
    avg_score_delta: null,
    max_score_delta: null,
    promoted_count: 0,
    demoted_count: 0,
    unchanged_count: 0,
    top5_entering: setDiff(topSet(adjustedRows, TOP5), topSet(normalRows, TOP5)),
    top5_leaving: setDiff(topSet(normalRows, TOP5), topSet(adjustedRows, TOP5)),
    top20_entering: setDiff(topSet(adjustedRows, TOP20), topSet(normalRows, TOP20)),
    top20_leaving: setDiff(topSet(normalRows, TOP20), topSet(adjustedRows, TOP20)),
    priority_label_counts: countBy(adjustedRows, 'intraday_priority_label'),
    confirmation_label_counts: countBy(adjustedRows, 'intraday_confirmation_label'),
    provider_matched_count: adjustedRun && adjustedRun.intraday_adjustment_matched != null ? Number(adjustedRun.intraday_adjustment_matched) : null,
    provider_missing_count: adjustedRun && adjustedRun.intraday_adjustment_missing != null ? Number(adjustedRun.intraday_adjustment_missing) : null,
    cautions: []
  };
  for (const ticker of tickers) {
    const n = normal.get(ticker); const a = adjusted.get(ticker);
    if (!n) { metrics.adjusted_only.push(ticker); continue; }
    if (!a) { metrics.normal_only.push(ticker); continue; }
    metrics.matched_tickers++;
    const scoreDelta = n.score !== null && a.score !== null ? Number((a.score - n.score).toFixed(4)) : null;
    if (scoreDelta !== null) deltas.push(scoreDelta);
    const rankDelta = a.rank - n.rank;
    if (rankDelta < 0) metrics.promoted_count++; else if (rankDelta > 0) metrics.demoted_count++; else metrics.unchanged_count++;
    rows.push({ ticker, normal_score: n.score, adjusted_score: a.score, score_delta: scoreDelta, normal_rank: n.rank, adjusted_rank: a.rank, rank_delta: rankDelta, normal_status: n.status, adjusted_status: a.status, intraday_priority_label: a.intraday_priority_label, intraday_confirmation_label: a.intraday_confirmation_label, intraday_score_adjustment_applied: a.intraday_score_adjustment_applied, key_reasons: a.reasons.length ? a.reasons : a.intraday_labels });
  }
  if (deltas.length) {
    metrics.avg_score_delta = Number((deltas.reduce((s, n) => s + n, 0) / deltas.length).toFixed(4));
    metrics.max_score_delta = Number(Math.max.apply(null, deltas.map(Math.abs)).toFixed(4));
  }
  metrics.cautions = deriveCautions(metrics, adjustedRows);
  return { metrics, rows: rows.sort((a, b) => a.adjusted_rank - b.adjusted_rank) };
}

function deriveCautions(metrics, adjustedRows) {
  const cautions = [];
  if (metrics.matched_tickers < Math.min(5, Math.max(metrics.normal_count, metrics.adjusted_count))) cautions.push('LOW_MATCHED_TICKER_COUNT');
  if (metrics.top5_entering.length + metrics.top5_leaving.length >= 4) cautions.push('LARGE_TOP5_CHURN');
  const unknown = adjustedRows.filter((r) => r.intraday_confirmation_label === 'INTRADAY_UNKNOWN' || r.intraday_priority_label === 'INTRADAY_UNKNOWN').length;
  const chase = adjustedRows.filter((r) => r.intraday_labels.includes('CHASE_RISK')).length;
  const below = adjustedRows.filter((r) => r.intraday_labels.includes('BELOW_VWAP_RISK')).length;
  if (unknown >= Math.max(3, adjustedRows.length * 0.3)) cautions.push('MANY_INTRADAY_UNKNOWN');
  if (chase >= Math.max(3, adjustedRows.length * 0.3)) cautions.push('MANY_CHASE_RISK');
  if (below >= Math.max(3, adjustedRows.length * 0.3)) cautions.push('MANY_BELOW_VWAP_RISK');
  if (metrics.provider_missing_count !== null && metrics.provider_missing_count > 0) cautions.push('STALE_OR_INCOMPLETE_INTRADAY_DATA');
  return cautions;
}

async function readJsonFile(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') throw new Error('Input file not found: ' + file); throw e; } }
async function readJsonlRuns(file) { try { return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { if (e.code === 'ENOENT') throw new Error('Logs file not found: ' + file); throw e; } }
function findLatestRun(runs, predicate) { return runs.filter(predicate).sort((a, b) => Date.parse(b.ended_at || b.started_at || 0) - Date.parse(a.ended_at || a.started_at || 0))[0] || null; }
async function loadInputs(opts) {
  if (opts.normalFile && opts.adjustedFile) return { normal: await readJsonFile(opts.normalFile), adjusted: await readJsonFile(opts.adjustedFile), sources: { normal: opts.normalFile, adjusted: opts.adjustedFile } };
  const runs = await readJsonlRuns(opts.logsFile || DEFAULT_LOGS_FILE);
  const normal = findLatestRun(runs, (r) => !r.intraday_score_enabled && !r.intraday_adjustment_provider_used);
  const adjusted = findLatestRun(runs, (r) => r.intraday_adjustment_provider_used === true && r.intraday_score_enabled === true);
  if (!normal) throw new Error('No latest normal observe run found in JSONL.');
  if (!adjusted) throw new Error('No latest adjusted observe run found in JSONL.');
  return { normal, adjusted, sources: { logs: opts.logsFile || DEFAULT_LOGS_FILE } };
}
function today() { return new Date().toISOString().slice(0, 10); }
function markdownReport(report) {
  const m = report.comparison.metrics;
  const fmt = (arr) => arr.length ? arr.join(', ') : 'none';
  const body = report.comparison.rows.slice(0, 50).map((r) => `| ${r.ticker} | ${r.normal_score ?? 'n/a'} | ${r.adjusted_score ?? 'n/a'} | ${r.score_delta ?? 'n/a'} | ${r.normal_rank} | ${r.adjusted_rank} | ${r.rank_delta} | ${r.normal_status || 'n/a'} | ${r.adjusted_status || 'n/a'} | ${r.intraday_priority_label || 'n/a'} | ${r.intraday_confirmation_label || 'n/a'} | ${r.intraday_score_adjustment_applied ?? 'n/a'} | ${(r.key_reasons || []).join('; ') || 'n/a'} |`).join('\n') || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |';
  return `# Day Trade Adjusted vs Normal Observe — ${report.date}\n\nGenerated at: ${report.generated_at}\n\n## Summary\n\n- normal_count: ${m.normal_count}\n- adjusted_count: ${m.adjusted_count}\n- matched_tickers: ${m.matched_tickers}\n- normal_only: ${fmt(m.normal_only)}\n- adjusted_only: ${fmt(m.adjusted_only)}\n- avg_score_delta: ${m.avg_score_delta ?? 'n/a'}\n- max_score_delta: ${m.max_score_delta ?? 'n/a'}\n- promoted_count: ${m.promoted_count}\n- demoted_count: ${m.demoted_count}\n- unchanged_count: ${m.unchanged_count}\n- top5_entering: ${fmt(m.top5_entering)}\n- top5_leaving: ${fmt(m.top5_leaving)}\n- top20_entering: ${fmt(m.top20_entering)}\n- top20_leaving: ${fmt(m.top20_leaving)}\n- priority_label_counts: ${JSON.stringify(m.priority_label_counts)}\n- confirmation_label_counts: ${JSON.stringify(m.confirmation_label_counts)}\n- provider_matched_count: ${m.provider_matched_count ?? 'n/a'}\n- provider_missing_count: ${m.provider_missing_count ?? 'n/a'}\n\n## Cautions\n\n${m.cautions.length ? m.cautions.map((c) => '- ' + c).join('\n') : '- none'}\n\n## Per Ticker\n\n| Ticker | Normal Score | Adjusted Score | Score Delta | Normal Rank | Adjusted Rank | Rank Delta | Normal Status | Adjusted Status | Priority | Confirmation | Applied | Key Reasons |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | --- |\n${body}\n\n## Read-only Confirmation\n\nThis report only reads observe files or local JSONL logs and writes local report artifacts. It does not write Supabase, send Telegram, add API endpoints, alter UI, add SQL, change cron, or enable production scoring defaults.\n`;
}
async function writeReports(report, opts) { const dir = opts.outputDir || DEFAULT_OUTPUT_DIR; await fs.mkdir(dir, { recursive: true }); const base = path.join(dir, 'daytrade-adjusted-vs-normal-' + report.date); const markdown = base + '.md'; await fs.writeFile(markdown, markdownReport(report)); let json = null; if (opts.writeJson) { json = base + '.json'; await fs.writeFile(json, JSON.stringify(report, null, 2) + '\n'); } return { markdown, json }; }
function buildReport(normal, adjusted, sources, opts) { const date = (opts && opts.date) || today(); return { date, generated_at: new Date().toISOString(), sources: sources || {}, comparison: compareRuns(normal, adjusted) }; }

module.exports = { DEFAULT_LOGS_FILE, DEFAULT_OUTPUT_DIR, asArray, normalizeCandidate, compareRuns, deriveCautions, readJsonFile, readJsonlRuns, findLatestRun, loadInputs, markdownReport, writeReports, buildReport };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_LOGS_FILE = path.resolve(process.cwd(), 'logs', 'daytrade-vps-worker', 'runs.jsonl');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'data', 'reports');
const DEFAULT_LEVEL_TOLERANCE = 0.01;

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.candidates)) return value.candidates;
  if (Array.isArray(value.top_candidates)) return value.top_candidates;
  return [];
}

function normalizeTicker(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return null;
}

function normalizeCandidate(row) {
  row = row || {};
  const ticker = normalizeTicker(firstDefined(row, ['ticker', 'symbol', 'code']));
  const entry1 = numberOrNull(firstDefined(row, ['entry1', 'entry_low', 'entry', 'buy_price']));
  const entry2 = numberOrNull(firstDefined(row, ['entry2', 'entry_high']));
  const tp1 = numberOrNull(firstDefined(row, ['tp1', 'take_profit_1']));
  const tp2 = numberOrNull(firstDefined(row, ['tp2', 'take_profit_2']));
  const sl = numberOrNull(firstDefined(row, ['sl', 'stop_loss', 'stoploss']));
  const score = numberOrNull(firstDefined(row, ['daytrade_score', 'score', 'daily_score']));
  return {
    ticker,
    score,
    status: firstDefined(row, ['final_status', 'status', 'action_label']),
    entry1,
    entry2,
    tp1,
    tp2,
    sl,
    rr: numberOrNull(firstDefined(row, ['rr', 'risk_reward', 'riskReward'])),
    risk_label: firstDefined(row, ['risk_label', 'derived_risk', 'risk']),
    rejection_reason: firstDefined(row, ['rejection_reason', 'fail_reason', 'reason', 'final_quality_status', 'gate_bucket_reason']),
    freshness: firstDefined(row, ['cache_status', 'freshness', 'data_freshness_status', 'data_quality_status', 'calculated_at', 'updated_at']),
    raw: row
  };
}

function indexByTicker(rows) {
  const map = new Map();
  for (const row of asArray(rows).map(normalizeCandidate)) {
    if (row.ticker) map.set(row.ticker, row);
  }
  return map;
}

function isLevelMismatch(a, b, tolerance) {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(a - b) > tolerance;
}

function compareDayTrade(localRows, productionRows, opts) {
  opts = opts || {};
  const tolerance = Number(opts.levelTolerance == null ? DEFAULT_LEVEL_TOLERANCE : opts.levelTolerance);
  const limit = Number(opts.limit == null ? 10 : opts.limit);
  const local = indexByTicker(localRows);
  const prod = indexByTicker(productionRows);
  const tickers = Array.from(new Set([].concat(Array.from(local.keys()), Array.from(prod.keys())))).sort();
  const rows = [];
  const metrics = {
    local_count: local.size,
    production_count: prod.size,
    matched_tickers: 0,
    local_only: [],
    production_only: [],
    score_delta_avg: null,
    score_delta_max: null,
    level_delta_counts: { entry1: 0, entry2: 0, tp1: 0, tp2: 0, sl: 0, rr: 0 },
    status_mismatch_count: 0,
    risk_label_mismatch_count: 0,
    top_mismatches_by_score_delta: [],
    possible_cause_notes: []
  };
  const scoreDeltas = [];

  for (const ticker of tickers) {
    const l = local.get(ticker) || null;
    const p = prod.get(ticker) || null;
    if (!l) { metrics.production_only.push(ticker); continue; }
    if (!p) { metrics.local_only.push(ticker); continue; }
    metrics.matched_tickers++;
    const scoreDelta = l.score !== null && p.score !== null ? Number((l.score - p.score).toFixed(4)) : null;
    if (scoreDelta !== null) scoreDeltas.push(Math.abs(scoreDelta));
    const level_mismatches = {};
    for (const key of Object.keys(metrics.level_delta_counts)) {
      level_mismatches[key] = isLevelMismatch(l[key], p[key], tolerance);
      if (level_mismatches[key]) metrics.level_delta_counts[key]++;
    }
    const statusMismatch = String(l.status || '') !== String(p.status || '');
    if (statusMismatch) metrics.status_mismatch_count++;
    const riskMismatch = String(l.risk_label || '') !== String(p.risk_label || '');
    if (riskMismatch) metrics.risk_label_mismatch_count++;
    rows.push({ ticker, local: l, production: p, score_delta: scoreDelta, score_delta_abs: scoreDelta === null ? null : Math.abs(scoreDelta), status_mismatch: statusMismatch, risk_label_mismatch: riskMismatch, level_mismatches });
  }

  if (scoreDeltas.length) {
    metrics.score_delta_avg = Number((scoreDeltas.reduce((a, b) => a + b, 0) / scoreDeltas.length).toFixed(4));
    metrics.score_delta_max = Number(Math.max.apply(null, scoreDeltas).toFixed(4));
  }
  metrics.top_mismatches_by_score_delta = rows.filter((r) => r.score_delta_abs !== null).sort((a, b) => b.score_delta_abs - a.score_delta_abs).slice(0, limit).map((r) => ({ ticker: r.ticker, local_score: r.local.score, production_score: r.production.score, score_delta: r.score_delta, local_status: r.local.status, production_status: r.production.status }));
  metrics.possible_cause_notes = deriveCauseNotes(metrics, rows);
  return { metrics, rows };
}

function deriveCauseNotes(metrics, rows) {
  const notes = [];
  if (metrics.local_only.length || metrics.production_only.length) notes.push('missing ticker');
  if (rows.some((r) => /stale|old|expired/i.test(String(r.local.freshness || '')))) notes.push('cache stale');
  if (metrics.score_delta_max !== null && metrics.score_delta_max > 5) notes.push('source data mismatch');
  if (Object.values(metrics.level_delta_counts).some((n) => n > 0)) notes.push('rounding/tick normalization mismatch');
  return notes.length ? notes : ['no obvious mismatch cause detected'];
}

async function readLatestLocalRun(logsFile) {
  let raw;
  try { raw = await fs.readFile(logsFile, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { ok: false, error: 'Local logs file not found: ' + logsFile, run: null, rows: [] }; throw e; }
  let latest = null;
  const invalid = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const ts = row.ended_at || row.started_at || row.timestamp || row.created_at || '';
      if (!latest || Date.parse(ts || 0) >= Date.parse((latest.ended_at || latest.started_at || latest.timestamp || latest.created_at || 0))) latest = row;
    } catch (e) { invalid.push(e.message); }
  }
  if (!latest) return { ok: false, error: invalid.length ? 'No valid JSONL rows in local logs.' : 'Local logs file has no runs.', run: null, rows: [] };
  const rows = asArray(latest.results || latest.candidates || latest.top_candidates);
  return { ok: true, error: null, run: latest, rows };
}

function markdownReport(report) {
  const m = report.comparison.metrics;
  const top = m.top_mismatches_by_score_delta.length ? m.top_mismatches_by_score_delta.map((r) => `| ${r.ticker} | ${r.local_score ?? 'n/a'} | ${r.production_score ?? 'n/a'} | ${r.score_delta ?? 'n/a'} | ${r.local_status || 'n/a'} | ${r.production_status || 'n/a'} |`).join('\n') : '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return `# Day Trade Local vs Vercel Comparison — ${report.date}\n\nGenerated at: ${report.generated_at}\n\n## Data Sources\n\n- local logs: \`${report.sources.local.logs_file}\`\n- production source: ${report.sources.production.type}\n- production detail: ${report.sources.production.detail}\n\n## Summary Metrics\n\n- local_count: ${m.local_count}\n- production_count: ${m.production_count}\n- matched_tickers: ${m.matched_tickers}\n- local_only: ${m.local_only.length ? m.local_only.join(', ') : 'none'}\n- production_only: ${m.production_only.length ? m.production_only.join(', ') : 'none'}\n- score_delta_avg: ${m.score_delta_avg ?? 'n/a'}\n- score_delta_max: ${m.score_delta_max ?? 'n/a'}\n- status_mismatch_count: ${m.status_mismatch_count}\n- risk_label_mismatch_count: ${m.risk_label_mismatch_count}\n- level_delta_counts: entry1=${m.level_delta_counts.entry1}, entry2=${m.level_delta_counts.entry2}, tp1=${m.level_delta_counts.tp1}, tp2=${m.level_delta_counts.tp2}, sl=${m.level_delta_counts.sl}, rr=${m.level_delta_counts.rr}\n- possible cause notes: ${m.possible_cause_notes.join(', ')}\n\n## Top Mismatches by Score Delta\n\n| Ticker | Local Score | Production Score | Delta | Local Status | Production Status |\n| --- | ---: | ---: | ---: | --- | --- |\n${top}\n\n## Read-only Confirmation\n\nThis report only reads local JSONL logs and production read sources. It does not write Supabase, send Telegram, alter scoring, create API endpoints, or change production behavior.\n`;
}

async function writeReports(report, opts) {
  opts = opts || {};
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  await fs.mkdir(outputDir, { recursive: true });
  const base = path.join(outputDir, 'daytrade-local-vs-vercel-' + report.date);
  const markdown = base + '.md';
  await fs.writeFile(markdown, markdownReport(report));
  let json = null;
  if (opts.writeJson) { json = base + '.json'; await fs.writeFile(json, JSON.stringify(report, null, 2) + '\n'); }
  return { markdown, json };
}

function sanitizeForOutput(value) {
  return String(value || '').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]').replace(/token=[^\s&]+/gi, 'token=[REDACTED]');
}

module.exports = { DEFAULT_LOGS_FILE, DEFAULT_OUTPUT_DIR, DEFAULT_LEVEL_TOLERANCE, asArray, normalizeCandidate, compareDayTrade, readLatestLocalRun, markdownReport, writeReports, sanitizeForOutput };

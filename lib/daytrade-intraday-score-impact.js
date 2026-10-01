'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'data', 'reports');
const DEFAULT_LIMIT = 30;

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeTicker(ticker) { return String(ticker || '').toUpperCase().replace(/\.JK$/, '').replace(/[^A-Z0-9_-]/g, ''); }
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.rows)) return v.rows;
  if (v && Array.isArray(v.data)) return v.data;
  if (v && Array.isArray(v.candidates)) return v.candidates;
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v.top_candidates)) return v.top_candidates;
  return [];
}
function first(row, keys) {
  for (const k of keys) if (row && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  return null;
}
function clampScore(score) { return Math.max(0, Math.min(100, Number(score) || 0)); }
function normalizeIntradayRow(row) {
  row = row || {};
  return {
    ticker: safeTicker(first(row, ['ticker', 'symbol', 'code'])),
    adjustment: numberOrNull(first(row, ['intraday_score_adjustment_preview'])),
    intraday_priority_label: first(row, ['intraday_priority_label']) || 'INTRADAY_UNKNOWN',
    intraday_confirmation_label: first(row, ['intraday_confirmation_label']) || 'INTRADAY_UNKNOWN',
    data_quality: first(row, ['data_quality']) || 'UNKNOWN',
    intraday_score_adjustment_reasons: Array.isArray(row.intraday_score_adjustment_reasons) ? row.intraday_score_adjustment_reasons : [],
    intraday_labels: Array.isArray(row.intraday_labels) ? row.intraday_labels : [],
    current_score: numberOrNull(first(row, ['daytrade_score', 'score'])),
    raw: row
  };
}
function normalizeProductionRow(row) {
  row = row || {};
  return { ticker: safeTicker(first(row, ['ticker', 'symbol', 'code'])), current_score: numberOrNull(first(row, ['daytrade_score', 'score'])), raw: row };
}
function rankRows(rows, scoreKey, rankKey) {
  return rows.slice().sort((a, b) => (b[scoreKey] - a[scoreKey]) || a.ticker.localeCompare(b.ticker)).map((r, i) => Object.assign(r, { [rankKey]: i + 1 }));
}
function countBy(rows, key) { return rows.reduce((m, r) => { const v = String(r[key] || 'UNKNOWN'); m[v] = (m[v] || 0) + 1; return m; }, {}); }
function avg(rows, key) { return rows.length ? rows.reduce((s, r) => s + (numberOrNull(r[key]) || 0), 0) / rows.length : 0; }
function topSet(rows, rankKey, n) { return new Set(rows.filter((r) => r[rankKey] <= n).map((r) => r.ticker)); }
function setDiff(a, b) { return Array.from(a).filter((x) => !b.has(x)).sort(); }
function includesRisk(row, label) { return (row.intraday_labels || []).includes(label) || (row.intraday_score_adjustment_reasons || []).some((r) => String(r).includes(label)); }

function simulateImpact(intradayRows, productionRows, opts) {
  opts = opts || {};
  const limit = Number(opts.limit || DEFAULT_LIMIT);
  const intraday = asArray(intradayRows).map(normalizeIntradayRow).filter((r) => r.ticker);
  const prodMap = new Map(asArray(productionRows).map(normalizeProductionRow).filter((r) => r.ticker).map((r) => [r.ticker, r]));
  const skipped = [];
  const baseRows = intraday.map((row) => {
    const prod = prodMap.get(row.ticker);
    const currentScore = prod && prod.current_score !== null ? prod.current_score : row.current_score;
    if (currentScore === null) {
      skipped.push({ ticker: row.ticker, reason: 'missing_production_score' });
      return null;
    }
    const adjustment = row.adjustment === null ? 0 : row.adjustment;
    return Object.assign({}, row, {
      current_score: currentScore,
      adjustment,
      simulated_score: clampScore(currentScore + adjustment),
      missing_adjustment: row.adjustment === null
    });
  }).filter(Boolean);
  const currentRanked = rankRows(baseRows.map((r) => Object.assign({}, r)), 'current_score', 'current_rank');
  const byTicker = new Map(currentRanked.map((r) => [r.ticker, r]));
  for (const r of rankRows(baseRows.map((r) => Object.assign({}, r)), 'simulated_score', 'simulated_rank')) byTicker.get(r.ticker).simulated_rank = r.simulated_rank;
  const rows = Array.from(byTicker.values()).map((r) => Object.assign(r, { rank_delta: r.current_rank - r.simulated_rank })).sort((a, b) => a.current_rank - b.current_rank).slice(0, limit);
  const allRows = Array.from(byTicker.values());
  const cur5 = topSet(allRows, 'current_rank', 5); const sim5 = topSet(allRows, 'simulated_rank', 5);
  const cur20 = topSet(allRows, 'current_rank', 20); const sim20 = topSet(allRows, 'simulated_rank', 20);
  const summary = {
    total_rows_simulated: allRows.length,
    avg_adjustment: avg(allRows, 'adjustment'),
    positive_adjustment_count: allRows.filter((r) => r.adjustment > 0).length,
    neutral_adjustment_count: allRows.filter((r) => r.adjustment === 0).length,
    negative_adjustment_count: allRows.filter((r) => r.adjustment < 0).length,
    top_promotions: allRows.filter((r) => r.rank_delta > 0).sort((a, b) => (b.rank_delta - a.rank_delta) || a.simulated_rank - b.simulated_rank).slice(0, 10),
    top_demotions: allRows.filter((r) => r.rank_delta < 0).sort((a, b) => (a.rank_delta - b.rank_delta) || a.simulated_rank - b.simulated_rank).slice(0, 10),
    entering_top_5: setDiff(sim5, cur5),
    leaving_top_5: setDiff(cur5, sim5),
    entering_top_20: setDiff(sim20, cur20),
    leaving_top_20: setDiff(cur20, sim20),
    intraday_priority_label: countBy(allRows, 'intraday_priority_label'),
    intraday_confirmation_label: countBy(allRows, 'intraday_confirmation_label'),
    data_quality: countBy(allRows, 'data_quality'),
    skipped
  };
  return { summary, rows, all_rows: allRows.sort((a, b) => a.simulated_rank - b.simulated_rank) };
}
function cautionLines(report) {
  const rows = report.all_rows || []; const threshold = Math.max(2, Math.ceil(rows.length * 0.4)); const lines = [];
  const unknown = rows.filter((r) => r.intraday_priority_label === 'INTRADAY_UNKNOWN' || r.intraday_confirmation_label === 'INTRADAY_UNKNOWN').length;
  const stale = rows.filter((r) => r.data_quality === 'STALE_CACHE').length;
  const chase = rows.filter((r) => includesRisk(r, 'CHASE_RISK')).length;
  const below = rows.filter((r) => includesRisk(r, 'BELOW_VWAP_RISK')).length;
  const churn5 = report.summary.entering_top_5.length + report.summary.leaving_top_5.length;
  if (unknown >= threshold) lines.push(`many INTRADAY_UNKNOWN rows: ${unknown}/${rows.length}`);
  if (stale >= threshold) lines.push(`many STALE_CACHE rows: ${stale}/${rows.length}`);
  if (chase >= threshold) lines.push(`many CHASE_RISK rows: ${chase}/${rows.length}`);
  if (below >= threshold) lines.push(`many BELOW_VWAP_RISK rows: ${below}/${rows.length}`);
  if (churn5 >= 4) lines.push(`large Top 5 churn: ${churn5} enter/leave events`);
  if (rows.length < 10) lines.push(`low matched row count: ${rows.length}`);
  if (report.summary.skipped.length) lines.push(`skipped rows: ${report.summary.skipped.length}`);
  return lines;
}
function fmt(n) { return n === null || n === undefined || !Number.isFinite(Number(n)) ? 'n/a' : Number(n).toFixed(2); }
function markdownReport(report) {
  const s = report.summary;
  const lines = ['# Day Trade Intraday Score Impact Simulation — ' + report.date, '', '> Read-only decision support. Production Day Trade score, ranking, writes, notifications, API, and UI are not changed.', '', '## Simulation Rules', '', '- current_score = daytrade_score or score', '- adjustment = intraday_score_adjustment_preview (missing values are treated as 0)', '- simulated_score = clamp(current_score + adjustment, 0, 100)', '- current_rank = rank by current_score desc', '- simulated_rank = rank by simulated_score desc', '', '## Summary', '', `- total rows simulated: ${s.total_rows_simulated}`, `- avg adjustment: ${fmt(s.avg_adjustment)}`, `- positive/neutral/negative adjustment count: ${s.positive_adjustment_count}/${s.neutral_adjustment_count}/${s.negative_adjustment_count}`, `- entering Top 5: ${s.entering_top_5.join(', ') || '-'}`, `- leaving Top 5: ${s.leaving_top_5.join(', ') || '-'}`, `- entering Top 20: ${s.entering_top_20.join(', ') || '-'}`, `- leaving Top 20: ${s.leaving_top_20.join(', ') || '-'}`, `- intraday_priority_label: \`${JSON.stringify(s.intraday_priority_label)}\``, `- intraday_confirmation_label: \`${JSON.stringify(s.intraday_confirmation_label)}\``, `- data_quality: \`${JSON.stringify(s.data_quality)}\``, '', '## Caution', '', ...(cautionLines(report).length ? cautionLines(report).map((w) => '- ' + w) : ['- none']), '', '## Ranking Impact', '', '| Ticker | Current Score | Adj | Sim Score | Current Rank | Sim Rank | Rank Delta | Priority | Confirmation | Key Reasons |', '|---|---:|---:|---:|---:|---:|---:|---|---|---|'];
  for (const r of report.rows) lines.push(`| ${r.ticker} | ${fmt(r.current_score)} | ${fmt(r.adjustment)} | ${fmt(r.simulated_score)} | ${r.current_rank} | ${r.simulated_rank} | ${r.rank_delta} | ${r.intraday_priority_label || '-'} | ${r.intraday_confirmation_label || '-'} | ${(r.intraday_score_adjustment_reasons || []).join('; ') || '-'} |`);
  return lines.join('\n') + '\n';
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function findLatestReport(dir, prefix) {
  const entries = await fs.readdir(dir).catch(() => []);
  const files = entries.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No ${prefix}*.json report found in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}
async function loadProductionFromSupabase(limit) {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing Supabase env for production-source=supabase');
  const { data, error } = await createClient(url, key).from('daytrade_screener_latest').select('*').order('daytrade_score', { ascending: false }).limit(limit || 200);
  if (error) throw error;
  return data || [];
}
async function runSimulation(opts) {
  opts = Object.assign({ outputDir: DEFAULT_OUTPUT_DIR, limit: DEFAULT_LIMIT, productionSource: 'supabase' }, opts || {});
  const intradayFile = opts.intradayFile || await findLatestReport(opts.outputDir, 'daytrade-intraday-observe-');
  const intradayReport = await readJson(intradayFile);
  const intradayRows = asArray(intradayReport);
  let productionRows = intradayRows;
  if (opts.productionSource === 'file') productionRows = asArray(await readJson(opts.productionFile));
  else if (opts.productionSource === 'supabase') productionRows = await loadProductionFromSupabase(opts.limit);
  else if (opts.productionSource !== 'intraday') throw new Error('Unsupported --production-source: ' + opts.productionSource);
  const sim = simulateImpact(intradayRows, productionRows, opts);
  const date = opts.sessionDate || intradayReport.date || new Date(opts.nowMs || Date.now()).toISOString().slice(0, 10);
  return Object.assign({ date, generated_at: new Date(opts.nowMs || Date.now()).toISOString(), source: { intraday_file: intradayFile, production_source: opts.productionSource, production_file: opts.productionFile || null } }, sim);
}
async function writeReports(report, opts) {
  await fs.mkdir(opts.outputDir, { recursive: true });
  const base = path.join(opts.outputDir, 'daytrade-intraday-score-impact-' + report.date);
  await fs.writeFile(base + '.md', markdownReport(report));
  let json = null;
  if (opts.writeJson) { json = base + '.json'; await fs.writeFile(json, JSON.stringify(report, null, 2) + '\n'); }
  return { markdown: base + '.md', json };
}
module.exports = { DEFAULT_OUTPUT_DIR, DEFAULT_LIMIT, numberOrNull, safeTicker, clampScore, normalizeIntradayRow, normalizeProductionRow, simulateImpact, cautionLines, markdownReport, findLatestReport, loadProductionFromSupabase, runSimulation, writeReports };

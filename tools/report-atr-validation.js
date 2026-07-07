/**
 * ATR Validation Report for Telegram Daily Picks.
 *
 * Read-only: fetches telegram_daily_picks and OHLCV candles, writes only local
 * report artifacts under data/reports. It does not update Supabase, Telegram,
 * signal scoring, monitor state, Dashboard/UI, cron, SQL, or API endpoints.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCacheProvider } = require('../lib/daytrade-ohlcv-cache');
const atr = require('../lib/atr-report-helpers');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '60', 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'data/reports';
const WRITE_CSV = String(process.env.WRITE_CSV || '1') !== '0';

function requireEnv() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
}

async function fetchDailyPicks() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_BACK);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const baseUrl = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '');
  const url = new URL(baseUrl + '/rest/v1/telegram_daily_picks');
  url.searchParams.set('select', '*');
  url.searchParams.set('date', 'gte.' + cutoffStr);
  url.searchParams.set('order', 'date.desc');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!response.ok) throw new Error('Supabase read failed: HTTP ' + response.status + ' ' + await response.text());
  return await response.json();
}

async function validatePicks(picks, opts) {
  opts = opts || {};
  const provider = opts.provider || createCacheProvider({ cacheDir: process.env.OHLCV_CACHE_DIR });
  const candleByTicker = new Map();
  const rows = [];

  for (const pick of picks) {
    const normalized = atr.normalizePick(pick);
    let candles = null;
    if (normalized.ticker) {
      if (!candleByTicker.has(normalized.ticker)) {
        try {
          candleByTicker.set(normalized.ticker, await provider.fetchWithCache(normalized.ticker));
        } catch (e) {
          candleByTicker.set(normalized.ticker, null);
        }
      }
      candles = candleByTicker.get(normalized.ticker);
    }
    rows.push(atr.validatePick(pick, candles));
  }
  return { rows, summary: atr.buildSummary(rows), cacheStats: provider.getStats ? provider.getStats() : {} };
}

function fmt(n, d) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return atr.round(n, d == null ? 2 : d).toFixed(d == null ? 2 : d);
}

function formatConsole(result) {
  const lines = [];
  lines.push('='.repeat(72));
  lines.push('ATR VALIDATION REPORT (READ-ONLY)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('OHLCV source: daytrade cache provider backed by Yahoo Finance (.JK), stale cache fallback');
  lines.push('ATR rule: simple average of last 14 True Range values from daily OHLCV');
  lines.push('='.repeat(72));
  lines.push('Total signals: ' + result.summary.total);
  lines.push('');
  lines.push('By source:');
  for (const [source, s] of Object.entries(result.summary.bySource)) {
    lines.push('  ' + source + ': count=' + s.count + ', avgSL=' + fmt(s.avgSlAtr) + ' ATR, avgTP1=' + fmt(s.avgTp1Atr) + ' ATR, avgTP2=' + fmt(s.avgTp2Atr) + ' ATR, SL_TOO_TIGHT=' + fmt(s.pctSlTooTight, 1) + '%, TP1_STRETCHED=' + fmt(s.pctTp1Stretched, 1) + '%');
  }
  lines.push('');
  lines.push('Sample rows:');
  for (const r of result.rows.slice(0, 10)) {
    lines.push('  ' + [r.ticker, r.source, r.date, r.outcome, 'entry=' + fmt(r.entryReference), 'ATR=' + fmt(r.atr14), r.slClass, r.tp1Class, r.tp2Class, r.reason || 'ok'].join(' | '));
  }
  return lines.join('\n');
}

function formatMarkdown(result) {
  const lines = [];
  lines.push('# ATR Validation Report');
  lines.push('');
  lines.push('**Generated:** ' + new Date().toISOString());
  lines.push('**Read-only:** yes; no Supabase writes, Telegram sends, scoring changes, monitor updates, migrations, API endpoints, or UI changes.');
  lines.push('**OHLCV source:** existing `lib/daytrade-ohlcv-cache.js` provider using Yahoo Finance `.JK` daily candles with local stale-cache fallback.');
  lines.push('**ATR rule:** simple average of the latest 14 daily True Range values.');
  lines.push('');
  lines.push('## Summary by Source');
  lines.push('| Source | Count | Avg SL ATR | Avg TP1 ATR | Avg TP2 ATR | % SL_TOO_TIGHT | % TP1_STRETCHED | SL_TOO_TIGHT & SL_HIT | TP1_STRETCHED & TP Hit |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [source, s] of Object.entries(result.summary.bySource)) {
    lines.push('| ' + source + ' | ' + s.count + ' | ' + fmt(s.avgSlAtr) + ' | ' + fmt(s.avgTp1Atr) + ' | ' + fmt(s.avgTp2Atr) + ' | ' + fmt(s.pctSlTooTight, 1) + '% | ' + fmt(s.pctTp1Stretched, 1) + '% | ' + s.slTooTightSlHit + ' | ' + s.tp1StretchedTpHit + ' |');
  }
  lines.push('');
  lines.push('## Per Signal');
  lines.push('| Ticker | Source | Date | Outcome | Entry | SL % | TP1 % | TP2 % | ATR14 | SL ATR | TP1 ATR | TP2 ATR | SL Class | TP1 Class | TP2 Class | Reason |');
  lines.push('|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|');
  for (const r of result.rows) {
    lines.push('| ' + [r.ticker, r.source, r.date || '', r.outcome, fmt(r.entryReference), fmt(r.slDistancePct), fmt(r.tp1DistancePct), fmt(r.tp2DistancePct), fmt(r.atr14), fmt(r.slAtrMultiple), fmt(r.tp1AtrMultiple), fmt(r.tp2AtrMultiple), r.slClass, r.tp1Class, r.tp2Class, r.reason || ''].join(' | ') + ' |');
  }
  return lines.join('\n');
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formatCsv(rows) {
  const cols = ['ticker','source','date','status','outcome','score','entryReference','slDistancePct','tp1DistancePct','tp2DistancePct','atr14','slAtrMultiple','tp1AtrMultiple','tp2AtrMultiple','slClass','tp1Class','tp2Class','reason'];
  return [cols.join(',')].concat(rows.map(r => cols.map(c => csvEscape(r[c])).join(','))).join('\n') + '\n';
}

function writeReports(result) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const md = path.join(OUTPUT_DIR, 'atr-validation-' + date + '.md');
  fs.writeFileSync(md, formatMarkdown(result) + '\n', 'utf8');
  let csv = null;
  if (WRITE_CSV) {
    csv = path.join(OUTPUT_DIR, 'atr-validation-' + date + '.csv');
    fs.writeFileSync(csv, formatCsv(result.rows), 'utf8');
  }
  return { md, csv };
}

async function main() {
  requireEnv();
  const picks = await fetchDailyPicks();
  const result = await validatePicks(picks);
  console.log(formatConsole(result));
  const files = writeReports(result);
  console.log('\nMarkdown report saved to: ' + files.md);
  if (files.csv) console.log('CSV report saved to: ' + files.csv);
}

if (require.main === module) main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

module.exports = { fetchDailyPicks, validatePicks, formatConsole, formatMarkdown, formatCsv, writeReports };

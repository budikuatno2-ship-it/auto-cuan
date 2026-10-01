#!/usr/bin/env node
'use strict';

/**
 * Backtest Screener CLI & Evaluator
 * Parses trade/screener logs, calculates Maximum Favorable Excursion (MFE),
 * filters anomalies (> +500%), and evaluates performance deterministically.
 */

const fs = require('fs');
const path = require('path');

function parseLines(rawText) {
  if (typeof rawText !== 'string') return [];
  return rawText.split(/\r\n|\n|\r/).map(line => line.trim()).filter(line => line.length > 0);
}

function parseCsv(content) {
  const lines = parseLines(content);
  if (lines.length === 0) return [];
  const headerLine = lines[0];
  const headers = headerLine.split(',').map(h => h.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    const record = {};
    headers.forEach((h, idx) => {
      record[h] = cols[idx] !== undefined ? cols[idx] : null;
    });
    records.push(record);
  }
  return records;
}

function calculateMfe(entry, high) {
  const e = Number(entry);
  const h = Number(high);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(h)) return 0;
  const mfe = ((h - e) / e) * 100;
  const best_gain = Math.max(0, mfe);
  return Number.isFinite(best_gain) ? Number(best_gain.toFixed(2)) : 0;
}

function isAnomalyGain(gain) {
  const g = Number(gain);
  return Number.isFinite(g) && g > 500;
}

function runBacktest(rows = [], options = {}) {
  const anomalyThreshold = options.anomalyThreshold || 500;
  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let anomaliesFiltered = 0;
  let totalGain = 0;
  let bestOverallGain = 0;
  const processed = [];

  for (const row of rows) {
    if (!row) continue;
    const ticker = String(row.ticker || '').toUpperCase();
    const entry = Number(row.entry || row.entry1 || row.entry_price || row.price || 0);
    const high = Number(row.high || row.highest_price || row.high_price || entry);
    const exit = Number(row.exit || row.exit_price || row.close || entry);

    if (entry <= 0) continue;

    let mfe = row.mfe != null ? Number(row.mfe) : ((high - entry) / entry) * 100;
    let best_gain = Math.max(0, mfe);

    // Anomaly filter: > +500%
    if (best_gain > anomalyThreshold) {
      anomaliesFiltered++;
      continue;
    }

    const gainPct = Number(row.gain_pct != null ? row.gain_pct : (((exit - entry) / entry) * 100));
    if (gainPct > anomalyThreshold) {
      anomaliesFiltered++;
      continue;
    }

    totalTrades++;
    if (gainPct > 0) winningTrades++;
    else if (gainPct < 0) losingTrades++;

    totalGain += gainPct;
    if (best_gain > bestOverallGain) {
      bestOverallGain = best_gain;
    }

    processed.push({
      ticker,
      entry,
      exit,
      high,
      gain_pct: Number(gainPct.toFixed(2)),
      mfe: Number(mfe.toFixed(2)),
      best_gain: Number(best_gain.toFixed(2)),
      outcome: row.outcome || (gainPct > 0 ? 'WIN' : (gainPct < 0 ? 'LOSS' : 'BREAKEVEN'))
    });
  }

  const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(1) + '%' : '0.0%';
  const avgGain = totalTrades > 0 ? (totalGain / totalTrades).toFixed(2) + '%' : '0.00%';

  return {
    success: true,
    total_trades: totalTrades,
    winning_trades: winningTrades,
    losing_trades: losingTrades,
    anomalies_filtered: anomaliesFiltered,
    win_rate: winRate,
    avg_gain: avgGain,
    best_gain: Number(bestOverallGain.toFixed(2)),
    trades: processed
  };
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: node tools/backtest-screener.js <path-to-csv-or-json>');
    process.exit(0);
  }
  const content = fs.readFileSync(path.resolve(filePath), 'utf8');
  let data;
  if (filePath.endsWith('.json')) {
    data = JSON.parse(content);
  } else {
    data = parseCsv(content);
  }
  const results = runBacktest(Array.isArray(data) ? data : (data.signals || data.rows || []));
  console.log(JSON.stringify(results, null, 2));
}

module.exports = {
  parseLines,
  parseCsv,
  calculateMfe,
  isAnomalyGain,
  runBacktest
};

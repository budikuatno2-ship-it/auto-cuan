#!/usr/bin/env node
'use strict';

/**
 * Prepare DeepScan weekly full-history cache.
 *
 * Heavy/retryable preparation is deliberately separate from activation.
 * A failed preparation never consumes the once-per-week DeepScan lock.
 *
 * Usage:
 *   node tools/prepare-deepscan-weekly.js
 *   node tools/prepare-deepscan-weekly.js --concurrency=2
 *   node tools/prepare-deepscan-weekly.js --limit=20
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const acquisition = require('./acquire-pattern-abcd-data');
const t1Policy = require('../lib/chart-t1-policy');
const context = require('../lib/deepscan-context');

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 3;

function loadEnvFile(rootDir) {
  const candidates = ['.env.ai-eval-once', '.env.local', '.env'];
  for (const name of candidates) {
    const file = path.join(rootDir, name);
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (!text || text.startsWith('#')) continue;
        const idx = text.indexOf('=');
        if (idx <= 0) continue;
        const key = text.slice(0, idx).trim();
        let value = text.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (!process.env[key]) process.env[key] = value;
      }
    } catch (_) {}
  }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv || []) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function previousJakartaDate(now) {
  const current = now instanceof Date ? now : new Date(now || Date.now());
  const today = t1Policy.formatJakartaDate(current);
  const midnightUtc = Date.parse(today + 'T00:00:00Z');
  return new Date(midnightUtc - 86400000).toISOString().slice(0, 10);
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

async function mapBounded(items, concurrency, fn) {
  let next = 0;
  const results = new Array(items.length);
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error: String(error && error.message || 'fetch_failed').slice(0, 120) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main(argv) {
  const rootDir = path.resolve(__dirname, '..');
  loadEnvFile(rootDir);
  const args = parseArgs(argv);

  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Number(args.concurrency) || DEFAULT_CONCURRENCY));
  const limit = Math.max(0, Number(args.limit) || 0);
  const from = context.FULL_HISTORY_START;
  const to = previousJakartaDate(new Date());

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let tickers = await context.loadContinuousAuctionUniverse(db, []);
  if (limit > 0) tickers = tickers.slice(0, limit);
  if (!tickers.length) throw new Error('DeepScan universe is empty');

  const startedAt = new Date().toISOString();
  let completed = 0;
  const results = await mapBounded(tickers, concurrency, async (ticker) => {
    const candles = await acquisition.fetchTicker(ticker, {
      from,
      to,
      fetchFn: fetch,
      timeoutMs: 20000
    });
    const normalized = context.normalizeCandles(candles);
    if (normalized.length < 30) throw new Error('insufficient_history');

    const filePath = context.historyFilePath(rootDir, ticker);
    writeJsonAtomic(filePath, {
      ticker,
      source: 'Yahoo Finance chart API (.JK)',
      requested_from: from,
      requested_to: to,
      first_date: normalized[0].date,
      last_date: normalized[normalized.length - 1].date,
      candle_count: normalized.length,
      generated_at: new Date().toISOString(),
      candles: normalized
    });

    completed += 1;
    if (completed % 25 === 0 || completed === tickers.length) {
      process.stdout.write('[DeepScan prepare] ' + completed + '/' + tickers.length + '\n');
    }
    return {
      ticker,
      candle_count: normalized.length,
      first_date: normalized[0].date,
      last_date: normalized[normalized.length - 1].date
    };
  });

  const successes = [];
  const failures = [];
  results.forEach((row, index) => {
    if (row && row.ok) successes.push(row.value);
    else failures.push({ ticker: tickers[index], reason: row && row.error || 'unknown_failure' });
  });

  const fundamentals = await context.loadFundamentalsMap(db, tickers);
  let brokerAvailable = 0;
  for (const ticker of tickers) {
    if (context.loadBrokerContext(rootDir, ticker)) brokerAvailable += 1;
  }

  const fullUniverseRun = limit === 0;
  const historyReady = successes.length === tickers.length && failures.length === 0;
  const financialReady = fundamentals.size === tickers.length;
  const brokerReady = brokerAvailable === tickers.length;
  const readyForActivation = fullUniverseRun && historyReady && financialReady && brokerReady;

  const report = {
    schema_version: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    requested_from: from,
    requested_to: to,
    concurrency,
    universe_count: tickers.length,
    full_universe_run: fullUniverseRun,
    history_complete_count: successes.length,
    history_failed_count: failures.length,
    financial_available_count: fundamentals.size,
    financial_missing_count: tickers.length - fundamentals.size,
    broker_available_count: brokerAvailable,
    broker_missing_count: tickers.length - brokerAvailable,
    ready_for_activation: readyForActivation,
    failures: failures.slice(0, 100)
  };

  const reportPath = path.join(rootDir, 'data', 'reports', 'deepscan-weekly-preparation-latest.json');
  writeJsonAtomic(reportPath, report);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (!readyForActivation) process.exitCode = 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write('DeepScan preparation failed: ' + String(error && error.message || error).slice(0, 180) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  previousJakartaDate,
  mapBounded,
  writeJsonAtomic,
  main
};

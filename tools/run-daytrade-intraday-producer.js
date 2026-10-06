#!/usr/bin/env node
'use strict';

/**
 * Canonical VPS intraday DayTrade producer.
 *
 * Restores the producer half of the 09:00-16:00 pipeline after the VPS
 * migration. The existing run-daytrade.sh jobs are consumers/senders only;
 * FastWatcher also consumes the canonical DayTrade latest table. Without this
 * producer both paths freeze when the previous EOD producer fails.
 *
 * Production contract:
 * - local VPS API only (never Vercel)
 * - FAST DayTrade universe (same contract as local_scan_runner auto-fast)
 * - explicit --execute required
 * - market-session guard before mutation
 * - defer public producer delivery to FastWatcher (no duplicate stock signal)
 * - materialize screener-latest.json after successful publication so the
 *   scheduled DayTrade sender sees authoritative per-mode source_dates
 */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const guard = require(path.join(ROOT, 'lib', 'market-hours-guard'));
const runner = require(path.join(ROOT, 'tools', 'run-all-screeners-vps'));
const snapshotBuilder = require(path.join(ROOT, 'tools', 'build-screener-snapshot'));

function parseArgs(argv) {
  const opts = { execute: false, maxBatches: 120, sleepMs: 500 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--dry-run') opts.execute = false;
    else if (arg === '--max-batches') opts.maxBatches = Math.max(1, Number(argv[++i]) || opts.maxBatches);
    else if (arg === '--sleep-ms') opts.sleepMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error('Unknown option: ' + arg);
  }
  return opts;
}

function terminalStatus(value) {
  return ['published', 'already_done', 'completed'].includes(String(value || '').toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(options, deps) {
  const opts = options || parseArgs(process.argv);
  deps = deps || {};
  const log = deps.log || console.log;
  const now = deps.now || new Date();
  const market = (deps.getMarketSessionStatus || guard.getMarketSessionStatus)(now);

  log('DayTrade intraday producer');
  log('  market   : ' + String(market.status || market.session || 'UNKNOWN') +
    ' (' + String(market.reason || '-') + ')');

  if (!market || market.isOpen !== true) {
    log('  skip     : market session is not open');
    return { ok: true, skipped: true, reason: 'MARKET_CLOSED', market };
  }

  const env = deps.env || runner.loadEnvFiles();
  if (!env.CRON_SECRET) throw new Error('CRON_SECRET is required.');

  const baseUrl = deps.baseUrl || runner.resolveBaseUrl(env);
  runner.assertNotServerlessForExecute(baseUrl, opts.execute);

  const client = deps.client || runner.makeClient(baseUrl, env.CRON_SECRET, deps.fetch);
  if (!opts.execute) {
    const current = await client.call({ action: 'daytrade-screener' });
    log('  mode     : DRY-RUN');
    return { ok: true, dryRun: true, base_url: baseUrl, current };
  }

  const mem = runner.assertHeavyScanMemoryHeadroom(env, deps.fs);
  if (mem.availableMb != null) {
    log('  memory   : ' + mem.availableMb.toFixed(1) + ' MB available (floor ' + mem.minMb.toFixed(0) + ' MB)');
  }

  log('  mode     : EXECUTE / FAST');
  log('  delivery : deferred_to_fast_watcher');
  log('  base URL : ' + baseUrl);

  let batch = 0;
  let last = null;

  while (batch < opts.maxBatches) {
    const query = {
      action: 'daytrade-screener-run',
      force: 1,
      batch,
      mode: 'auto',
      speed: 'fast',
      send_radar: 0,
      defer_to_fast_watcher: 1
    };

    last = await client.call(query);
    const status = String(last && last.status || '').toLowerCase();
    log('  batch ' + batch + ': status=' + (status || 'unknown') +
      ' scanned=' + Number(last && last.scanned_count || 0) +
      '/' + Number(last && last.universe_count || 0));

    if (terminalStatus(status)) {
      const buildSnapshot = deps.buildSnapshot || snapshotBuilder.main;
      const snapshot = await buildSnapshot(
        { dryRun: false, print: false },
        {
          baseUrl,
          env,
          rootDir: deps.rootDir || ROOT,
          fetchFn: deps.snapshotFetch || deps.fetch
        }
      );
      if (!snapshot || snapshot.ok !== true) {
        throw new Error('DayTrade published but snapshot materialization failed: ' +
          String(snapshot && snapshot.reason || 'unknown'));
      }
      log('  snapshot : materialized (' + Number(snapshot.rows || 0) + ' rows)');
      return {
        ok: true,
        status,
        run_date: last.run_date || null,
        run_id: last.run_id || null,
        published_count: Number(last.published_count || 0),
        snapshot
      };
    }

    if (status === 'paused') {
      log('  skip     : endpoint paused for market session (' + String(last.reason || 'market_break') + ')');
      return { ok: true, skipped: true, reason: last.reason || 'MARKET_PAUSED', response: last };
    }

    if (status === 'failed' || last.success === false) {
      throw new Error('DayTrade producer failed: ' + String(last.error || last.error_code || status || 'unknown'));
    }

    if (status !== 'running') {
      throw new Error('Unexpected DayTrade producer status: ' + (status || 'missing'));
    }

    const next = Number(last.next_batch);
    batch = Number.isInteger(next) && next > batch ? next : batch + 1;
    if (opts.sleepMs > 0) await sleep(opts.sleepMs);
  }

  throw new Error('DayTrade producer reached --max-batches without publication.');
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: node tools/run-daytrade-intraday-producer.js [--dry-run|--execute] [--max-batches N] [--sleep-ms N]');
    return;
  }
  const result = await run(opts);
  if (!result || result.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('ERROR: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, terminalStatus, run };

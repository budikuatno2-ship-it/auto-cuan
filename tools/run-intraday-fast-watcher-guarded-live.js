#!/usr/bin/env node
'use strict';

const path = require('node:path');
const guarded = require('../lib/intraday-fast-watcher-guarded-live');
const pool = require('../lib/intraday-fast-watcher-pool');

function parseArgs(argv) {
  const args = { sampleDate: null, scheduledTime: null, shortlistFile: null, stateDir: null, eventDir: null, publishedDir: null, observationRoot: null, cacheDir: null, productionLockFile: null, maxShortlist: pool.MAX_ACTIVE_POOL, concurrency: 4, timeoutMs: 12000, dryRun: false, json: false, help: false };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--sample-date') args.sampleDate = argv[++index];
    else if (value === '--scheduled-time') args.scheduledTime = argv[++index];
    else if (value === '--shortlist-file') args.shortlistFile = argv[++index];
    else if (value === '--state-dir') args.stateDir = argv[++index];
    else if (value === '--event-dir') args.eventDir = argv[++index];
    else if (value === '--published-dir') args.publishedDir = argv[++index];
    else if (value === '--observation-root') args.observationRoot = argv[++index];
    else if (value === '--cache-dir') args.cacheDir = argv[++index];
    else if (value === '--production-lock-file') args.productionLockFile = argv[++index];
    else if (value === '--max-shortlist') args.maxShortlist = Number(argv[++index]);
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--json') args.json = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else args.invalid = value;
  }
  return args;
}
const USAGE = `Usage:\nnode tools/run-intraday-fast-watcher-guarded-live.js \\\n  --sample-date YYYY-MM-DD --scheduled-time HH:MM --shortlist-file PATH \\\n  [--max-shortlist 30] [--concurrency 4] [--timeout-ms 12000] \\\n  [--state-dir PATH] [--event-dir PATH] [--published-dir PATH] \\\n  [--observation-root PATH] [--cache-dir PATH] [--production-lock-file PATH] \\\n  [--dry-run] [--json]\n\nKill switches default OFF:\nFAST_WATCHER_LIVE_ENABLED=1\nFAST_WATCHER_PUBLISH_ENABLED=1\nFAST_WATCHER_TELEGRAM_ENABLED=1\nFAST_WATCHER_RADAR_TELEGRAM_ENABLED=1`;
async function main(argv) {
  const args = parseArgs(argv || process.argv);
  if (args.help) { process.stdout.write(USAGE + '\n'); return 0; }
  const invalid = args.invalid || !args.sampleDate || !args.scheduledTime || !args.shortlistFile || !Number.isInteger(args.maxShortlist) || args.maxShortlist < 1 || args.maxShortlist > pool.MAX_ACTIVE_POOL || !Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 4 || !Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 30000;
  if (invalid) { process.stderr.write(USAGE + '\n'); return 2; }
  const result = await guarded.run({
    sampleDate: args.sampleDate, scheduledTime: args.scheduledTime, shortlistFile: path.resolve(args.shortlistFile),
    stateDir: args.stateDir ? path.resolve(args.stateDir) : null, eventDir: args.eventDir ? path.resolve(args.eventDir) : null,
    publishedDir: args.publishedDir ? path.resolve(args.publishedDir) : null, observationRoot: args.observationRoot ? path.resolve(args.observationRoot) : null,
    cacheDir: args.cacheDir ? path.resolve(args.cacheDir) : null, productionLockFile: args.productionLockFile ? path.resolve(args.productionLockFile) : null,
    maxShortlist: args.maxShortlist, concurrency: args.concurrency, timeoutMs: args.timeoutMs, dryRun: args.dryRun, env: process.env
  });
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(`Fast Watcher guarded-live: ${result.status}; shortlist=${result.shortlist_count || 0}; pool=${result.active_pool_count || 0}; confirmed=${(result.confirmed || []).length}; spikes=${result.informational_spike_count || 0}; radar=${result.radar_items_sent || 0}; system=${result.system_published || 0}; telegram=${result.telegram_sent || 0}\n`);
  return new Set(['invalid_input', 'shortlist_missing', 'shortlist_invalid', 'lock_busy', 'skipped_due_to_production_lock']).has(result.status) ? 1 : 0;
}
if (require.main === module) main(process.argv).then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`FATAL: ${error.message}\n`); process.exitCode = 1; });
module.exports = { parseArgs, main, USAGE };

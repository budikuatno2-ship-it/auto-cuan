#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const guarded = require('../lib/intraday-fast-watcher-guarded-live');

const ENV_FILES = ['.env.local', '.env.intraday-runtime', '.env'];

function loadEnvFiles(env, cwd) {
  env = env || process.env;
  cwd = cwd || process.cwd();
  for (const name of ENV_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(cwd, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    text.split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
      if (!match || Object.prototype.hasOwnProperty.call(env, match[1])) return;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      env[match[1]] = value;
    });
  }
  return env;
}

function parseArgs(argv) {
  const args = {
    sampleDate: null,
    scheduledTime: null,
    shortlistFile: null,
    stateDir: null,
    eventDir: null,
    observationRoot: null,
    cacheDir: null,
    productionLockFile: null,
    baseUrl: null,
    maxPool: guarded.DEFAULT_MAX_POOL,
    concurrency: 4,
    timeoutMs: 12000,
    sourceTimeoutMs: 10000,
    dryRun: false,
    json: false,
    help: false
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--sample-date') args.sampleDate = argv[++index];
    else if (value === '--scheduled-time') args.scheduledTime = argv[++index];
    else if (value === '--shortlist-file') args.shortlistFile = argv[++index];
    else if (value === '--state-dir') args.stateDir = argv[++index];
    else if (value === '--event-dir') args.eventDir = argv[++index];
    else if (value === '--observation-root') args.observationRoot = argv[++index];
    else if (value === '--cache-dir') args.cacheDir = argv[++index];
    else if (value === '--production-lock-file') args.productionLockFile = argv[++index];
    else if (value === '--base-url') args.baseUrl = argv[++index];
    else if (value === '--max-pool') args.maxPool = Number(argv[++index]);
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
    else if (value === '--source-timeout-ms') args.sourceTimeoutMs = Number(argv[++index]);
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--json') args.json = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else args.invalid = value;
  }
  return args;
}

const USAGE = `Usage:
node tools/run-intraday-fast-watcher-guarded-live.js \\
  --sample-date YYYY-MM-DD --scheduled-time HH:MM \\
  --shortlist-file PATH --production-lock-file PATH \\
  [--max-pool 20] [--concurrency 4] [--timeout-ms 12000] \\
  [--state-dir PATH] [--event-dir PATH] [--observation-root PATH] \\
  [--cache-dir PATH] [--base-url URL] [--dry-run] [--json]

Production activation requires:
  FAST_WATCHER_LIVE_ENABLED=1
  FAST_WATCHER_KILL_SWITCH=0
  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

Telegram additionally requires:
  FAST_WATCHER_TELEGRAM_ENABLED=1
  TELEGRAM_ENABLED=1
  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID

Safety:
- full Day Trade screener schedule remains unchanged;
- source pool is bounded to 20 tickers;
- publication requires two consecutive momentum confirmations;
- database publication completes before best-effort Telegram delivery;
- FAST_WATCHER_KILL_SWITCH=1 blocks all live publication immediately.`;

async function main(argv, dependencies) {
  const args = parseArgs(argv || process.argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const invalid = args.invalid || !guarded.validDate(args.sampleDate) || !guarded.validTime(args.scheduledTime) || !args.shortlistFile ||
    !Number.isInteger(args.maxPool) || args.maxPool < 1 || args.maxPool > guarded.MAX_POOL_LIMIT ||
    !Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 4 ||
    !Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 30000 ||
    !Number.isInteger(args.sourceTimeoutMs) || args.sourceTimeoutMs < 1000 || args.sourceTimeoutMs > 30000;
  if (invalid) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  const env = loadEnvFiles((dependencies && dependencies.env) || process.env, process.cwd());
  const result = await guarded.runGuardedLive(Object.assign({
    sampleDate: args.sampleDate,
    scheduledTime: args.scheduledTime,
    shortlistFile: path.resolve(args.shortlistFile),
    stateDir: args.stateDir ? path.resolve(args.stateDir) : null,
    eventDir: args.eventDir ? path.resolve(args.eventDir) : null,
    observationRoot: args.observationRoot ? path.resolve(args.observationRoot) : null,
    cacheDir: args.cacheDir ? path.resolve(args.cacheDir) : null,
    productionLockFile: args.productionLockFile ? path.resolve(args.productionLockFile) : null,
    baseUrl: args.baseUrl || env.APP_BASE_URL || 'https://auto-cuan.vercel.app',
    maxPool: args.maxPool,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    sourceTimeoutMs: args.sourceTimeoutMs,
    dryRun: args.dryRun,
    env
  }, dependencies || {}));

  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write([
    'Guarded Fast Watcher: ' + result.status,
    'pool=' + (result.pool_count || 0),
    'confirmed=' + (result.confirmed_count || 0),
    'published=' + (result.published_count || 0),
    'telegram=' + (result.telegram_sent_count || 0),
    'gate=' + (result.live_gate && result.live_gate.reason || 'open')
  ].join('; ') + '\n');

  return new Set(['invalid_input', 'lock_busy', 'collection_failed', 'skipped_due_to_production_lock', 'source_missing', 'source_invalid']).has(result.status) ? 1 : 0;
}

if (require.main === module) {
  main(process.argv).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write('FATAL: ' + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { ENV_FILES, loadEnvFiles, parseArgs, main, USAGE };

#!/usr/bin/env node
'use strict';

const path = require('node:path');

const followup =
  require('../lib/intraday-fast-watcher-shadow-followup');

function parseArgs(argv) {
  const args = {
    sampleDate: null,
    publishedDir: null,
    outputRoot: null,
    ticker: null,
    timeoutMs: 12000,
    networkFetch: false,
    persist: false,
    json: false,
    invalid: false
  };

  for (let i = 2; i < argv.length; i++) {
    const value = argv[i];

    if (value === '--sample-date') {
      args.sampleDate = argv[++i];
    } else if (value === '--published-dir') {
      args.publishedDir = argv[++i];
    } else if (value === '--output-root') {
      args.outputRoot = argv[++i];
    } else if (value === '--ticker') {
      args.ticker = argv[++i];
    } else if (value === '--timeout-ms') {
      args.timeoutMs = Number(argv[++i]);
    } else if (value === '--network-fetch') {
      args.networkFetch = true;
    } else if (value === '--persist') {
      args.persist = true;
    } else if (value === '--json') {
      args.json = true;
    } else if (
      value === '--help' ||
      value === '-h'
    ) {
      args.help = true;
    } else {
      args.invalid = true;
    }
  }

  return args;
}

const USAGE = [
  'Usage:',
  '',
  'node tools/run-intraday-fast-watcher-shadow-followup.js \\',
  '  --sample-date YYYY-MM-DD \\',
  '  --published-dir PATH \\',
  '  [--output-root PATH] \\',
  '  [--ticker TICKER] \\',
  '  [--timeout-ms 12000] \\',
  '  [--network-fetch] \\',
  '  [--persist] \\',
  '  [--json]',
  '',
  'Safety defaults:',
  '  network fetch = OFF',
  '  persistence   = OFF',
  '  Telegram      = unsupported',
  '  Supabase      = unsupported',
  '',
  '--network-fetch only permits the current WIB date.',
  '--persist requires --output-root.'
].join('\n');

async function main(argv) {
  const args = parseArgs(argv || process.argv);

  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  if (
    args.invalid ||
    !args.sampleDate ||
    !args.publishedDir ||
    !Number.isFinite(args.timeoutMs) ||
    args.timeoutMs < 1000 ||
    args.timeoutMs > 30000
  ) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  const result =
    await followup.runShadowFollowup({
      sampleDate: args.sampleDate,
      publishedDir:
        path.resolve(args.publishedDir),
      outputRoot:
        args.outputRoot
          ? path.resolve(args.outputRoot)
          : null,
      tickerFilter:
        args.ticker,
      timeoutMs: args.timeoutMs,
      networkFetch:
        args.networkFetch,
      persist:
        args.persist
    });

  if (args.json) {
    process.stdout.write(
      JSON.stringify(result, null, 2) +
      '\n'
    );
  } else {
    process.stdout.write(
      [
        'Fast Watcher shadow follow-up:',
        `status=${result.status}`,
        `published=${result.published_count || 0}`,
        `fetched=${result.fetched_count || 0}`,
        `failed=${result.failed_count || 0}`,
        `network=${result.network_fetch_attempted === true}`,
        `persisted=${result.persisted === true}`
      ].join(' ') +
      '\n'
    );
  }

  const failureStatuses = new Set([
    'invalid_input',
    'blocked_historical_network_fetch',
    'published_ticker_not_found'
  ]);

  return failureStatuses.has(result.status)
    ? 1
    : 0;
}

if (require.main === module) {
  main(process.argv)
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      process.stderr.write(
        `FATAL: ${error.message}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  main,
  USAGE
};

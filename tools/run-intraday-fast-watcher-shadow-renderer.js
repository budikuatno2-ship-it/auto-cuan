#!/usr/bin/env node
'use strict';

const path = require('node:path');

const renderer =
  require('../lib/intraday-fast-watcher-shadow-renderer');

function parseArgs(argv) {
  const args = {
    observationsFile: null,
    stateFile: null,
    commitState: false,
    maxAgeMinutes:
      renderer.DEFAULT_MAX_CANDLE_AGE_MINUTES,
    rescueRate:
      renderer.DEFAULT_RESCUE_RATE,
    json: false,
    help: false,
    invalid: false
  };

  for (
    let i = 2;
    i < argv.length;
    i++
  ) {
    const value = argv[i];

    if (
      value ===
      '--observations-file'
    ) {
      args.observationsFile =
        argv[++i];
    } else if (
      value === '--state-file'
    ) {
      args.stateFile =
        argv[++i];
    } else if (
      value === '--commit-state'
    ) {
      args.commitState = true;
    } else if (
      value ===
      '--max-age-minutes'
    ) {
      args.maxAgeMinutes =
        Number(argv[++i]);
    } else if (
      value === '--rescue-rate'
    ) {
      args.rescueRate =
        Number(argv[++i]);
    } else if (
      value === '--json'
    ) {
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
  'node tools/run-intraday-fast-watcher-shadow-renderer.js \\',
  '  --observations-file PATH \\',
  '  [--state-file PATH] \\',
  '  [--commit-state] \\',
  '  [--max-age-minutes 20] \\',
  '  [--rescue-rate 4] \\',
  '  [--json]',
  '',
  'Safety:',
  '  Telegram send = unsupported',
  '  Network fetch = unsupported',
  '  Supabase      = unsupported',
  '  State write   = OFF by default',
  '',
  '--commit-state requires --state-file.'
].join('\n');

async function main(argv) {
  const args =
    parseArgs(
      argv || process.argv
    );

  if (args.help) {
    process.stdout.write(
      USAGE + '\n'
    );
    return 0;
  }

  if (
    args.invalid ||
    !args.observationsFile ||
    !Number.isFinite(
      args.maxAgeMinutes
    ) ||
    args.maxAgeMinutes < 1 ||
    args.maxAgeMinutes > 120 ||
    !Number.isFinite(
      args.rescueRate
    ) ||
    args.rescueRate < 1 ||
    args.rescueRate > 20 ||
    (
      args.commitState &&
      !args.stateFile
    )
  ) {
    process.stderr.write(
      USAGE + '\n'
    );
    return 2;
  }

  const result =
    await renderer.runRenderer({
      observationsFile:
        path.resolve(
          args.observationsFile
        ),

      stateFile:
        args.stateFile
          ? path.resolve(
              args.stateFile
            )
          : null,

      commitState:
        args.commitState,

      maxCandleAgeMinutes:
        args.maxAgeMinutes,

      rescueRate:
        args.rescueRate
    });

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        result,
        null,
        2
      ) + '\n'
    );
  } else {
    if (result.message) {
      process.stdout.write(
        result.message + '\n'
      );
    } else {
      process.stdout.write(
        'FAST_WATCHER_SHADOW_NO_CHANGES\n'
      );
    }

    process.stdout.write(
      [
        '',
        `STATUS=${result.status}`,
        `TRANSITIONS=${result.diagnostics?.transition_count || 0}`,
        `STATE_COMMITTED=${result.state_committed === true}`
      ].join('\n') + '\n'
    );
  }

  return result.status ===
    'invalid_input'
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

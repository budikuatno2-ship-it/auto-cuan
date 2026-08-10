#!/usr/bin/env node
'use strict';

/*
 * Fast Watcher Shadow Historical Replay CLI
 *
 * Safety:
 *   - local stored files only;
 *   - no network fetch;
 *   - no Telegram send;
 *   - no Supabase/database access;
 *   - no renderer state persistence;
 *   - each date starts from a fresh in-memory state.
 */

const fs =
  require('node:fs');

const path =
  require('node:path');

const adapter =
  require(
    '../lib/intraday-fast-watcher-shadow-historical-adapter'
  );

const renderer =
  require(
    '../lib/intraday-fast-watcher-shadow-renderer'
  );

const VERSION =
  'shadow-historical-replay-cli-v1';

const DEFAULT_RESCUE_RATE = 4;

function finite(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeDate(value) {
  const text =
    String(value || '')
      .trim();

  if (
    !/^\d{4}-\d{2}-\d{2}$/
      .test(text)
  ) {
    throw new Error(
      `invalid_date:${text || 'missing'}`
    );
  }

  const ms =
    Date.parse(
      `${text}T00:00:00Z`
    );

  if (!Number.isFinite(ms)) {
    throw new Error(
      `invalid_date:${text}`
    );
  }

  return text;
}

function parseArgs(argv) {
  const args =
    Array.isArray(argv)
      ? argv
      : [];

  const options = {
    prodRoot: null,
    dates: [],
    rescueRate:
      DEFAULT_RESCUE_RATE,
    json: false,
    help: false
  };

  for (
    let index = 0;
    index < args.length;
    index += 1
  ) {
    const arg =
      args[index];

    if (
      arg === '--help' ||
      arg === '-h'
    ) {
      options.help = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--prod-root') {
      const value =
        args[index + 1];

      if (
        !value ||
        String(value)
          .startsWith('--')
      ) {
        throw new Error(
          'missing_prod_root'
        );
      }

      options.prodRoot =
        path.resolve(
          String(value)
        );

      index += 1;
      continue;
    }

    if (arg === '--date') {
      const value =
        args[index + 1];

      if (
        !value ||
        String(value)
          .startsWith('--')
      ) {
        throw new Error(
          'missing_date'
        );
      }

      options.dates.push(
        normalizeDate(value)
      );

      index += 1;
      continue;
    }

    if (arg === '--dates') {
      const value =
        args[index + 1];

      if (
        !value ||
        String(value)
          .startsWith('--')
      ) {
        throw new Error(
          'missing_dates'
        );
      }

      const dates =
        String(value)
          .split(',')
          .map(item => item.trim())
          .filter(Boolean)
          .map(normalizeDate);

      options.dates.push(
        ...dates
      );

      index += 1;
      continue;
    }

    if (arg === '--rescue-rate') {
      const value =
        finite(
          args[index + 1]
        );

      if (
        value === null ||
        value <= 0
      ) {
        throw new Error(
          'invalid_rescue_rate'
        );
      }

      options.rescueRate =
        value;

      index += 1;
      continue;
    }

    throw new Error(
      `unsupported_option:${arg}`
    );
  }

  options.dates =
    [...new Set(
      options.dates
    )];

  return options;
}

function validateOptions(options) {
  const opts =
    options || {};

  if (opts.help)
    return;

  if (!opts.prodRoot) {
    throw new Error(
      'prod_root_required'
    );
  }

  if (
    !Array.isArray(opts.dates) ||
    !opts.dates.length
  ) {
    throw new Error(
      'at_least_one_date_required'
    );
  }
}

function usage() {
  return [
    'Fast Watcher Shadow Historical Replay',
    '',
    'Usage:',
    '  node tools/run-intraday-fast-watcher-shadow-historical-replay.js \\',
    '    --prod-root /home/ubuntu/auto-cuan \\',
    '    --date 2026-08-10',
    '',
    'Multiple dates:',
    '  --date YYYY-MM-DD --date YYYY-MM-DD',
    '  or',
    '  --dates YYYY-MM-DD,YYYY-MM-DD',
    '',
    'Optional:',
    '  --rescue-rate 4',
    '  --json',
    '',
    'Safety:',
    '  Network fetch: UNSUPPORTED',
    '  Telegram send: UNSUPPORTED',
    '  Supabase/database: UNSUPPORTED',
    '  State commit/write: UNSUPPORTED'
  ].join('\n');
}

function readJson(file) {
  return JSON.parse(
    fs.readFileSync(
      file,
      'utf8'
    )
  );
}

function readJsonl(file) {
  return fs
    .readFileSync(
      file,
      'utf8'
    )
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line =>
      JSON.parse(line)
    );
}

function historicalPaths(
  prodRoot,
  sampleDate
) {
  const root =
    path.resolve(
      prodRoot
    );

  const date =
    normalizeDate(
      sampleDate
    );

  return {
    radar:
      path.join(
        root,
        'data/intraday-fast-watcher-published/radar',
        `${date}.json`
      ),

    candidates:
      path.join(
        root,
        'data/intraday-fast-watcher-live-observations',
        date,
        'candidates.jsonl'
      ),

    events:
      path.join(
        root,
        'data/intraday-fast-watcher-live-events',
        `${date}.jsonl`
      )
  };
}

function loadHistoricalDay(
  prodRoot,
  sampleDate
) {
  const files =
    historicalPaths(
      prodRoot,
      sampleDate
    );

  return {
    radar:
      readJson(
        files.radar
      ),

    candidates:
      readJsonl(
        files.candidates
      ),

    events:
      readJsonl(
        files.events
      ),

    files
  };
}

function transitionStatus(row) {
  return String(
    row &&
    (
      row.to_status ??
      row.status ??
      row.lifecycle_status ??
      ''
    )
  ).trim() || 'UNKNOWN';
}

function transitionTicker(row) {
  return String(
    row &&
    row.ticker ||
    ''
  )
    .trim()
    .toUpperCase();
}

function countStatuses(rows) {
  const counts = {};

  for (
    const row of
    Array.isArray(rows)
      ? rows
      : []
  ) {
    const status =
      transitionStatus(row);

    counts[status] =
      (counts[status] || 0) + 1;
  }

  return counts;
}

function finalTickerStatuses(rows) {
  const final =
    new Map();

  for (
    const row of
    Array.isArray(rows)
      ? rows
      : []
  ) {
    const ticker =
      transitionTicker(row);

    if (!ticker)
      continue;

    final.set(
      ticker,
      transitionStatus(row)
    );
  }

  const tickers =
    Object.fromEntries(
      [...final.entries()]
        .sort(
          (a, b) =>
            a[0].localeCompare(
              b[0]
            )
        )
    );

  return {
    ticker_count:
      final.size,

    counts:
      countStatuses(
        [...final.entries()]
          .map(
            ([ticker, status]) => ({
              ticker,
              status
            })
          )
      ),

    tickers
  };
}

function previewNowMs(sampleDate) {
  return Date.parse(
    `${normalizeDate(sampleDate)}T16:00:00+07:00`
  );
}

function replayHistoricalDayData(
  options
) {
  const opts =
    options || {};

  const sampleDate =
    normalizeDate(
      opts.sampleDate
    );

  const rescueRate =
    finite(
      opts.rescueRate
    ) ??
    DEFAULT_RESCUE_RATE;

  if (rescueRate <= 0) {
    throw new Error(
      'invalid_rescue_rate'
    );
  }

  const adapted =
    adapter.buildHistoricalObservations({
      sampleDate,

      radar:
        opts.radar,

      candidates:
        opts.candidates,

      events:
        opts.events
    });

  /*
   * Fresh empty state per trading date.
   * No state is read or written.
   */
  const processed =
    renderer.processObservationSequence(
      adapted.observations,
      {},
      {
        rescueRate
      }
    );

  const rendered =
    renderer.renderDigest(
      processed.transitions,
      {
        nowMs:
          previewNowMs(
            sampleDate
          )
      }
    );

  const final =
    finalTickerStatuses(
      processed.transitions
    );

  return {
    version:
      VERSION,

    sample_date:
      sampleDate,

    safety: {
      state_written: false,
      telegram_sent: false,
      network_fetched: false,
      database_written: false
    },

    rescue_rate:
      rescueRate,

    adapter: {
      diagnostics:
        adapted.diagnostics,

      no_post_tickers:
        adapted.no_post_tickers,

      invalid_plan_tickers:
        adapted.invalid_plan_tickers
    },

    renderer: {
      input_observations:
        adapted.observations.length,

      transition_count:
        processed.transitions.length,

      transition_status_counts:
        countStatuses(
          processed.transitions
        ),

      final_ticker_count:
        final.ticker_count,

      final_status_counts:
        final.counts,

      final_tickers:
        final.tickers,

      diagnostics:
        processed.diagnostics,

      message:
        rendered.text || ''
    },

    transitions:
      processed.transitions
  };
}

function replayHistoricalFiles(
  options
) {
  const opts =
    options || {};

  validateOptions(opts);

  const results = [];

  for (
    const sampleDate of
    opts.dates
  ) {
    const loaded =
      loadHistoricalDay(
        opts.prodRoot,
        sampleDate
      );

    const result =
      replayHistoricalDayData({
        sampleDate,

        radar:
          loaded.radar,

        candidates:
          loaded.candidates,

        events:
          loaded.events,

        rescueRate:
          opts.rescueRate
      });

    result.source_files =
      loaded.files;

    results.push(result);
  }

  return {
    version:
      VERSION,

    safety: {
      state_written: false,
      telegram_sent: false,
      network_fetched: false,
      database_written: false
    },

    results
  };
}

function formatCounts(counts) {
  const entries =
    Object.entries(
      counts || {}
    );

  if (!entries.length)
    return '-';

  return entries
    .map(
      ([key, value]) =>
        `${key}=${value}`
    )
    .join(', ');
}

function formatHumanDay(result) {
  const adapterDiagnostics =
    result.adapter.diagnostics;

  const lines = [
    '',
    '='.repeat(82),
    `DATE=${result.sample_date}`,
    '='.repeat(82),
    '',
    '--- ADAPTER ---',
    `RADAR=${adapterDiagnostics.radar_count}`,
    `REPLAYABLE_TICKERS=${adapterDiagnostics.replayable_tickers}`,
    `NO_POST=${adapterDiagnostics.no_post_tickers}`,
    `POST_OBSERVATIONS=${adapterDiagnostics.post_observations}`,
    `EXACT_RATE_JOIN=${adapterDiagnostics.exact_volume_rate_join}`,
    `RATE_GE_${result.rescue_rate}=${adapterDiagnostics.volume_rate_ge_4}`,
    `RATE_CONFLICTS=${adapterDiagnostics.volume_rate_conflicts}`,
    `NO_POST_TICKERS=${
      result.adapter.no_post_tickers.length
        ? result.adapter.no_post_tickers.join(',')
        : '-'
    }`,
    '',
    '--- RENDERER ---',
    `INPUT_OBSERVATIONS=${result.renderer.input_observations}`,
    `TRANSITIONS=${result.renderer.transition_count}`,
    `TRANSITION_STATUS_COUNTS=${formatCounts(
      result.renderer.transition_status_counts
    )}`,
    `FINAL_TICKERS=${result.renderer.final_ticker_count}`,
    `FINAL_STATUS_COUNTS=${formatCounts(
      result.renderer.final_status_counts
    )}`,
    '',
    'FINAL_TICKER_STATUS='
  ];

  for (
    const [ticker, status] of
    Object.entries(
      result.renderer.final_tickers
    )
  ) {
    lines.push(
      `${ticker}=${status}`
    );
  }

  lines.push(
    '',
    '--- TELEGRAM PREVIEW ONLY ---',
    result.renderer.message ||
      '[EMPTY DIGEST]',
    '',
    '--- END DATE ---'
  );

  return lines.join('\n');
}

function formatHumanRun(run) {
  const lines = [
    '=== HISTORICAL SHADOW REPLAY ===',
    'STATE_WRITE=FALSE',
    'NETWORK_FETCH=FALSE',
    'TELEGRAM_SEND=FALSE',
    'DATABASE_WRITE=FALSE'
  ];

  for (
    const result of
    run.results
  ) {
    lines.push(
      formatHumanDay(
        result
      )
    );
  }

  lines.push(
    '',
    '=== REPLAY COMPLETE ===',
    'STATE_WRITTEN=FALSE',
    'TELEGRAM_SENT=FALSE',
    'NETWORK_FETCHED=FALSE',
    'DATABASE_WRITTEN=FALSE'
  );

  return lines.join('\n');
}

async function main(argv) {
  const options =
    parseArgs(argv);

  if (options.help) {
    process.stdout.write(
      `${usage()}\n`
    );

    return {
      status: 'help'
    };
  }

  validateOptions(
    options
  );

  const run =
    replayHistoricalFiles(
      options
    );

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        run,
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(
      `${formatHumanRun(
        run
      )}\n`
    );
  }

  return {
    status: 'ok',
    run
  };
}

if (
  require.main === module
) {
  main(
    process.argv.slice(2)
  ).catch(error => {
    process.stderr.write(
      `ERROR=${
        error &&
        error.message
          ? error.message
          : String(error)
      }\n`
    );

    process.exitCode = 1;
  });
}

module.exports = {
  VERSION,
  DEFAULT_RESCUE_RATE,
  finite,
  normalizeDate,
  parseArgs,
  validateOptions,
  usage,
  readJson,
  readJsonl,
  historicalPaths,
  loadHistoricalDay,
  transitionStatus,
  transitionTicker,
  countStatuses,
  finalTickerStatuses,
  previewNowMs,
  replayHistoricalDayData,
  replayHistoricalFiles,
  formatCounts,
  formatHumanDay,
  formatHumanRun,
  main
};

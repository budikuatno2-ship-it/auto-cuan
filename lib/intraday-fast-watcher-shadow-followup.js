'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const VERSION = 'FAST_WATCHER_SHADOW_FOLLOWUP_V1';
const TIMEZONE = 'Asia/Jakarta';
const DEFAULT_TIMEOUT_MS = 12000;

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    typeof value === 'boolean'
  ) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTicker(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
}

function parseRadarKey(key) {
  const parts = String(key || '').split('|');

  let schema;
  let status;
  let source = null;
  let entryLow;
  let entryHigh;
  let tp1;
  let tp2;
  let stopLoss;

  if (parts.length === 6) {
    schema = 'LEGACY_6';
    status = parts[0];
    entryLow = numberOrNull(parts[1]);
    entryHigh = numberOrNull(parts[2]);
    tp1 = numberOrNull(parts[3]);
    tp2 = parts[4] === '-' ? null : numberOrNull(parts[4]);
    stopLoss = numberOrNull(parts[5]);
  } else if (parts.length === 7) {
    schema = 'ENRICHED_7';
    status = parts[0];
    source = parts[1];
    entryLow = numberOrNull(parts[2]);
    entryHigh = numberOrNull(parts[3]);
    tp1 = numberOrNull(parts[4]);
    tp2 = parts[5] === '-' ? null : numberOrNull(parts[5]);
    stopLoss = numberOrNull(parts[6]);
  } else {
    return {
      valid: false,
      schema: 'UNKNOWN',
      parts: parts.length,
      reason: 'unsupported_key_arity'
    };
  }

  const valid =
    entryLow !== null &&
    entryHigh !== null &&
    tp1 !== null &&
    stopLoss !== null &&
    entryLow > 0 &&
    entryHigh >= entryLow &&
    tp1 > entryHigh &&
    stopLoss < entryLow;

  return {
    valid,
    schema,
    parts: parts.length,
    status,
    source,
    entry_low: entryLow,
    entry_high: entryHigh,
    tp1,
    tp2,
    stop_loss: stopLoss,
    reason: valid ? null : 'invalid_trade_plan'
  };
}

function wibClock(nowMs) {
  const date = new Date(
    nowMs === undefined ? Date.now() : nowMs
  );

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  const dateStr =
    `${values.year}-${values.month}-${values.day}`;

  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const totalMinutes = hour * 60 + minute;

  const weekdayMap = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return {
    date: dateStr,
    weekday:
      weekdayMap[values.weekday] || null,
    hour,
    minute,
    total_minutes: totalMinutes
  };
}

function wibDate(nowMs) {
  return wibClock(nowMs).date;
}

function marketSessionStatus(nowMs) {
  const clock = wibClock(nowMs);
  const d = clock.weekday;
  const m = clock.total_minutes;

  if (!d || d >= 6) {
    return {
      open: false,
      reason: 'weekend',
      clock
    };
  }

  let open = false;

  if (d >= 1 && d <= 4) {
    open =
      (m >= 9 * 60 && m < 12 * 60) ||
      (m >= 13 * 60 + 30 && m < 16 * 60);
  } else if (d === 5) {
    open =
      (m >= 9 * 60 && m < 11 * 60 + 30) ||
      (m >= 14 * 60 && m < 16 * 60);
  }

  return {
    open,
    reason: open
      ? null
      : 'outside_market_session',
    clock
  };
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map(row => ({
      time: Number(row && row.time),
      open: numberOrNull(row && row.open),
      high: numberOrNull(row && row.high),
      low: numberOrNull(row && row.low),
      close: numberOrNull(row && row.close),
      volume: numberOrNull(row && row.volume) || 0
    }))
    .filter(row =>
      Number.isFinite(row.time) &&
      row.open !== null &&
      row.high !== null &&
      row.low !== null &&
      row.close !== null
    )
    .sort((a, b) => a.time - b.time);
}

function latestCandle(candles) {
  const rows = normalizeCandles(candles);
  return rows.length ? rows[rows.length - 1] : null;
}

function buildPublishedRows(ledger) {
  const tickers = ledger && ledger.tickers;

  if (!tickers || typeof tickers !== 'object') {
    return [];
  }

  return Object.entries(tickers)
    .map(([ticker, published]) => {
      const plan = parseRadarKey(published && published.key);

      return {
        ticker: normalizeTicker(ticker),
        sent_at: published && published.sent_at || null,
        scheduled_time: published && published.scheduled_time || null,
        published_status: published && published.status || null,
        published_key: published && published.key || null,
        plan
      };
    })
    .filter(row => row.ticker && row.plan.valid)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function readPublishedLedger(options) {
  const file = path.join(
    options.publishedDir,
    'radar',
    `${options.sampleDate}.json`
  );

  let parsed;

  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        file,
        missing: true,
        rows: []
      };
    }

    throw error;
  }

  return {
    file,
    missing: false,
    rows: buildPublishedRows(parsed)
  };
}

async function rawFetch15m(ticker, options) {
  /*
   * Lazy import:
   * unit tests and no-network preview do not even need
   * to initialize the production intraday provider.
   *
   * IMPORTANT:
   * use RAW fetchYahooIntradayCandles only.
   * Do NOT use fetchWithCache / runObserve because those
   * have cache/report side effects.
   */
  const provider = require('./daytrade-intraday-observe');

  return provider.fetchYahooIntradayCandles(
    ticker,
    {
      timeoutMs:
        Number(options && options.timeoutMs) ||
        DEFAULT_TIMEOUT_MS
    }
  );
}

function observationFromCandles(input) {
  const latest = latestCandle(input.candles);

  if (!latest) {
    return {
      version: VERSION,
      sample_date: input.sampleDate,
      observed_at: new Date(input.nowMs).toISOString(),
      ticker: input.published.ticker,
      source: 'yahoo_chart_15m_raw',
      interval: '15m',
      fetch_ok: false,
      error: input.error || 'no_intraday_candles',
      published_sent_at: input.published.sent_at,
      published_scheduled_time: input.published.scheduled_time,
      plan: input.published.plan
    };
  }

  const candleTimeMs = latest.time * 1000;

  const candleAgeMinutes =
    Number.isFinite(candleTimeMs)
      ? (input.nowMs - candleTimeMs) / 60000
      : null;

  const candleDate =
    Number.isFinite(candleTimeMs)
      ? wibDate(candleTimeMs)
      : null;

  const sameTradingDate =
    candleDate === input.sampleDate;

  return {
    version: VERSION,
    sample_date: input.sampleDate,
    observed_at: new Date(input.nowMs).toISOString(),
    ticker: input.published.ticker,
    source: 'yahoo_chart_15m_raw',
    interval: '15m',
    fetch_ok: sameTradingDate,
    freshness_valid:
      sameTradingDate,

    stale_reason:
      sameTradingDate
        ? null
        : 'candle_not_from_current_trading_date',

    candle_time:
      new Date(candleTimeMs).toISOString(),

    candle_wib_date:
      candleDate,

    candle_age_minutes:
      Number.isFinite(candleAgeMinutes)
        ? Number(candleAgeMinutes.toFixed(3))
        : null,

    current_price: latest.close,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    volume: latest.volume,

    published_sent_at:
      input.published.sent_at,

    published_scheduled_time:
      input.published.scheduled_time,

    plan:
      input.published.plan
  };
}

async function appendJsonl(file, rows) {
  if (!rows.length) return;

  await fs.mkdir(
    path.dirname(file),
    {
      recursive: true,
      mode: 0o700
    }
  );

  const payload =
    rows.map(row => JSON.stringify(row)).join('\n') +
    '\n';

  await fs.appendFile(
    file,
    payload,
    {
      mode: 0o600
    }
  );
}

async function runShadowFollowup(options) {
  const opts = Object.assign({
    networkFetch: false,
    persist: false,
    tickerFilter: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    nowMs: Date.now(),
    fetchFn: null
  }, options || {});

  if (!opts.sampleDate) {
    return {
      status: 'invalid_input',
      reason: 'missing_sample_date'
    };
  }

  if (!opts.publishedDir) {
    return {
      status: 'invalid_input',
      reason: 'missing_published_dir'
    };
  }

  if (opts.persist && !opts.outputRoot) {
    return {
      status: 'invalid_input',
      reason: 'missing_output_root'
    };
  }

  if (opts.networkFetch) {
    const today = wibDate(opts.nowMs);

    if (opts.sampleDate !== today) {
      return {
        status: 'blocked_historical_network_fetch',
        sample_date: opts.sampleDate,
        current_wib_date: today,
        network_fetch_attempted: false,
        persisted: false
      };
    }

    const market =
      marketSessionStatus(opts.nowMs);

    if (!market.open) {
      return {
        status: 'blocked_market_closed',
        reason: market.reason,
        sample_date: opts.sampleDate,
        current_wib_date: today,
        market_clock: market.clock,
        network_fetch_attempted: false,
        persisted: false
      };
    }
  }

  const ledger =
    await readPublishedLedger(opts);

  if (ledger.missing) {
    return {
      status: 'published_ledger_missing',
      sample_date: opts.sampleDate,
      published_file: ledger.file,
      published_count: 0,
      network_fetch_attempted: false,
      persisted: false,
      observations: []
    };
  }

  const publishedTotal =
    ledger.rows.length;

  let selectedRows =
    ledger.rows;

  let requestedTicker = null;

  if (
    opts.tickerFilter !== null &&
    opts.tickerFilter !== undefined &&
    String(opts.tickerFilter).trim() !== ''
  ) {
    requestedTicker =
      normalizeTicker(opts.tickerFilter);

    if (!requestedTicker) {
      return {
        status: 'invalid_input',
        reason: 'invalid_ticker_filter',
        sample_date: opts.sampleDate,
        published_total: publishedTotal,
        network_fetch_attempted: false,
        persisted: false
      };
    }

    selectedRows =
      ledger.rows.filter(
        row =>
          row.ticker === requestedTicker
      );

    if (!selectedRows.length) {
      return {
        status: 'published_ticker_not_found',
        sample_date: opts.sampleDate,
        requested_ticker: requestedTicker,
        published_total: publishedTotal,
        published_count: 0,
        network_fetch_attempted: false,
        persisted: false,
        observations: []
      };
    }
  }

  /*
   * Fail closed by default.
   * Reading the published ledger is allowed, but no provider
   * call occurs without explicit networkFetch=true.
   */
  if (!opts.networkFetch) {
    return {
      status: 'preview_no_network',
      sample_date: opts.sampleDate,
      published_file: ledger.file,
      published_total: publishedTotal,
      published_count: selectedRows.length,
      requested_ticker: requestedTicker,
      tickers:
        selectedRows.map(row => row.ticker),
      network_fetch_attempted: false,
      persisted: false,
      observations: []
    };
  }

  const fetchFn =
    opts.fetchFn ||
    ((ticker) =>
      rawFetch15m(
        ticker,
        {
          timeoutMs: opts.timeoutMs
        }
      ));

  const observations = [];

  for (const published of selectedRows) {
    try {
      const candles =
        await fetchFn(
          published.ticker,
          {
            timeoutMs: opts.timeoutMs
          }
        );

      observations.push(
        observationFromCandles({
          sampleDate: opts.sampleDate,
          nowMs: opts.nowMs,
          published,
          candles
        })
      );
    } catch (error) {
      observations.push(
        observationFromCandles({
          sampleDate: opts.sampleDate,
          nowMs: opts.nowMs,
          published,
          candles: [],
          error:
            String(
              error && error.message ||
              'fetch_failed'
            ).slice(0, 160)
        })
      );
    }
  }

  let outputFile = null;

  if (opts.persist) {
    outputFile = path.join(
      opts.outputRoot,
      opts.sampleDate,
      'observations.jsonl'
    );

    await appendJsonl(
      outputFile,
      observations
    );
  }

  return {
    status: 'ok',
    sample_date: opts.sampleDate,
    published_file: ledger.file,
    published_total: publishedTotal,
    published_count: selectedRows.length,
    requested_ticker: requestedTicker,
    fetched_count: observations.filter(row => row.fetch_ok).length,
    failed_count: observations.filter(row => !row.fetch_ok).length,
    network_fetch_attempted: true,
    persisted: opts.persist === true,
    output_file: outputFile,
    observations
  };
}

module.exports = {
  VERSION,
  TIMEZONE,
  DEFAULT_TIMEOUT_MS,
  numberOrNull,
  normalizeTicker,
  parseRadarKey,
  wibClock,
  wibDate,
  marketSessionStatus,
  normalizeCandles,
  latestCandle,
  buildPublishedRows,
  readPublishedLedger,
  observationFromCandles,
  appendJsonl,
  rawFetch15m,
  runShadowFollowup
};

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const VERSION =
  'FAST_WATCHER_SHADOW_RENDERER_V1';

const DEFAULT_MAX_CANDLE_AGE_MINUTES = 20;
const DEFAULT_RESCUE_RATE = 4;

const TERMINAL = new Set([
  'TP1',
  'SL',
  'AMBIGUOUS',
  'INVALIDATED'
]);

function n(value) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    typeof value === 'boolean'
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function normalizeTicker(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
}

function timeMs(value) {
  const parsed = Date.parse(value || '');

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function normalizePlan(row) {
  const source =
    row && row.plan &&
    typeof row.plan === 'object'
      ? row.plan
      : {};

  const entryLow =
    n(source.entry_low);

  const entryHigh =
    n(source.entry_high);

  const tp1 =
    n(source.tp1);

  const tp2 =
    n(source.tp2);

  const stopLoss =
    n(
      source.stop_loss !== undefined
        ? source.stop_loss
        : source.sl
    );

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
    status:
      String(source.status || ''),
    source:
      String(source.source || ''),
    entry_low: entryLow,
    entry_high: entryHigh,
    tp1,
    tp2,
    stop_loss: stopLoss
  };
}

function volumeRate(row) {
  const direct =
    n(row && row.volume_rate_vs_average);

  if (direct !== null)
    return direct;

  return n(
    row &&
    row.metrics &&
    row.metrics.volume_rate_vs_average
  );
}

function spikeHint(row, plan) {
  const text = [
    plan && plan.status,
    plan && plan.source,
    row && row.status,
    row && row.published_status,
    row && row.lifecycle_hint
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  return text.includes('SPIKE');
}

function freshEnough(row, options) {
  const maxAge =
    n(options.maxCandleAgeMinutes) ??
    DEFAULT_MAX_CANDLE_AGE_MINUTES;

  if (!row)
    return false;

  if (row.fetch_ok !== true)
    return false;

  if (row.freshness_valid === false)
    return false;

  const age =
    n(row.candle_age_minutes);

  if (age !== null && age > maxAge)
    return false;

  return n(row.current_price) !== null;
}

function safeCandleBounds(row) {
  const current =
    n(row.current_price);

  const sent =
    timeMs(row.published_sent_at);

  const candle =
    timeMs(row.candle_time);

  /*
   * Yahoo 15m candle OHLC is safe as post-publication
   * evidence only when the candle itself starts at or
   * after the publication timestamp.
   *
   * If the alert was sent in the middle of that candle,
   * using its high/low could leak pre-publication movement.
   * In that case use only the sampled current price.
   */
  const fullPostPublishCandle =
    sent !== null &&
    candle !== null &&
    candle >= sent;

  if (!fullPostPublishCandle) {
    return {
      high: current,
      low: current,
      full_post_publish_candle: false
    };
  }

  const high = n(row.high);
  const low = n(row.low);

  return {
    high:
      high !== null && current !== null
        ? Math.max(high, current)
        : current,
    low:
      low !== null && current !== null
        ? Math.min(low, current)
        : current,
    full_post_publish_candle: true
  };
}

function initialTickerState() {
  return {
    last_status: null,
    entry_triggered: false,
    closed: false,
    terminal_status: null,
    last_observed_at: null,
    last_current_price: null
  };
}

function normalizeState(state) {
  const input =
    state &&
    typeof state === 'object'
      ? state
      : {};

  const tickers =
    input.tickers &&
    typeof input.tickers === 'object'
      ? input.tickers
      : {};

  return {
    version: VERSION,
    tickers: JSON.parse(
      JSON.stringify(tickers)
    )
  };
}

function classifyObservation(
  row,
  previousState,
  options
) {
  options = Object.assign({
    maxCandleAgeMinutes:
      DEFAULT_MAX_CANDLE_AGE_MINUTES,
    rescueRate:
      DEFAULT_RESCUE_RATE
  }, options || {});

  const ticker =
    normalizeTicker(row && row.ticker);

  const previous =
    Object.assign(
      initialTickerState(),
      previousState || {}
    );

  const plan =
    normalizePlan(row);

  const current =
    n(row && row.current_price);

  if (!ticker || !plan.valid) {
    return {
      ticker,
      status: 'INVALIDATED',
      reason: 'invalid_shadow_observation',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: true
    };
  }

  /*
   * Once a trade/setup is terminal, later price rows
   * cannot reopen it.
   */
  if (previous.closed) {
    return {
      ticker,
      status:
        previous.terminal_status ||
        previous.last_status ||
        'INVALIDATED',
      reason: 'already_closed',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: true,
      suppressed_closed: true
    };
  }

  if (!freshEnough(row, options)) {
    return {
      ticker,
      status: 'STALE',
      reason:
        row.stale_reason ||
        'shadow_observation_not_fresh',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: false
    };
  }

  const bounds =
    safeCandleBounds(row);

  const priorEntry =
    previous.entry_triggered === true;

  const currentInsideEntry =
    current >= plan.entry_low &&
    current <= plan.entry_high;

  const candleTouchesEntry =
    bounds.full_post_publish_candle &&
    bounds.high !== null &&
    bounds.low !== null &&
    bounds.high >= plan.entry_low &&
    bounds.low <= plan.entry_high;

  const entryTouchedNow =
    currentInsideEntry ||
    candleTouchesEntry;

  const entryEstablished =
    priorEntry ||
    entryTouchedNow;

  const tpTouched =
    entryEstablished &&
    bounds.high !== null &&
    bounds.high >= plan.tp1;

  const slTouched =
    entryEstablished &&
    bounds.low !== null &&
    bounds.low <= plan.stop_loss;

  /*
   * If entry and TP/SL appear for the first time inside
   * the SAME 15m candle, OHLC does not reveal path order.
   * Never manufacture a TP or SL from that ambiguity.
   */
  if (
    !priorEntry &&
    candleTouchesEntry &&
    (tpTouched || slTouched)
  ) {
    return {
      ticker,
      status: 'AMBIGUOUS',
      reason:
        'entry_and_terminal_same_15m_interval',
      plan,
      current_price: current,
      entry_triggered_now: true,
      terminal: true
    };
  }

  if (priorEntry) {
    if (tpTouched && slTouched) {
      return {
        ticker,
        status: 'AMBIGUOUS',
        reason:
          'tp_sl_same_15m_interval',
        plan,
        current_price: current,
        entry_triggered_now: false,
        terminal: true
      };
    }

    if (tpTouched) {
      return {
        ticker,
        status: 'TP1',
        reason: 'tp1_touched_after_entry',
        plan,
        current_price: current,
        entry_triggered_now: false,
        terminal: true
      };
    }

    if (slTouched) {
      return {
        ticker,
        status: 'SL',
        reason: 'stop_touched_after_entry',
        plan,
        current_price: current,
        entry_triggered_now: false,
        terminal: true
      };
    }

    return {
      ticker,
      status: 'ENTRY_TRIGGERED',
      reason: 'position_open',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: false
    };
  }

  /*
   * Before entry, touching/breaking SL invalidates the
   * setup but is NOT counted as a trading loss.
   */
  if (current <= plan.stop_loss) {
    return {
      ticker,
      status: 'INVALIDATED',
      reason: 'plan_broken_before_entry',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: true
    };
  }

  if (currentInsideEntry) {
    return {
      ticker,
      status: 'ENTRY_TRIGGERED',
      reason: 'sampled_price_inside_entry',
      plan,
      current_price: current,
      entry_triggered_now: true,
      terminal: false
    };
  }

  if (candleTouchesEntry) {
    return {
      ticker,
      status: 'ENTRY_TRIGGERED',
      reason:
        'post_publish_15m_candle_touched_entry',
      plan,
      current_price: current,
      entry_triggered_now: true,
      terminal: false
    };
  }

  /*
   * Already beyond TP without a proven entry is not a
   * retrospective win. It is late/non-executable.
   */
  if (current >= plan.tp1) {
    return {
      ticker,
      status: 'LATE',
      reason:
        'beyond_tp_without_proven_entry',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: false
    };
  }

  if (
    spikeHint(row, plan) &&
    current > plan.entry_high
  ) {
    return {
      ticker,
      status: 'SPIKE',
      reason: 'spike_chase_risk',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: false
    };
  }

  /*
   * Frozen Lane A:
   * price remains below entry_high and plan is intact.
   */
  if (current < plan.entry_high) {
    return {
      ticker,
      status: 'WORTH_IT',
      reason: 'lane_a_price_below_entry_high',
      plan,
      current_price: current,
      entry_triggered_now: false,
      terminal: false
    };
  }

  /*
   * Frozen Lane B / Momentum Rescue.
   * Rescue is fail-closed when exact rate is absent.
   */
  const rate =
    volumeRate(row);

  if (
    current >= plan.entry_high &&
    current < plan.tp1 &&
    rate !== null &&
    rate >= options.rescueRate
  ) {
    return {
      ticker,
      status: 'MOMENTUM_RESCUE',
      reason: 'lane_b_volume_rate_rescue',
      plan,
      current_price: current,
      volume_rate_vs_average: rate,
      entry_triggered_now: false,
      terminal: false
    };
  }

  return {
    ticker,
    status: 'LATE',
    reason:
      rate === null
        ? 'above_entry_high_no_rescue_rate'
        : 'above_entry_high_rescue_rate_too_low',
    plan,
    current_price: current,
    volume_rate_vs_average: rate,
    entry_triggered_now: false,
    terminal: false
  };
}

function applyClassification(
  row,
  classification,
  previousState
) {
  const previous =
    Object.assign(
      initialTickerState(),
      previousState || {}
    );

  const terminal =
    classification.terminal === true ||
    TERMINAL.has(classification.status);

  return {
    last_status:
      classification.status,

    entry_triggered:
      previous.entry_triggered === true ||
      classification.entry_triggered_now === true,

    closed:
      previous.closed === true ||
      terminal,

    terminal_status:
      terminal
        ? classification.status
        : previous.terminal_status,

    last_observed_at:
      row.observed_at ||
      previous.last_observed_at ||
      null,

    last_current_price:
      n(row.current_price)
  };
}

function rowSortMs(row) {
  return (
    timeMs(row && row.observed_at) ??
    timeMs(row && row.candle_time) ??
    0
  );
}

function processObservationSequence(
  rows,
  state,
  options
) {
  const nextState =
    normalizeState(state);

  const transitions = [];
  let skippedOld = 0;
  let suppressedSame = 0;
  let suppressedClosed = 0;

  const sorted =
    (Array.isArray(rows) ? rows : [])
      .slice()
      .sort((a, b) =>
        rowSortMs(a) - rowSortMs(b)
      );

  for (const row of sorted) {
    const ticker =
      normalizeTicker(row && row.ticker);

    if (!ticker)
      continue;

    const previous =
      Object.assign(
        initialTickerState(),
        nextState.tickers[ticker] || {}
      );

    const incomingMs =
      rowSortMs(row);

    const previousMs =
      timeMs(previous.last_observed_at);

    if (
      previousMs !== null &&
      incomingMs <= previousMs
    ) {
      skippedOld++;
      continue;
    }

    if (previous.closed) {
      suppressedClosed++;

      nextState.tickers[ticker] =
        Object.assign({}, previous, {
          last_observed_at:
            row.observed_at ||
            previous.last_observed_at
        });

      continue;
    }

    const classification =
      classifyObservation(
        row,
        previous,
        options
      );

    const nextTickerState =
      applyClassification(
        row,
        classification,
        previous
      );

    nextState.tickers[ticker] =
      nextTickerState;

    const changed =
      classification.status !==
      previous.last_status;

    if (!changed) {
      suppressedSame++;
      continue;
    }

    transitions.push({
      ticker,
      from_status:
        previous.last_status,
      to_status:
        classification.status,
      observed_at:
        row.observed_at || null,
      current_price:
        classification.current_price,
      volume_rate_vs_average:
        classification
          .volume_rate_vs_average ?? null,
      reason:
        classification.reason,
      plan:
        classification.plan
    });
  }

  return {
    state: nextState,
    transitions,
    diagnostics: {
      input_rows:
        Array.isArray(rows)
          ? rows.length
          : 0,
      transition_count:
        transitions.length,
      skipped_old:
        skippedOld,
      suppressed_same_status:
        suppressedSame,
      suppressed_after_closed:
        suppressedClosed
    }
  };
}

function collapseTransitions(transitions) {
  const latest = new Map();

  for (const transition of transitions || []) {
    latest.set(
      transition.ticker,
      transition
    );
  }

  return Array.from(
    latest.values()
  );
}

function fmtPrice(value) {
  const parsed = n(value);

  return parsed === null
    ? '-'
    : parsed.toLocaleString('id-ID');
}

function fmtRate(value) {
  const parsed = n(value);

  return parsed === null
    ? '-'
    : `${parsed.toFixed(2)}×`;
}

function renderDetailed(transition) {
  const p = transition.plan;

  return [
    transition.ticker,
    `Harga ${fmtPrice(transition.current_price)}`,
    `Entry ${fmtPrice(p.entry_low)}–${fmtPrice(p.entry_high)}`,
    `TP1 ${fmtPrice(p.tp1)}`,
    `SL ${fmtPrice(p.stop_loss)}`
  ].join(' | ');
}

function hhmmWib(nowMs) {
  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }
    ).formatToParts(
      new Date(
        nowMs === undefined
          ? Date.now()
          : nowMs
      )
    );

  const values =
    Object.fromEntries(
      parts
        .filter(
          part =>
            part.type !== 'literal'
        )
        .map(
          part => [
            part.type,
            part.value
          ]
        )
    );

  return `${values.hour}:${values.minute}`;
}

function renderDigest(
  transitions,
  options
) {
  options =
    Object.assign({
      nowMs: Date.now()
    }, options || {});

  const rows =
    collapseTransitions(
      transitions || []
    );

  if (!rows.length) {
    return {
      empty: true,
      text: '',
      counts: {}
    };
  }

  const groups = {
    WORTH_IT: [],
    MOMENTUM_RESCUE: [],
    ENTRY_TRIGGERED: [],
    TP1: [],
    SL: [],
    AMBIGUOUS: [],
    INVALIDATED: [],
    SPIKE: [],
    LATE: [],
    STALE: []
  };

  for (const row of rows) {
    if (groups[row.to_status]) {
      groups[row.to_status].push(row);
    }
  }

  for (const group of Object.values(groups)) {
    group.sort(
      (a, b) =>
        a.ticker.localeCompare(
          b.ticker
        )
    );
  }

  const lines = [
    `📊 FAST WATCHER UPDATE — ${hhmmWib(options.nowMs)} WIB`
  ];

  if (groups.WORTH_IT.length) {
    lines.push(
      '',
      '✅ MASIH WORTH IT'
    );

    for (const row of groups.WORTH_IT) {
      lines.push(
        renderDetailed(row)
      );
    }
  }

  if (
    groups.MOMENTUM_RESCUE.length
  ) {
    lines.push(
      '',
      '🔥 MOMENTUM RESCUE'
    );

    for (
      const row of
      groups.MOMENTUM_RESCUE
    ) {
      lines.push(
        `${renderDetailed(row)} | Volume Rate ${fmtRate(row.volume_rate_vs_average)}`
      );
    }
  }

  if (
    groups.ENTRY_TRIGGERED.length
  ) {
    lines.push(
      '',
      '🎯 ENTRY TERPICU'
    );

    for (
      const row of
      groups.ENTRY_TRIGGERED
    ) {
      lines.push(
        renderDetailed(row)
      );
    }
  }

  if (groups.TP1.length) {
    lines.push(
      '',
      `🏆 TP1 TERCAPAI: ${groups.TP1.map(row => row.ticker).join(', ')}`
    );
  }

  if (groups.SL.length) {
    lines.push(
      '',
      `🛑 SL TERCAPAI: ${groups.SL.map(row => row.ticker).join(', ')}`
    );
  }

  if (
    groups.AMBIGUOUS.length
  ) {
    lines.push(
      '',
      `⚠️ TIMING AMBIGU: ${groups.AMBIGUOUS.map(row => row.ticker).join(', ')}`
    );
  }

  if (
    groups.INVALIDATED.length
  ) {
    lines.push(
      '',
      `🛑 INVALIDATED: ${groups.INVALIDATED.map(row => row.ticker).join(', ')}`
    );
  }

  if (groups.SPIKE.length) {
    lines.push(
      '',
      `⚡ SPIKE — JANGAN CHASE: ${groups.SPIKE.map(row => row.ticker).join(', ')}`
    );
  }

  if (groups.LATE.length) {
    lines.push(
      '',
      `⏰ SUDAH TERLAMBAT: ${groups.LATE.map(row => row.ticker).join(', ')}`
    );
  }

  if (groups.STALE.length) {
    lines.push(
      '',
      `📡 DATA TIDAK FRESH: ${groups.STALE.map(row => row.ticker).join(', ')}`
    );
  }

  const counts =
    Object.fromEntries(
      Object.entries(groups)
        .map(
          ([key, value]) => [
            key,
            value.length
          ]
        )
    );

  return {
    empty: false,
    text: lines.join('\n'),
    counts
  };
}

async function readJsonl(file) {
  let content;

  try {
    content =
      await fs.readFile(
        file,
        'utf8'
      );
  } catch (error) {
    if (
      error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }

    throw error;
  }

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readState(file) {
  if (!file)
    return normalizeState(null);

  try {
    const parsed =
      JSON.parse(
        await fs.readFile(
          file,
          'utf8'
        )
      );

    return normalizeState(parsed);
  } catch (error) {
    if (
      error &&
      error.code === 'ENOENT'
    ) {
      return normalizeState(null);
    }

    throw error;
  }
}

async function writeStateAtomic(
  file,
  state
) {
  await fs.mkdir(
    path.dirname(file),
    {
      recursive: true,
      mode: 0o700
    }
  );

  const temp =
    `${file}.tmp-${process.pid}`;

  await fs.writeFile(
    temp,
    JSON.stringify(
      normalizeState(state),
      null,
      2
    ) + '\n',
    {
      mode: 0o600
    }
  );

  await fs.rename(
    temp,
    file
  );
}

async function runRenderer(options) {
  const opts =
    Object.assign({
      commitState: false,
      maxCandleAgeMinutes:
        DEFAULT_MAX_CANDLE_AGE_MINUTES,
      rescueRate:
        DEFAULT_RESCUE_RATE,
      nowMs: Date.now()
    }, options || {});

  if (!opts.observationsFile) {
    return {
      status: 'invalid_input',
      reason:
        'missing_observations_file'
    };
  }

  if (
    opts.commitState &&
    !opts.stateFile
  ) {
    return {
      status: 'invalid_input',
      reason:
        'commit_state_requires_state_file'
    };
  }

  const rows =
    await readJsonl(
      opts.observationsFile
    );

  const state =
    await readState(
      opts.stateFile
    );

  const processed =
    processObservationSequence(
      rows,
      state,
      {
        maxCandleAgeMinutes:
          opts.maxCandleAgeMinutes,
        rescueRate:
          opts.rescueRate
      }
    );

  const rendered =
    renderDigest(
      processed.transitions,
      {
        nowMs: opts.nowMs
      }
    );

  if (opts.commitState) {
    await writeStateAtomic(
      opts.stateFile,
      processed.state
    );
  }

  return {
    status:
      rendered.empty
        ? 'no_changes'
        : 'ok',

    observations_file:
      opts.observationsFile,

    state_file:
      opts.stateFile || null,

    state_committed:
      opts.commitState === true,

    transitions:
      processed.transitions,

    diagnostics:
      processed.diagnostics,

    counts:
      rendered.counts,

    message:
      rendered.text
  };
}

module.exports = {
  VERSION,
  DEFAULT_MAX_CANDLE_AGE_MINUTES,
  DEFAULT_RESCUE_RATE,
  TERMINAL,
  n,
  normalizeTicker,
  normalizePlan,
  volumeRate,
  spikeHint,
  freshEnough,
  safeCandleBounds,
  initialTickerState,
  normalizeState,
  classifyObservation,
  applyClassification,
  processObservationSequence,
  collapseTransitions,
  renderDigest,
  readJsonl,
  readState,
  writeStateAtomic,
  runRenderer
};

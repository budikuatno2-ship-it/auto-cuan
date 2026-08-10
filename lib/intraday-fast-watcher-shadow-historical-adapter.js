'use strict';

/*
 * Historical adapter for Fast Watcher Shadow Lifecycle.
 *
 * Purpose:
 *   Convert already-recorded production radar + candidate snapshots +
 *   Fast Watcher event metrics into the conservative observation contract
 *   consumed by intraday-fast-watcher-shadow-renderer.
 *
 * Safety / provenance rules:
 *   - published radar is the immutable source of the trade plan;
 *   - only candidate snapshots at/after radar sent_at are eligible;
 *   - historical daily/session high/low are NEVER forwarded as 15m OHLC;
 *   - candle_time is NEVER invented;
 *   - current_price is sampled-price evidence only;
 *   - volume_rate_vs_average is joined only from the exact production
 *     Fast Watcher event metric at the same ticker + scheduled_time;
 *   - conflicting exact rates fail closed and are omitted;
 *   - no network, Telegram, database, filesystem write, or state mutation.
 */

const VERSION = 'shadow-historical-adapter-v1';

function finite(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeTicker(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\.JK$/, '');
}

function timeMs(value) {
  if (!value)
    return null;

  const parsed = Date.parse(String(value));

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function normalizeRadarEntries(radar) {
  const source =
    radar &&
    typeof radar === 'object'
      ? radar.tickers
      : null;

  if (Array.isArray(source)) {
    return source
      .filter(
        item =>
          item &&
          typeof item === 'object'
      )
      .map(item => Object.assign({}, item, {
        ticker:
          normalizeTicker(item.ticker)
      }))
      .filter(item => item.ticker);
  }

  if (
    source &&
    typeof source === 'object'
  ) {
    return Object.entries(source)
      .map(([ticker, value]) => {
        const item =
          value &&
          typeof value === 'object'
            ? Object.assign({}, value)
            : { value };

        item.ticker =
          normalizeTicker(
            item.ticker || ticker
          );

        return item;
      })
      .filter(item => item.ticker);
  }

  return [];
}

function parseRadarPlan(item) {
  const key =
    String(
      item && item.key || ''
    );

  const parts =
    key.split('|');

  if (parts.length < 6) {
    return {
      valid: false,
      reason: 'radar_key_missing_plan'
    };
  }

  const values =
    parts.slice(-5)
      .map(finite);

  const [
    entryLow,
    entryHigh,
    tp1,
    tp2,
    stopLoss
  ] = values;

  const valid =
    entryLow !== null &&
    entryHigh !== null &&
    tp1 !== null &&
    tp2 !== null &&
    stopLoss !== null &&
    entryLow > 0 &&
    entryHigh >= entryLow &&
    tp1 > entryHigh &&
    stopLoss < entryLow;

  if (!valid) {
    return {
      valid: false,
      reason: 'radar_key_invalid_plan'
    };
  }

  return {
    valid: true,
    source: 'published_radar_key',
    prefix: parts.slice(0, -5),
    entry_low: entryLow,
    entry_high: entryHigh,
    tp1,
    tp2,
    stop_loss: stopLoss
  };
}

function buildEventIndex(events) {
  const index =
    new Map();

  for (
    const event of
    Array.isArray(events)
      ? events
      : []
  ) {
    const ticker =
      normalizeTicker(
        event && event.ticker
      );

    const scheduledTime =
      String(
        event && event.time || ''
      ).trim();

    if (
      !ticker ||
      !scheduledTime
    ) {
      continue;
    }

    const key =
      `${ticker}|${scheduledTime}`;

    if (!index.has(key)) {
      index.set(key, []);
    }

    index.get(key).push(event);
  }

  return index;
}

function exactVolumeRate(events) {
  const values = [];

  for (
    const event of
    Array.isArray(events)
      ? events
      : []
  ) {
    const metrics =
      event &&
      event.metrics &&
      typeof event.metrics === 'object'
        ? event.metrics
        : null;

    const value =
      finite(
        metrics &&
        metrics.volume_rate_vs_average
      );

    if (value !== null) {
      values.push(value);
    }
  }

  const unique =
    [...new Set(values)]
      .sort((a, b) => a - b);

  if (!unique.length) {
    return {
      available: false,
      conflict: false,
      value: null,
      values: []
    };
  }

  if (unique.length > 1) {
    return {
      available: false,
      conflict: true,
      value: null,
      values: unique
    };
  }

  return {
    available: true,
    conflict: false,
    value: unique[0],
    values: unique
  };
}

function candidateIsStale(row) {
  return Boolean(
    row &&
    row.freshness &&
    typeof row.freshness === 'object' &&
    row.freshness.is_stale === true
  );
}

function buildHistoricalObservations(options) {
  const opts =
    options || {};

  const sampleDate =
    String(
      opts.sampleDate || ''
    ).trim();

  const radarEntries =
    normalizeRadarEntries(
      opts.radar
    );

  const candidates =
    Array.isArray(opts.candidates)
      ? opts.candidates
      : [];

  const events =
    Array.isArray(opts.events)
      ? opts.events
      : [];

  const candidatesByTicker =
    new Map();

  for (const candidate of candidates) {
    const ticker =
      normalizeTicker(
        candidate &&
        candidate.ticker
      );

    if (!ticker)
      continue;

    if (
      !candidatesByTicker.has(
        ticker
      )
    ) {
      candidatesByTicker.set(
        ticker,
        []
      );
    }

    candidatesByTicker
      .get(ticker)
      .push(candidate);
  }

  const eventIndex =
    buildEventIndex(events);

  const observations = [];
  const noPostTickers = [];
  const invalidPlanTickers = [];

  const diagnostics = {
    radar_count:
      radarEntries.length,

    plan_ok: 0,
    plan_invalid: 0,

    replayable_tickers: 0,
    no_post_tickers: 0,

    post_observations: 0,
    current_price_missing: 0,
    stale_observations: 0,

    event_join_any: 0,
    exact_volume_rate_join: 0,
    volume_rate_ge_4: 0,
    volume_rate_conflicts: 0
  };

  for (const radarItem of radarEntries) {
    const ticker =
      normalizeTicker(
        radarItem.ticker
      );

    const plan =
      parseRadarPlan(
        radarItem
      );

    if (!plan.valid) {
      diagnostics.plan_invalid += 1;
      invalidPlanTickers.push(ticker);
      continue;
    }

    diagnostics.plan_ok += 1;

    const sentAt =
      radarItem.sent_at;

    const sentMs =
      timeMs(sentAt);

    const tickerRows =
      (
        candidatesByTicker.get(
          ticker
        ) || []
      )
        .map(row => ({
          row,
          observedMs:
            timeMs(
              row &&
              row.sample_timestamp
            )
        }))
        .filter(item =>
          sentMs !== null &&
          item.observedMs !== null &&
          item.observedMs >= sentMs
        )
        .sort(
          (a, b) =>
            a.observedMs -
            b.observedMs
        );

    if (!tickerRows.length) {
      diagnostics.no_post_tickers += 1;
      noPostTickers.push(ticker);
      continue;
    }

    diagnostics.replayable_tickers += 1;

    for (const item of tickerRows) {
      const row =
        item.row;

      const current =
        finite(
          row &&
          row.current_price
        );

      if (current === null) {
        diagnostics
          .current_price_missing += 1;
        continue;
      }

      const stale =
        candidateIsStale(row);

      if (stale) {
        diagnostics
          .stale_observations += 1;
      }

      const scheduledTime =
        String(
          row &&
          row.scheduled_time || ''
        ).trim();

      const eventRows =
        eventIndex.get(
          `${ticker}|${scheduledTime}`
        ) || [];

      if (eventRows.length) {
        diagnostics
          .event_join_any += 1;
      }

      const rate =
        exactVolumeRate(
          eventRows
        );

      if (rate.conflict) {
        diagnostics
          .volume_rate_conflicts += 1;
      }

      if (rate.available) {
        diagnostics
          .exact_volume_rate_join += 1;

        if (rate.value >= 4) {
          diagnostics
            .volume_rate_ge_4 += 1;
        }
      }

      const observation = {
        schema_version: VERSION,
        source:
          'historical_sampled_price',

        sample_date:
          sampleDate || null,

        ticker,

        observed_at:
          row.sample_timestamp,

        published_sent_at:
          sentAt,

        published_scheduled_time:
          radarItem.scheduled_time ||
          null,

        scheduled_time:
          scheduledTime || null,

        published_status:
          radarItem.status || null,

        published_key:
          radarItem.key || null,

        radar_watch_score:
          finite(
            radarItem.watch_score
          ),

        current_price:
          current,

        /*
         * Historical candidate OHLC is DAILY/session OHLC.
         * Do not forward high/low/open or invent candle_time.
         * Renderer safeCandleBounds() will therefore use only
         * current_price as conservative sampled-price evidence.
         */

        fetch_ok: true,

        freshness_valid:
          stale !== true,

        stale_reason:
          stale
            ? (
                row.freshness &&
                row.freshness.stale_reason
              ) ||
              'historical_candidate_marked_stale'
            : null,

        /*
         * Renderer contract: normalizePlan() reads row.plan.
         * Preserve the immutable published-radar plan here.
         *
         * TP2 is provenance/display metadata only for the
         * current lifecycle classifier; it is not allowed to
         * invalidate an otherwise executable TP1/SL plan.
         */
        plan: {
          status:
            radarItem.status || null,

          source:
            plan.source,

          entry_low:
            plan.entry_low,

          entry_high:
            plan.entry_high,

          tp1:
            plan.tp1,

          tp2:
            plan.tp2,

          stop_loss:
            plan.stop_loss
        },

        /*
         * Keep flat fields as additive provenance/debug data.
         */
        entry_low:
          plan.entry_low,

        entry_high:
          plan.entry_high,

        tp1:
          plan.tp1,

        tp2:
          plan.tp2,

        stop_loss:
          plan.stop_loss,

        sl:
          plan.stop_loss,

        plan_source:
          plan.source,

        plan_prefix:
          plan.prefix
      };

      /*
       * Lane B is fail-closed:
       * only attach the exact production metric when the
       * ticker+scheduled_time join has one unambiguous value.
       */
      if (rate.available) {
        observation
          .volume_rate_vs_average =
            rate.value;
      }

      observations.push(
        observation
      );

      diagnostics
        .post_observations += 1;
    }
  }

  observations.sort((a, b) => {
    const aTime =
      timeMs(a.observed_at) || 0;

    const bTime =
      timeMs(b.observed_at) || 0;

    if (aTime !== bTime)
      return aTime - bTime;

    return a.ticker.localeCompare(
      b.ticker
    );
  });

  return {
    status: 'ok',
    version: VERSION,
    sample_date:
      sampleDate || null,

    observations,

    no_post_tickers:
      noPostTickers,

    invalid_plan_tickers:
      invalidPlanTickers,

    diagnostics
  };
}

module.exports = {
  VERSION,
  finite,
  normalizeTicker,
  timeMs,
  normalizeRadarEntries,
  parseRadarPlan,
  buildEventIndex,
  exactVolumeRate,
  candidateIsStale,
  buildHistoricalObservations
};

'use strict';

// Centralized thresholds/config for the Daily Market Context data layer.
// Keep this the single source of truth so RSI/volume/foreign thresholds are
// never hardcoded in more than one place.

module.exports = {
  // Feature flag gate for any future Fast Watcher integration. The frozen
  // Fast Watcher persistence/confirmation logic (commit 680ec37c) must never
  // change based on this layer while the flag is false (the default).
  FAST_WATCHER_DAILY_CONTEXT_ENABLED:
    String(process.env.FAST_WATCHER_DAILY_CONTEXT_ENABLED || 'false').toLowerCase() === 'true',

  RSI_PERIOD: 14,
  RSI_OVERSOLD_MAX: 30,
  RSI_OVERBOUGHT_MIN: 70,

  // History retention: enough for RSI14 plus headroom for future research
  // (moving averages, longer-window volume stats) without unbounded growth.
  HISTORY_RETENTION_TRADING_SESSIONS: 120,

  // Website/API surface only shows the most recent N trading sessions.
  DISPLAY_TRADING_SESSIONS: 7,

  // Freshness window for treating a "last price" as current, not stale.
  PRICE_FRESHNESS_MAX_AGE_HOURS: 30,

  DATA_QUALITY: {
    OK: 'ok',
    PARTIAL: 'partial',
    STALE: 'stale',
    ESTIMATED: 'estimated'
  }
};

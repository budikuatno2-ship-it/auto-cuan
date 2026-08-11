-- ============================================================
-- Daily Market Context Data Layer — v1 Migration
-- Run this manually in Supabase SQL Editor after review.
-- Safe to run multiple times (idempotent CREATE/ALTER IF NOT EXISTS).
--
-- Introduces:
--   idx_trading_calendar   — IDX exchange trading-day / holiday calendar
--   stock_daily_history    — durable per-ticker daily OHLCV + foreign flow archive
--   stock_daily_features   — precomputed "latest feature" snapshot cache (avoids
--                            recomputing RSI/volume/foreign context on every read)
--   stock_fundamentals     — latest known book-value-per-share / equity input for PBV
--
-- This migration does NOT modify any existing table used by the Fast Watcher,
-- Day Trade screener, Swing screener, or Telegram delivery pipeline.
-- ============================================================

-- ------------------------------------------------------------
-- 1. IDX Trading Calendar
-- ------------------------------------------------------------
-- Weekend (Sat/Sun) is always derived in application code and does NOT need a
-- row here. This table only needs to carry exchange HOLIDAY overrides (and,
-- optionally, explicit TRADING confirmations for dates that would otherwise
-- look like a holiday, e.g. a cuti bersama that IDX did not observe).
--
-- Table intentionally ships EMPTY of holiday rows in this migration: the
-- authoritative IDX/KSEI holiday announcement (Peng-00171/BEI.POP/09-2025 for
-- 2026) could not be fetched over the network in this environment, and the
-- project must never fabricate exchange holiday data (see AUDIT/README notes).
-- Populate rows manually from the official IDX announcement before relying on
-- calendar-based automation for anything beyond the weekend guard.
CREATE TABLE IF NOT EXISTS idx_trading_calendar (
  trade_date DATE PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('HOLIDAY', 'TRADING')),
  name TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  verified_at TIMESTAMPTZ,
  override_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idx_trading_calendar_status ON idx_trading_calendar (status);

ALTER TABLE idx_trading_calendar ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 2. Stock Daily History (durable archive)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_daily_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  trade_date DATE NOT NULL,

  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC,
  previous_close NUMERIC,

  volume NUMERIC,
  value NUMERIC,
  frequency NUMERIC,

  foreign_buy_value NUMERIC,
  foreign_sell_value NUMERIC,
  foreign_net_value NUMERIC,

  foreign_buy_lot NUMERIC,
  foreign_sell_lot NUMERIC,
  foreign_net_lot NUMERIC,

  data_source TEXT NOT NULL DEFAULT 'yahoo',
  source_timestamp TIMESTAMPTZ,
  data_quality_status TEXT NOT NULL DEFAULT 'ok'
    CHECK (data_quality_status IN ('ok', 'partial', 'stale', 'estimated')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT stock_daily_history_ticker_upper_chk CHECK (ticker = UPPER(ticker)),
  CONSTRAINT stock_daily_history_ticker_date_key UNIQUE (ticker, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_daily_history_ticker_date
  ON stock_daily_history (ticker, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_daily_history_trade_date
  ON stock_daily_history (trade_date DESC);

ALTER TABLE stock_daily_history ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 3. Stock Fundamentals (minimal input for PBV; no scraper exists yet —
--    populate manually/via future admin tool. Never fabricate rows here.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_fundamentals (
  ticker TEXT PRIMARY KEY,
  book_value_per_share NUMERIC,
  equity NUMERIC,
  shares_outstanding NUMERIC,
  fundamental_period TEXT,
  source TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT stock_fundamentals_ticker_upper_chk CHECK (ticker = UPPER(ticker))
);

ALTER TABLE stock_fundamentals ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 4. Stock Daily Features (precomputed snapshot cache — one row per ticker,
--    rebuilt in batch by the daily collector job; this is what the API and
--    screeners should read at runtime to avoid recomputing RSI/volume/foreign
--    context on every request)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_daily_features (
  ticker TEXT PRIMARY KEY,
  as_of_trade_date DATE NOT NULL,

  last_price NUMERIC,
  last_price_as_of TIMESTAMPTZ,
  last_price_source TEXT,

  rsi_14 NUMERIC,
  rsi_state TEXT,

  pbv NUMERIC,
  pbv_as_of_price NUMERIC,
  fundamental_period TEXT,
  fundamental_source TEXT,

  volume_today NUMERIC,
  volume_previous_session NUMERIC,
  volume_avg_7d NUMERIC,
  volume_median_7d NUMERIC,
  volume_ratio_vs_previous NUMERIC,
  volume_ratio_vs_7d_avg NUMERIC,

  foreign_net_today NUMERIC,
  foreign_net_3d NUMERIC,
  foreign_net_5d NUMERIC,
  foreign_net_7d NUMERIC,
  foreign_positive_days_7d INTEGER,
  foreign_negative_days_7d INTEGER,
  foreign_net_streak INTEGER,

  data_freshness TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT stock_daily_features_ticker_upper_chk CHECK (ticker = UPPER(ticker))
);

CREATE INDEX IF NOT EXISTS idx_stock_daily_features_as_of ON stock_daily_features (as_of_trade_date);

ALTER TABLE stock_daily_features ENABLE ROW LEVEL SECURITY;

-- Deny direct client access on all four tables. Service role bypasses RLS for
-- server-side collector/API/admin code, matching the convention already used
-- by foreign_watchlist_daily.

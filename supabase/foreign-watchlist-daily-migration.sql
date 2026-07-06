-- ============================================================
-- Foreign Watchlist Import v1 — Supabase Migration
-- Run this manually in Supabase SQL Editor after review.
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS foreign_watchlist_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date DATE NOT NULL,
  ticker TEXT NOT NULL,
  foreign_buy NUMERIC,
  foreign_sell NUMERIC,
  foreign_net NUMERIC,
  source TEXT DEFAULT 'csv',
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT foreign_watchlist_daily_ticker_upper_chk CHECK (ticker = UPPER(ticker)),
  CONSTRAINT foreign_watchlist_daily_trade_date_ticker_key UNIQUE (trade_date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_foreign_watchlist_daily_ticker ON foreign_watchlist_daily (ticker);
CREATE INDEX IF NOT EXISTS idx_foreign_watchlist_daily_trade_date ON foreign_watchlist_daily (trade_date);

ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS close NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS volume NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS freq NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS valuasi NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS nbsa NUMERIC;


-- Deny direct client access. Service role bypasses RLS for server/local import tools.
ALTER TABLE foreign_watchlist_daily ENABLE ROW LEVEL SECURITY;

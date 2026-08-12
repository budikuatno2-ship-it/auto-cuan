-- ============================================================
-- Daily Market Context — 52-Week High/Low + Ranking Table Columns
-- Run this manually in Supabase SQL Editor after review.
-- Safe to run multiple times (idempotent ALTER ... ADD COLUMN IF NOT EXISTS).
--
-- Purely additive: adds columns to the existing stock_daily_features cache
-- table. Does NOT touch stock_daily_history, idx_trading_calendar,
-- stock_fundamentals, or any table used by the Fast Watcher, Day Trade
-- screener, Swing screener, or Telegram delivery pipeline.
--
-- Why: stock_daily_history only retains HISTORY_RETENTION_TRADING_SESSIONS
-- (120 sessions, ~6 months) — not enough to answer a true 52-week high/low
-- question. lib/daily-history-collector.js already fetches a full 1-year
-- daily series from Yahoo Finance per ticker (range=1y); these columns let
-- the derived 52W high/low (and the ranking table's day-over-day change)
-- be persisted alongside the rest of the precomputed snapshot instead of
-- being silently discarded after the collector trims to the retention
-- window.
-- ============================================================

ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS previous_close NUMERIC;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS change_pct NUMERIC;

ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS week52_high NUMERIC;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS week52_high_date DATE;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS week52_low NUMERIC;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS week52_low_date DATE;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS week52_high_dist_pct NUMERIC;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS week52_low_dist_pct NUMERIC;

-- Daily Market Context — 52W ranking columns
-- Additive + idempotent. Does not touch Fast Watcher/Day Trade/Swing tables.

ALTER TABLE stock_daily_features
  ADD COLUMN IF NOT EXISTS high_52w NUMERIC;

ALTER TABLE stock_daily_features
  ADD COLUMN IF NOT EXISTS distance_to_high_52w_pct NUMERIC;

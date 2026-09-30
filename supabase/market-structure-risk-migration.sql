-- ============================================================
-- Market Structure Risk v1 — Free Float + HSC
--
-- Additive, idempotent migration.
-- Verified market-structure values live in stock_fundamentals because that
-- table is already the batch-loaded per-ticker trusted-input store. The daily
-- feature cache copies the latest verified context for lightweight ranking/API
-- reads. No screener table or live trading path is modified.
-- ============================================================

ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS free_float_pct NUMERIC;
ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS free_float_source TEXT;
ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS free_float_as_of DATE;
ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS hsc_flag BOOLEAN;
ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS hsc_source TEXT;
ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS hsc_as_of DATE;

ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS free_float_pct NUMERIC;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS free_float_source TEXT;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS free_float_as_of DATE;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS hsc_flag BOOLEAN;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS hsc_source TEXT;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS hsc_as_of DATE;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS market_structure_status TEXT;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS market_structure_guard TEXT;
ALTER TABLE stock_daily_features ADD COLUMN IF NOT EXISTS market_structure_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_fundamentals_free_float_pct_chk'
  ) THEN
    ALTER TABLE stock_fundamentals
      ADD CONSTRAINT stock_fundamentals_free_float_pct_chk
      CHECK (free_float_pct IS NULL OR (free_float_pct >= 0 AND free_float_pct <= 100));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_daily_features_free_float_pct_chk'
  ) THEN
    ALTER TABLE stock_daily_features
      ADD CONSTRAINT stock_daily_features_free_float_pct_chk
      CHECK (free_float_pct IS NULL OR (free_float_pct >= 0 AND free_float_pct <= 100));
  END IF;
END $$;

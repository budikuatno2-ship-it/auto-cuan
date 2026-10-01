-- ============================================================
-- Swing price provenance — Phase 2A
--
-- Adds genuine quote-source timestamps to Swing persistence.
-- Legacy rows intentionally remain NULL. Do not derive price_date
-- from run_date, calculated_at, published_at, or updated_at.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.swing_screener_latest
  IN SHARE ROW EXCLUSIVE MODE;

LOCK TABLE public.swing_screener_non_konglo_staging
  IN SHARE ROW EXCLUSIVE MODE;

LOCK TABLE public.swing_screener_non_konglo_latest
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.swing_screener_latest
  ADD COLUMN IF NOT EXISTS price_source TEXT;

ALTER TABLE public.swing_screener_latest
  ADD COLUMN IF NOT EXISTS price_asof TIMESTAMPTZ;

ALTER TABLE public.swing_screener_latest
  ADD COLUMN IF NOT EXISTS price_date DATE;

ALTER TABLE public.swing_screener_non_konglo_staging
  ADD COLUMN IF NOT EXISTS price_source TEXT;

ALTER TABLE public.swing_screener_non_konglo_staging
  ADD COLUMN IF NOT EXISTS price_asof TIMESTAMPTZ;

ALTER TABLE public.swing_screener_non_konglo_staging
  ADD COLUMN IF NOT EXISTS price_date DATE;

ALTER TABLE public.swing_screener_non_konglo_latest
  ADD COLUMN IF NOT EXISTS price_source TEXT;

ALTER TABLE public.swing_screener_non_konglo_latest
  ADD COLUMN IF NOT EXISTS price_asof TIMESTAMPTZ;

ALTER TABLE public.swing_screener_non_konglo_latest
  ADD COLUMN IF NOT EXISTS price_date DATE;

COMMIT;

-- Read-only verification
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'swing_screener_latest',
    'swing_screener_non_konglo_staging',
    'swing_screener_non_konglo_latest'
  )
  AND column_name IN (
    'price_source',
    'price_asof',
    'price_date'
  )
ORDER BY table_name, column_name;

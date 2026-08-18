-- Preserve the already-computed Swing Non-Konglo Trade Plan V2 snapshot
-- across staging and latest persistence.
-- Apply this migration BEFORE deploying the matching application code.
-- Safe to run repeatedly.

BEGIN;

ALTER TABLE swing_screener_non_konglo_staging
  ADD COLUMN IF NOT EXISTS trade_plan_v2 JSONB,
  ADD COLUMN IF NOT EXISTS trade_plan_v2_structural JSONB;

ALTER TABLE swing_screener_non_konglo_latest
  ADD COLUMN IF NOT EXISTS trade_plan_v2 JSONB,
  ADD COLUMN IF NOT EXISTS trade_plan_v2_structural JSONB;

COMMIT;

-- Preserve the already-computed Trade Plan V2 snapshot for Day Trade and Swing Konglo
-- across database persistence.
-- Apply this migration BEFORE deploying the matching application code.
-- Safe to run repeatedly.

BEGIN;

ALTER TABLE daytrade_screener_latest
  ADD COLUMN IF NOT EXISTS trade_plan_v2 JSONB,
  ADD COLUMN IF NOT EXISTS trade_plan_v2_structural JSONB;

ALTER TABLE swing_screener_latest
  ADD COLUMN IF NOT EXISTS trade_plan_v2 JSONB,
  ADD COLUMN IF NOT EXISTS trade_plan_v2_structural JSONB;

COMMIT;

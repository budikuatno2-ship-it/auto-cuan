-- Patch: Add transaction value columns and setup_type
-- Safe to run multiple times (IF NOT EXISTS)

-- Non-Konglo staging
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS tx_value_1d NUMERIC;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS avg_tx_value_3d NUMERIC;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS avg_tx_value_7d NUMERIC;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS setup_type TEXT;

-- Non-Konglo latest
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tx_value_1d NUMERIC;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS avg_tx_value_3d NUMERIC;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS avg_tx_value_7d NUMERIC;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS setup_type TEXT;

-- Konglo screener value columns (display only)
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tx_value_1d NUMERIC;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS avg_tx_value_3d NUMERIC;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS avg_tx_value_7d NUMERIC;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS avg_tx_value_20d NUMERIC;

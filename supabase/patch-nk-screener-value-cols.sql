ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tx_value_1d NUMERIC;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS avg_tx_value_3d NUMERIC;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS avg_tx_value_7d NUMERIC;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS tx_value_1d NUMERIC;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS avg_tx_value_3d NUMERIC;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS avg_tx_value_7d NUMERIC;
-- Konglo screener value columns
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tx_value_1d NUMERIC;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS avg_tx_value_3d NUMERIC;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS avg_tx_value_7d NUMERIC;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS avg_tx_value_20d NUMERIC;

-- Migration: Add pattern_personality column to screener latest tables
-- Enables physical storage of matched pattern personality key

ALTER TABLE IF EXISTS daytrade_screener_latest 
  ADD COLUMN IF NOT EXISTS pattern_personality text;

ALTER TABLE IF EXISTS swing_screener_latest 
  ADD COLUMN IF NOT EXISTS pattern_personality text;

ALTER TABLE IF EXISTS swing_screener_non_konglo_latest 
  ADD COLUMN IF NOT EXISTS pattern_personality text;

COMMENT ON COLUMN daytrade_screener_latest.pattern_personality IS 'Matched quantitative pattern personality key';
COMMENT ON COLUMN swing_screener_latest.pattern_personality IS 'Matched quantitative pattern personality key';
COMMENT ON COLUMN swing_screener_non_konglo_latest.pattern_personality IS 'Matched quantitative pattern personality key';

-- Migration: Add nullable timeframe/context summary columns to screener latest tables
-- Purpose: Persist multi-timeframe candle context, volume phase, risk label, quality grade
-- Safe: Uses ADD COLUMN IF NOT EXISTS, all columns nullable, no existing data affected

-- Day Trade Screener
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS tf_1d_context text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS tf_2d_context text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS tf_3d_context text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS tf_5d_context text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS tf_10d_context text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS tf_20d_context text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS multi_timeframe_bias text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS multi_timeframe_notes text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS volume_phase text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS risk_label text;
ALTER TABLE daytrade_screener_latest ADD COLUMN IF NOT EXISTS quality_grade text;

-- Konglo Swing Screener
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tf_1d_context text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tf_2d_context text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tf_3d_context text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tf_5d_context text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tf_10d_context text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS tf_20d_context text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS multi_timeframe_bias text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS multi_timeframe_notes text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS volume_phase text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS risk_label text;
ALTER TABLE swing_screener_latest ADD COLUMN IF NOT EXISTS quality_grade text;

-- Non-Konglo Swing Screener (latest published)
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tf_1d_context text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tf_2d_context text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tf_3d_context text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tf_5d_context text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tf_10d_context text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS tf_20d_context text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS multi_timeframe_bias text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS multi_timeframe_notes text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS volume_phase text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS risk_label text;
ALTER TABLE swing_screener_non_konglo_latest ADD COLUMN IF NOT EXISTS quality_grade text;

-- Non-Konglo Staging (intermediate processing table)
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS tf_1d_context text;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS tf_5d_context text;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS tf_20d_context text;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS multi_timeframe_bias text;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS volume_phase text;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS risk_label text;
ALTER TABLE swing_screener_non_konglo_staging ADD COLUMN IF NOT EXISTS quality_grade text;

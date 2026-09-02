-- Migration: AI Analysis Cache Table
-- Purpose: Persist and cache AI analysis and portfolio chat responses to save tokens and prevent rate limits.

CREATE TABLE IF NOT EXISTS ai_analysis_cache (
  cache_key TEXT PRIMARY KEY,
  ticker TEXT,
  analysis_type TEXT NOT NULL DEFAULT 'stock_analysis', -- 'stock_analysis', 'portfolio_chat', etc.
  payload_response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_cache_expires_at ON ai_analysis_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_cache_ticker ON ai_analysis_cache (ticker);

ALTER TABLE ai_analysis_cache ENABLE ROW LEVEL SECURITY;

DO
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ai_analysis_cache' AND policyname = 'service_role_all_ai_analysis_cache'
  ) THEN
    CREATE POLICY service_role_all_ai_analysis_cache ON ai_analysis_cache
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END ;
